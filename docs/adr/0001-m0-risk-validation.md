# ADR 0001：M0 风险验证结论

- 状态：Accepted  
- 日期：2026-08-07  
- 最近更新：2026-08-08（用量来源重开验证）
- 关联：Epic [#1](https://github.com/devShuai/conspectus/issues/1)

## 背景

进入 M1/M3/M4 实现前，需用真实 E2E 消除认证与用量来源不确定性。M0 只做验证与范围决策，不实现完整业务。

## 决策

### 认证轨 → **GO（M1 / M4 授权）**

| 子项 | 结论 | 证据 |
| --- | --- | --- |
| #2 OIDC + 不透明 Session | **GO** | [docs/m0-auth-poc.md](../m0-auth-poc.md) · commit 55ba5b2 |
| #6 device + usage:write + introspection | **GO** | [docs/m0-device-introspection.md](../m0-device-introspection.md) · commit 611922e |
| #3 email_verified + user status | **GO**（邮件 fail-safe） | [docs/m0-capabilities-status.md](../m0-capabilities-status.md) · commit d85a74a |
| #4 capabilities | **GO** | 同上 |

**M1**：可采用 certus OIDC + 自有 DB Session 骨架；不得用 `invalid_grant` 写 `User.suspended`。  
**M4 授权**：device code + `usage:write` + `introspectable_by` 跨客户端 introspection 已证实。  
**M3 邮件**：`email_verified` Claim/状态可用；未验证或缺失 → **block** 邮件渠道；certus#10 前不做状态端点邮箱成对校验。

### 用量来源轨 → **不阻塞 M1；M3/M4 分级接入**

| 子项 | 结论 | 证据 |
| --- | --- | --- |
| #7 平台余额 | DeepSeek **E2E GO**；Kimi/xAI 官方合同 GO、凭据 deferred；MiniMax 现金余额无公开官方 API | [docs/m0-usage-sources.md](../m0-usage-sources.md) |
| #8 Claude Code / Codex | Codex App Server **E2E GO（实验性）**；Claude status line 官方合同 GO、本机认证 deferred | 同上 |
| MiniMax Coding Plan | 三个开源项目交叉验证 `remains` 合同；无 Key，真实 E2E deferred；按 `quota` 而非 `balance` 建模 | 同上 |

**M3**：DeepSeek 为首个必做 balance adapter；Kimi/xAI 可按官方合同推进，但真实兼容凭据 E2E 是上线门；MiniMax API 现金余额走通道 C。

**M4**：Codex 为首个必做 collector，但 App Server 仍是实验性接口，必须版本门控并可降级；Claude 按官方 status line 白名单字段实现，真实认证 E2E 通过后上线；MiniMax Coding Plan 作为实验性本地 collector。

### 上游

- certus#9 capabilities：**已关闭且 E2E GO**（#4）。  
- certus#10（status 返回 email）：**open**，M3 fail-safe 已写明。

## 版本指纹

| 组件 | 版本/标识 |
| --- | --- |
| Node.js | ≥20.9（验证机 24.19.0） |
| Next.js | 16.3.0 |
| openid-client | 6.8.4 |
| Claude Code | 2.1.150（本机 OAuth 请求被拒，待重新认证） |
| Codex CLI | 2026-08-08 临时获取官方 `@openai/codex`，App Server E2E GO |
| certus issuer | https://certus.devshuai.com |
| 测试 | 31 tests（提交 d85a74a 时点） |

## 范围变更清单

| 里程碑 | 变更 |
| --- | --- |
| M1 | 无削减；按 design 实现 DB Session / Back-Channel 等 |
| M3 | DeepSeek adapter 必做；Kimi/xAI 分别按 Open Platform/Management API 合同接入；MiniMax 现金余额不自动化 |
| M4 | Codex collector 必做但可降级；Claude 以 status line schema 接入；MiniMax Coding Plan 以实验性 OSS 合同接入 |

## 后续 issue（建议）

1. `[M3] DeepSeek balance adapter`（已有真实 E2E 证据）
2. `[M4] Codex App Server collector`（实验性接口 + 降级）
3. `[M4] Claude status line collector`（重新认证后补 E2E）
4. `[M4] MiniMax Coding Plan experimental collector`（有 Key 后补 E2E）
5. certus#10 关闭后：评估 status 成对邮箱校验

## 后果

- 正面：M1 可立即开工；DeepSeek 与 Codex 已有真实 E2E；Claude/MiniMax 都有可实现合同。
- 负面：除 DeepSeek/Codex 外仍缺兼容真实凭据；MiniMax 与 Codex 来源存在上游变更风险。
- 风险：实验性或未公开合同必须做能力探测、schema 校验、熔断、脱敏与通道 C 降级。

## 否决方案

- 为 M0 强行开户充值凑齐四平台 → 拒绝（issue 明确非目标）。  
- 解析 Claude 会话文件推断用量 → 拒绝（隐私/合规）。
- 把 MiniMax Coding Plan `remains` 当现金余额 → 拒绝（计量语义错误）。
- 直接复制 GPL 项目实现 → 拒绝（只交叉验证行为，独立实现）。
