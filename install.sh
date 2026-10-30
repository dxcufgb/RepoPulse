#!/usr/bin/env bash
# RepoPulse installer for Linux (and macOS).
#
#   ./install.sh                 set up Python environment, config and admin account
#   ./install.sh --service       also install and start a systemd service (needs sudo)
#   ./install.sh --remove-service
#   ./install.sh --port 9000     use another port than 8080
#
# Automatic updates (systemd, needs the service; see README, Automatic updates):
#   ./install.sh --service --auto-update    install and turn automatic updates on (--no-auto-update: off)
#   ./install.sh --enable-auto-update       turn them on later    ./install.sh --disable-auto-update   off
#   ./install.sh --check-update             exit 0 = up to date, 10 = a newer release exists, 1 = could not check
#   ./install.sh --update-now               install a newer release now (whether or not daily updates are on)
#   ./install.sh --set-notify               who gets the update e-mails, and the mail server
set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$(pwd)"
PORT=""
SERVICE=0
REMOVE=0
AUTO=""        # "", on, off
ACTION=""      # enable, disable, check, now, notify
while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE=1 ;;
    --remove-service) REMOVE=1 ;;
    --port) PORT="${2:-}"; shift ;;
    --auto-update) AUTO=on ;;
    --no-auto-update) AUTO=off ;;
    --enable-auto-update) ACTION=enable ;;
    --disable-auto-update) ACTION=disable ;;
    --check-update) ACTION=check ;;
    --update-now) ACTION=now ;;
    --set-notify) ACTION=notify ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ------------------------------------------------------------------ automatic updates
UPDATE_LIB=/usr/local/lib/repopulse-update
UPDATE_CONF=/etc/repopulse/auto-update.conf
UPDATE_TOKEN=/etc/repopulse/updater-token
UNIT_DIR=/etc/systemd/system

service_user() { sed -n 's/^User=//p' "$UNIT_DIR/repopulse.service" 2>/dev/null | head -n 1; }
auto_update_on() { [ -f "$UPDATE_CONF" ]; }

enable_auto_update() {  # run user
  local run_user="$1" py
  if [ ! -f "$UNIT_DIR/repopulse.service" ]; then
    echo "Automatic updates need the service: run ./install.sh --service --auto-update"
    return 1
  fi
  if [ -e "$APP_DIR/.git" ]; then
    echo "This folder is a git checkout: update it with git pull. Automatic updates are for installs from a release archive."
    return 1
  fi
  # root runs the updater with the system Python, never with the .venv the service account can change
  py="$(readlink -f "$(command -v python3 || true)" 2>/dev/null || true)"
  if [ -z "$py" ] || [ "$(stat -c %u "$py")" != 0 ]; then
    echo "Automatic updates need python3 owned by root (the system Python); found: ${py:-none}"
    return 1
  fi
  sudo install -d -m 755 /etc/repopulse "$UPDATE_LIB"
  sudo install -m 755 "$APP_DIR/auto-update.sh" "$UPDATE_LIB/auto-update.sh"
  sudo install -m 644 "$APP_DIR/repopulse/updater.py" "$UPDATE_LIB/updater.py"
  if [ -n "${UPDATER_GITHUB_TOKEN:-}" ]; then
    (umask 077 && printf '%s\n' "$UPDATER_GITHUB_TOKEN" | sudo tee "$UPDATE_TOKEN" >/dev/null)
    sudo chmod 600 "$UPDATE_TOKEN"
    echo "Stored the updater's GitHub token in $UPDATE_TOKEN (root only)."
  fi
  printf 'APP_DIR=%s\nRUN_USER=%s\nPYTHON=%s\nTOKEN_FILE=%s\n' "$APP_DIR" "$run_user" "$py" "$UPDATE_TOKEN" \
    | sudo tee "$UPDATE_CONF" >/dev/null
  sudo chmod 644 "$UPDATE_CONF"
  # written by RepoPulse for "Update now" on the admin page; root only watches it, never reads it
  sudo -u "$run_user" sh -c ': >> "$1"' sh "$APP_DIR/data/update-request" 2>/dev/null || {
    sudo touch "$APP_DIR/data/update-request"; sudo chown "$run_user": "$APP_DIR/data/update-request"; }
  sudo tee "$UNIT_DIR/repopulse-update.service" >/dev/null <<EOF
[Unit]
Description=RepoPulse automatic update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$UPDATE_LIB/auto-update.sh --run
TimeoutStartSec=30min
EOF
  sudo tee "$UNIT_DIR/repopulse-update.timer" >/dev/null <<EOF
[Unit]
Description=Daily check for a new RepoPulse release

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF
  sudo tee "$UNIT_DIR/repopulse-update-now.path" >/dev/null <<EOF
[Unit]
Description=Update RepoPulse when the admin page asks for it

[Path]
PathModified=$APP_DIR/data/update-request
Unit=repopulse-update.service

[Install]
WantedBy=paths.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now repopulse-update.timer repopulse-update-now.path >/dev/null
  echo "Automatic updates are on: a daily check, and Update now on Admin, Settings. Log: journalctl -u repopulse-update"
}

