# M0：certus OIDC + 自有 Session PoC

> 对应 [conspectus#2](https://github.com/devShuai/conspectus/issues/2)。本 PoC 只验证认证边界，不是 M1 的生产认证实现。

## 当前结论

本地代码、拒绝路径测试、TypeScript 检查和生产构建已通过。2026-08-07 已使用 Fedora 上的真实 certus 环境完成 Authorization Code + PKCE 登录；登录成功后进入 `/me`，页面只显示派生的 `usr_…` 本地标识，未读取或保存 ID Token、access token、邮箱及其他 OIDC profile。

| 项目 | 当前版本/结果 |
| --- | --- |
| Node.js | 本地 `v24.19.0`；项目最低 `>=20.9.0` |
| Next.js | `16.3.0` |
| React | `19.2.8` |
| TypeScript | `5.9.3` |
| openid-client | `6.8.4` |
| certus | Fedora release `11f875b`；issuer `https://certus.devshuai.com`；健康检查与真实登录 E2E 通过 |
| 自动化 | 18 tests；`typecheck`、`next build` 通过 |

## 验证的边界

```text
浏览器
  ├─ HttpOnly OIDC transaction handle（仅 callback path）
  │      └─ 服务端 Map 只以 SHA-256(handle) 为键保存 state / nonce / PKCE verifier
  └─ HttpOnly opaque Session token（全站）
         └─ 服务端 Map 只以 SHA-256(token) 为键保存 userId / timestamps

certus ID Token
  └─ openid-client 验签并校验 issuer / audience / state / nonce / PKCE
         └─ 立即派生稳定本地 userId；不把 token/profile 放进业务 Session
```

- 回调 URL 必须与 `${APP_URL}/api/auth/certus/callback` 的 origin 和 path 精确一致。
- OIDC transaction 一次性消费，10 分钟过期；错误/重复 state 在 token exchange 前拒绝。
- ID Token 必须具有匹配的 issuer、audience、nonce 和非空 sub。
- Session token 为 32 字节随机值；Cookie 不含用户资料或业务 JWT，服务端不存原 token。
- 受保护页面只读取 `session.userId`；注销会删除服务端记录并过期 Cookie。
- 对外错误页只暴露稳定错误码，不输出上游响应、token 或 claims。

## 真实 E2E 证据

执行日期：2026-08-07。证据只记录版本、协议结果和脱敏结论，不记录真实 subject、邮箱、授权码、Cookie 或 token。

| 检查项 | 结果 |
| --- | --- |
| certus discovery / issuer | `https://certus.devshuai.com`，通过 |
| certus 运行版本 | Fedora release `11f875b`，`/healthz` 通过 |
| confidential 客户端 | `conspectus`；`client_secret_basic`；Authorization Code + Refresh Token |
| redirect URI | `http://127.0.0.1:3000/api/auth/certus/callback`（同时登记 localhost 变体用于本地调试） |
| OIDC 校验 | PKCE、state、nonce、issuer、audience、ID Token 签名通过 |
| 业务 Session | `/me` 显示有效 Session，只读取 `session.userId` |
| 数据最小化 | 页面与业务 Session 不保存 ID Token、access token、邮箱或 profile |
| 互操作问题 | [certus#11](https://github.com/devShuai/certus/issues/11) 已修复并关闭 |

拒绝路径、一次性事务、Session 哈希存储与注销失效由自动化测试覆盖；真实 smoke test 不把任何敏感值固化为 fixture 或日志。

## 注册测试客户端

在 certus 测试环境创建一个机密客户端；回调 URI 必须与本地环境精确一致：

```json
{
  "id": "conspectus",
  "name": "conspectus M0",
  "application_type": "confidential",
  "token_endpoint_auth_method": "client_secret_basic",
  "protocols": ["oauth2.1"],
  "grant_types": ["authorization_code", "refresh_token"],
  "redirect_uris": [
    "http://127.0.0.1:3000/api/auth/certus/callback",
    "http://localhost:3000/api/auth/certus/callback"
  ],
  "login_methods": ["password"],
  "allowed_scopes": ["openid", "profile", "email"],
  "enabled": true
}
```

client secret 只在创建/轮换时显示一次，不得写入 issue、日志或 Git。

## 运行

```powershell
Copy-Item .env.example .env.local
# 在 .env.local 填入测试 client secret
# APP_URL 必须与 certus redirect_uris 的 origin 完全一致（推荐双方都用 127.0.0.1，不要混用 localhost）
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

浏览器打开 **`http://127.0.0.1:3000`**（不要用 `localhost`，除非 certus 与 `APP_URL` 也登记为 localhost），完成以下 smoke test：

1. certus 登录后进入 `/me`，页面只显示 `usr_...` 本地标识。
2. 修改回调 state，必须跳转到安全错误页且不创建 Session。
3. 重放同一 callback，必须得到 `invalid_transaction`。
4. POST `/api/auth/logout` 后，旧 Session Cookie 不能再访问 `/me`。
5. 测试日志、浏览器 Cookie 和服务端存储中均不存在邮箱、ID Token、access token 或原始 Session token。

## M0 限制

- Session 和 OIDC transaction 暂存在进程内 Map，只适合单进程 PoC；M1 必须替换为数据库存储，才能支持多实例、重启和 Back-Channel Logout。
- 本 PoC 不实现 JIT 用户档案、Reauth、refresh、三层身份状态、恢复 runner 或本地账号。
- 本地 HTTP 仅允许 loopback 且生产环境强制 HTTPS。

实现依据：[openid-client OIDC 示例](https://github.com/panva/openid-client/blob/main/examples/oidc.ts)、[Next.js Authentication 指南](https://nextjs.org/docs/app/guides/authentication)。
