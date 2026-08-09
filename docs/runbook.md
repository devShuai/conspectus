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
cp .env.example .env   # 填全部 secret
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
