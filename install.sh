#!/usr/bin/env bash
# RepoPulse installer for Linux (and macOS).
#
#   ./install.sh                 set up Python environment, config and admin account
#   ./install.sh --service       also install and start a systemd service (needs sudo)
#   ./install.sh --remove-service
#   ./install.sh --port 9000     use another port than 8080
set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$(pwd)"
PORT=""
SERVICE=0
REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE=1 ;;
    --remove-service) REMOVE=1 ;;
    --port) PORT="${2:-}"; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "$REMOVE" = 1 ]; then
  say "Removing the repopulse systemd service"
  sudo systemctl disable --now repopulse.service 2>/dev/null || true
  sudo rm -f /etc/systemd/system/repopulse.service
  sudo systemctl daemon-reload
  echo "Service removed. Your data in $APP_DIR/data is untouched."
  exit 0
fi

say "1/4  Checking Python"
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
    PY="$c"; break
  fi
done
if [ -z "$PY" ]; then
  echo "Python 3.9 or newer is needed. On Debian/Ubuntu/Raspberry Pi OS: sudo apt install python3 python3-venv"
  exit 1
fi
echo "Using $($PY --version)"

say "2/4  Creating the virtual environment in .venv"
if [ ! -x .venv/bin/python ]; then
  if ! "$PY" -m venv .venv; then
    echo "Could not create a virtual environment. On Debian/Ubuntu/Raspberry Pi OS run: sudo apt install python3-venv"
    exit 1
  fi
fi
.venv/bin/python -m pip install --upgrade pip >/dev/null
.venv/bin/python -m pip install -r requirements.txt

say "3/4  Configuration"
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "Created config.json"
fi
if [ -n "$PORT" ]; then
  .venv/bin/python - "$PORT" <<'EOF'
import json, sys
cfg = json.load(open("config.json"))
cfg["port"] = int(sys.argv[1])
json.dump(cfg, open("config.json", "w"), indent=2)
EOF
  echo "Port set to $PORT"
fi
mkdir -p data

say "4/4  Admin account"
HAS_ADMIN=$(.venv/bin/python -c 'from repopulse.config import load_config; from repopulse.db import Database; from repopulse.auth import user_count; print(user_count(Database(load_config().db_path)))')
if [ "$HAS_ADMIN" != "0" ]; then
  echo "An admin account already exists. Change its password with: .venv/bin/python -m repopulse set-password"
elif [ -t 0 ]; then
  .venv/bin/python -m repopulse create-admin
else
  echo "Skipped (no terminal). Create it later with: .venv/bin/python -m repopulse create-admin"
fi

if [ "$SERVICE" = 1 ]; then
  say "Installing the systemd service"
  RUN_USER="${SUDO_USER:-$(id -un)}"
  # If the installer ran with sudo, the files it created belong to root and the
  # service (which runs as $RUN_USER) could not write its data. Hand them back.
  sudo chown -R "$RUN_USER": "$APP_DIR"
  sudo tee /etc/systemd/system/repopulse.service >/dev/null <<EOF
[Unit]
Description=RepoPulse GitHub download statistics
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/python -m repopulse serve
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now repopulse.service
  echo "Service installed and started. Logs: journalctl -u repopulse -f"
fi

PORT_NOW=$(.venv/bin/python -c 'from repopulse.config import load_config; print(load_config().port)')
say "Done"
if [ "$SERVICE" = 1 ]; then
  echo "RepoPulse runs in the background and starts with the computer."
else
  echo "Start RepoPulse with:  ./run.sh"
  echo "Run it in the background at boot with:  ./install.sh --service"
fi
echo "Dashboard: http://localhost:$PORT_NOW/    Admin: http://localhost:$PORT_NOW/admin"
