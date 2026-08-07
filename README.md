<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img alt="conspectus 订阅资产" src="docs/assets/logo-light.svg" width="300">
</picture>

# conspectus

**订阅资产管理中心。**

把散落各处的付费订阅——流媒体、云服务、域名、SaaS 工具、AI coding plan——收拢成一张能一眼扫完的清单，回答四个问题：我在订阅什么、花了多少钱、什么时候要付钱、有没有用够本。

conspectus 拉丁本义"一览、总览"。图形：四格总览网格，右上一格砖红填实 —— 一眼扫过所有资产，有一项需要注意。

---

## 状态

🚧 **M0 风险验证阶段。** 最小 Next.js 工程与 certus OIDC + 自有不透明 Session PoC 已完成真实 E2E；尚无可发布的业务功能。

完整设计见 **[docs/design.md](docs/design.md)** —— 产品定位、数据模型、模块详设、里程碑与风险。

设计审阅意见见 **[docs/design-review.md](docs/design-review.md)**（十二轮复审台账；当前实现基线 **v0.5.1**，下一步 **M0**）。

M0 认证 PoC 的复现步骤与安全边界见 **[docs/m0-auth-poc.md](docs/m0-auth-poc.md)**。

## 计划中的能力

| | |
| --- | --- |
| **订阅管理** | 完整生命周期：试用、续费、暂停、取消、涨价追踪 |
| **多币种** | 汇率换算到本位币，金额入库即固化，历史统计不漂移 |
| **用量额度** | 对有配额的订阅追踪"已用 / 额度"，识别浪费与临期不足 |
| **本地采集**（增强） | `conspectus-collect` CLI 读取本机 coding plan 用量并上报 —— 这类套餐没有公开 API，只有本机拿得到。依赖非公开接口，可能随上游升级失效；手动录入与 API 平台自动同步是始终可用的保证路径 |
| **主动提醒** | 到期、试用结束、用量超阈值 —— 邮件与 Webhook 双渠道 |
| **账单导入** | 扣款邮件转发至专属地址，解析为草稿待确认 |
| **数据自主** | CSV 导入导出，随时可迁移、可备份 |
| **PWA** | 可安装到手机主屏；V1 离线只提供静态应用壳，不缓存用户的订阅与金额数据 |

## 技术栈

Next.js 16（App Router）· React 19 · TypeScript · Tailwind CSS v4 · Prisma · PostgreSQL · `openid-client` · 自有不透明数据库会话

登录支持两种模式，由 `AUTH_MODE` 按需开启：接入同家族的 **[certus 统一认证中心](../certus)**（OAuth 2.1 授权码 + PKCE / OIDC，注册与 MFA 全部由它承担），或使用 conspectus 自己的本地账号。正式部署推荐前者。

部署目标是自有服务器（Docker / compose），同时保持 Vercel 托管可用。分钟级通知重试在 Vercel 上需要 Pro Cron 或外部调度器；Hobby 形态只能明确降级为每日调度。

## 里程碑

| 阶段 | 内容 |
| --- | --- |
| **M0** 风险验证 | OIDC + 自有 Session PoC；certus 机器可读 capabilities 契约与真实 E2E；平台余额 API 与本地 collector 可行性验证 |
| **M1** 骨架 | certus OIDC、自有数据库会话、租户约束、订阅 CRUD、周期推算 |
| **M1b** 本地账号 | 本地密码接入同一 Session、找回、验证与账号绑定 |
| **M2** 钱 | 扣费/退款、版本化汇率投影、总览与统计、续费日历、CSV |
| **M3** 提醒 + 用量 | Cron 幂等、通知 outbox、用量模型、API 平台余额适配器 |
| **M4** 本地采集器 | certus 设备授权、设备签名、manifest binding、Codex 与 Claude Code 采集 |
| **M5** PWA + 部署 | 可安装、静态离线壳、移动端布局；Docker 与 Vercel 两套产物 |
| **M6** 导入 | 专属收件地址、邮件解析规则库、草稿确认流 |

## 品牌

| 角色 | 明色底 | 暗色底 |
| --- | --- | --- |
| 骨架 / 字标 | `#14161F` | `#F2F3F7` |
| 强调色 | `#C4553C` | `#E07A5F` |
| 副标文字 | `#6B6E7B` | `#9A9DA8` |

家族成员共用 `#14161F` 深灰骨架：specus 紫罗兰 · certus 琥珀金 · scriptus 青绿 · conspectus 砖红。
