#!/bin/sh
set -e

if command -v systemctl >/dev/null 2>&1; then
  mkdir -p /var/lib/agentic-leash
  cat <<'EOF' > /etc/systemd/system/agentic-leash-helper.service
[Unit]
Description=Agentic Leash Activity Helper
After=network.target

[Service]
Type=simple
ExecStart=/opt/AgenticLeash/agentic-leash /opt/AgenticLeash/resources/app.asar.unpacked/out/main/leash-helper.js
Environment=ELECTRON_RUN_AS_NODE=1
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 /etc/systemd/system/agentic-leash-helper.service
  systemctl daemon-reload || true
  systemctl enable --now agentic-leash-helper.service || true
fi
