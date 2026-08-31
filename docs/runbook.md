# 部署 Runbook

## 预检（切流前，任一失败即阻止）

```bash
# 1) 轻量 ready：只验 DB + 迁移
curl -fsS http://<app>/api/ready
# → {"status":"ready"}

# 2) 受保护 deep：capabilities + 配置闸门
curl -fsS -H "Authorization: Bearer $DEPLOY_PROBE_SECRET" "http://<app>/api/ready?deep=1"
# → {"status":"ready","deep":{"ok":true,...}}
# 无密钥访问必须 404

# 3) 真实 OIDC smoke：登录 → /me → logout（人工一次）
# 4) 真实 CLI smoke：conspectus-collect login → run --dry-run → run
```

## 形态 A：自有服务器（Docker）

```bash
cd docker
cp ../.env.example .env   # 填全部 secret；docker/ 下没有单独的模板
docker compose up -d --build
docker compose logs -f cron   # 观察任务执行
```

回滚：`docker compose up -d --build app`（旧镜像 tag）或 `docker compose down`。

## 形态 B：Vercel（Pro 或外部调度器）

- Build：默认 Next.js（`npm run build`）。
- 环境变量：与 `.env.example` 一致（`DATABASE_URL` 指向 Neon/Supabase）。
- Cron：`vercel.json` 已声明 9 个 GET cron；**分钟级 dispatcher 需要 Pro**。
- **Hobby 限制**：只有每日 cron 且任务数有限 → 部署时若检测到 Hobby，必须明确接受「通知 SLA 降级为每日一次」；`/api/cron/notification-dispatch` 无法分钟级运行。不能假装 09:00 与分钟重试可用。
- 外部调度器替代：GitHub Actions cron 或自建 cron 容器 `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/<job>`。

## 形态 C：fedora 原生发布（conspectus.devshuai.com）

与同机 certus 同一形态：`releases/<rev>` + `current` 软链 + 用户级 systemd，回滚就是把软链指回上一版。
不用 Docker 是因为这台机器已经有原生 PostgreSQL 与 OpenResty，compose 会再起一套 PG 造成数据分裂。

| 位置 | 内容 |
| --- | --- |
| `~/.local/opt/conspectus/build/` | ship.sh 投递的源码树，每次全量覆盖 |
| `~/.local/opt/conspectus/releases/<rev>/` | 构建产物（standalone），保留最近 5 个 |
| `~/.local/opt/conspectus/current` | → 当前 release |
| `~/.local/opt/conspectus/backups/` | 迁移前的 `pg_dump -Fc`，保留最近 5 个 |
| `~/.config/conspectus/conspectus.env` | 密钥，0600，不在仓库里，发布不覆盖 |
| `~/.config/systemd/user/conspectus{,-cron}.{service,timer}` | 由 release.sh 安装 |

构建在 fedora 本机做：`argon2` 是原生模块，不能从开发机拷贝二进制过去。

### 一次性准备

1. **certus 注册**：给 `conspectus` 这个 confidential client 加两个 URI——
   redirect `https://conspectus.devshuai.com/api/auth/certus/callback`，
   post-logout `https://conspectus.devshuai.com/logout/done`。少任何一个，登录会停在 certus 的 `invalid_redirect_uri`。
2. **首次 ship**：`bash deploy/fedora/ship.sh`。env 文件不存在时 release.sh 生成模板（`AUTH_SECRET` / `CRON_SECRET` /
   `DEPLOY_PROBE_SECRET` 当场随机生成）后**以 exit 2 停下**，不构建也不改任何服务。
3. **填 3 个值**（`~/.config/conspectus/conspectus.env`，0600）：`CERTUS_CLIENT_SECRET`、`DATABASE_URL` 的库密码、
   `CREDENTIAL_ENC_KEYS`。最后一个必须与开发机 `.env.local` **逐字节一致**——线上与开发是同一个库，换密钥等于把
   已有密文（Session refresh/ID token、服务商凭证）全部锁死。留着 `REPLACE_ME` 时 release.sh 会报出行号并拒绝发布。
