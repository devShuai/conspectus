import { createHash, randomBytes } from "node:crypto";

export interface ExpiringRecord {
  expiresAt: number;
}

export class HashedTokenStore<T extends ExpiringRecord> {
  constructor(private readonly records: Map<string, T>) {}

  issue(record: T, now = Date.now()): string {
    this.purgeExpired(now);
    const token = randomOpaqueToken();
    this.records.set(tokenDigest(token), { ...record });
    return token;
  }

  read(token: string | undefined, now = Date.now()): T | null {
    if (!token) {
      return null;
    }
    const key = tokenDigest(token);
    const record = this.records.get(key);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= now) {
      this.records.delete(key);
      return null;
    }
    return { ...record };
  }

  consume(token: string | undefined, now = Date.now()): T | null {
    if (!token) {
      return null;
    }
    const key = tokenDigest(token);
    const record = this.records.get(key);
    this.records.delete(key);
    if (!record || record.expiresAt <= now) {
      return null;
    }
    return { ...record };
  }

  delete(token: string | undefined): void {
    if (token) {
      this.records.delete(tokenDigest(token));
    }
  }

  clear(): void {
    this.records.clear();
  }

  storageKeysForTests(): string[] {
    return [...this.records.keys()];
  }

  private purgeExpired(now: number): void {
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
      }
    }
  }
}

export function randomOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}
