import { describe, expect, it } from "vitest";

import { BIND_ERROR_CODES } from "@/server/auth/bind";
import { BIND_FLOW_ERROR_CODES } from "@/server/auth/bind-flow";
import { OIDC_FLOW_ERROR_CODES } from "@/server/auth/flow";
import { REAUTH_FLOW_ERROR_CODES } from "@/server/auth/reauth-flow";

import { resolveAuthError } from "./messages";

const LOGIN_FALLBACK = resolveAuthError("unexpected_error").message;
const BIND_FALLBACK = resolveAuthError("bind_unexpected_error").message;
const REAUTH_FALLBACK = resolveAuthError("reauth_unexpected_error").message;

describe("resolveAuthError", () => {
  /*
   * #123 的根因是「回调能产生的 code」和「页面认识的 code」是两张各自维护的表，
   * 后者漏掉了全部带前缀的分支。这里直接遍历流程模块导出的 code，新增一个而忘了
   * 写文案就会红——两张表不会再悄悄分叉。
   */
  it.each(OIDC_FLOW_ERROR_CODES)("gives login code %s its own message", (code) => {
    const view = resolveAuthError(code);
    expect(view.branch).toBe("login");
    expect(view.message).not.toBe(LOGIN_FALLBACK);
  });

  it.each([...BIND_FLOW_ERROR_CODES, ...BIND_ERROR_CODES])(
    "gives bind code %s its own message",
    (code) => {
      const view = resolveAuthError(`bind_${code}`);
      expect(view.branch).toBe("bind");
      expect(view.message).not.toBe(BIND_FALLBACK);
    },
  );

  it.each(REAUTH_FLOW_ERROR_CODES)("gives reauth code %s its own message", (code) => {
    const view = resolveAuthError(`reauth_${code}`);
    expect(view.branch).toBe("reauth");
    expect(view.message).not.toBe(REAUTH_FALLBACK);
  });

  it("keeps every message within a branch distinct", () => {
    for (const [prefix, codes] of [
      ["", OIDC_FLOW_ERROR_CODES],
      ["bind_", [...BIND_FLOW_ERROR_CODES, ...BIND_ERROR_CODES]],
      ["reauth_", REAUTH_FLOW_ERROR_CODES],
    ] as const) {
      const messages = codes.map((code) => resolveAuthError(`${prefix}${code}`).message);
      // authorization_response_rejected 的排障说明三个分支共用，其余必须各不相同
      const distinct = new Set(messages);
      expect(distinct.size).toBe(messages.length);
    }
  });

  it("titles the branch it actually failed in", () => {
    expect(resolveAuthError("invalid_state").title).toBe("没有创建业务 Session");
    expect(resolveAuthError("bind_invalid_state").title).toBe("没有绑定 certus 账号");
    // reauth 不创建 Session（design §7.1），不能沿用登录分支的标题
    expect(resolveAuthError("reauth_invalid_state").title).toBe("没有通过身份复核");
  });

  it("falls back per branch instead of to the login wording", () => {
    expect(resolveAuthError("bind_nope").message).toBe(BIND_FALLBACK);
    expect(resolveAuthError("reauth_nope").message).toBe(REAUTH_FALLBACK);
    expect(resolveAuthError("nope").message).toBe(LOGIN_FALLBACK);
    expect(BIND_FALLBACK).not.toBe(LOGIN_FALLBACK);
    expect(REAUTH_FALLBACK).not.toBe(LOGIN_FALLBACK);
  });

  it("treats a missing or repeated code as unknown", () => {
    expect(resolveAuthError(undefined).message).toBe(LOGIN_FALLBACK);
    // 重复的 ?code= 会被 Next 交成数组；不猜哪个是真的
    expect(resolveAuthError(["bind_sub_in_use", "invalid_state"]).message).toBe(
      LOGIN_FALLBACK,
    );
  });

  it("never renders text taken from the code itself", () => {
    const injected = "<script>alert(1)</script>";
    for (const code of [injected, `bind_${injected}`, `reauth_${injected}`]) {
      expect(resolveAuthError(code).message).not.toContain("script");
    }
    // 前缀套前缀不得穿透成另一个分支的已知 code
    expect(resolveAuthError("bind_reauth_stale_auth_time").message).toBe(BIND_FALLBACK);
    expect(resolveAuthError("bind_bind_sub_in_use").message).toBe(BIND_FALLBACK);
  });
});
