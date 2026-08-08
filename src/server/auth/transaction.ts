import { HashedTokenStore } from "./opaque-store";

export const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1000;

export interface OIDCTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
  /**
   * What this authorization is for. Kept server-side and keyed by the opaque
   * handle, so the browser never carries the intent: a client-supplied
   * purpose/user would reintroduce the class of flaw that made bind
   * impersonation possible (#96).
   */
  purpose?: "login" | "bind";
  /** For `bind`: the already-authenticated user the sub will be attached to. */
  bindUserId?: string;
}

declare global {
  var __conspectusOIDCTransactions: Map<string, OIDCTransaction> | undefined;
}

const transactionRecords =
  globalThis.__conspectusOIDCTransactions ?? new Map<string, OIDCTransaction>();
globalThis.__conspectusOIDCTransactions = transactionRecords;

const transactions = new HashedTokenStore(transactionRecords);

export function createOIDCTransaction(
  input: Omit<OIDCTransaction, "expiresAt">,
  now = Date.now(),
): { handle: string; transaction: OIDCTransaction } {
  const transaction: OIDCTransaction = {
    ...input,
    expiresAt: now + OIDC_TRANSACTION_TTL_MS,
  };
  return { handle: transactions.issue(transaction, now), transaction };
}

export function consumeOIDCTransaction(
  handle: string | undefined,
  now = Date.now(),
): OIDCTransaction | null {
  return transactions.consume(handle, now);
}

export function resetOIDCTransactionsForTests(): void {
  transactions.clear();
}

export function oidcTransactionStorageKeysForTests(): string[] {
  return transactions.storageKeysForTests();
}

/**
 * Read a transaction without consuming it, so the callback can dispatch on the
 * server-recorded purpose. Routing on a client-supplied marker would let the
 * browser choose which branch runs.
 */
export function peekOIDCTransaction(
  handle: string | undefined,
  now = Date.now(),
): OIDCTransaction | null {
  return transactions.read(handle, now);
}
