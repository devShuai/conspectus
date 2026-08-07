import type { Prisma } from "@prisma/client";

import { db } from "@/server/db";

export interface CertusIdentityClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  idTokenIat?: number;
  name?: string;
  sid?: string;
}

/**
 * JIT provision / sync a local User row for a certus subject.
 * - Lookup is by certusSub ONLY; email is a snapshot and never merges accounts.
 * - Email snapshot: on address change, clear any prior verification proof,
 *   then (re)establish from this login's email_verified claim.
 * - Never writes User.suspended from token/flow errors.
 */
export async function upsertCertusUser(
  claims: CertusIdentityClaims,
  now: Date = new Date(),
  client?: Prisma.TransactionClient,
): Promise<{ userId: string; user: NonNullable<Awaited<ReturnType<typeof db.user.findUnique>>> }> {
  const tx = client ?? db;
  const existing = await tx.user.findUnique({
    where: { certusSub: claims.sub },
  });

  if (!existing) {
    const created = await tx.user.create({
      data: {
        certusSub: claims.sub,
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(claims.idTokenIat ?? Math.floor(now.getTime() / 1000) * 1000),
        name: claims.name,
        lastLoginAt: now,
        email: claims.email,
        emailVerifiedAt: claims.emailVerified ? now : null,
        emailVerificationSource: claims.emailVerified ? "certus" : null,
        emailSnapshotIssuedAt: claims.idTokenIat
          ? new Date(claims.idTokenIat * 1000)
          : null,
      },
    });
    return { userId: created.id, user: created };
  }

  const emailChanged = existing.email !== claims.email;
  const updated = await tx.user.update({
    where: { id: existing.id },
    data: {
      name: claims.name ?? existing.name,
      lastLoginAt: now,
      // Email snapshot rules (design.md §6.2):
      // - address changed → clear old proof unconditionally
      // - only (re)prove from this login's verified claim
      email: claims.email ?? existing.email,
      emailVerifiedAt:
        emailChanged && !claims.emailVerified
          ? null
          : claims.emailVerified
            ? now
            : emailChanged
              ? null
              : existing.emailVerifiedAt,
      emailVerificationSource:
        claims.emailVerified ? "certus" : emailChanged ? null : existing.emailVerificationSource,
      emailSnapshotIssuedAt: claims.idTokenIat
        ? new Date(claims.idTokenIat * 1000)
        : emailChanged
          ? null
          : existing.emailSnapshotIssuedAt,
    },
  });
  return { userId: updated.id, user: updated };
}
