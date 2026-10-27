#!/bin/sh
set -e

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now agentic-leash-helper.service 2>/dev/null || true
  rm -f /etc/systemd/system/agentic-leash-helper.service
  systemctl daemon-reload || true
fi
