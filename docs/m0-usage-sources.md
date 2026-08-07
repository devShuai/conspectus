# M0：用量来源轨（#7 / #8）

> 对应 [conspectus#7](https://github.com/devShuai/conspectus/issues/7)、[conspectus#8](https://github.com/devShuai/conspectus/issues/8)。  
> 结论日期：2026-08-07 · 验证机：Windows（本仓开发机）

## 总表

| 来源 | 账户/订阅 | 结论 | M3/M4 处置 |
| --- | --- | --- | --- |
| DeepSeek 余额 API | **本机无 API Key / 未确认余额账户** | **deferred**（接口文档存在，待有 Key 再实调） | M3：有 Key 后 adapter；否则通道 C |
| Kimi / Moonshot | 无账户 | **deferred** | 通道 C 或后续开户 issue |
| MiniMax | 无账户 | **deferred** | 同上 |
| xAI API | 未确认 API 平台账户 | **deferred**（形态未确认；若仅 Grok 会员 → 通道 C） | 见下 |
| Claude Code 本地用量 | CLI 已安装；**无稳定公开只读用量命令/文件** | **degraded / 倾向 no-go for auto** | M4 默认通道 C；若上游暴露结构化用量再开 collector |
| Codex 本地用量 | **本机未安装 codex CLI** | **deferred** | 有订阅+CLI 后再验；否则通道 C |

**用量来源轨对 M0 的收敛结论**：不阻塞 M1；**M3/M4 不得假设四平台余额与双 collector 开箱可用**；主路径为手动录入 + 按账户到位逐个加 adapter/collector。

---

## #7 四平台余额 API

### 账户可得性（前置表）

| 平台 | 是否已有账户 | 是否已有余额 | 决定 |
| --- | --- | --- | --- |
| DeepSeek | 未在本环境配置 Key | 未知 | **deferred**（文档调查完成） |
| Kimi | 否 | — | **deferred** |
| MiniMax | 否 | — | **deferred** |
| xAI API | 未确认形态 | — | **deferred** |

未为凑齐四个平台开户充值（符合 issue 非目标）。

### DeepSeek（文档调查 · 2026-08-07）

| 项 | 记录 |
| --- | --- |
| 文档 | https://api-docs.deepseek.com/api/get-user-balance |
| 方法/路径 | `GET https://api.deepseek.com/user/balance` |
| 鉴权 | `Authorization: Bearer <API_KEY>`（与 chat 同 Key；未见独立只读 Key 说明） |
| 成功 schema | `is_available: boolean`；`balance_infos[]`：`currency`∈{CNY,USD}，`total_balance`/`granted_balance`/`topped_up_balance` 为 **string** |
| 映射 `UsageReading` | `kind=balance`，`remainingValue=total_balance`（十进制定点字符串），`unit=currency` |
| 边界 | 未实调：401/429/零余额待有 Key 后补 |
| 条款 | 仅只读 GET；避免高频轮询，建议 ≥1h + 退避（与 design 同步任务一致） |
| 结论 | 接口设计 **适合** M3 adapter；本环境 **deferred** 实调 |

### Kimi / MiniMax / xAI

- 未持有账户 → 不进入实调矩阵。  
- xAI：**未确认**是 API 平台还是仅 Grok 消费级订阅；按 design §7.4 二者不可合并。若仅会员套餐 → **通道 C**，不进 M3 余额 adapter。

### #7 验收勾选

- [x] 账户可得性表已填  
- [x] 四平台均有 deferred/文档结论  
- [x] xAI 形态未确认已单列  
- [x] 无真实 Key/余额写入仓库  

---

## #8 Codex / Claude Code（Windows）

### 订阅/工具可得性

| 平台 | 本机状态 | 决定 |
| --- | --- | --- |
| Claude Code | `claude` CLI 可用（npm 全局） | 调查命令/本地文件 |
| Codex | `codex` 命令 **missing** | **deferred** |

### Claude Code（Windows 调查）

| 项 | 记录 |
| --- | --- |
| OS | Windows 10/11 开发机 |
| CLI | 已安装；`claude --help` 可见 |
| 公开用量子命令 | help 中**无**稳定的 `usage`/`quota`/`billing` 子命令 |
| `~/.claude` | 见 sessions/cache/settings 等；**未发现**官方文档保证的用量状态文件；**未读取**可能含 token 的凭据文件 |
| 合规 | M0 **禁止**解析会话 transcript 或上传对话；collector 若未来实现必须只读结构化用量字段 |
| 结论 | **no-go for M0 auto collector**（无稳定只读结构化来源）；M4 **默认通道 C**；若 Anthropic 后续提供 CLI/本地 JSON 用量视图再开 issue |

### Codex

- 本机未安装 → **deferred**。  
- 跨平台风险（供 M4）：路径分隔、`%USERPROFILE%` vs `$HOME`、命令是否在 PATH、输出编码 CRLF。

### #8 验收勾选

- [x] 订阅/工具可得性确认  
- [x] Claude Code Windows 结论 + OS 标注  
- [x] Codex deferred  
- [x] 未读取 token/对话内容  
- [x] 跨平台风险已记  

---

## 对里程碑的影响

| 里程碑 | 影响 |
| --- | --- |
| M1 | 无阻塞 |
| M3 | 余额 adapter **按平台账户到位再实现**；DeepSeek 优先（文档已清晰）；其余 deferred；手动录入一等公民 |
| M4 | 不以 Codex/Claude Code 自动采集为 V1 必达；框架可先做，collector 插件后补；通道 C 完整 |
