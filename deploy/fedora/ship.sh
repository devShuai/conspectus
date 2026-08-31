#!/usr/bin/env bash
# 从开发机把源码投递到 fedora 并触发一次发布。
#
#   bash deploy/fedora/ship.sh              # 发布 HEAD，要求工作区干净
#   bash deploy/fedora/ship.sh --dirty      # 连未提交的改动一起发（调试用）
#   CONSPECTUS_SSH_HOST=other bash deploy/fedora/ship.sh
#
# 投递用 git 的文件清单而不是 rsync 整个目录：一是本机没有 rsync，二是这样
# **结构上**不可能把未跟踪的文件带上服务器 —— .env.local、collector/.npmrc 这类
# 东西都在 .gitignore 里，用目录同步就要靠一串 --exclude 记全，漏一条就是泄密。
set -euo pipefail

HOST="${CONSPECTUS_SSH_HOST:-fedora}"
REMOTE_ROOT='$HOME/.local/opt/conspectus'
cd "$(git rev-parse --show-toplevel)"

dirty=0
[ "${1:-}" = "--dirty" ] && dirty=1

REV="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  if [ "$dirty" -eq 0 ]; then
    git status --short
    echo "工作区不干净：提交后再发，或加 --dirty 明确表示要发未提交的版本" >&2
    exit 1
  fi
  REV="$REV-dirty-$(date +%H%M%S)"
fi

echo "==> 投递 $REV → $HOST"
if [ "$dirty" -eq 1 ]; then
  # 已跟踪文件的**工作区内容**；未跟踪文件一概不带
  git ls-files -z | tar -cf - --null -T -
else
  git archive --format=tar HEAD
fi | ssh "$HOST" "set -e; d=$REMOTE_ROOT/build; rm -rf \"\$d\"; mkdir -p \"\$d\"; tar -x -C \"\$d\""

ssh -t "$HOST" "bash $REMOTE_ROOT/build/deploy/fedora/release.sh '$REV'"
