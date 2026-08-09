#!/bin/sh
# Table-driven cron dispatch (design §5.4): every job is GET + Bearer + no-store.
# Frequencies: minute / hour / daily / 5min.
BASE="$1"
SECRET="$2"

job() { # name interval_seconds
  name="$1"; interval="$2"
  # hour marker file ensures roughly-once-per-interval behavior
  marker="/tmp/cron-$name"
  now=$(date +%s)
  last=0
  [ -f "$marker" ] && last=$(cat "$marker")
  if [ $((now - last)) -ge "$interval" ]; then
    curl -fsS -H "Authorization: Bearer $SECRET" "$BASE/api/cron/$name" >/dev/null 2>&1 || true
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
