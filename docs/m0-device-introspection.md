# M0：设备码、usage:write 与跨客户端 introspection

> 对应 [conspectus#6](https://github.com/devShuai/conspectus/issues/6)。验证 M4 采集器授权链路，不实现正式 CLI / 设备签名 / 上报。

## 目标结论

| 项 | 状态 |
| --- | --- |
| Device Authorization Grant | **GO**（2026-08-07） |
| `usage:write` 在 access token scope | **GO** |
| `conspectus` 跨客户端 introspection → `active:true` + 预期 client/scope/sub | **GO** |
| 垃圾 token → `active:false` 且无泄漏字段 | **GO** |
| 去掉 `introspectable_by` 后 denial | 可选对照（未阻塞 M4 主路径 GO） |
| 自动化 | device-m0 单测 + typecheck 通过 |

**M4 授权链路临时结论：GO**

### 脱敏 E2E 证据（2026-08-07）

```text
issuer: https://certus.devshuai.com
cli_client_id: conspectus-cli
resource_client_id: conspectus
device_scope: openid profile usage:write
token_scope_observed: openid profile usage:write
token_fp: Of_cvVeoQ_5JN68H
token_type: bearer
token_expires_in: 900
introspect_active: true
introspect_client_id: conspectus-cli
introspect_scope: openid profile usage:write
sub_fp: 0quQYDZ9SIsOcGay
garbage_token_active: false
garbage_inactive_without_leak: true
provisional_m4_auth: GO
```

未记录 access token、refresh token、client secret、原始 sub 或邮箱。

## certus 客户端登记（管理员）

### `conspectus-cli`（public）

```json
{
  "id": "conspectus-cli",
  "name": "conspectus collect (M0)",
  "application_type": "public",
  "token_endpoint_auth_method": "none",
  "protocols": ["oauth2.1"],
  "grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  "login_methods": ["password"],
  "allowed_scopes": ["openid", "profile", "usage:write"],
  "introspectable_by": ["conspectus"],
  "enabled": true
}
```

### `conspectus`（confidential）

沿用 #2 的 SSO 客户端；**必须**被列入 CLI 的 `introspectable_by`。无需为 introspection 单独改 grant_types。

## 本地运行

```powershell
# .env.local 至少包含：
# CERTUS_ISSUER / CERTUS_CLIENT_ID / CERTUS_CLIENT_SECRET / CERTUS_CLI_CLIENT_ID
npm test
npm run typecheck
npm run m0:device-introspect
```

脚本会打印 `user_code` 与 `verification_uri`。在浏览器打开 certus 设备页完成批准后，轮询换 token 并对 access token 做 introspection。

**绝不**把 access token、refresh token、client secret、原始 `sub` 或邮箱写入 issue / git / fixture。

## 负路径

| 路径 | 做法 |
| --- | --- |
| 垃圾 access token | 脚本末尾自动 introspect，期望 `active:false` |
| 无 `introspectable_by` | 管理员临时清空 CLI 的白名单后重跑；期望 `active:false`，响应尽量无 `sub`/`client_id` |
| 错误 resource secret | 改错 `CERTUS_CLIENT_SECRET` 后应在 discovery/introspect 失败（勿提交错误值） |
| 拒绝设备码 | 用户在设备页拒绝；轮询应得到 `access_denied` 类错误 |

## 脱敏证据模板

```text
date:
certus_issuer:
certus_release:
cli_client_id: conspectus-cli
resource_client_id: conspectus
device_scope: openid profile usage:write
token_scope_observed: [list]
token_fp: <16-char sha256 prefix>
introspect_active: true|false
introspect_client_id:
introspect_scope:
sub_fp:
deny_whitelist_active: false
garbage_token_active: false
provisional_m4_auth: GO|NO-GO
```

## 代码入口

| 路径 | 作用 |
| --- | --- |
| `src/server/auth/device-m0-config.ts` | 环境变量 |
| `src/server/auth/device-introspection.ts` | openid-client device + introspect + 评估 |
| `scripts/m0-device-introspection.ts` | 交互 E2E |
| `src/server/auth/device-introspection.test.ts` | 纯函数单测 |

## M0 限制

- 不实现 `conspectus-collect`、设备密钥、binding 或 `/api/collect/*`。
- 正式 M4 仍需在 production 客户端上固定 `introspectable_by` 与 scope，并做租约/撤销 E2E。
