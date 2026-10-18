#!/usr/bin/env bash
# Installs WattLlama for the current user on Linux: creates .env, a systemd user service that
# starts it when you log in, starts it now and opens the page. Runs as your user; sudo is asked
# only for the optional --rapl helper and the --allow-lan firewall rule.
#
#   ./install.sh               install / update and start
#   ./install.sh --rapl        also install the root helper that makes CPU + RAM power measurable
#   ./install.sh --allow-lan   also serve the page to your phone on the home network (token required)
#   ./install.sh --no-open     do not open the browser
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RAPL=0 ALLOW_LAN=0 NO_OPEN=0
for a in "$@"; do
  case "$a" in
    --rapl) RAPL=1 ;;
    --allow-lan) ALLOW_LAN=1 ;;
    --no-open) NO_OPEN=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done
if [ "$(id -u)" -eq 0 ]; then
  echo "Run install.sh as your normal user, not as root; it asks for sudo only where needed." >&2
  exit 1
fi

say() { printf '%s\n' "$*"; }
setting() { grep -E "^\s*$1\s*=" "$DIR/.env" 2>/dev/null | tail -n1 | sed -E "s/^\s*$1\s*=\s*//; s/\s*$//; s/^\"(.*)\"$/\1/"; }
set_setting() {   # set_setting KEY VALUE (replace or append)
  if grep -qE "^\s*$1\s*=" "$DIR/.env"; then sed -i -E "s|^\s*$1\s*=.*$|$1=$2|" "$DIR/.env"; else printf '\n%s=%s\n' "$1" "$2" >> "$DIR/.env"; fi
}

# --- Node.js 22.13+ (built-in SQLite) ---
NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  say "Node.js not found. Install Node.js 22.13 or newer (your distribution's package, nodejs.org, or nvm), then run this again."
  exit 1
fi
NODE=$(readlink -f "$NODE")
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  say "Node.js $("$NODE" --version) is too old; 22.13 or newer is required."
  exit 1
fi
say "Node.js $("$NODE" --version)  OK ($NODE)"

# --- .env ---
if [ ! -f "$DIR/.env" ]; then cp "$DIR/.env.example" "$DIR/.env"; say "Created .env from .env.example"; fi
# Settings (tokens, API keys, webhook URL) and history: readable by you only.
chmod 600 "$DIR/.env"; mkdir -p "$DIR/data"; chmod 700 "$DIR/data"
PORT=$(setting DASH_PORT); PORT=${PORT:-8091}
case "$PORT" in ''|*[!0-9]*) say "DASH_PORT in .env is not a number"; exit 1 ;; esac

if [ "$ALLOW_LAN" -eq 1 ]; then
  set_setting DASH_HOST 0.0.0.0
  if [ -z "$(setting DASH_TOKEN)" ]; then set_setting DASH_TOKEN "$("$NODE" -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"; fi
  chmod 600 "$DIR/.env"
  if command -v ufw >/dev/null; then
    if sudo ufw status 2>/dev/null | grep -q "Status: active"; then
      for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
        sudo ufw allow from "$net" to any port "$PORT" proto tcp comment WattLlama >/dev/null
      done
      say "Firewall (ufw): port $PORT open for private networks only"
    fi
  fi
  command -v firewall-cmd >/dev/null && say "firewalld: allow port $PORT/tcp in your home zone, e.g. sudo firewall-cmd --zone=home --add-port=$PORT/tcp --permanent"
  IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  say "Open this once on your phone (it remembers the token): http://${IP:-<this-pc>}:$PORT/?token=$(setting DASH_TOKEN)"
fi

# --- optional root helper for CPU + RAM power ---
if [ "$RAPL" -eq 1 ]; then
  if ! ls /sys/class/powercap/intel-rapl:* >/dev/null 2>&1; then
    say "RAPL: this machine has no RAPL counters (virtual machine, WSL or an unsupported CPU); skipping the helper."
  else
    say "RAPL: installing the root helper (asks for sudo)..."
    sudo install -D -o root -g root -m 0755 "$DIR/platform/rapl-helper.sh" /usr/local/lib/wattllama/rapl-helper
    sudo install -D -o root -g root -m 0644 "$DIR/platform/wattllama-rapl.service" /etc/systemd/system/wattllama-rapl.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now wattllama-rapl.service
    sudo systemctl restart wattllama-rapl.service
  fi
fi

# --- what this PC can measure ---
if command -v nvidia-smi >/dev/null; then say "GPU power:      nvidia-smi found, measured"; else say "GPU power:      no NVIDIA GPU (AMD / Intel GPUs are read from hwmon)"; fi
if [ -r /run/wattllama/rapl ] || systemctl is-active --quiet wattllama-rapl.service 2>/dev/null; then say "CPU power:      measured (RAPL helper)"
elif cat /sys/class/powercap/intel-rapl:0/energy_uj >/dev/null 2>&1; then say "CPU power:      measured (RAPL readable)"
elif ls /sys/class/powercap/intel-rapl:* >/dev/null 2>&1; then say "CPU power:      estimated from load; ./install.sh --rapl makes it measured (needs sudo once)"
else say "CPU power:      estimated from load (no RAPL counters here)"; fi
say "Sensors:        $(cat /sys/class/hwmon/hwmon*/name 2>/dev/null | sort -u | tr '\n' ' ' || true)"
for e in "llama.cpp http://127.0.0.1:8080/models" "Ollama http://127.0.0.1:11434/api/ps" "LM-Studio http://127.0.0.1:1234/api/v1/models"; do
  read -r name url <<< "$e"
  if curl -sf -m 2 -o /dev/null "$url" 2>/dev/null; then s="running, found"; else s="not running now (found automatically when it starts)"; fi
  printf '%-16s%s\n' "${name/-/ }:" "$s"
done

# --- systemd user service: starts at login, restarts on failure ---
URL="http://127.0.0.1:$PORT"
if systemctl --user show-environment >/dev/null 2>&1; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  # NoNewPrivileges blocks pkexec, which the optional GPU power-limit control needs.
  NNP="NoNewPrivileges=yes"; [ "$(setting DASH_ALLOW_POWER_LIMIT)" = "1" ] && NNP="# NoNewPrivileges off: DASH_ALLOW_POWER_LIMIT=1 uses pkexec"
  cat > "$UNIT_DIR/wattllama.service" <<EOF
[Unit]
Description=WattLlama power and token dashboard ($URL)
Documentation=https://github.com/depthark/wattllama

[Service]
WorkingDirectory=$DIR
ExecStart="$NODE" --no-warnings "$DIR/server.mjs"
Restart=always
RestartSec=10
Nice=10
IOSchedulingClass=idle
MemoryMax=1G
$NNP

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable wattllama.service >/dev/null 2>&1
  systemctl --user restart wattllama.service
  say "Service 'wattllama' installed (systemd user service, starts at login). Logs: journalctl --user -u wattllama"
else
  say "No systemd user session here: start it with  $DIR/start.sh &  (add that to your login startup)"
  nohup "$DIR/start.sh" >/dev/null 2>&1 &
fi

for _ in $(seq 1 20); do curl -sf -m 2 -o /dev/null "$URL/api/live" && break; sleep 1; done
say ""
say "WattLlama is running: $URL"
if [ "$NO_OPEN" -eq 0 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
