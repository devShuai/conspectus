import { randomBytes } from "node:crypto";

import { db } from "@/server/db";

/**
 * 专属收件别名（#58，design §7.5）：`u-<26 位 base32>`，16 字节（128 bit）
 * 随机熵按 RFC 4648 base32 小写无填充编码。明文存 users.inboundAddress（§6.2
 * 该列本就为此而设，unique 索引支持入站精确查找）；轮换即覆盖该列，旧别名
 * 因此立即失效。
 */

export const INBOUND_ALIAS_LOCAL_PART = /^u-[a-z2-7]{26}$/;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ENTROPY_BYTES = 16;
const MAX_GENERATION_ATTEMPTS = 5;

export function base32NoPad(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function generateInboundAlias(random: () => Buffer = () => randomBytes(ENTROPY_BYTES)): string {
  return `u-${base32NoPad(random())}`;
}

export class InboundAliasError extends Error {
  constructor(
    readonly code: "collision_exhausted" | "domain_not_configured",
    message: string,
  ) {
    super(message);
    this.name = "InboundAliasError";
  }
}

/** 展示用完整地址；INBOUND_EMAIL_DOMAIN 未配置时为 null（§12.4：M6 前可空）。 */
export function inboundAddressDisplay(
  localPart: string | null,
  environment: Record<string, string | undefined> = process.env,
): string | null {
  if (!localPart) return null;
  const domain = environment.INBOUND_EMAIL_DOMAIN?.trim();
  if (!domain) return null;
  return `${localPart}@${domain}`;
}

export function requireInboundDomain(
  environment: Record<string, string | undefined> = process.env,
): string {
  const domain = environment.INBOUND_EMAIL_DOMAIN?.trim();
  if (!domain) {
    throw new InboundAliasError("domain_not_configured", "未配置收件域名");
  }
  return domain;
}

/** 结构化审计：只记事件与 userId，绝不记别名值（§9 日志脱敏；#58 不泄露映射）。 */
function audit(event: string, userId: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, userId, at: new Date().toISOString(), ...extra }));
}

/**
 * 生成或轮换别名：唯一冲突时重试有限次（128 bit 熵下冲突实质是 unique 索引
 * 兜底测试，不是现实碰撞）。旧别名随 UPDATE 提交立即失效。
 */
export async function rotateInboundAlias(userId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const alias = generateInboundAlias();
    try {
      await db.user.update({ where: { id: userId }, data: { inboundAddress: alias } });
      audit("inbound_alias_rotated", userId);
      return alias;
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        (cause as { code?: string }).code === "P2002"
      ) {
        continue;
      }
      throw cause;
    }
  }
  throw new InboundAliasError("collision_exhausted", "别名生成冲突超限，请重试");
}

/** 撤销别名：入站地址立即失效，既有 InboundEmail/草稿保留。 */
export async function revokeInboundAlias(userId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { inboundAddress: null } });
  audit("inbound_alias_revoked", userId);
}

/** 原文保留开关（§7.5/§9）：false 后新邮件 rawCipher 恒为空；不清既有原文。 */
export async function setInboundRawRetention(userId: string, retain: boolean): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { inboundRetainRaw: retain } });
  audit("inbound_raw_retention_changed", userId, { retain });
}

/** 立即清除该用户全部已存原文（§7.5）；行与元数据保留。 */
export async function clearInboundRawNow(userId: string): Promise<number> {
  const result = await db.inboundEmail.updateMany({
    where: { userId, rawCipher: { not: null } },
    data: { rawCipher: null },
  });
  audit("inbound_raw_cleared", userId, { cleared: result.count });
  return result.count;
}
