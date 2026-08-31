#!/usr/bin/env bash
# 在 fedora 主机上执行（由 deploy/fedora/ship.sh 通过 ssh 调起，也可手工跑）。
#
# 形态与同机的 certus 一致：releases/<rev> + current 软链 + 用户级 systemd 单元，
# 回滚就是把软链指回上一版再重启。构建在本机做，因为 argon2 是原生模块，
# 不能从开发机拷贝二进制过来。
#
#   ~/.local/opt/conspectus/build/      ← ship.sh 投递的源码树（每次全量覆盖）
#   ~/.local/opt/conspectus/releases/   ← 构建产物，保留最近 KEEP 个
#   ~/.local/opt/conspectus/current     → releases/<rev>
#   ~/.local/opt/conspectus/backups/    ← 迁移前的 pg_dump
#   ~/.config/conspectus/conspectus.env ← 密钥，0600，不在仓库里也不随发布覆盖
set -euo pipefail

REV="${1:?usage: release.sh <rev>}"
ROOT="$HOME/.local/opt/conspectus"
BUILD="$ROOT/build"
TARGET="$ROOT/releases/$REV"
CURRENT="$ROOT/current"
BACKUPS="$ROOT/backups"
ENV_DIR="$HOME/.config/conspectus"
ENV_FILE="$ENV_DIR/conspectus.env"
UNIT_DIR="$HOME/.config/systemd/user"
BASE_URL="http://127.0.0.1:3000"
KEEP=5

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- env 闸门
mkdir -p "$ENV_DIR" "$BACKUPS" "$ROOT/releases"
if [ ! -f "$ENV_FILE" ]; then
  log "首次部署：生成 $ENV_FILE"
  install -m 600 /dev/null "$ENV_FILE"
  # 三个纯应用侧密钥当场随机生成，不经过任何人的剪贴板；
  # 其余 REPLACE_ME 只能由本人填（库密码、certus client secret、加密密钥）
  sed -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n=')|" \
      -e "s|^CRON_SECRET=.*|CRON_SECRET=$(openssl rand -hex 32)|" \
      -e "s|^DEPLOY_PROBE_SECRET=.*|DEPLOY_PROBE_SECRET=$(openssl rand -hex 32)|" \
      "$BUILD/deploy/fedora/conspectus.env.example" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  cat <<MSG

已生成 $ENV_FILE（0600）。还有 3 个值必须手工填，填完重新执行本脚本：

  CERTUS_CLIENT_SECRET   certus 里 conspectus 这个 client 的密钥
  DATABASE_URL           把 REPLACE_ME 换成 conspectus 角色的库密码
  CREDENTIAL_ENC_KEYS    与开发机 .env.local 中的值逐字节一致

MSG
  exit 2
fi
chmod 600 "$ENV_FILE"
if grep -q 'REPLACE_ME' "$ENV_FILE"; then
  grep -n 'REPLACE_ME' "$ENV_FILE" | cut -d= -f1 >&2
  die "$ENV_FILE 里还有 REPLACE_ME（上面是行号与变量名），填完再发布"
fi

# 只为取 DATABASE_URL 做备份与迁移；应用进程的环境由 systemd 从同一个文件加载
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL 未设置"

# ---------------------------------------------------------------- 迁移前备份
if [ "${SKIP_DB_BACKUP:-}" = "1" ]; then
  log "跳过数据库备份（SKIP_DB_BACKUP=1）"
