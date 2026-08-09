/**
 * certus 回调失败的开发期详情（#123）。
 *
 * 重定向只能携带白名单里的 code，所以真实原因唯一存在的地方就是这条日志。它
 * 此前只打 `error.name`：一次真实故障打出来是「PrismaClientKnownRequestError」，
 * 看不出是哪张表、哪一列、什么错误码，而这些在 message 和 error.code 里全都有。
 * 三个分支（login / bind / reauth）此前只有 login 有日志。
 */

/** 把错误链摊平成一行；不打 stack，定位靠 name + message + Prisma 的 P####。 */
export function describeCallbackFailure(error: unknown, code: string): string {
  const parts: string[] = [];
  const describe = (label: string, value: unknown): void => {
    if (!(value instanceof Error)) {
      if (value !== undefined) parts.push(`${label}=${typeof value}`);
      return;
    }
    parts.push(`${label}=${value.name}: ${value.message}`);
    const errorCode = (value as { code?: unknown }).code;
    // Prisma 把 P#### 挂在 error.code 上，是定位列 / 约束问题最快的线索。
    // 我们自己的流程错误也有 code，但那就是已经打出来的这个，不重复。
    if (typeof errorCode === "string" && errorCode !== code) {
      parts.push(`${label}.code=${errorCode}`);
    }
  };
  describe("error", error);
  if (error instanceof Error && error.cause !== undefined) {
    describe("cause", error.cause);
  }
  return parts.join(" ");
}

/** 生产环境一律静默：这些 message 可能带上库结构，甚至查询参数值。 */
export function logCallbackFailure(
  branch: "login" | "bind" | "reauth",
  code: string,
  error: unknown,
): void {
  if (process.env.NODE_ENV === "production") return;
  console.error(`[auth/callback:${branch}]`, code, describeCallbackFailure(error, code));
}