4. **nginx vhost**（需要 root，release.sh 只把副本放到 `~/.config/conspectus/` 并提示）：

```bash
sudo install -m 644 ~/.config/conspectus/conspectus.devshuai.com.conf /usr/local/openresty/nginx/conf/conf.d/ && sudo /usr/local/openresty/nginx/sbin/nginx -t && sudo /usr/local/openresty/nginx/sbin/nginx -s reload
```

### 发布

```bash
bash deploy/fedora/ship.sh
```

投递用 `git archive HEAD`（`--dirty` 则是已跟踪文件的工作区内容），**结构上不可能把未跟踪文件带上服务器**——
`.env.local`、`collector/.npmrc` 都在 `.gitignore` 里，换成目录同步就要靠一串 `--exclude` 记全，漏一条就是泄密。
工作区不干净时默认拒绝发布。

顺序：备份库 → `npm ci` → `prisma generate` → `next build` → 组装 release → **`prisma migrate deploy`** → 切软链 → 重启 →
轮询 `/api/ready`。探针 60 秒内不 ready 就自动把软链指回上一版并重启，退出码非 0。

**迁移在切软链之前**：新代码依赖新 schema。反过来（旧代码 + 新 schema）只在迁移只加不改时安全；破坏性迁移必须按
expand/contract 拆成两次发布，否则自动回滚只回代码、回不了库。

### 回滚

```bash
ssh fedora 'ln -sfn ~/.local/opt/conspectus/releases/<rev> ~/.local/opt/conspectus/current && systemctl --user restart conspectus'
```

库要一起回时用 `~/.local/opt/conspectus/backups/` 下对应的 dump（`pg_restore`）。

### 排查

```bash
ssh fedora 'systemctl --user status conspectus conspectus-cron.timer --no-pager; journalctl --user -u conspectus -n 50 --no-pager'
```

- 启动即退出：多半是 §5.4 启动闸门，`journalctl` 里有具体变量名。`TEST_DATABASE_URL` 出现在 env 文件里会被直接拒绝。
- 定时任务不跑：`systemctl --user list-timers conspectus-cron.timer`；节奏标记在 `~/.local/state/conspectus/cron/`，
  删掉即让所有任务下一分钟各跑一次。
- 单元文件改动不生效：release.sh 每次都会覆盖 `~/.config/systemd/user/` 下的三个单元，改要改仓库里的 `deploy/fedora/`。

### 已知问题

`@prisma/client` 目前在 `devDependencies`，而运行时代码 import 它。形态 C 不受影响（本机全量 `npm ci` 后构建，
standalone 已把它 trace 进产物），但形态 A 的 `npm ci --omit=dev` 会漏掉它。

## 邮件入站（Cloudflare Email Worker，#59）

链路：Email Routing 收信 → `workers/email-forward/` Worker → HMAC-SHA256 签名 POST `/api/inbound/email`（契约见 `src/server/import/inbound.ts` 头注；双端签名一致性由根 `npm test` 的 email-forward 项目对拍用例保证）。

### 首次部署

1. **域名/DNS**：收件域名托管在 Cloudflare，Dashboard → Email Routing → 启用，MX/SPF 记录自动写入。用子域（如 `in.conspectus.app`）收件需账户支持 subdomain routing，否则改用 apex 域。
2. **Worker 配置**：`cd workers/email-forward && npm install`；把 `wrangler.toml` 的 `INBOUND_ENDPOINT` 改成站点基址（不含路径）。
3. **secret**：`npx wrangler login` 后 `npx wrangler secret put INBOUND_WEBHOOK_SECRET`；取值与服务端环境变量 `INBOUND_WEBHOOK_SECRET` **逐字节一致**（生成：`openssl rand -hex 32`；服务端侧见 `.env.example`）。secret 绝不写入 `wrangler.toml`。
4. **部署**：`npx wrangler deploy`。
5. **绑定路由**：Dashboard → Email Routing → Routes → catch-all（或指定地址）→ Send to a Worker → 选 `conspectus-email-forward`。

