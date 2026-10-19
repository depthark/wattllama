#!/usr/bin/env bash
# Removes what install.sh set up: the user service, the optional RAPL helper and the firewall
# rules. Keeps your history in data/ unless you pass --remove-data.
set -euo pipefail
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REMOVE_DATA=0
for a in "$@"; do case "$a" in --remove-data) REMOVE_DATA=1 ;; *) echo "unknown option: $a" >&2; exit 2 ;; esac; done

UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/wattllama.service"
if [ -f "$UNIT" ]; then
  systemctl --user disable --now wattllama.service >/dev/null 2>&1 || true
  rm -f "$UNIT"
  systemctl --user daemon-reload || true
  echo "Removed the wattllama user service"
fi
pkill -f "$DIR/start.sh" 2>/dev/null || true
pkill -f "$DIR/server.mjs" 2>/dev/null || true

if [ -f /etc/systemd/system/wattllama-rapl.service ] || [ -f /usr/local/lib/wattllama/rapl-helper ]; then
  echo "Removing the RAPL helper (asks for sudo)..."
  sudo systemctl disable --now wattllama-rapl.service >/dev/null 2>&1 || true
  sudo rm -f /etc/systemd/system/wattllama-rapl.service /usr/local/lib/wattllama/rapl-helper
  sudo rmdir /usr/local/lib/wattllama 2>/dev/null || true
  sudo systemctl daemon-reload
fi

if [ -f /etc/sudoers.d/wattllama-power-limit ] || [ -f /usr/local/lib/wattllama/power-limit ]; then
  echo "Removing the power-limit helper and its sudoers rule (asks for sudo)..."
  sudo rm -f /etc/sudoers.d/wattllama-power-limit /usr/local/lib/wattllama/power-limit /etc/wattllama/power-limit-above-default
  sudo rmdir /etc/wattllama 2>/dev/null || true
  sudo rmdir /usr/local/lib/wattllama 2>/dev/null || true
fi

if command -v ufw >/dev/null && sudo ufw status 2>/dev/null | grep -q WattLlama; then
  while n=$(sudo ufw status numbered | grep WattLlama | head -n1 | sed -n 's/^\[ *\([0-9]*\)\].*/\1/p') && [ -n "$n" ]; do
    yes | sudo ufw delete "$n" >/dev/null
  done
  echo "Removed the WattLlama firewall rules"
fi

if [ "$REMOVE_DATA" -eq 1 ]; then rm -rf "$DIR/data"; echo "Deleted $DIR/data"; else echo "History kept in $DIR/data (--remove-data deletes it)"; fi