disable_auto_update() {
  sudo systemctl disable --now repopulse-update.timer repopulse-update-now.path 2>/dev/null || true
  sudo rm -f "$UNIT_DIR/repopulse-update.service" "$UNIT_DIR/repopulse-update.timer" "$UNIT_DIR/repopulse-update-now.path"
  sudo systemctl daemon-reload
  sudo rm -rf "$UPDATE_LIB"
  sudo rm -f "$UPDATE_CONF" "$UPDATE_TOKEN"
  sudo rmdir /etc/repopulse 2>/dev/null || true
  rm -f "$APP_DIR/data/update-request" 2>/dev/null || sudo rm -f "$APP_DIR/data/update-request"
  echo "Automatic updates are off."
}

ask_notify() {  # e-mail settings: from REPOPULSE_NOTIFY_EMAILS / REPOPULSE_SMTP_*, else asked when there is a terminal
  local run_user="$1"
  if [ -n "${REPOPULSE_NOTIFY_EMAILS:-}" ]; then
    sudo -u "$run_user" --preserve-env=REPOPULSE_NOTIFY_EMAILS,REPOPULSE_SMTP_HOST,REPOPULSE_SMTP_PORT,REPOPULSE_SMTP_SECURITY,REPOPULSE_SMTP_USER,REPOPULSE_SMTP_PASSWORD,REPOPULSE_SMTP_FROM \
      "$APP_DIR/.venv/bin/python" -m repopulse set-notify --from-env
  elif [ -t 0 ]; then
    echo "Update e-mails: RepoPulse can e-mail you when it installs an update or an update fails."
    sudo -u "$run_user" "$APP_DIR/.venv/bin/python" -m repopulse set-notify || true
  else
    echo "Set who gets the update e-mails on Admin, Settings, Notifications, or with ./install.sh --set-notify"
  fi
}

case "$ACTION" in
  enable)
    say "Turning automatic updates on"
    enable_auto_update "$(service_user)"
    ask_notify "$(service_user)"
    exit 0 ;;
  disable)
    say "Turning automatic updates off"
    disable_auto_update
    exit 0 ;;
  check)
    if auto_update_on; then
      set +e; sudo "$UPDATE_LIB/auto-update.sh" --check; rc=$?; set -e
    else
      set +e; .venv/bin/python -m repopulse check-update; rc=$?; set -e
    fi
    case "$rc" in 0) echo "Up to date." ;; 10) echo "A newer release is available: ./install.sh --update-now" ;; 75) echo "Another update run is busy." ;; *) echo "Could not check." ;; esac
    exit "$rc" ;;
  now)
    if ! auto_update_on; then
      echo "The updater is not set up. Turn it on with ./install.sh --enable-auto-update (needs the service)."
      exit 1
    fi
    say "Updating RepoPulse"
    set +e; sudo systemctl start repopulse-update.service; rc=$?; set -e
    sudo journalctl -u repopulse-update --since "-15min" --no-pager -o cat | tail -n 30 || true
    exit "$rc" ;;
  notify)
    ask_notify "${SUDO_USER:-$(id -un)}"
    exit 0 ;;
esac

if [ "$REMOVE" = 1 ]; then
  say "Removing the repopulse systemd service"
  if auto_update_on; then disable_auto_update; fi
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

  # automatic updates: keep the earlier choice unless told otherwise; a first install asks
  if [ -z "$AUTO" ]; then
    if auto_update_on; then AUTO=on
    elif [ -t 0 ] && [ ! -e "$APP_DIR/.git" ]; then
      read -r -p "Install new RepoPulse releases automatically (checked daily)? [y/N] " answer
      case "$answer" in [yY]*) AUTO=on ;; esac
    fi
  fi
  if [ "$AUTO" = on ]; then
    say "Automatic updates"
    first=1; auto_update_on && first=0
    enable_auto_update "$RUN_USER"
    if [ "$first" = 1 ]; then ask_notify "$RUN_USER"; fi
  elif [ "$AUTO" = off ] && auto_update_on; then
    disable_auto_update
  fi
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
