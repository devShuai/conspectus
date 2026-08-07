# M0：用量来源轨（#7 / #8）

> 对应 [conspectus#7](https://github.com/devShuai/conspectus/issues/7)、[conspectus#8](https://github.com/devShuai/conspectus/issues/8)。  
> 重新验证日期：2026-08-08 · 验证机：Windows（本仓开发机）

## 总表

| 来源 | 本轮证据 | 结论 | M3/M4 处置 |
| --- | --- | --- | --- |
| DeepSeek 余额 API | 现有本地 Key；官方 `GET /user/balance` 实调 200，schema/Decimal 校验通过 | **E2E GO** | M3 首个服务端 balance adapter |
| Kimi / Moonshot 余额 API | 官方合同确认；现有 Kimi-for-coding Key 在国际站、国内站余额端点均为 401 | **合同 GO / 凭据 deferred** | M3 adapter 可按官方 schema 实现；真实账户验收待 Open Platform Key |
| MiniMax API 现金余额 | 官方文档索引未发现公开现金余额端点 | **no-go for auto balance** | 通道 C；不得声称存在官方余额 API |
| MiniMax Coding Plan 配额 | 三个活跃开源项目交叉验证未公开的 `remains` 端点；本机无 Key | **OSS 合同可行 / 实调 deferred** | M4 实验性本地 collector，按 `quota` 建模 |
| xAI API 预付余额 | 官方 Management API 有 team prepaid balance；本机无 Management Key/team ID | **合同 GO / 凭据 deferred** | M3 独立 adapter；不是普通推理 API Key |
| Claude Code 本地配额 | 官方 status line JSON 已声明 5h/7d 字段；本机 CLI 2.1.150 的现有 OAuth 状态显示已登录，但真实请求被认证拒绝 | **官方合同 GO / 本机 E2E deferred** | M4 collector 做字段能力探测；重新登录后复测 |
| Codex 本地配额/计数 | 官方 CLI App Server 实调成功：rate limits、summary、daily buckets 均通过类型校验 | **E2E GO（实验性接口）** | M4 首个 collector；版本门控、失败降级到通道 C |

**收敛结论**：用量来源不阻塞 M1。M3 先实现 DeepSeek；Kimi/xAI 可按官方合同实现但真实凭据验收后才能宣称 E2E；MiniMax Coding Plan、Codex、Claude Code 属于通道 B，MiniMax 的现金余额仍走通道 C。所有实验性/未公开来源都必须可禁用且不能阻断手动录入。

---

## #7 平台余额 API

### 账户与凭据可得性

| 平台 | 本机可用凭据 | 实调结果 | 决定 |
| --- | --- | --- | --- |
| DeepSeek | 有，来自既有本地客户端配置 | 200 | **E2E GO** |
| Kimi | 有 Kimi-for-coding Key，但不是 Open Platform balance Key | 国际/国内端点均 401 | **deferred**，需兼容凭据 |
| MiniMax | 无 | 未实调 | 现金余额 **no-go**；Coding Plan 另见 OSS 方案 |
| xAI | 无 Management API Key/team ID | 未实调 | **deferred** |

未为凑齐四个平台新开户或充值，也未把任何 Key、余额、百分比或账户标识写入仓库和探针输出。

### DeepSeek（官方合同 + 真实 E2E）

| 项 | 记录 |
| --- | --- |
| 文档 | https://api-docs.deepseek.com/api/get-user-balance |
| 方法/路径 | `GET https://api.deepseek.com/user/balance` |
| 鉴权 | `Authorization: Bearer <API_KEY>`（与推理同 Key；未见独立只读 Key） |
| 成功 schema | `is_available: boolean`；`balance_infos[]`；金额字段为十进制 **string** |
| 本轮实调 | HTTP 200；存在 CNY 行；金额均可无损解析；可用性字段存在 |
| 映射 | `kind=balance`，`remainingValue=total_balance`，`unit=currency` |
| 安全边界 | Key 具推理能力，服务端必须加密、脱敏日志、限制拉取频率并支持撤销 |
| 结论 | **E2E GO**，作为 M3 第一个 balance adapter |

### Kimi / Moonshot（官方合同，凭据不兼容）

| 项 | 记录 |
| --- | --- |
| 文档 | 国际站 https://platform.kimi.ai/docs/api/balance；国内站 https://platform.kimi.com/docs/api/balance |
| 方法/路径 | 国际站 `GET https://api.moonshot.ai/v1/users/me/balance`；国内站 `GET https://api.moonshot.cn/v1/users/me/balance` |
| 鉴权 | Open Platform API Key；现有 Kimi-for-coding Key 两站均返回 401 |
| 成功 schema | `available_balance`、`voucher_balance`、`cash_balance` 为 JSON **number**，不是 string |
| 精度要求 | 禁止先转 IEEE-754 `number` 再转 Decimal；必须从原始 number token 无损解析，或使用 lossless JSON parser |
| 结论 | **官方合同 GO / 真实凭据 deferred**；401 只说明当前 Coding Plan Key 不兼容，不说明端点不可用 |

### MiniMax：现金余额与 Coding Plan 必须拆开

MiniMax 官方文档索引（https://platform.minimax.io/docs/llms.txt）未列出公开现金余额 API，因此原设计中“MiniMax 预付余额有官方接口”的表述不成立。API 现金余额暂走通道 C。

社区项目提供的是 **Coding Plan 周期配额**，不是现金余额：

| 开源项目 | 许可证 | 交叉验证结果 |
| --- | --- | --- |
| [opgginc/opencode-bar](https://github.com/opgginc/opencode-bar) | MIT | 国际站 `coding_plan/remains`；有 MiniMax parser 测试 |
| [slkiser/opencode-quota](https://github.com/slkiser/opencode-quota) | MIT | 国际站同端点；中国站 `token_plan/remains` |
| [onllm-dev/onWatch](https://github.com/onllm-dev/onWatch) | GPL-3.0 | 独立 Go 实现与测试；同时处理 count/percentage 变体 |

交叉验证出的实验性合同：

- 国际站：`GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains`。
- 中国站：`GET https://api.minimaxi.com/v1/token_plan/remains`。
- 使用 Bearer API Key；没有独立只读 scope 的证据，因此优先在用户本机读取并只上传归一化配额。
- `current_interval_usage_count` / weekly usage count 在现有响应中实际被社区实现解释为**剩余量**；`used = total - remaining`，不能按字段名直接当已用量。
- 兼容旧 count 字段与新 percentage 字段；状态 1=有效、2=有效但耗尽、3=未订阅。
- 端点未出现在官方文档中，必须标为 experimental，做 schema/范围校验、版本遥测、熔断和通道 C 降级；错误日志不得包含响应正文。
- GPL 项目仅作行为交叉验证，不复制其代码；实现依据观察到的 HTTP 合同和本仓测试独立编写。

本机没有 MiniMax Key，因此结论是 **OSS 合同可行 / 真实 E2E deferred**。该来源映射 `kind=quota`、5h/weekly 两张 metric 卡，不得映射为 `balance`。

### xAI（Management API，不是普通推理 API）

| 项 | 记录 |
| --- | --- |
| 文档 | https://docs.x.ai/developers/rest-api-reference/management/billing |
| 方法/路径 | `GET https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance` |
| 鉴权 | 独立的 Management API Key + team ID；不能假设普通推理 Key 可用 |
| 映射 | xAI API 预付余额 → `kind=balance`；Grok 消费级订阅仍是另一张 Subscription |
| 结论 | **官方合同 GO / 凭据 deferred**；实现前确认 Management Key 权限面和安全接受度 |

### #7 验收结论

- [x] DeepSeek 使用现有凭据完成真实只读 E2E
- [x] Kimi 使用现有凭据验证出 Coding Plan Key 与 Open Platform Key 不兼容
- [x] MiniMax 现金余额与 Coding Plan 配额拆模
- [x] xAI Management API 与普通推理 API Key 拆模
- [x] 未输出或入库真实 Key、余额和账户标识
- [ ] Kimi、MiniMax、xAI 待兼容真实凭据后补充 E2E

---

## #8 Codex / Claude Code（Windows）

### 可复现探针

```powershell
# Claude：发送一次最小请求；仅输出认证/字段存在性，不输出实际配额或响应
.\scripts\m0-probe-claude-rate-limits.ps1

# Codex：临时运行官方 CLI；只读 App Server，输出字段类型/范围布尔值
node .\scripts\m0-probe-codex-app-server.mjs cmd.exe /d /s /c npx --yes @openai/codex app-server
```

探针不读取或打印 email、token、会话正文、余额、百分比、reset timestamp、token 数量；Claude 临时设置和捕获文件在验证后删除，Codex 不写项目依赖。

### Claude Code

官方 status line 文档（https://code.claude.com/docs/en/statusline）提供结构化 JSON：

- `rate_limits.five_hour.used_percentage` / `resets_at`
- `rate_limits.seven_day.used_percentage` / `resets_at`
- `rate_limits` 只对 Claude.ai Pro/Max 订阅者在首个 API 响应后出现；两个窗口可分别缺失。

这比解析 `/usage` 文本或会话 transcript 稳定且更符合隐私边界。collector 只能读取上述白名单字段，不能上传 status line 输入中的 `session_id`、`transcript_path`、workspace、模型、成本或上下文内容。

本机结果：Claude Code `2.1.150` 可用，`claude auth status` 表示 OAuth 已登录，但最小真实请求仍被认证拒绝，status line 捕获未触发。因此本轮是 **官方合同 GO / 本机 E2E deferred**，不是 no-go。下一次由用户重新登录/更新 CLI 后重跑探针；实现以字段存在性为能力门控，不猜测最低版本。

### Codex

官方 App Server 文档（https://learn.chatgpt.com/docs/app-server）提供：

- `account/rateLimits/read`：单桶与 `rateLimitsByLimitId` 多桶；每个窗口含 `usedPercent`、`windowDurationMins`、`resetsAt`。
- `account/usage/read`：token activity `summary` 与可选 `dailyUsageBuckets`。

本轮通过临时官方 `@openai/codex` CLI 完成真实 E2E：初始化成功；两个只读请求均成功；窗口百分比、周期和重置时间类型/范围通过；summary 与 daily bucket schema 通过。探针只输出布尔验证结果。

官方当前仍把 `codex app-server` 命令标为 experimental/unsupported for production，因此结论是 **E2E GO，但只能作为版本门控的本地 collector**：启动失败、方法缺失、schema 漂移或未认证时降级为 unavailable + 通道 C，不能让采集失败影响业务 Session 或其他订阅。

### #8 验收结论

- [x] Codex 官方 App Server 完成真实只读 E2E
- [x] Claude 官方结构化 rate-limit 合同确认
- [x] 探针输出经过隐私最小化
- [x] Windows 调用方式与实验性接口风险已记录
- [ ] Claude 待有效 OAuth/兼容版本补真实 E2E

---

## 对里程碑的影响

| 里程碑 | 影响 |
| --- | --- |
| M1 | 无阻塞 |
| M3 | DeepSeek 为首个必做 balance adapter；Kimi/xAI 按官方合同推进但以凭据 E2E 为上线门；MiniMax API 现金余额保持通道 C |
| M4 | Codex 为首个必做 collector；Claude 按官方 status line 合同实现并保留 E2E 门；MiniMax Coding Plan 作为 experimental collector；所有来源均可降级到通道 C |
