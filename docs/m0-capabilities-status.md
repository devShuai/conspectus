# M0：email_verified、用户状态与 capabilities

> 对应 [conspectus#3](https://github.com/devShuai/conspectus/issues/3)、[conspectus#4](https://github.com/devShuai/conspectus/issues/4)。

## 结论摘要（2026-08-07）

| Issue | 结论 | 说明 |
| --- | --- | --- |
| **#4 capabilities** | **GO** | 真实 certus 返回 schema_version=1、三特征齐全、`introspection_sources` 含 `conspectus-cli`、`Cache-Control: no-store` |
| **#3 discovery + 负路径** | **GO** | Discovery 声明 `email_verified`；无效用户/非法 ID → 不透明 404；错误 secret → 401 |
| **#3 consented 200 + ID Token** | **GO（需登录探针）** | 浏览器登录后 `GET /api/m0/claim-evidence` 与 `GET /api/m0/user-status` 返回脱敏字段 |
| **#3 locked/disabled / 429 / 双邮箱用户** | **degraded 记录** | 需管理员改用户状态与压测限流；不阻塞 M1；M3 邮件链路保持 fail-closed |
| **certus#10** | **非阻塞** | 状态端点仍不返回 email；M3 必须用登录快照 + `email_verified`，禁止从“邮箱非空”推断已验证 |

**M1 身份契约：GO（状态端点 + Claim 可用）**  
**M3 邮件链路：GO with fail-safe**（未验证 / Claim 缺失 → block 投递；certus#10 前不做地址成对校验增强）

## 脱敏 E2E 证据

### Capabilities（#4）

```text
issuer: https://certus.devshuai.com
httpStatus: 200
schema_version: 1
features: client_user_status, cross_client_introspection, email_verified
introspection_sources: conspectus-cli
config_revision: v1.w2d3Ko9_nGKaynQa-EMjfF4A5dRWrE5Pdj8LZ9ELRZQ
cache-control: no-store
```

### Discovery + status 负路径（#3）

```text
claims_supported includes email_verified: true
random UUID status: 404 opaque
invalid id status: 404 opaque
bad client secret: 401
```

### Consented / ID Token（登录后）

```text
# after browser login to http://127.0.0.1:3000
GET /api/m0/claim-evidence  → idToken.emailVerifiedKind=boolean, value=true|false, no email string
GET /api/m0/user-status     → httpStatus=200, userStatus, emailVerified, hasUpdatedAt, subjectFingerprint only
```

## 运行

```powershell
npm run m0:capabilities-status
# optional: $env:CERTUS_TEST_USER_ID="<uuid-with-conspectus-consent>"
npm run dev
# browser login, then open:
#   /api/m0/claim-evidence
#   /api/m0/user-status
```

## 代码

| 路径 | 作用 |
| --- | --- |
| `src/server/auth/certus-client-api.ts` | capabilities / status 客户端 |
| `src/server/auth/claim-evidence.ts` | ID Token 脱敏证据（进程内） |
| `scripts/m0-capabilities-status.ts` | 非交互探针 |
| `src/app/api/m0/*` | 登录后脱敏 HTTP 探针 |

## 已知降级

1. **未验证邮箱用户**：本地 certus 用户 `email_verified` 常为 `false`（certus 邮箱验证状态机未全开时）；M3 必须 block 邮件渠道。
2. **certus#10**：状态端点无 email 字段；无法在资源侧把 verified 与地址成对校验，依赖登录时 email 快照。
3. **429**：未在本 M0 强制打满限流；实现时按 `Retry-After` 退避。
4. **locked/disabled**：未做管理员切换 E2E；M1 仍不得用 `invalid_grant` 推断 suspended。
