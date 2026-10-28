#!/bin/sh
# 从环境变量落 SSH deploy key；GitHub host key 用官方公布值钉死（不 TOFU）。
set -e
if [ -n "$GIT_SSH_KEY_B64" ]; then
  mkdir -p /root/.ssh
  umask 077
  echo "$GIT_SSH_KEY_B64" | base64 -d > /root/.ssh/commons_deploy
  chmod 600 /root/.ssh/commons_deploy
  cat > /root/.ssh/known_hosts_github <<'HOSTS'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
HOSTS
  export GIT_SSH_KEY_FILE=/root/.ssh/commons_deploy
  export GIT_KNOWN_HOSTS_FILE=/root/.ssh/known_hosts_github
fi
unset GIT_SSH_KEY_B64
exec node src/server.js
