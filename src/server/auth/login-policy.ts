/** Raised at the final Session creation boundary for a globally suspended user. */
export class AccountSuspendedError extends Error {
  readonly code = "account_suspended" as const;

  constructor() {
    super("account is suspended");
    this.name = "AccountSuspendedError";
  }
}
