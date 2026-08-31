#!/bin/sh
# Table-driven cron dispatch (design §5.4): every job is GET + Bearer + no-store.
# Frequencies: minute / hour / daily / 5min.
#
# 密钥只从环境变量 CRON_SECRET 读，不接受命令行参数：/proc/<pid>/cmdline 对同机
# 其他用户可读，密钥一旦进 argv 就等于公开。调用方（docker compose 的 cron 服务、
# fedora 的 conspectus-cron.service）都已经在自己的环境里带上它。
#
# STATE_DIR 存放各任务的上次执行时刻。容器里默认 /tmp 即可（容器重建等于重置节奏）；
# systemd 侧必须指向持久目录，否则 PrivateTmp 每次拉起都是空的，日/时级任务会
# 退化成每分钟都跑一次。
BASE="${1:?usage: cron-jobs.sh <base-url>}"
: "${CRON_SECRET:?CRON_SECRET must be set in the environment}"
STATE_DIR="${STATE_DIR:-/tmp}"
mkdir -p "$STATE_DIR"

job() { # name interval_seconds
  name="$1"; interval="$2"
  # marker file ensures roughly-once-per-interval behavior
  marker="$STATE_DIR/cron-$name"
  now=$(date +%s)
  last=0
  [ -f "$marker" ] && last=$(cat "$marker")
  if [ $((now - last)) -ge "$interval" ]; then
    curl -fsS -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/cron/$name" >/dev/null 2>&1 || true
    echo "$now" > "$marker"
  fi
}

job notification-dispatch 60
job notification-digest 60
job renewals 3600
job usage-sync 3600
job notification-scan 3600
job identity-status 3600
job purge 86400
job fx 86400
job certus-capabilities 86400
job rebase 300
