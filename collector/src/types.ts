/** Shared UsageReading contract (mirrors src/server/usage/reading.ts). */
export interface UsageReading {
  bindingId: string;
  kind: "quota" | "balance" | "counter";
  metric: string;
  unit: string;
  usedValue?: string;
  limitValue?: string;
  remainingValue?: string;
  periodStart?: string;
  periodEnd?: string;
  capturedAt: string;
}

export interface LocalCollector {
  id: string;
  displayName: string;
  /** Whether this tool is installed on this machine. Skip if not. */
  detect(): Promise<boolean>;
  /** Read usage. Read-only; must not modify tool files. */
  collect(ctx: CollectContext): Promise<UsageReading[]>;
}

export interface CollectContext {
  /** Bindings this collector is allowed to write (from manifest). */
  bindings: Array<{
    bindingId: string;
    metric: string;
    kind: string;
    unit: string;
  }>;
}

export interface DeviceLoginResult {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  deviceId?: string;
  devicePrivateKey?: string;
}
