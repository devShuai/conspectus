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

## 回滚

1. Vercel：Instant Rollback 到上一部署；先跑 `/api/ready` 再切流量。
2. Docker：`docker compose up -d app:<previous-tag>`；迁移用 `prisma migrate deploy` 前先备份 DB。
3. 任何形态：schema 迁移落后时 `/api/ready` 返回 503，流量自动被探针拦下。
