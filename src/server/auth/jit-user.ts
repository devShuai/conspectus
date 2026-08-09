import type { Prisma } from "@prisma/client";

import { db } from "@/server/db";

export interface CertusIdentityClaims {
  /** certus's raw `sub` (design §6.2). */
  sub: string;
  /** Pre-#94 digest of the same subject, used once to adopt legacy rows. */
  legacySub?: string;
  email?: string;
  emailVerified?: boolean;
  idTokenIat?: number;
  name?: string;
  sid?: string;
}

function statusObservationAt(claims: CertusIdentityClaims, now: Date): Date {
  const issuedAtSeconds =
    claims.idTokenIat ?? Math.floor(now.getTime() / 1_000);
  if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds < 0) {
    throw new Error("invalid ID Token iat");
  }
  return new Date(issuedAtSeconds * 1_000);
}

function laterDate(left: Date | null, right: Date): Date {
  return left && left > right ? left : right;
}

/**
 * JIT provision / sync a local User row for a certus subject.
 * - Lookup is by certusSub ONLY; email is a snapshot and never merges accounts.
 * - Rows written before #94 hold a digest; they are matched once via
 *   certusSubLegacy and upgraded to the raw sub in place, so a stored digest
 *   never causes a second account to be provisioned for the same person.
 * - Email snapshot: on address change, clear any prior verification proof,
 *   then (re)establish from this login's email_verified claim.
 * - Never writes User.suspended from token/flow errors; a fresh successful
 *   authorization may only clear certus-caused suspension, never admin.
 */
export async function upsertCertusUser(
  claims: CertusIdentityClaims,
  now: Date = new Date(),
  client?: Prisma.TransactionClient,
): Promise<{ userId: string; user: NonNullable<Awaited<ReturnType<typeof db.user.findUnique>>> }> {
  if (!client) {
    return db.$transaction((tx) => upsertCertusUser(claims, now, tx));
  }
  const tx = client;
  const observedAt = statusObservationAt(claims, now);
  let existing = await tx.user.findUnique({
    where: { certusSub: claims.sub },
  });

  if (existing) {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${existing.id}::uuid FOR UPDATE`;
    existing = await tx.user.findUnique({ where: { id: existing.id } });
  }

  if (!existing && claims.legacySub) {
    const legacy = await tx.user.findUnique({
      where: { certusSubLegacy: claims.legacySub },
    });
    if (legacy) {
      existing = await tx.user.update({
        where: { id: legacy.id },
        data: { certusSub: claims.sub, certusSubLegacy: null },
      });
    }
  }

  if (!existing) {
    const hasVerifiedEmail =
      claims.email !== undefined && claims.emailVerified === true;
    const created = await tx.user.create({
      data: {
        certusSub: claims.sub,
        certusLinkStatus: "active",
        lastStatusSyncedAt: observedAt,
        name: claims.name,
        lastLoginAt: now,
        email: claims.email,
        emailVerifiedAt: hasVerifiedEmail ? now : null,
        emailVerificationSource: hasVerifiedEmail ? "certus" : null,
      },
    });
    return { userId: created.id, user: created };
  }

  const hasEmailClaim = claims.email !== undefined;
  const emailChanged = hasEmailClaim && existing.email !== claims.email;
  const certusSuspended =
    existing.status === "suspended" &&
    (existing.statusReason === "certus_locked" ||
      existing.statusReason === "certus_disabled");
  const emailData: Prisma.UserUpdateInput = hasEmailClaim
    ? {
        email: claims.email,
        emailVerifiedAt:
          emailChanged && !claims.emailVerified
            ? null
            : claims.emailVerified
              ? now
              : emailChanged
                ? null
                : existing.emailVerifiedAt,
        emailVerificationSource: claims.emailVerified
          ? "certus"
          : emailChanged
            ? null
            : existing.emailVerificationSource,
      }
    : {};
  const updated = await tx.user.update({
    where: { id: existing.id },
    data: {
      name: claims.name ?? existing.name,
      lastLoginAt: now,
      certusLinkStatus: "active",
      lastStatusSyncedAt: laterDate(existing.lastStatusSyncedAt, observedAt),
      status: certusSuspended ? "active" : existing.status,
      statusReason: certusSuspended ? null : existing.statusReason,
      statusCheckFailureCount: 0,
      nextStatusCheckAt: null,
      lastStatusSyncError: null,
      // Email snapshot rules (design.md §6.2):
      // - address changed → clear old proof unconditionally
      // - only (re)prove from this login's verified claim
      // - missing email Claim → no email snapshot fields change
      ...emailData,
    },
  });
  // #125：不再有「等重新登录刷新邮箱快照」这条路径 —— 投递前的逐批复核直接拿
  // certus 的 email + email_verified 成对判定，因门禁延迟的行按各自的退避重试
  // 自行恢复，不需要登录来解锁。
  return { userId: updated.id, user: updated };
}
