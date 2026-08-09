# conspectus 设计审阅意见

> 针对 [design.md](./design.md) v0.1–**v0.6.0**（2026-08-08）  
> 最近复审：2026-08-08 · 状态：**M0–M6 已全部交付**，全部 issue 已关闭。v0.6.0 完成了一次实现↔文档对账（见 §9n）：补齐 10 条端点、3 张表、`certusSubLegacy` 与 `ReauthTransaction.targetPath` 两个安全修复字段、collector 侧环境变量；上游 [certus#9](https://github.com/devShuai/certus/issues/9) 已实现关闭，仅 [certus#10](https://github.com/devShuai/certus/issues/10) 仍 open

本文把设计评审结论落成可追踪条目，便于改设计稿、拆任务与验收对照。  
**不替代** `design.md`。§3–§6 为**首轮问题台账（历史）**；落地状态以 §9–§9m 与修订记录为准。

---

## 1. 总评（相对 design.md **v0.5.1**）

| 维度 | 评分（/5） | 一句话 |
| --- | --- | --- |
| 产品定位 | 5 | 四个问题 + 用量差异化仍稳；README 能力已分层 |
| 领域模型 | 5 | 权威 Binding、周期历史额度、Digest 与持久退避状态均可落表 |
| 认证与安全 | 5 | 全局停用、certus 关联、临时门禁分层；邮箱地址与验证位成对；所有恢复路径可执行 |
| 架构与部署 | 5 | 状态复核有 single-flight/恢复 runner；deep 探针可验证、受保护、缓存且有限流 |
| 里程碑可执行性 | 5 | M0 明确承接 capabilities 上游契约；M3 明确承接状态端点 email 契约；新约束均有验收或显式降级 |
| 文档工程化 | 5 | README、正文、台账、资产说明与修订记录统一到 v0.5.1 |

**当前结论**：**可以启动 M0**。certus#2–#4 的功能代码已核对；十二轮确认仍有两项需要落实到 certus issue 的上游工作：机器可读 capabilities 是 M0 完整认证 profile 的 go/no-go，状态端点返回 email 是 M3 certus 邮件链路去除过渡启发式的闸门。M1–M4 统一以 **v0.5.1** 与 §12.3 为实现基线，不再使用 v0.5.0 及更早版本。

---

## 2. 值得保留的设计决策

以下结论评审认同，实现时不要轻易推翻：

1. **四个问题 + 用量差异化**（design §1）  
   产品主线清楚；后续模块应继续回答这四个问题，而不是扩成通用财务管理。

2. **非目标**（design §2.2）  
   不做支付网关、不做自动退订、不存完整卡号、不按 email 自动合并、本地模式不做 MFA——每一条都在挡真实事故。

3. **用量先分 `kind` 再谈 UI**（design §7.4）  
   `quota` / `balance` / `counter` 分开建模；多设备「取最新、不求和」；三通道共用 `UsageReading` + `ingest`。

4. **认证与会话边界**（design §7.1）  
   身份以 `sub` 为准；`openid-client` 只处理 OIDC，自有不透明数据库 Session 同时承接 certus 与 local；Back-Channel 可按 `sid` / `sub` 撕会话。

5. **部署形态收敛**（design §5.4）  
   Cron 统一为 Vercel 兼容的带 Bearer GET；环境差异只落到调度器、频率能力和数据库位置，业务服务无 `if (vercel)`。

6. **财务口径**（design §7.3）  
   原币 BillingRecord 不可变，BillingConversion 固化报表投影；退款独立成事件，本位币切换完成后原子生效。

7. **导入不自动入库**（design §7.5）  
   邮件/CSV → `ImportDraft` → 用户确认，防止解析错误污染财务数据。

8. **通知幂等**（design §7.6）  
   NotificationEvent dedupe + 每渠道 NotificationDelivery outbox；内部不丢事件，对外明确 at-least-once。

9. **PWA 私有缓存边界**（design §7.9）  
   V1 只缓存静态壳，认证 HTML/RSC/API 一律 no-store；不以“离线只读”为名把上一用户财务数据留在共享设备。

10. **里程碑依赖**（design §10）  
    M4 采集器只做第三数据源，不另起入库路径。

---

## 3. 文档结构与一致性（首轮台账 · 历史）

> 下列 C* 在 v0.1.1+ 已基本落地；保留便于追溯。最新审计闭环见 §9g。

| ID | 问题 | 建议 |
| --- | --- | --- |
| C1 | V1 目标表 G 编号乱序：G1 → G9 → G10 → G2… | 按 G1–G10 重排；或增加「优先级 / 对应里程碑」列 |
| C2 | 设计目录为 `src/app/...`，与部分脚手架默认根目录 `app/` 不一致 | **锁定 `src/` 布局**，M1 初始化按 design §5.3 执行并写进 README |
| C3 | `AppLogo.tsx` 附录写 `src/components/`，仓库现位于 `design/logo/` | design 注明：设计稿暂存 `design/`，M1 迁入 `src/components/` |
| C4 | README 状态为「设计阶段、应用未初始化」——与当前仓一致 | 代码落地后同步改 README「状态」与里程碑勾选 |
| C5 | §11「待确认」出现两个「4.」 | 改为 4、5 连续编号 |
| C6 | ER 图有 Usage 相关实体，**缺 `CollectorDevice`** | 补 `User \|\|--o{ CollectorDevice` |
| C7 | ER 有 `PaymentMethod`，正文无表结构 | 补最小字段集，或明确标注「M2 细化」并链到 issue |
| C8 | 相对链接 `../../certus/docs/...` 在独立克隆本仓时可能 404 | 写明 monorepo / 兄弟目录假设，或改为可访问的文档地址说明 |
| C9 | 目标表 G6（邮件导入）排序靠前，实际在 M6 | 目标表增加「阶段」列，避免误读为 V1 必达 |

---

## 4. 分域意见

### 4.1 产品与范围

| ID | 意见 | 级别 |
| --- | --- | --- |
| P1 | **M1 过重**：双模式认证 + 绑定/解绑 + 启动自检 + 订阅 CRUD，「2 周」偏紧。design 已提示可先只做 certus——建议正式写入里程碑默认路径。 | P0 |
| P2 | 生产示例（compose / 环境变量）**默认 `AUTH_MODE=certus`**；`local` 用独立 profile，避免默认 `both` 导致安全基线只维护一半（呼应 R8）。 | P0 |
| P3 | 通道 B（CLI）绑非公开接口 + 用户愿装——对外文案应分层：**保证**手动 + 通道 A；**增强**通道 B。避免 README 暗示 Codex/Claude Code「开箱自动」。 | P1 |
| P4 | 多用户严格 `userId` 隔离与「个人工具、不做 RBAC」一致；**不要过早加 org/workspace 字段**（V2 再做）。 | 信息 |
| P5 | Grok 按形态拆成两条 Subscription 的判断正确，待确认项应收到 ADR 或 issue，避免长期挂在文档末尾。 | P2 |

### 4.2 数据模型

| ID | 意见 | 级别 |
| --- | --- | --- |
| D1 | 明确 **`canceled` / `expired` 不计入年化**，仍计入历史实付（`BillingRecord.paid`）。 | P0 |
| D2 | 用户修改 `billingCycle` / `anchorDay` / `startedAt` 时，**Server Action 内同步重算 `nextBillingAt`**，不只依赖日批。 | P0 |
| D3 | **`trial` → `active`/`expired`**：日批与续费任务一并扫描 `trialEndsAt`，避免状态永久停在 trial。 | P0 |
| D4 | **`UsageQuota` 唯一性**：建议 `(subscriptionId, metric)` 或 `(subscriptionId, metric, source)`，防止重复卡片。 | P0 |
| D5 | `autoRenew = false` 时续费任务：**可提醒，不建 `pending` 实付预期**；或建 `projected` 且不进入「本月支出/年化实付」口径——需在 design §7.2 写死一种。 | P0 |
| D6 | `tags text[]`：若支持按 tag 筛，补充 GIN 索引说明。 | P2 |
| D7 | 汇率源不覆盖的币种：拒绝保存或标记 `unconvertible`，禁止静默当 0。 | P1 |
| D8 | `PaymentMethod` 最小字段建议：`id, userId, label, brand?, last4?, type(enum), createdAt`——仍不存完整卡号。 | P1 |
| D9 | `UsageSnapshot.raw` 保留时长未定义：建议 ≤ 邮件原文策略或更短，并支持用户清除。 | P1 |
| D10 | `CREDENTIAL_ENC_KEYS` 轮换：需双钥解密窗口或批量重加密 runbook，避免一换钥全部 connection 作废。 | P1 |

### 4.3 认证、采集与安全

| ID | 意见 | 级别 |
| --- | --- | --- |
| A1 | **缺口：`AUTH_MODE=local`（无 certus）时 CLI 设备码不可用**。须二选一写进 design：① 采集器仅 certus 模式支持；② local 提供 PAT/设备令牌（存储、吊销、限流完整设计）。推荐 V1 选 ①，成本更低。 | P0 |
| A2 | Collect 路径每次 Introspection 可能打满 certus：允许 **introspection 结果短 TTL 缓存**（如 30–60s），文档加一句即可。 | P1 |
| A3 | Webhook 出站：除禁内网 IP 外，补充 **不跟随不安全重定向、DNS rebinding 注意**。 | P1 |
| A4 | 导出全部数据 / 注销账号：已有 `prompt=login`；补充 **注销二次确认文案与冷却**（防 SSO 会话下误触）。 | P2 |
| A5 | R6（certus 单点）已写清；登录页「认证中心不可达」态应在 M1 UI 验收中显式出现。 | P1 |

### 4.4 架构、API 与任务

| ID | 意见 | 级别 |
| --- | --- | --- |
| T1 | 用量同步分片：M3 起 API 即按 `userId % N`（或 cursor）设计，避免 R4 爆发时改契约。 | P1 |
| T2 | 建议增加 `GET /api/health`（或 `/api/ready`）：进程存活 + DB + 可选「自检项是否通过」。 | P1 |
| T3 | 限流实现选型未写：单机 memory 不够双实例/Serverless；需 Redis（或平台级）并写进部署文档。 | P1 |
| T4 | i18n：默认中文 UI + 随 `timezone`/`baseCurrency` 的格式化策略写一句，避免组件内写死。 | P2 |
| T5 | 本位币变更触发的历史重算：异步任务入口、进度、失败重试应在 API/Actions 表占位。 | P1 |

### 4.5 测试与验收

design 仅写 Vitest + Playwright，建议在 M1 起把下列**写成验收清单**（可放 design 附录或 `docs/qa-checklist.md`）：

| 域 | 必测场景 |
| --- | --- |
| 周期 | 月末锚定不漂移；跨年；`custom` days；`lifetime`/`one_time` 无 next |
| 认证 | Back-Channel 撕会话；refresh 失败登出；禁止 email 自动合并；绑定/解绑最后登录方式 409 |
| 用量 | 乱序 `capturedAt` 不覆盖新值；多设备不双计；同快照幂等 |
| 通知 | cron 重跑同一 `dedupeKey` 不重复发送 |
| 导入 | Draft 未确认不出现在 BillingRecord / 实付统计 |
| 部署 | 缺 `CRON_SECRET` / `APP_URL` 不一致时**拒绝启动** |

### 4.6 品牌与前端

| ID | 意见 | 级别 |
| --- | --- | --- |
| U1 | Tailwind theme 纳入 `#14161F` / `#C4553C` / `#E07A5F` 等品牌色，避免临时通用灰阶与家族产品不一致。 | P1 |
| U2 | PWA 192/512 PNG + maskable 已在 design 标明缺口——M5 checklist 单项跟踪。 | P2 |
| U3 | 移动端底部 IA（总览 / 订阅 / 日历 / 用量 / 设置）与 `(app)/` 路由一致，M2 页面成型时不要改信息架构。 | 信息 |

---

## 5. 优先改动清单（落地 design 用）

### P0 — 实现前应写入 `design.md`

1. **M1 默认路径**：主路径仅 `certus`（+ 本地 dev 例外若需要）；`local` 整包标为 M1b 或并入 M5 前；**会话抽象（只认 `session.userId`）M1 必须就位**。  
2. **local-only 与 CLI**：写明采集器仅 certus 可用，或给出完整 PAT 方案（推荐前者）。  
3. **`autoRenew = false` 的续费任务行为**（提醒 vs pending/projected 口径）。  
4. **年化/实付口径**：哪些 `status` 计入年化；trial 到期状态迁移。  
5. **`nextBillingAt` 在订阅字段变更时同步重算**。  
6. **`UsageQuota` 唯一约束**。  
7. **G 编号重排 + 目标↔里程碑映射列**；待确认列表编号修正。  
8. **目录布局锁定 `src/`**；AppLogo 路径说明。

### P1 — M1～M3 实现期补进 design 或 ADR

9. `PaymentMethod` 最小字段；ER 补 `CollectorDevice`。  
10. `CREDENTIAL_ENC_KEYS` 轮换；introspection 短缓存。  
11. 未知币种策略；`raw` 保留策略。  
12. `GET /api/health`；限流与分片契约。  
13. Webhook SSRF 加固要点；certus 不可达登录页。  
14. 对外能力分层文案（README + design §1 或 §4）。  
15. 品牌色进入 design token / Tailwind 说明。

### P2 — 可延后

16. tags GIN；注销冷却文案。  
17. PWA 出图任务。  
18. 待确认项（域名、客户端注册、Grok 形态、公开注册）→ 独立 issue/ADR。  
19. i18n 策略一小节。

---

## 6. 建议的 design.md 补丁提纲

便于直接改稿时对照（段落级，非最终措辞）：

| 位置 | 补丁要点 |
| --- | --- |
| §2.1 目标表 | 重排 G1–G10；列：`阶段(M1…M6)` |
| §5.3 | 文首加粗：仓库采用 `src/`；`design/logo` 为设计暂存 |
| §6.1 ER | 增加 CollectorDevice |
| §6.2 Subscription | 状态与年化/列表可见性规则；trial 迁移 |
| §6.2 UsageQuota | UNIQUE；kind 与告警交叉引用 §7.4 |
| §6.2 PaymentMethod | 新小节最小字段 或 「见 M2」 |
| §7.2 | 字段变更重算；`autoRenew` 与 pending 账单；trial 扫描 |
| §7.4 末 | 「采集器与 AUTH_MODE」：local 不可用设备码时的产品行为 |
| §7.6 / §9 | Webhook 出站限制细节；Snapshot.raw TTL |
| §8 | `GET /api/health`；币种重算任务占位 |
| §10 M1 | 拆默认范围 vs 可选 local；验收标准对齐本文 §4.5 |
| §11 | 编号修复；A1/D5 等风险可并入表或「评审增补」 |
| §12.3 | 示例默认 `AUTH_MODE=certus`；注释 local profile |

---

## 7. 与仓库现状

| 项 | 状态 |
| --- | --- |
| 应用代码 | 未初始化（与 README 一致） |
| 设计正文 | `docs/design.md` |
| 品牌资产 | `docs/assets/*`、`public/favicon*.svg`、`public/logo.svg` |
| Logo 组件稿 | `design/logo/AppLogo.tsx`（待迁 `src/components`） |
| PWA PNG | 缺口，见 design §7.9 |

评审不要求先写完整业务代码。**v0.5.1：先 M0**；除既有 OIDC/设备码/用量来源 E2E 外，先登记并落 certus 机器可读 capabilities 契约，同时登记状态端点 email 契约。M1 schema 按正文含身份三层状态、状态同步租约、邮箱过渡快照字段、Vendor 触发器、ReauthTransaction、BackchannelLogoutReplay；M2 含 rebase 与 trial 首账；M3 含权威 Binding、持久退避、NotificationArmState、Digest 与可恢复延迟状态，并按上游 email 能力决定完整或降级验收。

---

## 8. 后续动作（建议）

| 顺序 | 动作 | 负责人（占位） |
| --- | --- | --- |
| 1 | 执行 design §10 的 M0：先登记 certus capabilities 与状态端点 email 两个 issue；完成 OIDC/设备码/跨客户端内省/状态/邮箱真实 E2E及第三方用量可行性 | — |
| 2 | M0 结论 + §11 待确认 → ADR / issue | — |
| 3 | M1：Prisma/SQL 含组合外键、身份状态分层与恢复租约、邮箱快照、Vendor 触发器、Session、ReauthTransaction、BackchannelLogoutReplay | — |
| 4 | 按 M0 go/no-go 与 v0.5.1 验收清单建 M1–M4 任务板 | — |

---

## 9. 二轮复审与落地（v0.2）

二轮复审发现首轮“P0 已全部落地”的结论遗漏了依赖库与平台真实约束。以下问题现已写入主设计，不再作为实现阶段临时决定：

| ID | 二轮问题 | v0.2 落地结果 |
| --- | --- | --- |
| R2-AUTH | Auth.js Credentials 只能使用 JWT session，与 Back-Channel 要求的可删除数据库会话冲突；默认 Prisma Adapter 的 email 唯一模型也不适用 | 改为 `openid-client` + 自有不透明数据库 Session；certus/local 统一 `createAppSession()` |
| R2-CRON | Vercel Cron 固定发 GET，原设计统一 POST 无法运行 | `/api/cron/*` 统一 GET + Bearer + no-store，并增加锁、业务唯一键和可重入游标 |
| R2-USAGE | `UsageReading` 无法定位用户的具体订阅/Quota，JS number 也不适合余额 | manifest 下发 `bindingId`；reading 使用十进制定点字符串并按 user+binding 复核 |
| R2-DEVICE | 设备 grant 名错误，consent 无法实现单设备撤销 | 使用完整 RFC 8628 URN；设备注册签名公钥，token + 请求签名双校验，区分单设备撤销与全客户端 consent 撤销 |
| R2-TENANT | 独立 userId/FK 不能阻止跨租户父子引用 | 所有 tenant 表携带 userId，核心关系使用组合租户外键；Action 固定 `requireUser()` |
| R2-MONEY | 异步 rebase 会混合币种，`refunded` 状态无法表达退款日期和部分退款 | 原币记录不可变；增加 BillingConversion；退款独立记录并指向原扣费 |
| R2-NOTIFY | 单一 NotificationLog 无法兼顾多渠道、重试、崩溃恢复和本地 09:00 | Event/Delivery outbox + Delivery UTC scheduledAt + 分钟 dispatcher；v0.3.0 再补 Digest；明确 Vercel 计划限制 |
| R2-PWA | 缓存认证页面可能在退出/换号后泄露上一用户数据 | V1 只缓存静态壳，私有响应 `private, no-store`，私有离线保险箱延期 |
| R2-READY | discovery 无法验证客户端登记回调，Vercel 也没有单一启动钩子 | 冷启动格式校验 + `/api/ready` + 部署清单/真实登录 smoke test 分层 |

## 9b. 三轮复审与落地（v0.2.1）

三轮复审聚焦 v0.2 新机制之间的**接缝**——新部件各自成立，但互相咬合处有 9 个未定义行为，均已落地 design.md v0.2.1：

| ID | 三轮问题 | v0.2.1 落地结果 |
| --- | --- | --- |
| R3-CONV | `pending` 入库即固化 BillingConversion，但建档日汇率 ≠ 实际扣费日汇率，转 paid 时"预计"与"实付"会跳变 | 投影只为已成立事实（paid/refund）按 `billedAt` 汇率生成；pending 保持实时估算口径 |
| R3-PAUSE | `paused → active` 恢复语义未定义，恢复会把暂停期追成一串 pending | 恢复不补账：`nextBillingAt` 推到下一个未来账期；24 期追补只服务于任务停摆 |
| R3-QCONN | `UsageQuota.connectionId` 与 `UsageBinding.connectionId` 两处真相 | 删除 Quota 上的冗余外键，数据源关联只经 Binding；ER 图 `feeds` 边同步改指 Binding |
| R3-SRC | Quota.source"当前权威来源"的切换规则未定义 | 初版规定切换时机；v0.3.0 进一步移除模糊 source，改为具体 `authoritativeBindingId` 并从目标快照重建（§9g） |
| R3-CHAN | NotificationChannel 表结构始终未定义（webhook secret、验证状态无处落） | 补最小字段集：secretCipher 加密存储可轮换、webhook 保存时验证性 POST、本地未验证邮箱不能启用 email 渠道 |
| R3-SUSP | `User.suspended` 期间后台行为未定义（还发通知/同步吗） | 停止一切出站：不投递、不同步、拒绝上报；数据保留 |
| R3-CLIREG | `conspectus-cli` 只有文字描述无注册 JSON；`usage:write` 需在 certus 登记未写明 | 补注册 JSON；明确网页客户端不申请 `usage:write` 的隔离理由 |
| R3-STALE | 多设备段落只写 `usedValue`，balance 读数措辞遗漏 | 改为"当前值（usedValue / remainingValue）对比 `valueCapturedAt`" |
| R3-DIAG | 通道 A 同步时序图未反映 binding 校验步骤，图文不同步 | 图中补"逐条校验 bindingId 归属该 connection"，返回类型改 ProviderUsageReading[] |

**三轮结论**：无新增 P0。v0.2.1 可作为 M0 开工基线；累计仍未落地项不变（P5/待确认转 issue、T4 i18n、A4 注销冷却、D6 tags GIN）。

## 9c. 四轮复审（v0.2.1 全文再读 · 2026-08-07）

在三轮接缝已写入正文的前提下，对 v0.2.1 做**独立再读**（不依赖「已落地」声明）。结论：历史 P0 在正文中**可核对存在**；新发现如下。

### 已核对：首轮 P0 在正文中的落点

| 原 P0 | design.md 落点（抽样） |
| --- | --- |
| M1 / M1b 拆分 | §10 M1 仅 certus；M1b 可漂移；G1 阶段列 |
| local × CLI | §7.4「与 AUTH_MODE 的关系」：仅 certus 身份可用通道 B |
| autoRenew=false | §7.2：只提醒、不建 pending，到期 → expired |
| 年化 / trial | §7.2 + §7.8：年化仅 trial+active；trialEndsAt 任务迁移 |
| nextBillingAt 重算 | §7.2：字段变更同 Action 同步重算 |
| UsageQuota UNIQUE | §6.2：`(subscriptionId, metric)` + kind CHECK |
| G 表 / src 布局 | §2.1 阶段列；§5.3 锁定 src/ |
| pending 不投影 | §6.2 BillingConversion + §7.3 |
| paused 不补账 | §7.2 |
| Quota 只经 Binding | §6.2；ER feeds → Binding |

### 本轮新发现

| ID | 级别 | 问题 | 建议 |
| --- | --- | --- | --- |
| **R4-VENDOR** | **M1 前补文档** | §6.2 要求租户组合外键，并写「订阅只能引用系统 Vendor 或自己的私有 Vendor」。系统 Vendor 的 `userId IS NULL`，**无法**用 `Subscription(userId, vendorId) → Vendor(userId, id)` 一条组合外键表达。 | 在 §6.2 Vendor/Subscription 下写死实现策略，三选一或组合：① 应用层校验 + 触发器 `vendor.userId IS NULL OR vendor.userId = subscription.userId`；② 禁止对 Vendor 使用与 PaymentMethod 同构的组合 FK，单列 `vendorId` + CHECK/触发器；③ 系统目录复制为 per-tenant 只读行（一般不推荐）。并列入 §12.3 租户验收。 |
| R4-RULE | P1 · M3 | `NotificationRule` 在 §6.2 仍「见 §7.6」，§7.6 有 type/触发时机与 Channel/Event/Delivery，**缺 Rule 表字段**（scope 全局 vs 单订阅、config jsonb、enabled、默认规则是否 seed）。 | M3 前补最小字段：`id, userId, type, config jsonb, subscriptionId?, enabled, createdAt` + 与 Event 的 ruleId 外键。 |
| R4-BIND | P1 · M3 | Binding 结构完整，但**生命周期**偏隐含：`connectProvider` / 创建 Quota / manifest 首次拉取时谁 `INSERT UsageBinding`？撤销 connection 是否级联 `revoked`？ | 在 §7.4 加一小段「Binding 生命周期」：创建时机、sourceKey 约定、撤销级联、与 `source` 权威回退的次序。 |
| R4-DIR | P2 | §5.3 目录树未列 `/api/health`、`/api/ready`（§8 已有）。 | 目录树补两行，避免实现漏注册。 |
| R4-COUNTER | P2 | §7.4 称三种计量，对比表只列 quota/balance，counter 仅正文一句。 | 表中加 counter 一行，与 §6.2 CHECK 对齐。 |
| R4-DRAFT | P2 | `acceptDraft` → `paid` 时写 `BillingConversion` 主要靠「paid 入账事务内投影」推论。 | §7.5 确认步显式写：与 `recordPayment` 同一投影路径。 |
| R4-SCOPE | M0 | `usage:write` 为 certus 自定义 scope，依赖对方是否支持登记。 | 写入 M0 ADR 检查项；不可用则改 scope 方案或延后 M4。 |
| R4-TRIAL-UI | P2 | 年化含 `trial`：试用免费但已填正价时，总览年化可能偏「恐吓」。 | 不改口径；UI 标注「试用中 · 按转正价格估算」即可。 |

### 仍未落地（与三轮相同，不挡 M0）

- P5 / §11 待确认 → issue/ADR  
- T4 i18n 专节  
- A4 注销冷却文案  
- D6 tags GIN（若做 tag 筛选再补）

### 四轮结论

| 判断 | 说明 |
| --- | --- |
| 能否开 M0 | **能。** 不依赖 R4-VENDOR。 |
| 能否开 M1 schema | **建议先花半页写清 R4-VENDOR**，否则「组合外键」验收与 Vendor 模型会打架。 |
| 能否开 M3 | 建议先补 R4-RULE、R4-BIND（可与 M3 设计尖刺同一 PR）。 |
| 是否新增大阻断 P0 | **否。** R4-VENDOR 是实现前必须消歧的模型边角，不是产品方向错误。 |

## 9d. 五轮复审（执行者审计 · 2026-08-07）

四轮把模型接缝基本扫完，本轮换一个角度：**逐条核对设计里的每个承诺是否有执行者**（任务、端点、队列），并复核四轮台账未覆盖的角落。结果：3 项 P0，性质相同——机制承诺了，执行者没设计。

### P0 — 对应里程碑开工前写入 design.md

| ID | 级别 | 问题 | 建议 |
| --- | --- | --- | --- |
| **R5-PURGE** | P0 · 文档先行 | **保留策略没有执行者。** 全文 8 处 TTL/清理承诺——过期 Session（M1）、PasswordResetToken（M1b）、终态 NotificationDelivery 与 UsageSnapshot 180 天 / `raw` 30 天置空（M3）、设备签名一次性 nonce（M4）、ImportDraft `expiresAt` 与 InboundEmail 原文 30 天（M6）——§5.2 任务清单、§8 端点表、§5.3 目录中没有任何清理任务。§9 对邮件原文的 30 天承诺没有机制兑现，等于合规口径说谎。 | 新增 `GET /api/cron/purge`（每日），逐项列出清理对象与条件；nonce 表随之建模；同步 §5.2 Jobs、§8 表、§12.3 验收（清理幂等、不误删未到期行）。 |
| **R5-FXREADY** | P0 · M2 | **R3-CONV 把投影收进"入账事务内按 billedAt 当日汇率"，但汇率并非随时可用**：① 当日账当日记——ECB 约 CET 16:00 才发布当日 fix，06:00 UTC 批次恒为 T-1；② 新币种首日，批次尚未抓过该币种对；③ 补录历史账单，billedAt 早于 fx 任务上线；④ billedAt 落在周末/假日，当日本无 fix。且事务内不能含外呼 HTTP。 | §7.3 写明：`fxDate` 取 **≤ billedAt 的最近可得日期**；入账前先让汇率就绪——ExchangeRate 缺失时在事务外按需抓取（frankfurter 支持历史日期）并落表，再开写事务；抓不到则账单照存、投影入待补集合由 fx 任务补齐、UI 标记"待换算"。并注明 06:00 批次的 T-1 语义（或改 15:00 UTC）。 |
| **R5-REBASE** | P0 · M2 | **rebaseCurrency 有入口无执行者。** §8 声明"异步重算入口，含进度查询与失败重试"，§7.3 说"异步生成"，但没有任何 cron/队列消费者；Serverless 下不可能在 Action 内跑完全量历史投影。 | 指明执行路径：新增分片 cron（如 `/api/cron/rebase`）或 DB 队列表由分钟级 dispatcher 顺带轮询；进度与失败状态落库（可复用 outbox 思路）。 |

### P1 / M0 补充

| ID | 级别 | 问题 | 建议 |
| --- | --- | --- | --- |
| R5-CERTUSCAP | M0（扩 R4-SCOPE） | R4-SCOPE 只把 `usage:write` 登记写进 M0 检查项；M4 的认证链还有两个未验证前提：**certus 设备码流程端到端可用**、**conspectus 机密客户端可 introspect `conspectus-cli` 的令牌**（跨客户端 introspection 属 certus 侧授权策略，RFC 7662 不保证）。任一不成立 M4 改道。 | M0 增列"certus 能力清单"：设备码 E2E + 跨客户端 introspection + 自定义 scope 登记，一次验完；§12.3 M0 行同步。 |
| R5-CHANDEST | P1 · M3 | R3-CHAN 的"email 渠道复用账户邮箱"与"`destination` 是收件地址"并存成两处真相：destination 若复制账户邮箱，certus 用户改邮箱后渠道地址漂移（User.email 快照每次登录刷新，channel 行不刷）——正是 R3-QCONN 消除的那类问题。 | 写明 email 渠道投递时读 `User.email`，destination 仅 webhook 使用（或改为可自定义收件地址并删掉"复用"表述）；`verifiedAt` 同样派生不复制。 |
| R5-LOCALEP | P1 · M1b | 本地账号的注册、找回密码、邮箱验证端点在 §5.3 与 §8 均不存在，M1b 范围却包含它们。 | 写明形态（Route Handler 或 Server Action）并列进 §8 表。 |
| R5-RPLOGOUT | P1 · M1 | "退出所有系统"需要本站发起端（带 `id_token_hint` 跳 certus `/oauth2/logout`），§8 只有撕本站会话的 `/api/auth/logout`。 | 补端点或注明由 Action 发起跳转；与 `/logout/done` 页对齐。 |
| R5-SUSPSESS | P1 · M1b | R3-SUSP 只定义了 suspended 停止出站，未定义现有会话与登录行为。 | 写死：suspend 即撤销现有会话、拒绝新登录（certus 侧禁用已有 backchannel 覆盖，local 管理操作需等价动作）。 |

### P2 — 细节

- §9 承诺"一键导出全部数据（CSV/JSON）"，§8 仅 `format=csv`——对齐其一。
- CSV 导入冲突判定键未定义：skip/update/duplicate 按什么匹配已有订阅（建议 `name+vendor` 或显式 id 列）。
- Vercel Hobby 除每日频率外另有 cron 任务数量上限（历史为 2 个，以当时计划为准）；端点已 4+ 且本轮再加 2——建议合并单入口表驱动分发或要求外部调度，并入 R10。
- 部分唯一索引、coalesce 表达式索引、按 kind 的条件 CHECK 超出 Prisma schema 表达力，需手写 SQL migration——§6 注明并纳入 §12.3 验收。
- 设备签名 5 分钟时间窗下，用户机器时钟偏移会导致莫名上报失败——collector 需检测 skew 并明确报错。
- 设备注册仅凭 certus token：被盗 token 可注册新设备写入伪造用量（可发现、可撤销）——记录为已接受风险，或要求网页端预授权设备。
- §12.4 缺 Resend 发件身份（`EMAIL_FROM`）与入站域名配置。
- 租户外键规则示例补 `UsageBinding(userId, connectionId) → ProviderConnection(userId, id)`；§9 加密 envelope 列表补 webhook `secretCipher`。

### 五轮结论

| 判断 | 说明 |
| --- | --- |
| 能否开 M0 | **能。** 建议带上 R5-CERTUSCAP 三项检查（与 R4-SCOPE 合并执行）。 |
| P0 性质 | 均为"承诺无执行者"，不涉及产品方向；落地为 v0.2.2 后 M2/M3 无文档级障碍。 |
| 未落地累计 | **四轮 R4-\* 与本轮 R5-\* 已于 v0.2.2 全部落地。** 仅剩历史延期项：P5/待确认转 issue、T4 i18n、A4 注销冷却、D6 tags GIN。 |

## 9e. 六轮复审（通知系统审计 · 2026-08-07）

前五轮分别扫过：模型接缝（三轮）、全文再读（四轮）、执行者审计（五轮）。本轮对 v0.2.2 做独立全文核对，重点落在**唯一没被正面审过的模块——通知系统**（前几轮只审了它的 outbox 与投递可靠性，没审"事件何时该再次发生"）。

### 已核对：四/五轮意见在正文的落点

| 承诺 | design.md 落点 | 核对结果 |
| --- | --- | --- |
| R5-PURGE | §5.4 保留清理段 + §8 `/api/cron/purge` + §5.2 C5 + §12.3 | 六处清理对象逐项列出，比建议更具体 ✅ |
| R5-FXREADY | §7.3 汇率就绪 + §6.2 BillingConversion | 事务外抓取、T-1 语义、待补投影齐备 ✅ |
| R5-REBASE | §6.2 CurrencyRebaseJob + §8 `/api/cron/rebase` + §5.2 C6 | 队列表带进度字段，执行者明确 ✅ |
| R4-VENDOR | §6.2 Vendor + 租户外键规则的"唯一例外" | 触发器方案 + 验收项 ✅ |
| R4-RULE / R4-BIND | §7.6 Rule 字段 + §7.4 Binding 生命周期 | ✅ |
| R5-CERTUSCAP | §10 M0 + §12.3 M0 行 | 三项能力一次验完 ✅ |
| R5-CHANDEST / LOCALEP / RPLOGOUT / SUSPSESS | §7.6 渠道模型、§8 端点表、§6.2 User.status | ✅（但 CHANDEST 与 SUSPSESS 各留下一个新缺口，见下） |

### 本轮新发现

| ID | 级别 | 问题 | 落地结果（v0.2.3） |
| --- | --- | --- | --- |
| **R6-DEDUPE** | **P0 · M3** | 全文只给了 `renewal:2026-08-14:d7` 一个 dedupeKey 例子，其余 6 种 rule type 未定义。这不只是"缺文档"——朴素取值会**永久静默**：`usage_threshold` 若用 `usage:80`，第二个周期再超 80% 会撞上一周期的唯一键；`balance_low` 连周期都没有，一辈子只提醒一次；`connection_failed` 反过来会每轮重试各发一条。少收通知没人会发现，比重复打扰更伤 G5。 | §7.6 增逐类型 dedupeKey 表 + 恢复告警资格依据；新增 `UsageQuota.balanceLowSince`（迟滞 ×1.1 清零）与 `ProviderConnection.failedSince` 两个字段，专为"无自然周期"的两类告警提供恢复告警资格的状态依据；§12.3 通知行加跨周期恢复告警资格用例。**注**：两个 since 字段在 v0.2.4 被 R7-ARM 的 `NotificationArmState` 取代（见 §9f） |
| **R6-SUSPGAP** | P1 · M1 | R5-SUSPSESS 定义了 suspended 的后果，没定义**谁写入**。certus 用户的两条信号都不能用：Back-Channel 的 logout_token 分不出"登出"与"禁用"，误判会把正常登出当禁用；而身份复核依赖活跃会话——**一个被禁用且当时无会话的用户，conspectus 无从得知，会继续发提醒、继续同步用量**。"停止一切出站"成了没有触发器的空话。 | §6.2 写明写入者（仅身份复核明确 inactive 时置位，Back-Channel 不置）；把"无活跃会话则无从得知"作为已知边界写进运维预期，并说明这不是加个任务能补的（机密客户端只能内省令牌，不能查任意用户）；§11 待确认新增第 6 条：是否向 certus 提"接入系统查询用户状态"的跨仓库需求 |
| **R6-VERIFY** | P1 · M3 | R5-CHANDEST 让 email 渠道**投递时实时读** `User.email` 以防地址漂移，但验证状态仍写作"certus 用户认 ID Token 的 `email_verified`"——投递发生在 cron 里，没有 ID Token 可读；`User.emailVerifiedAt` 又被标注"仅本地账号使用"。地址实时、验证位不实时，等于只堵了一半：certus 用户把邮箱改成未验证地址后，快照会刷进来，渠道照发。 | `emailVerifiedAt` 改为两种模式都维护（certus 用户按登录时 `email_verified` 刷新/置空）；dispatcher 发送前检查，为空则 Delivery 置 `blocked` 并站内提示，不发不重试。v0.2.6 补充：certus 当前缺少该 Claim，已登记 [certus#1](https://github.com/devShuai/certus/issues/1)，缺失时按未验证处理 |
| R6-ASYM | P2 | local 侧端点在模式关闭时 404，certus 侧没有对称规定——`AUTH_MODE=local` 时 `/api/auth/certus/*` 与 backchannel 仍可达。 | §7.1 模式 B 补反向 404 |
| R6-DELACC | P2 | §9 承诺"注销账号并级联硬删除"、§7.1 把它列为敏感操作，但 Server Actions 清单里没有它，级联策略也未定义（约 15 张表靠应用代码逐表删，漏一张就是孤儿数据）。 | §8 补 `deleteAccount` 及 `revokeDevice` / `bindCertus` / `unbindCertus` 等遗漏 Action；明确 `ON DELETE CASCADE` 由 schema 承担、需重认证与二次确认、certus 账号不受影响 |
| R6-IDLE | P2 | 闲置识别要"连续 3 个周期"，但 `UsageSnapshot` 只留 180 天；`resetCycle=billing_cycle` 的年付订阅要跨 3 年，靠快照永远凑不齐。 | §7.4 用量洞察写明判据取自周期收尾汇总，不依赖逐条快照 |
| R6-TZ | P2 | "夏令时只解释一次"已写，用户主动改时区是同类情形但未提。 | §7.6 合并表述为"时区解释只在事件创建时发生一次"，并说明取舍 |

### 六轮结论

| 判断 | 说明 |
| --- | --- |
| 四/五轮落地质量 | **扎实。** 抽查的每条承诺都能在正文定位，且多处比建议更具体（如 purge 逐项列清理对象、fx 的 T-1 语义）。 |
| 新增 P0 | 1 条（R6-DEDUPE），限于 M3 通知模块，不影响 M0/M1/M2 开工。 |
| 能否开 M0 | **能，且本轮无任何新增 M0 前置。** |
| 模式观察 | 三条主要发现全部来自"上一轮修复引入的新接缝"（CHANDEST → VERIFY、SUSPSESS → SUSPGAP、outbox → DEDUPE）。修复引入新缺口是正常的，但也说明**通知模块该在 M3 开工前单独过一遍**，而不是继续靠通用复审顺带扫。 |

## 9f. 七轮复审（v0.2.3 → v0.2.4 · 2026-08-07）

独立复审结论：**可开 M0，但不宜把 v0.2.3 当 M1–M4 无条件基线。** 对照 certus OAuth（`invalid_grant` 含过期/重放/授权失效）与正文接缝，发现并已写入 v0.2.4：

| ID | 级别 | 问题 | v0.2.4 落地 |
| --- | --- | --- | --- |
| **R7-SUSP-TOKEN** | **P0** | 将 `invalid_grant`/`inactive` 写 `User.suspended` 会把令牌过期/轮换重放/会话撤销误判为账号停用，`both` 下封锁本地登录 | 令牌失败**只撕 certus Session**；suspended 仅权威状态 API/管理操作；§7.1 同步 |
| R7-REBASE | P1 · M2 | rebase 与新 paid 无串行，可切币种时缺投影 | 每用户一活动任务 + 用户级锁；切换前缺失数=0；统计 `incomplete` |
| R7-REFUND | P1 · M2 | `originalRecordId` 缺同用户/订阅/币种/charge 约束 | CHECK/触发器 + 上限只计 paid refund |
| R7-REAUTH | P1 · M1 | 一次性 re-auth 无 consumed 状态 | `ReauthTransaction` + CAS 消费 |
| R7-DEV-BIND | P1 · M4 | 撤设备却 revoke 共享 local binding | 撤设备只废公钥；binding 按 collector 不按 device |
| R7-ARM | P1 · M3 | `balanceLowSince` 单字段无法服务多规则/多阈值 | `NotificationArmState(ruleId, subject*)`；去掉 quota/connection 上的 since 字段 |
| R7-RULE-CH | P2 | 概念「条件+渠道」与模型广播不一致 | V1 明确全渠道广播；概念表改文案 |
| R7-SUB-SESS | P2 | sub 回退登出可能删 local Session | 仅删 `authMethod=certus` |
| R7-BASELINE | P2 | README/台账仍写 v0.2.1 | 文首与 §1 对齐 v0.2.4 |

**七轮结论**：M0 无新增前置。M1 起必须按 v0.2.4 实现 suspended/reauth；M2 rebase/退款；M3 ArmState；M4 设备≠binding。

## 9g. 八轮复审问题闭环（v0.2.6 → v0.3.0 · 2026-08-07）

对 v0.2.6 做认证、财务/用量和通知执行链复审后，无新增 P0；以下本仓问题已全部写入 v0.3.0。表中“落地”表示设计模型、事务、执行者和 §12.3 验收均已同步，不只是补充描述。

| ID | 级别 | 问题 | v0.3.0 落地 |
| --- | --- | --- | --- |
| R8-REAUTH-SUB | P1 · M1 | 重新认证回调未约束返回 `sub` 必须是原 Session 用户，浏览器切换 certus 账号可替另一用户完成敏感操作 | Reauth 增 `verifiedAt`；回调核对 `sub == User.certusSub`，Action 消费同时匹配 user/session/action |
| R8-USAGE-AUTH | P1 · M3 | Quota 只存来源枚举，不能定位具体 Binding；非权威连接可覆盖当前值，切换后也无法重建 | 增 `authoritativeBindingId`、Snapshot.`bindingId` 与组合外键；所有快照追加，仅权威 binding 原子更新；切换从目标快照重建 |
| R8-TRIAL-FIRST | P1 · M2 | trial 到期分支与非空定价 schema 矛盾，autoRenew=false 冲突，且可能跳过首笔账单 | 明确两个互斥事务分支；autoRenew=false expired 无账，true 先建 `trialEndsAt` occurrence pending 再迁 active/推进 next |
| R8-ARM-CAS | P1 · M3 | 两个扫描 worker 可同时判断“可告警”，状态与 Event/Delivery 也可能部分提交 | 按 rule+subject 事务锁/CAS，状态迁移与 Event/Delivery/Digest 同事务，只有胜出 CAS 能建事件 |
| R8-DISPATCH | P1 · M3 | dispatcher 未重查 User/Channel/Rule，过期 sending lease 和 failed 终态语义不清 | 发送前实时复核；租用 pending 与过期 sending；leaseToken 防迟到回写；pending 表重试、failed 等明确终态 |
| R8-STALE-RUNNER | P1 · M3–M4 | `collector_stale` 有规则但没有任务执行者 | 新增小时级 `/api/cron/notification-scan`，设备从未上报以 createdAt 起算；API、架构和验收同步 |
| R8-SYNC-BACKOFF | P1 · M3 | 6h runner 无法兑现 1h 退避，失败次数/next attempt/lease 也未持久化 | runner 改每小时；Connection 持久化 failureCount/nextSyncAt/leaseToken；1h/4h/12h 后 degraded 日探测，成功/手动重试可恢复 |
| R8-USAGE-CAS | P1 · M3–M4 | 多设备先读后写会让旧读数晚提交覆盖新值，相同 capturedAt 无确定规则 | Snapshot 插入与 Quota 更新同事务，以 `(capturedAt,snapshotId)` 数据库 CAS；重试复用 Snapshot ID |
| R8-USAGE-HISTORY | P1 · M3 | `UsageCycleSummary` 不存历史 limit，套餐变更会改写旧周期利用率 | 固化 limit/unit/authoritative binding 与 `utilizationAtClose`，闲置识别不再拿当前额度回算历史 |
| R8-LOGOUT-CSRF | P1 · M1 | GET 全局登出可被跨站图片/链接触发 | 改 `POST /api/auth/certus/logout` + 会话 + CSRF，完成后 303 到 certus |
| R8-LOCAL-EMAIL | P1 · M1b | 本地邮箱唯一性未定义大小写/规范化，并发可产生逻辑重复账号 | 所有入口统一规范化，DB 使用 `UNIQUE(lower(email)) WHERE passwordHash IS NOT NULL` |
| R8-LOGOUT-JTI | P2 · M1 | Back-Channel `jti` 只写“去重”，没有跨实例存储与清理 | 增 `BackchannelLogoutReplay(issuer,jti,expiresAt)`；插入与删 Session 同事务，purge 到期清理 |
| R8-DIGEST | P2 · M3 | “次日摘要”没有持久模型，Event 单一 scheduledAt 也不能同时表达 Webhook 即时与 Email 摘要 | Event 只存 occurredAt；Delivery 各有 scheduledAt；新增持久化 Digest 批次、租约、终态和聚合发送事务 |
| R8-FX-ENUM | P2 · M2 | `BillingConversion.rateSource=manual` 与正文 `manual_rate` 不一致 | 全文统一为枚举值 `manual` |
| R8-BASELINE | P2 · 文档 | 当前说明仍写 v0.2.4，首轮台账还把 §9c 称作最新未决 | README/正文/台账统一 v0.3.0；历史提示改指向本节 |
| R8-CERTUS-VERIFY | P1 · 外部 | 设计依赖 `email_verified`，certus 当前不签发且 Discovery 不声明 | 已创建 [certus#1](https://github.com/devShuai/certus/issues/1)；M0 验证，修复前 Claim 缺失按未验证阻塞邮件，不伪造 true |

**八轮结论**：本仓无遗留 P0/P1/P2 设计缺口；可以启动 M0。唯一未在本仓关闭的是 certus#1，已有 fail-closed 降级和明确阶段边界。

## 9h. 九轮复审（外部依赖与扫描边界 · 2026-08-07）

对 v0.3.0 做独立全文复核（不依赖“已落地”声明）。**认同八轮"本仓无遗留 P0"的判断**：抽查的每条承诺都能在正文定位，且多处比建议更严谨——purge 已处理 `UsageQuota.valueSnapshotId` 仍引用的当前快照不误删、Reauth 的 verified/consumed 两次 CAS、ingest 的 `(capturedAt, snapshotId)` 确定性 tie-break。本轮 4 项发现均已落地 v0.3.1。

### 本轮新发现

| ID | 级别 | 问题 | v0.3.1 落地 |
| --- | --- | --- | --- |
| **R9-CERTUS1-BLAST** | **P1 · 跨里程碑** | certus#1 的**爆炸半径没画到风险表和里程碑上**。fail-closed 决定本身正确，但推导下去：`AUTH_MODE=certus`（推荐生产形态）下 `email_verified` 恒缺失 → `emailVerifiedAt` 恒空 → **每条 Email Delivery 都 `blocked`**；而 `daily_digest` 只允许 email，摘要功能一并归零。于是 G5 只剩 Webhook 一条腿，M3 交付标准里的"摘要与即时渠道独立调度"在 certus 模式下**根本无法验收**。此前这条依赖只以"M0 验证、缺失按未验证降级"的形式存在于 §7.6 与 §10 M0，风险表 R1–R10 无对应条目，M3 也没写依赖与降级验收路径。 | 新增 **R11**；M3 交付标准写明邮件链路改用 `local` 账号或已修复的 certus 验收，certus 用户 email 端到端显式挂在 certus#1 之后，且不因此判 M3 失败 |
| **R9-SCAN-SCOPE** | P2 · M3–M4（真 bug） | `notification-scan` 未写 subject 状态过滤。`collector_stale` 会对 **已撤销设备** 报警——`revokedAt` 非空的设备 `lastSeenAt` 冻结，N 天后仍满足离线条件，用户刚亲手撤销的设备三天后收到"它离线了"，纯噪音且让人怀疑撤销没生效。`renewal_due` / `trial_ending` 同样未限定订阅状态，暂停期间冻结的过期 `nextBillingAt` 存在误触发面。 | §7.6 扫描执行者段落写死过滤：`renewal_due` 仅 `active`、`trial_ending` 仅 `trial`、`collector_stale` 仅 `revokedAt IS NULL`、`suspended` 用户整体跳过；§12.3 通知行加验收用例 |
| **R9-ARM-TENANT** | P2 · M3 | `NotificationArmState` 主键写作 `(ruleId, subjectType, subjectId)`，与同段正文"维度为 `(userId, ruleId, …)`"自相矛盾，且缺 `(userId, ruleId) → NotificationRule(userId, id)` 组合外键——通知模块成了全文唯一只靠应用层保证租户正确性的地方，与 §6.2"组合外键是数据库底线"的立场不一致。 | 主键补 `userId`，声明组合外键 |
| **R9-BLOCKED-UX** | P2 · M3 | `blocked` 是终态且不补发（这个取舍正确），但**没有对用户可见的解释路径**。邮箱未验证期间的提醒静默消失，验证后也不回补；在 certus#1 场景下等于"整段时间一条通知都没有，且用户不知道为什么"。 | §7.6 写明渠道设置页与通知中心必须在**渠道层面**展示不可投递原因并给出替代路径，而非把状态留在 Delivery 行里等人查；§12.3 加验收 |

### 九轮结论

| 判断 | 说明 |
| --- | --- |
| 八轮落地质量 | **扎实。** 抽查全部可定位，细节处（purge 引用保护、双 CAS、tie-break）比建议更严。 |
| 新增 P0 | **无。** M0 可按原计划启动，本轮无新增 M0 前置。 |
| 本轮性质 | 三条 P2 是模块边界的收尾；唯一 P1 不是"设计写错了"，而是**已知外部阻塞的后果没有传导到风险与里程碑平面** —— 文档把技术决策写对了，却没把它翻译成"M3 那周会发生什么"。 |
| 建议 | certus#1 的优先级应高于其在 M0 清单里的位置：它不只影响一个 Claim，而是决定推荐生产形态下 G5 是否成立。 |

## 9i. certus 能力实测校正（v0.3.1 → v0.3.2 · 2026-08-07）

九轮的 R11 建立在 conspectus 文档的转述之上。**直接读 certus 源码后，发现前提有出入**，据实校正并把三项跨仓库需求登记为 issue。

| 项 | 文档原先的假设 | 代码实测结论 | 处置 |
| --- | --- | --- | --- |
| `email_verified` | certus 尚未签发、Discovery 未声明（certus#1） | **已修复**（`a48460d`，certus#1 已 CLOSED）：`claims_supported` 含该 Claim。但 README 与实现表明**本地注册 / 管理员建号 / LDAP 用户默认且长期为 `false`**，只有联邦到外部 IdP 且上游声明 `true` 才继承 —— certus 自身没有邮箱验证状态机（SMTP 已接入，缺状态机） | **R11 保留但改写病因**：后果（certus 模式下 email 渠道整体 `blocked`）不变，原因从「Claim 缺失」改为「Claim 恒 false」；开 [certus#3](https://github.com/devShuai/certus/issues/3) |
| 跨客户端 introspection | 列为 M0 待验证项，未判定可行性 | **明确不支持**：`oauth.go` 的 introspect 对 access/refresh 两条路径都带 `token.ClientID == registered.ID`，跨客户端一律 `{"active": false}` | **新增 R12**（M4 阻塞级）；开 [certus#2](https://github.com/devShuai/certus/issues/2)，建议在签发方加 `introspectable_by` 显式白名单 |
| `usage:write` 自定义 scope | 列为「依赖 certus 是否支持登记」的风险 | **已支持，无需改动**：`allowed_scopes` 只做模式校验 `^[a-zA-Z0-9._:/-]{1,64}$`，非固定白名单。唯一瑕疵是 Discovery 的 `scopes_supported` 硬编码四项，自定义 scope 不出现在元数据里 | 从风险降级为配置项；M0 清单相应改写 |
| 用户状态查询（待确认 #6） | 「需要 certus 新增能力」，未调研现状 | **已有 80%**：`GET /api/v1/access/users/{userID}` 机密客户端 Basic 认证 + 用户非 active 返回 404，可当探测用；但要求 `allowed_scopes` 含 `roles`（conspectus 明确不请求），且用 404 表达停用是副作用非契约 | 待确认 #6 改写为具体方案；开 [certus#4](https://github.com/devShuai/certus/issues/4)，建议新增专用端点并以「该用户对该客户端有有效 consent」限定查询范围 |
| 设备授权码流程 | M0 待验证 | `internal/platform/http/device.go` 已实现 | 保留在 M0 做端到端实测 |

**教训**：R11 是"照着本仓文档对本仓文档做推理"得出的，前提本身没有回到上游核对。跨仓库依赖的结论必须以**上游代码**为准，不能以本仓对上游的转述为准 —— 转述会随上游演进而过期，而过期的前提会推出看似严谨、实则失效的风险条目。

## 9j. certus 三项能力落地后的设计收敛（v0.3.2 → v0.4.0 · 2026-08-07）

> 本节保留当时结论作历史记录；其中“无能力级未知”和 404→全局 suspended 的判断已被 §9l 的真实状态机推演修正，当前实现只以 v0.5.0 为准。

[certus#2](https://github.com/devShuai/certus/issues/2) / [#3](https://github.com/devShuai/certus/issues/3) / [#4](https://github.com/devShuai/certus/issues/4) 均已实现并关闭（`d9ee9a6` / `59bb582` / `89fcacb`）。**按 §9i 的教训，本次仍以源码核对为准，不依据 issue 状态直接改稿。**

### 实测核对

| 能力 | 实现要点 | 与 conspectus 设计的契合 |
| --- | --- | --- |
| 跨客户端内省 | `Client.IntrospectableBy` + `AllowsIntrospectionBy`；校验被授权者存在/启用/未归档/机密/支持 OAuth、上限 20、不得含签发方自身；独立 migration 与管理界面 | 完全契合。**额外发现**：仅 access token 开放跨客户端内省，refresh token 仍限签发方——这是我未提出但正确的加固，且与 conspectus 用法一致（只内省采集器带上来的 access token） |
| 本地邮箱验证 | 一次性哈希 token、TTL 可配、单活动 token、按当前地址校验、重发双维度限流、注册/管理员建号/改邮箱三处触发、改邮箱重置、管理员手动标记（审计）、账户中心入口 | 完全契合，R11 原病因消失 |
| 状态端点 | `GET /api/v1/clients/me/users/{userID}/status`，机密客户端 Basic + **consent 限定范围** + 限流 + 审计 + `no-store`；返回 `{sub,status,email_verified,updated_at}`；无效 ID / 无 consent / 用户不存在**统一 404**，不留枚举面 | 完全契合，且 `email_verified` 一并返回，解决了"改邮箱要等下次登录才纠正验证位"的旧缺口 |

### v0.4.0 的设计收敛

| 项 | 变化 |
| --- | --- |
| `conspectus-cli` 注册 | 增 `introspectable_by: ["conspectus"]`，并说明没有这一行整条通道 B 断裂 |
| §6.2 `suspended` 写入者 | 从"无权威来源、保持 active"改为**以状态端点为唯一权威**；`status != active` 或 **404**（撤销授权/删除）均停止出站，两者分开记录原因 |
| 复核策略 | **按需 + TTL，不做全量轮询**：`User.lastStatusSyncedAt` 超过 `IDENTITY_STATUS_TTL`（默认 1h）时，在即将出站前（通知投递、用量同步、采集上报）同步一次；只为真正要产生外部动作的用户发请求 |
| 新字段/变量 | `User.lastStatusSyncedAt`；`IDENTITY_STATUS_TTL` |
| `emailVerifiedAt` | 除登录刷新外，状态复核同样刷新——用户在 certus 完成验证后无需重登即可恢复邮件投递 |
| R11 / R12 | 二者原病因均消失，合并为新 **R11：跨服务版本依赖**——三项能力都在 certus 侧，版本偏旧会**静默降级**且三种表现都不显眼，故进部署前置能力探测与 runbook 顺序 |
| 待确认 #6 | 从"要不要提需求"收敛为"`IDENTITY_STATUS_TTL` 取多少"，M0 联调后按实际请求量定 |
| M0 | 认证侧从"可行性验证"降为"端到端联调"，**剩余未知集中到第三方用量接口** |

### 结论

| 判断 | 说明 |
| --- | --- |
| 遗留 P0/P1 | **无。** 认证与身份层不再有能力级未知。 |
| 残留窗口 | 停用感知延迟上界 = `IDENTITY_STATUS_TTL`，且只在有出站动作时收敛。比先前"无会话就永远不知道"好一个数量级，但仍非实时，已写进运维预期。 |
| M0 | 可启动，且范围缩小：认证侧做联调而非探路。 |

## 9k. 十轮审计（v0.4.1 → v0.4.2 · 2026-08-07）

> 本节为 v0.4.2 历史台账；fail-open 上界、probe 执行者与 404 文案虽已加入，但其 NULL、恢复、可验证证据与访问控制缺口由 §9l 继续修正。

先核对 v0.4.1 的四项小修：`User.statusReason` 已落表、会话复核 / 状态复核术语已切分且交叉引用、`NotificationDigest` 已补 `blocked` 终态、certus 能力探测已写进 §5.4 就绪分层 —— **四项均已落地**。在此基础上独立审计，得 4 项，其中两项有实质价值。

| ID | 级别 | 问题 | v0.4.2 落地 |
| --- | --- | --- | --- |
| **R10-COLLECT-DUP** | P2（**代码核对得出**） | 状态复核被写进「采集上报入口」，但这是**冗余的跨服务往返**：certus 的 `writeAccessTokenIntrospection` → `validateOAuthUserGrant` 已校验 `user.Status != identity.UserActive` 并返回 `{"active": false}`，停用用户的上报在 introspection 阶段就被拒。而采集上报是每设备每小时的高频路径，多一次跨服务调用代价实在。 | 采集入口取消状态复核，改为依赖 introspection；注明残留窗口是 introspection 的 30–60 秒缓存，远小于 TTL；§8 端点表同步标注 |
| **R10-FAILOPEN** | P2 | 状态复核失败时 fail-open 的**决定是对的**（与 R6「故障不误杀」一致），但**没有上界**——与全文风格不一致：会话有 7 天绝对过期、同步退避 12 小时转 degraded、租约有超时回收，唯独这里可以无限期沿用旧状态。certus 长时间不可用会变成「持续给可能已停用的用户发信」且没有自愈终点。 | 增 `IDENTITY_STATUS_MAX_STALE`（默认 24h）：超过则出站由 fail-open 转 fail-closed 并置运维面板故障态；§12.3 认证行加验收 |
| **R10-PROBE-RUNNER** | P2（**老病复发**） | certus 能力探测写进了 §5.4，但**没有执行者**——「切流前与运行期运维面板各检查一次」在 §8 端点表和任务清单里都找不到落点。这正是五轮 R5-PURGE 那一类问题。 | 切流前走 `GET /api/ready?deep=1`（默认 `/api/ready` 保持轻量供平台高频探针）；运行期由每日 `purge` 顺带执行并写日志/指标；§8 与 §12.3 同步 |
| **R10-404-COPY** | P2 | `statusReason` 记 404 时，certus 有意把「无效 ID / 未授权本客户端 / 用户不存在」统一为 404（不留枚举面），因此 conspectus **无法区分**，UI 文案不能断言其中任何一种。原文只写「UI 文案不同」，实现时很容易写出一句错的。 | `statusReason` 取值定为 `certus_not_found`，并给出不断言的文案范式 |

### 十轮结论

| 判断 | 说明 |
| --- | --- |
| v0.4.1 落地质量 | 四项全部到位，术语切分尤其干净（会话复核 vs 状态复核是两个机制，此前混用确实容易写错实现）。 |
| 新增 P0/P1 | **无。** 四项均为 P2。 |
| 本轮价值点 | R10-COLLECT-DUP 只能靠读 certus 源码得出——设计文档自身自洽，是**跨服务的职责重复**；这类问题不会在单仓审阅里暴露。 |
| 复发观察 | R10-PROBE-RUNNER 与五轮 R5-PURGE 同型（承诺无执行者）。新增机制时把「谁来跑」当成必填项，比事后审计更省。 |

## 9l. 十一轮审计与修正（v0.4.2 → v0.5.0 · 2026-08-07）

本轮不再只问“有没有执行者”，而是沿着 certus 状态响应实际携带的字段，完整推演正常、撤销、停用、故障、恢复与多身份并存。由此发现十轮新增机制里有 5 项 P1 和 2 项 P2；均已写回设计正文、里程碑、风险与验收。

| ID | 级别 | 问题 | v0.5.0 落地 |
| --- | --- | --- | --- |
| **R11-EMAIL-PAIR** | **P1 · 隐私** | certus 状态端点只返回 `email_verified`，不返回 email；若用户 A→B 并验证 B，直接刷新验证位会把 `true` 套到 conspectus 留存的旧 A，财务提醒可能发给旧地址 | 增 `emailVerificationSource`、`emailSnapshotIssuedAt`、`emailSyncRequiredAt`；用 certus `updated_at > ID Token iat` 判断快照后画像变化；certus 来源 Email 每个实际批次强制成功状态预检，故障只延迟；版本变化后验证立即失效且必须重新登录取得 email+Claim 成对快照，可恢复项 pending 而非误发/终态丢失 |
| **R11-404-GLOBAL** | **P1 · 认证** | 404 含 consent 撤销，却写全局 suspended，`both` 模式的本地密码也会被锁死，与“授权失败不能锁本地身份”原则冲突 | 增 `certusLinkStatus(active|reauth_required)`；404 只撤 certus Session/关联，不写全局状态；200 locked/disabled 才写全局 suspended；本地身份仍可支撑非 certus 依赖动作 |
| **R11-RECOVERY** | **P1 · 状态机** | suspended 用户不再产生通知/同步，按需复核也就失去触发器，locked→active 会成为吸收态 | 增每小时 `identity-status` runner、持久重试和每用户租约；处理失败行与 certus 原因 suspended；新 OIDC 授权作为第二条恢复路径；reauth_required 明确只由重新授权恢复 |
| **R11-NULL-STALE** | **P1 · 安全/可用性** | `lastStatusSyncedAt` 可空却直接做时间差，可能无限 fail-open，或被实现成首次故障立即关闭 | certus 绑定要求非空；成功 ID Token `iat` 初始化；迁移按 `lastLoginAt/createdAt` 安全回填；NULL 明确 fail-closed；MAX_STALE 只形成可恢复 identity gate，不写永久 suspended，Delivery/Provider 延迟且成功后唤醒 |
| **R11-PROBE-EVIDENCE** | **P1 · 部署** | 随机 404 无法区分端点存在与路由缺失，`active:false` 无法区分 token 无效与跨客户端授权缺失；原 deep ready 没有可验证样本 | M0 新增 certus `/api/v1/clients/me/capabilities` 机密客户端契约，返回 feature 与当前客户端的 `introspection_sources`；机器声明与真实用户/token E2E 分层，缺任一都不切流 |
| **R11-DEEP-ABUSE** | **P2 · 运行安全** | 未保护的 `?deep=1` 可被反复调用，放大外部请求并消耗 certus 客户端限额；并发状态复核也会形成惊群 | deep 改用独立 `DEPLOY_PROBE_SECRET`，无凭据 404、60s 缓存、DB single-flight；运行期独立 `certus-capabilities` 任务；用户状态复核也加 per-user lease、并发/总速率上限与 429 Retry-After |
| **R11-BASELINE** | **P2 · 文档** | README、总评、行动清单与修订记录仍混用 v0.4.1/§9j，且资产源模板路径含义不清 | 全部统一 v0.5.0/§9l；修订记录恢复 v0.4.1→v0.4.2→v0.5.0 顺序；资产说明明确运行时 SVG 已落 `docs/assets`/`public`，`design/logo` 只保留源模板 |

### 十一轮结论

| 判断 | 说明 |
| --- | --- |
| 本轮落地 | 5×P1 + 2×P2 全部进入正文、任务执行者、环境变量与 §12.3 验收；未发现 P0。 |
| 实现基线 | v0.5.0。M1 不得复用 v0.4.x 的单一 suspended 模型或“状态端点 true 直接刷新邮箱验证位”的逻辑。 |
| M0 | 可以启动，但需把 capabilities 上游契约和真实 E2E 当作 go/no-go，不再把认证侧写成“已无未知”。 |

## 9m. 十二轮审计（v0.5.0 → v0.5.1 · 2026-08-07）

先核对 v0.5.0 的七项：`emailVerificationSource` / `emailSnapshotIssuedAt` / `emailSyncRequiredAt` 三字段、`certusLinkStatus`、`identity-status` 与 `certus-capabilities` 两个 runner、`DEPLOY_PROBE_SECRET` 与 deep 探针访问控制、NULL `lastStatusSyncedAt` 的 fail-closed —— **全部落地且三处一致**（§5.2 任务图 9 个 job、§5.3 目录树、§8 端点表）。certus 来源的 Email 要求"每次发信前取得新鲜状态响应、不吃 1 小时缓存、不 fail-open"，比我预期的更严。

本轮 2 项，都在**跨仓边界**上。

| ID | 级别 | 问题 | v0.5.1 落地 |
| --- | --- | --- | --- |
| **R12-UPSTREAM-OWNER** | P1 · 流程 | `/api/v1/clients/me/capabilities` 是 v0.5.0 新引入的上游依赖，正文诚实标注了"新增的明确上游依赖"，但**没有开 certus issue**——与 #2/#3/#4 建立的"跨仓需求即开 issue"流程不一致。M0 把它写成 go/no-go 闸门，闸门另一侧却没有归属人：要么 M0 无限期卡住，要么被绕过（"先跳过 deep 探测"），把 R11 的静默降级风险原样带进 M1。 | 新增 **R11b**，写明"issue 关闭前不宣称 M0 认证侧通过"，并给出上游排期不允许时的显式降级方案（退回 Discovery + 真实 E2E 两层，并把局限写进 runbook）而非默默不做；待确认新增第 7 条 |
| **R12-UPDATEDAT-FP** | P1 · 可用性（**代码核对得出**） | `updated_at > emailSnapshotIssuedAt` 被用作"邮箱快照后画像变化"的判据，但 certus 的 `UpdatedAt` 在**任何**用户更新时都 bump（`internal/identity/user.go` 的 `Update` 无条件赋值），改显示名、改状态都算。一次无关的画像变更就会写 `emailSyncRequiredAt`，**静默延迟该用户的邮件通知直到下次登录**——本地会话最长 7 天、PWA 用户可能更久不重新授权。方向安全（延迟而非误发），但代价被低估。 | §6.2 写明误报及其代价；指出**正解在上游且很便宜**——请 certus 在状态端点一并返回 `email`（对该客户端不构成新披露：端点已按 consent 限定，该客户端本就从 ID Token 拿到过同一地址），则三字段启发式连同误报可整体删除，改邮箱且新址已验证时也能立即恢复。落地前保持现有 fail-safe 不变，但不当终态设计 |

### 十二轮结论

| 判断 | 说明 |
| --- | --- |
| v0.5.0 落地质量 | 七项全部到位且跨章节一致；R11-EMAIL-PAIR（验证位脱离地址）是这几轮里最有价值的发现之一。 |
| 新增 P0 | **无。** 两项 P1 都不改变设计方向，一项是流程归属，一项是把启发式标记为过渡方案。 |
| 共同点 | 两项都源自**跨仓边界**：一个是需求没落到上游的 issue 列表，一个是把上游字段语义想得比实际窄。§9i 的教训（以上游代码为准）仍在持续产生价值。 |
| 建议 | 上游两项需求已开出 [certus#9](https://github.com/devShuai/certus/issues/9) / [certus#10](https://github.com/devShuai/certus/issues/10)，建议合并成一次 certus 迭代交付，避免 M0 分两次等待。 |

## 9n. 实现↔文档对账（v0.5.1 → v0.6.0 · 2026-08-08）

全部 issue 关闭后，对照实现逐项核对文档。**没有反向缺口**——文档写到的都实现了；偏差是单向的，实现跑在文档前面。

| 类别 | 差异 | v0.6.0 处理 |
| --- | --- | --- |
| **项目状态** | README 写「M0 风险验证阶段……尚无可发布的业务功能」，§10 里程碑全为未来时，本文件状态行写「M0 可启动」——而 M1–M6 早已落地（100 测试文件 / 622 用例）。**任何人打开仓库都会以为业务代码还没开始写。** | README 状态与里程碑表改为已交付；§10 标注全部交付；本文件状态行重写 |
| **§8 API 表** | 缺 10 条已实现路由。其中三条是实质契约而非补充端点：`cron/notification-digest`（第 10 个定时任务，而 §5.2 只画了 9 个）、`collect/revoke`（§7.4「单设备撤销」的唯一入口）、`auth/bind/start`（#96 账号接管修复的核心路径） | 10 条全部补入；§5.2 任务图补 C10；§5.3 目录树补 bind / reauth / delete-account / billing / settings |
| **§6.2 数据表** | 缺 `EmailVerificationToken`、`RateLimitCounter`、`DeepReadyProbe`。其中 `RateLimitCounter` 尤其不该缺：§9 明确要求「限流状态放 PostgreSQL 而非进程内存」，实现照做了，表却没进模型 | 三张表补入，各注明存在理由 |
| **安全修复字段** | `User.certusSubLegacy`（#94）与 `ReauthTransaction.targetPath`（#98）完全没进文档。二者都是**安全修复的载体**，无人知道为何存在时极易在「清理无用字段」中被删——后果分别是老账号变孤儿、开放重定向复活 | 两列补入并写明删除后果 |
| **§12.4 环境变量** | 服务端缺 `CERTUS_CLI_CLIENT_ID`、`TEST_DATABASE_URL`；collector 侧 5 个变量一个都没有 | 全部补入，collector 单列一段 |
| **上游依赖** | certus#9 已实现关闭，文档仍写成「M0 认证侧 go/no-go 闸门」「尚不存在」 | R11b 与待确认 #7 改写；上游需求收敛为仅剩 #10 |

### 偶发失败已定位（提交 9c105c0）

连跑六次抓到了真实错误。**并不是此前推测的连接池争用**（#66 评论里的那条判断是错的），而是两个互不相关的原因：

1. **`runRenewals` 用 `include: { user: … }` 取时区**。该关系是必需的，行在扫描与联接之间消失时 Prisma 抛 `Inconsistent query result: Field user is required to return data, got null`。测试里是别的文件在删自己的用户；**生产同样可达**——`deleteAccount` 级联删除，正好能撞上全局扫描，且会让整轮 cron 对所有其他用户一起失败。改为分开按 id 批量查时区，owner 消失的订阅本轮跳过。
2. **ingest 的 fixture 把 `capturedAt` 钉死在 `2026-01-01`**。`runPurge` 全局删除超过 180 天的快照，多个测试文件都会调它；真实日期越过截止线后，这些快照被**合法地**删掉。而断言检查的正是非权威快照——它按设计不被 `valueSnapshotId` 引用，所以 `notIn` 保护够不着它。改为相对当前时间的偏移，保留断言依赖的先后顺序。

第二条不是竞态而是**时间炸弹**：字面量写下时还在未来，随真实日期推进才变得可达。**任何落在保留期覆盖表上的固定过去日期都会重演**——这一条值得作为 fixture 约定记住。

改动后连跑八次全绿。

## 10. 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-08-08 | **偶发失败定位并修复**（9c105c0）：`runRenewals` 的必需关系 include 在 owner 被并发删除时中断整轮（生产经 `deleteAccount` 可达）；ingest fixture 的固定日期越过 180 天保留期被 purge 合法删除。见 §9n。 |
| 2026-08-08 | **实现↔文档对账** design.md v0.5.1 → **v0.6.0**：补 10 条端点 / 3 张表 / 2 个安全修复字段 / collector 环境变量；项目状态与上游依赖描述改为与实现一致。详见 §9n。 |
| 2026-08-07 | 初稿：基于 design.md v0.1 全文审阅 |
| 2026-08-07 | P0 全部 8 项落地 design.md v0.1.1：M1/M1b 拆分（P1）、local×CLI 限制（A1 选①）、`autoRenew=false` 只提醒不建 pending（D5）、年化口径与 trial 迁移（D1/D3）、字段变更同步重算（D2）、UsageQuota 唯一约束（D4）、G 表重排加阶段列（C1/C9）、`src/` 布局锁定（C2/C3）。一并落地的 P1/P2：C5/C6/C7/C8、D7/D8/D9/D10、A2/A3/A5、T1/T2/T3/T5、U1、P2（示例默认 certus）、§4.5 验收清单（design §12.3）。**落地时的增量修正**（本审阅未列出、改稿时发现）：`UsageSnapshot.usedValue` 存不了 balance 读数 → 改为语义随 kind 的 `value` 列；快照幂等约束在可空 `deviceId` 上失效（NULL 互不相等）→ 改表达式唯一索引；年化公式 `365/天数` 对 monthly 会得出 ×12.17 → 月/季/年改整数倍；§5.1 node-cron 与 §5.4 cron 容器矛盾 → 统一后者；登录时序图与客户端注册的 `login_methods` 矛盾 → 已对齐；风险表 R7/R8 间空行断表 → 已修。P3（README 能力分层）已在 README 落地。**未落地**：P5/待确认项转 issue、T4（i18n 一节）、A4（注销冷却文案）、D6（tags GIN）。 |
| 2026-08-07 | 二轮复审问题全部落地 design.md v0.2：认证改为 `openid-client` + 自有 Session；Cron 改 GET；增加 occurrence 幂等、租户组合外键、Binding/设备签名、BillingConversion/独立退款、通知 outbox、静态-only PWA 缓存与分层 readiness；新增 M0 风险验证。 |
| 2026-08-07 | 三轮复审（接缝审查）9 项全部落地 design.md v0.2.1，见 §9b。无新增 P0，M0 可开工。 |
| 2026-08-07 | **四轮复审**（文档变更后再读 v0.2.1）：核对历史 P0 均在正文可定位；新发现 R4-VENDOR（系统 Vendor 与组合外键，M1 schema 前补）、R4-RULE / R4-BIND（M3）、若干 P2；更新 §1 总评；§3 起标明为首轮历史台账。 |
| 2026-08-07 | **五轮复审**（执行者审计）：新增 R5-PURGE / R5-FXREADY / R5-REBASE 三项 P0（保留清理任务、投影汇率就绪、rebase 执行者），R5-CERTUSCAP（扩 R4-SCOPE）等 4 项 P1 与细节项，见 §9d。 |
| 2026-08-07 | **四/五轮意见落地** design.md v0.2.2：新增 purge / rebase 任务与端点、汇率就绪与待补投影、CollectorNonce / CurrencyRebaseJob 表、Vendor 触发器例外、NotificationRule / Channel 字段、本地认证与 RP-Initiated Logout 端点、Binding 生命周期、M0 certus 能力清单、R10 合并入口、环境变量补全；未落地仅剩历史延期项。 |
| 2026-08-07 | **六轮复审（通知系统审计）并同步落地** design.md v0.2.3：R6-DEDUPE（P0，逐类型 dedupeKey + `balanceLowSince` / `failedSince` 恢复告警资格辅助字段）、R6-SUSPGAP（suspended 写入者与已知边界 + 待确认第 6 条）、R6-VERIFY（`emailVerifiedAt` 两模式共用、投递前实时校验）、R6-ASYM / R6-DELACC / R6-IDLE / R6-TZ 四项 P2。见 §9e。M0 无新增前置。 |
| 2026-08-07 | **七轮复审（对照 certus 实现 + 并发/约束）并落地** design.md **v0.2.4**，见 §9f。 |
| 2026-08-07 | **用词/一致性审计修正**：design.md v0.2.4 → v0.2.5（14 项文本级：`one_time` 统一、nonce 保留期三处对齐、authTime 措辞降级、§8 certus 端点模式标注、binding 维度表述、ER 补注与 ArmState / UsageCycleSummary 边、闲置口径统一与判据表落点、Delivery / Connection status 枚举、inboundAddress 与「见上节」措辞、rebase 频率正文补注）；本文件 §9f 挪回 §10 之前、§9e R6-DEDUPE 行加 R7-ARM 回指。 |
| 2026-08-07 | **告警术语与外部依赖登记**：design.md v0.2.5 → v0.2.6；旧告警术语统一为“恢复告警资格”并补定义，稳定的 `NotificationArmState` / `armKey` 标识不改；确认 certus 尚未签发或声明 `email_verified`，创建 bug [certus#1](https://github.com/devShuai/certus/issues/1)，正文明确 Claim 缺失按未验证安全降级并纳入 M0 能力清单。 |
| 2026-08-07 | **八轮审计问题闭环**：design.md v0.2.6 → v0.3.0；补 Reauth 用户绑定、Back-Channel jti 表、POST 全局登出、本地邮箱规范化、trial 首账、权威 Binding + Snapshot CAS、同步退避、历史利用率、notification-scan、Digest、ArmState CAS、dispatcher 复核/租约与验收清单；详见 §9g。 |
| 2026-08-07 | **九轮复审（外部依赖与扫描边界）并同步落地** design.md v0.3.0 → **v0.3.1**：新增 **R11**（certus#1 使 certus 模式下邮件渠道与摘要整体不可用）并改写 M3 交付标准的降级验收路径；`notification-scan` 补 subject 状态过滤（撤销设备 / paused / suspended）；`NotificationArmState` 主键补 `userId` 与组合外键；`blocked` 渠道级可见原因。无新增 P0，M0 可启动。详见 §9h。 |
| 2026-08-07 | **certus 能力实测校正** design.md v0.3.1 → **v0.3.2**：直读 certus 源码后更正 R11 病因（`email_verified` 已签发但本地用户恒 false）、新增 **R12**（跨客户端 introspection 不支持，M4 阻塞）、`usage:write` 从风险降为配置项、待确认 #6 改写为具体方案；开出 [certus#2](https://github.com/devShuai/certus/issues/2) / [#3](https://github.com/devShuai/certus/issues/3) / [#4](https://github.com/devShuai/certus/issues/4)。详见 §9i。 |
| 2026-08-07 | **certus #2/#3/#4 落地后的设计收敛** design.md v0.3.2 → **v0.4.0**：`introspectable_by` 写入 CLI 注册；`suspended` 改以状态端点为唯一权威、404 同样停出站；新增按需 + TTL 复核策略与 `User.lastStatusSyncedAt` / `IDENTITY_STATUS_TTL`；R11+R12 合并为跨服务版本依赖风险；M0 认证侧降为端到端联调。详见 §9j。 |
| 2026-08-07 | **复审小项修正** design.md v0.4.0 → **v0.4.1**：`User.statusReason` 落点（404/disabled 文案分离）、状态端点 fail-open 与「会话复核 / 状态复核」术语区分、`NotificationDigest` 补 `blocked` 终态及子项连带、certus 能力探测写入 §5.4 就绪分层；本文件头部范围 / §1 / 修订记录顺序对齐，README 基线同步。 |
| 2026-08-07 | **十轮审计** design.md v0.4.1 → **v0.4.2**：采集入口取消冗余状态复核（introspection 已覆盖停用）、fail-open 加 `IDENTITY_STATUS_MAX_STALE` 上界、certus 能力探测补执行者（`/api/ready?deep=1` + 每日 purge）、404 原因值与文案范式。详见 §9k。无新增 P0/P1。 |
| 2026-08-07 | **十一轮审计问题闭环** design.md v0.4.2 → **v0.5.0**：5×P1 + 2×P2 全部落地；邮箱地址/验证位成对快照、全局状态与 certus 关联/临时门禁分层、404 不锁本地身份、identity-status 恢复 runner、状态复核租约与 NULL/MAX_STALE 语义、机器可读 capabilities 契约、受保护缓存 deep probe；README、总评、资产说明与修订顺序统一。详见 §9l。 |
| 2026-08-07 | **十二轮审计** design.md v0.5.0 → **v0.5.1**：新增 R11b（`capabilities` 是新上游依赖但无 issue 归属，M0 闸门另一侧没人认领）与其显式降级方案；§6.2 写明 `updated_at > iat` 的误报代价（certus `UpdatedAt` 对任何用户更新都 bump）并指出正解是请上游在状态端点返回 `email`；待确认合并为两项上游需求及降级边界。详见 §9m。无新增 P0。 |
| 2026-08-09 | **v0.5.x 实现状态对照**（conspectus#122，文档反向过期修正，设计语义不变、未升版本号）：§7.9 PWA 资产缺口更新为现状——`public/icons/` 已有 `icon-192.png` / `icon-512.png` / `icon-512-maskable.png`，仅缺 192 maskable（剩余归 #121-11）；§5.3 目录树对齐实际布局——`(auth)/` 路由组不存在，登录页在裸 `login/`（另有 `register/`、`reset-password/`），汇率在 `server/billing/fx.ts`、凭证加解密在 `server/auth/crypto.ts`，删除不存在的 `src/lib/` 与顶层 `server/crypto.ts`。M0 收尾：`scripts/m0-device-introspection.ts` 与 `m0:device-introspect` 保留为 certus 设备授权 / introspection 链路的人工诊断工具（头部已注明用途与场景），其余 M0 探针界面已在 `b8e4887` 清除。 |
