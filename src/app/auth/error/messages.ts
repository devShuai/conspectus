/**
 * 认证失败页的文案解析（#123）。
 *
 * 回调路由把失败原因压缩成一个 code 放进 URL：登录分支是裸 code，绑定分支是
 * `bind_` 前缀，复核分支是 `reauth_` 前缀。页面此前只认裸 code，两个前缀分支的
 * 全部失败都落到同一句「认证暂时不可用」，彼此之间以及与真正的未知错误都无法
 * 区分——其中 sub_in_use、session_mismatch 这类是用户自己能解决的，却被说成
 * 「稍后重试」，指向了错误的动作。
 *
 * 渲染的永远是本文件里的固定文案，绝不回显 URL 参数；无法识别的 code 退到所属
 * 分支的兜底句。
 */

export type AuthErrorBranch = "login" | "bind" | "reauth";

export interface AuthErrorView {
  branch: AuthErrorBranch;
  /** 标题按分支区分：复核分支本来就不创建 Session，不能声称「没有创建业务 Session」。 */
  title: string;
  message: string;
}

const AUTHORIZATION_RESPONSE_REJECTED =
  "certus 返回的授权响应未通过校验。请确认 APP_URL 与 certus 登记的 redirect_uri 完全一致（含 localhost / 127.0.0.1），且 client secret 正确；开发环境可查看服务端日志 [auth/callback]。";

/** 登录分支：OIDCFlowErrorCode。 */
const LOGIN_MESSAGES: Record<string, string> = {
  invalid_callback_url: "回调地址与本应用登记值不一致。",
  invalid_state: "登录事务校验失败，请重新开始。",
  invalid_transaction: "登录事务已失效或已使用，请重新开始。",
  invalid_claims: "身份声明未通过校验。",
  account_suspended: "账号已被停用，无法创建新的业务 Session。",
  authorization_response_rejected: AUTHORIZATION_RESPONSE_REJECTED,
};

/** 绑定分支：BindFlowErrorCode + BindError.code，都由回调加 `bind_` 前缀。 */
const BIND_MESSAGES: Record<string, string> = {
  invalid_transaction: "绑定事务已失效或已使用，未做任何绑定。请回到账号设置重新发起。",
  invalid_state: "绑定事务校验失败，未做任何绑定。请回到账号设置重新发起。",
  invalid_claims: "certus 返回的身份声明未通过校验，未做任何绑定。",
  authorization_response_rejected: AUTHORIZATION_RESPONSE_REJECTED,
  not_a_bind_transaction: "这一次不是绑定流程，未做任何绑定。请回到账号设置重新发起绑定。",
  session_mismatch:
    "登录状态已过期，或与发起绑定时不是同一个会话。请重新登录，再从账号设置发起绑定。",
  invalid_input: "绑定请求不完整，未做任何绑定。",
  already_bound: "当前账号已经绑定了 certus 身份。要换一个身份请先解绑。",
  sub_in_use: "这个 certus 身份已经绑定到另一个账号了，不能重复绑定。",
  last_auth_method: "这是账号最后一种登录方式，不能移除。",
};

/** 复核分支：ReauthFlowErrorCode，都由回调加 `reauth_` 前缀。 */
const REAUTH_MESSAGES: Record<string, string> = {
  invalid_context: "复核请求已失效，敏感操作未执行。请回到原页面重新发起。",
  invalid_transaction: "复核事务已失效或已使用，敏感操作未执行。请回到原页面重新发起。",
  invalid_callback_url: "回调地址与本应用登记值不一致。",
  invalid_state: "复核事务校验失败，敏感操作未执行。请回到原页面重新发起。",
  invalid_claims: "certus 返回的身份声明未通过校验，敏感操作未执行。",
  authorization_response_rejected: AUTHORIZATION_RESPONSE_REJECTED,
  identity_mismatch:
    "完成复核的是另一个 certus 账号，敏感操作未执行。请用当前登录的账号完成复核。",
  stale_auth_time:
    "certus 没有真正重新验证你的身份（多半是被 SSO 静默放行了），敏感操作未执行。请重新发起并完整输入一次凭据。",
  verify_failed: "复核校验未通过，敏感操作未执行。",
};

const BRANCHES: Record<
  AuthErrorBranch,
  { prefix: string; title: string; messages: Record<string, string>; fallback: string }
> = {
  login: {
    prefix: "",
    title: "没有创建业务 Session",
    messages: LOGIN_MESSAGES,
    fallback: "认证暂时不可用，请稍后重试。",
  },
  bind: {
    prefix: "bind_",
    title: "没有绑定 certus 账号",
    messages: BIND_MESSAGES,
    fallback: "绑定暂时不可用，请稍后重试。",
  },
  reauth: {
    prefix: "reauth_",
    title: "没有通过身份复核",
    messages: REAUTH_MESSAGES,
    fallback: "身份复核暂时不可用，请稍后重试。",
  },
};

export function resolveAuthError(code: string | string[] | undefined): AuthErrorView {
  // 重复的 ?code= 会被 Next 交成数组；不猜哪个是真的，直接当未知处理。
  const raw = typeof code === "string" ? code : undefined;
  const branch: AuthErrorBranch = raw?.startsWith("reauth_")
    ? "reauth"
    : raw?.startsWith("bind_")
      ? "bind"
      : "login";
  const { prefix, title, messages, fallback } = BRANCHES[branch];
  const key = raw ? raw.slice(prefix.length) : "";
  return { branch, title, message: messages[key] ?? fallback };
}
