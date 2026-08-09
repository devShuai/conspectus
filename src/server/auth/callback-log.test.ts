import { afterEach, describe, expect, it, vi } from "vitest";

import { describeCallbackFailure, logCallbackFailure } from "./callback-log";
import { OIDCFlowError } from "./flow";

/** Prisma 的错误形状：name + 多行 message + P#### 挂在 code 上。 */
function prismaError(): Error {
  const error = new Error(
    "\nInvalid `db.notificationDelivery.updateMany()` invocation\n\n" +
      "The column `deferredReason` does not exist in the current database.",
  );
  error.name = "PrismaClientKnownRequestError";
  (error as Error & { code?: string }).code = "P2022";
  return error;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("describeCallbackFailure", () => {
  /*
   * 这正是 #123 里那次真实故障：日志只打了 error.name，于是终端上只有
   * 「PrismaClientKnownRequestError」，看不出是哪张表哪一列。
   */
  it("keeps the Prisma message and P#### that name alone loses", () => {
    const detail = describeCallbackFailure(prismaError(), "unexpected_error");
    expect(detail).toContain("PrismaClientKnownRequestError");
    expect(detail).toContain("deferredReason");
    expect(detail).toContain("code=P2022");
  });

  it("follows the cause chain the flows attach", () => {
    const wrapped = new OIDCFlowError("authorization_response_rejected", {
      cause: prismaError(),
    });
    const detail = describeCallbackFailure(wrapped, "authorization_response_rejected");
    expect(detail).toContain("error=OIDCFlowError");
    expect(detail).toContain("cause=PrismaClientKnownRequestError");
    expect(detail).toContain("cause.code=P2022");
  });

  it("does not repeat the code it is already logged next to", () => {
    // OIDCFlowError.code 就是第二个参数，重复打没有信息量
    const detail = describeCallbackFailure(
      new OIDCFlowError("invalid_transaction"),
      "invalid_transaction",
    );
    expect(detail).toBe("error=OIDCFlowError: invalid_transaction");
  });

  it("survives a thrown non-Error", () => {
    expect(describeCallbackFailure("boom", "unexpected_error")).toBe("error=string");
    expect(describeCallbackFailure(undefined, "unexpected_error")).toBe("");
  });
});

describe("logCallbackFailure", () => {
  it.each(["login", "bind", "reauth"] as const)("tags the %s branch", (branch) => {
    vi.stubEnv("NODE_ENV", "development");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logCallbackFailure(branch, "invalid_state", new Error("nope"));
    expect(spy).toHaveBeenCalledWith(
      `[auth/callback:${branch}]`,
      "invalid_state",
      expect.stringContaining("nope"),
    );
  });

  it("stays silent in production", () => {
    // message 可能带上库结构甚至查询参数值，不能进生产日志
    vi.stubEnv("NODE_ENV", "production");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logCallbackFailure("login", "unexpected_error", prismaError());
    expect(spy).not.toHaveBeenCalled();
  });
});