else
  DUMP="$BACKUPS/$(date +%Y%m%d-%H%M%S)-pre-$REV.dump"
  log "备份数据库 → $DUMP"
  pg_dump "$DATABASE_URL" -Fc -f "$DUMP"
  chmod 600 "$DUMP"
  ls -1t "$BACKUPS"/*.dump 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f
fi

# ---------------------------------------------------------------- 构建
cd "$BUILD"
log "npm ci"
# 显式 --include=dev：构建要用 prisma / typescript / tailwind，
# 而继承来的 NODE_ENV=production 会让 npm 默认跳过 devDependencies
NODE_ENV=development npm ci --include=dev --no-audit --no-fund
log "prisma generate"
npx prisma generate
log "next build"
npm run build
[ -f "$BUILD/.next/standalone/server.js" ] || \
  die ".next/standalone/server.js 不存在 —— next.config.ts 的 output: \"standalone\" 没生效"

# ---------------------------------------------------------------- 组装 release
log "组装 $TARGET"
rm -rf "$TARGET" "$TARGET.tmp"
mkdir -p "$TARGET.tmp"
# standalone 自带裁剪过的 node_modules 与 server.js；static/public 是 Next 明确
# 要求另行拷贝的两个目录（不在 tracing 范围内）
cp -a "$BUILD/.next/standalone/." "$TARGET.tmp/"
mkdir -p "$TARGET.tmp/.next"
cp -a "$BUILD/.next/static" "$TARGET.tmp/.next/static"
cp -a "$BUILD/public" "$TARGET.tmp/public"
cp -a "$BUILD/prisma" "$TARGET.tmp/prisma"
# 查询引擎二进制：tracing 认不出 .prisma 里按平台生成的那个文件，漏了就是运行时报错
cp -a "$BUILD/node_modules/.prisma" "$TARGET.tmp/node_modules/.prisma"
# cron 单元执行的是 current/deploy/cron-jobs.sh
mkdir -p "$TARGET.tmp/deploy"
cp -a "$BUILD/deploy/cron-jobs.sh" "$TARGET.tmp/deploy/cron-jobs.sh"
mv "$TARGET.tmp" "$TARGET"

# ---------------------------------------------------------------- 迁移
# 必须在切软链之前：新代码依赖新 schema。反过来（旧代码 + 新 schema）只在
# 迁移是「只加不改」时安全，破坏性迁移要按 expand/contract 分两次发布。
log "prisma migrate deploy"
(cd "$BUILD" && npx prisma migrate deploy)

# ---------------------------------------------------------------- 切换
PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
log "安装 systemd 单元并切换到 $REV"
mkdir -p "$UNIT_DIR"
install -m 644 "$BUILD/deploy/fedora/conspectus.service"      "$UNIT_DIR/conspectus.service"
install -m 644 "$BUILD/deploy/fedora/conspectus-cron.service" "$UNIT_DIR/conspectus-cron.service"
install -m 644 "$BUILD/deploy/fedora/conspectus-cron.timer"   "$UNIT_DIR/conspectus-cron.timer"
# vhost 需要 root 才能装进 OpenResty，这里只留一份副本 + 提示，不代为写系统目录
install -m 600 "$BUILD/deploy/fedora/conspectus.devshuai.com.conf" \
  "$ENV_DIR/conspectus.devshuai.com.conf"
ln -sfn "$TARGET" "$CURRENT"
systemctl --user daemon-reload
systemctl --user enable --now conspectus.service >/dev/null
systemctl --user restart conspectus.service
systemctl --user enable --now conspectus-cron.timer >/dev/null

# ---------------------------------------------------------------- 就绪校验
log "等待 $BASE_URL/api/ready"
ready=""
for _ in $(seq 1 60); do
  if body="$(curl -fsS --max-time 3 "$BASE_URL/api/ready" 2>/dev/null)" \
     && [ "${body#*\"ready\"}" != "$body" ]; then
    ready="$body"; break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  printf '\033[31m就绪探针失败，回滚\033[0m\n' >&2
  systemctl --user status conspectus.service --no-pager -l | tail -30 >&2 || true
  journalctl --user -u conspectus.service -n 40 --no-pager >&2 || true
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    ln -sfn "$PREVIOUS" "$CURRENT"
    systemctl --user restart conspectus.service
    die "已回滚到 $(basename "$PREVIOUS")；数据库迁移不会自动回滚，必要时用 $BACKUPS 下的 dump"
  fi
  die "首次部署失败，没有可回滚的版本"
fi

# 保留最近 KEEP 个 release，但绝不删当前在用的那个
ls -1dt "$ROOT/releases"/* 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  [ "$(readlink -f "$old")" = "$(readlink -f "$CURRENT")" ] || rm -rf "$old"
done

log "$REV 已上线：$ready"