### 验证

- `npx wrangler tail`：应见 `inbound_forwarded` 事件。日志只含事件名/状态码/字节数——出现地址、主题或正文即为事故（§9 脱敏纪律）。
- 真实测试邮件：向某用户的 `u-…@<域名>` 别名发信，DB 出现一行 `InboundEmail`（#60 起同请求内解析，`parseStatus` 落 `parsed`/`failed`）；同一封重投（平台重试）不产生新行——幂等由 `(userId, messageId)` 唯一约束兜底。
- 解析成功率：按结构化日志 `inbound_email_parse_failed` 的 `reason` + `rule` 聚合——某规则 id 的 `template_drift` 突增即对应 vendor 模板改版，去 `src/server/import/rules/` 加新版本规则（只增不改）。日志只含事件/原因/规则 id，出现地址、主题或正文即为事故（§9 脱敏纪律）。
- 确认流（#61）：解析产出的 `ImportDraft` 出现在 `/inbox`，用户校正字段后「接受并入账」（无匹配订阅时自动新建，账单 `source=email`、`externalRef=draft:<id>`）或「拒绝」；未确认草稿不进 `BillingRecord` 与实付统计。`ImportDraft` 只有 `pending` 可迁移，并发/重复操作由 CAS 兜底。

### 原文与草稿生命周期（隐私，#62）

- **原文**：`rawCipher` 以 §9 envelope 加密（`CREDENTIAL_ENC_KEYS`），落库时写 `rawRetainedUntil = 入站 + 30 天`；`/api/cron/purge` 每日把到期行的 `rawCipher` 置空——行与 `fromAddr`/`subject`/`receivedAt` 元数据保留，已产出的草稿不受影响。
- **用户可控面**（设置 → 数据 → 邮件导入）：「关闭原文保留」后新邮件 `rawCipher` 恒空（仅主题可解析，通常凑不齐字段 → `parseStatus=failed`）；「立即清除已存原文」即时置空该用户全部 `rawCipher`。两条链路都有集成测试锁定（route/purge/E2E）。
- **草稿**：确认窗 30 天（`expiresAt`），purge 把超窗 `pending` 置 `expired`；`accepted`/`rejected`/`expired` 均为终态，purge 幂等重跑不回改。
- **脱敏证据**：服务端与 Worker 日志只含事件名、状态码、`reason`/`rule` id、`userId`——出现地址、主题、正文、别名或原文即为事故（§9）。fixture 与测试只使用 `*.test`/`example.test` 域名的合成邮件。

### secret 轮换（顺序不可颠倒）

1. 生成新 secret；2. **先**更新服务端 `INBOUND_WEBHOOK_SECRET` 并重启/重新部署；3. **再** `npx wrangler secret put INBOUND_WEBHOOK_SECRET`。
窗口内 Worker 持旧密钥会收 401：Worker 对一切非 202 抛错，由 Email Routing 平台重试，步骤 3 完成后自愈、不丢信。反向顺序会把 5 分钟窗外的失败扩散成更长的拒信窗口。

### 故障排查

- 持续 `inbound_forward_retry status=401`：两侧 secret 不一致，或站点时钟偏差超 5 分钟（服务端返回 `stale_timestamp`/`invalid_signature`）。
- `status=404`：服务端未配 `INBOUND_WEBHOOK_SECRET`，功能未启用。
- `status=429`：命中 IP/别名限流，平台重试自愈；持续 429 查 `RateLimitCounter` 的 `inbound:email*` 行。
- `fetch_failed`：站点不可达或 10s 未响应；先跑 `/api/ready` 再查 Worker 到站点链路。

## 回滚

1. Vercel：Instant Rollback 到上一部署；先跑 `/api/ready` 再切流量。
2. Docker：`docker compose up -d app:<previous-tag>`；迁移用 `prisma migrate deploy` 前先备份 DB。
3. 任何形态：schema 迁移落后时 `/api/ready` 返回 503，流量自动被探针拦下。
