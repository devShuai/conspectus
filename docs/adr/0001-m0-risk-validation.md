# ADR 0001：M0 风险验证结论

- 状态：Accepted  
- 日期：2026-08-07  
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

### 用量来源轨 → **不阻塞 M1；M3/M4 缩 scope**

| 子项 | 结论 | 证据 |
| --- | --- | --- |
| #7 四平台余额 | 全 **deferred**（无账户/Key）；DeepSeek 文档表明接口可行 | [docs/m0-usage-sources.md](../m0-usage-sources.md) |
| #8 Claude Code / Codex | Claude **no-go auto**（无稳定只读来源）；Codex **deferred** | 同上 |

**M3**：通道 A 不设“四平台齐备”为必达；有 Key 后优先 DeepSeek；其余手动录入。  
**M4**：不以 Codex/Claude Code 自动采集为 V1 必达；collector 框架可建，具体插件后补；通道 C 完整。

### 上游

- certus#9 capabilities：**已关闭且 E2E GO**（#4）。  
- certus#10（status 返回 email）：**open**，M3 fail-safe 已写明。

## 版本指纹

| 组件 | 版本/标识 |
| --- | --- |
| Node.js | ≥20.9（验证机 24.19.0） |
| Next.js | 16.3.0 |
| openid-client | 6.8.4 |
| certus issuer | https://certus.devshuai.com |
| 测试 | 31 tests（提交 d85a74a 时点） |

## 范围变更清单

| 里程碑 | 变更 |
| --- | --- |
| M1 | 无削减；按 design 实现 DB Session / Back-Channel 等 |
| M3 | 余额 adapter 清单改为“账户到位后 DeepSeek 优先”；Kimi/MiniMax/xAI deferred |
| M4 | 去掉“Codex+Claude Code 双 collector 必达”；改为可选插件 + 手动录入 |

## 后续 issue（建议）

1. 持有 DeepSeek Key 后：`[M3] DeepSeek balance adapter E2E`  
2. Claude/Codex 官方暴露结构化用量后：`[M4] collector plugin`  
3. certus#10 关闭后：评估 status 成对邮箱校验  

## 后果

- 正面：M1 可立即开工；认证不确定性已消除。  
- 负面：用量差异化卖点在 V1 更依赖手动录入与后续平台接入。  
- 风险：不得在实现期假设本地 coding plan 自动用量。

## 否决方案

- 为 M0 强行开户充值凑齐四平台 → 拒绝（issue 明确非目标）。  
- 解析 Claude 会话文件推断用量 → 拒绝（隐私/合规）。
