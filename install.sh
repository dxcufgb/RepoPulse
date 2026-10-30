#!/usr/bin/env bash
# RepoPulse installer for Linux (systemd). Run it from the extracted release folder:
#
#   tar xzf repopulse-linux.tar.gz && cd repopulse-*/ && sudo ./install.sh
#   once installed also: sudo /opt/repopulse/install.sh [options]
#
# Options:
#   (none)                  Install or upgrade in place, interactive (asks for what it needs)
#   --yes, -y               Non-interactive: no questions (the admin account is created only when
#                           REPOPULSE_ADMIN_USERNAME and REPOPULSE_ADMIN_PASSWORD are set)
#   --auto-update           Turn automatic updates on as part of this install
#   --no-auto-update        Turn automatic updates off as part of this install (without either, an upgrade keeps the
#                           current choice and a first interactive install asks)
#   --enable-auto-update    Turn automatic updates on for the existing install, nothing else
#   --disable-auto-update   Turn them off (and delete a stored GitHub token) for the existing install, nothing else
#   --check-update          Only check: exit 0 = up to date, 10 = newer release available, other = error
#   --update-now            Install the latest release now (same path as the daily updater)
#   --uninstall [--purge]   Remove the service and the program (keep / also delete settings, data and the user)
#   --help, -h              Show this help
#
# RepoPulse options:
#   --port N                Listen on port N (default 8080; kept on upgrades unless given again)
#   --host ADDRESS          Listen on this address (default 0.0.0.0 = all; 127.0.0.1 = this computer only)
#   --migrate-from DIR      Copy the database, session key and settings of an older RepoPulse folder
#                           (one unpacked and started with ./run.sh or an old "install.sh --service")
#   --no-migrate            Do not look for an older RepoPulse folder
#   --set-notify            Set who gets the update e-mails and the mail server, nothing else
#   PYTHON=/path            Use this Python 3.9+ instead of searching PATH (environment variable)
#
# Unattended: REPOPULSE_ADMIN_USERNAME and REPOPULSE_ADMIN_PASSWORD create the admin account; REPOPULSE_NOTIFY_EMAILS
# and REPOPULSE_SMTP_HOST, _PORT, _SECURITY, _USER, _PASSWORD, _FROM set the update e-mails; UPDATER_GITHUB_TOKEN gives
# the updater its own GitHub token (not needed: the repository is public). Secrets are never taken as arguments.
#
# Automatic updates (off unless turned on): a root systemd timer (repopulse-update.timer, daily) and Update now on
# Admin, Settings run /usr/local/lib/repopulse-update/auto-update.sh, which downloads the latest release, checks it
# against SHA256SUMS.txt, backs up /opt/repopulse, runs that release's install.sh and puts the backup back if the new
# version does not answer. Settings and data are never replaced. Log: journalctl -u repopulse-update
#
# Layout (the same on every machine; upgrades keep the settings and the data):
#   /opt/repopulse/              program files and .venv (owned by root; only root can change them)
#   /etc/repopulse/config.json   server settings (root:repopulse, 640)
#   /var/lib/repopulse/          database and session key (owned by the system user repopulse, 750)
#   /usr/local/bin/repopulse     the command line, run as the repopulse user (sudo repopulse status)
#   repopulse.service            the systemd service; logs: journalctl -u repopulse
#   /usr/local/lib/repopulse-update/, /etc/repopulse/auto-update.conf   the updater (root), when turned on
#
# Older versions ran RepoPulse from the folder it was unpacked in (for example ~/Downloads/repopulse-1.1.0). When the
# new data folder is still empty, this installer looks for such a folder (the one it runs from, the folder of an
# existing repopulse.service, and RepoPulse folders in the home folders, /opt and /srv), copies its database, session
# key and settings, and leaves the old folder untouched (a MOVED.txt in its data folder says where the data went).
set -euo pipefail
# Program files must not be writable by group or others.
umask 022

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
SRC_DIR="$(dirname "$SCRIPT")"
INSTALL_DIR="/opt/repopulse"
CONF_DIR="/etc/repopulse"
CONFIG="$CONF_DIR/config.json"
DEFAULT_DATA_DIR="/var/lib/repopulse"
SERVICE_USER="repopulse"
SERVICE_NAME="repopulse"
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
WRAPPER="/usr/local/bin/repopulse"
APP_FILES=(repopulse README.md LICENSE requirements.txt config.example.json install.sh auto-update.sh)
UPDATE_LIB="/usr/local/lib/repopulse-update"
UPDATE_CONF="$CONF_DIR/auto-update.conf"
UPDATE_TOKEN="$CONF_DIR/updater-token"
UPDATE_BACKUPS="/var/backups/repopulse-update"
UPDATE_UNIT="repopulse-update"
# Files of older releases that have no place in the program folder any more.
OLD_FILES=(run.sh run.bat install.bat install.ps1 config.json data .cache)

ASSUME_YES=0
ACTION="install"
PURGE=0
PORT=""
HOST=""
MIGRATE_FROM=""
MIGRATE=1
AUTO_UPDATE=""  # "" = keep the current choice, on, off

die() { echo "Error: $*" >&2; exit 1; }
info() { echo "==> $*"; }
warn() { echo "Warning: $*" >&2; }
interactive() { [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; }
confirm() {
    [ "$ASSUME_YES" -eq 1 ] && return 0
    [ -t 0 ] || return 1
    local answer
    # End of input (no answer at all) is a no, never the default yes.
    read -r -p "$1 [Y/n] " answer || return 1
    [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}
show_help() {
    awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$SCRIPT"
}

# --help works without root.
for arg in "$@"; do
    case "$arg" in
        -h | --help) show_help; exit 0 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    command -v sudo > /dev/null || die "run this script as root"
    keep=REPOPULSE_ADMIN_USERNAME,REPOPULSE_ADMIN_PASSWORD,PYTHON,UPDATER_GITHUB_TOKEN,REPOPULSE_NOTIFY_EMAILS
    keep+=,REPOPULSE_SMTP_HOST,REPOPULSE_SMTP_PORT,REPOPULSE_SMTP_SECURITY,REPOPULSE_SMTP_USER,REPOPULSE_SMTP_PASSWORD
    keep+=,REPOPULSE_SMTP_FROM
    exec sudo --preserve-env="$keep" bash "$SCRIPT" "$@"
fi
# Set by the dxcufgb/install one-line installer when it was given a token; RepoPulse does not need it.
unset INSTALL_GITHUB_TOKEN

while [ $# -gt 0 ]; do
    case "$1" in
        --port) PORT="${2:?--port needs a number}"; shift 2 ;;
        --host) HOST="${2:?--host needs an address}"; shift 2 ;;
        --migrate-from) MIGRATE_FROM="${2:?--migrate-from needs a folder}"; shift 2 ;;
        --no-migrate) MIGRATE=0; shift ;;
        --yes | -y) ASSUME_YES=1; shift ;;
        --uninstall) ACTION="uninstall"; shift ;;
        --purge) PURGE=1; shift ;;
        --auto-update) AUTO_UPDATE=on; shift ;;
        --no-auto-update) AUTO_UPDATE=off; shift ;;
        --enable-auto-update) ACTION="enable-update"; shift ;;
        --disable-auto-update) ACTION="disable-update"; shift ;;
        --check-update) ACTION="check-update"; shift ;;
        --update-now) ACTION="update-now"; shift ;;
        --set-notify) ACTION="set-notify"; shift ;;
        # Options of older versions: RepoPulse is now always installed as a service.
        --service) shift ;;
        --remove-service) ACTION="uninstall"; shift ;;
        -h | --help) show_help; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done
if [ -n "$PORT" ] && { [[ ! "$PORT" =~ ^[0-9]{1,5}$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; }; then
    die "--port must be a number from 1 to 65535"
fi
if [ -n "$HOST" ] && [[ ! "$HOST" =~ ^[0-9A-Za-z.:-]+$ ]]; then
    die "--host must be an IP address or a host name"
fi
# Started through a pipe (curl ... | sudo bash) but from a terminal: ask the questions there.
if [ "$ASSUME_YES" -eq 0 ] && [ ! -t 0 ] && { true < /dev/tty; } 2> /dev/null; then
    exec < /dev/tty
fi

if ! command -v systemctl > /dev/null || [ ! -d /run/systemd/system ]; then
    die "systemd is not running here. Without systemd, run RepoPulse by hand (README.md, \"Without the installer\")."
fi

# -- Python ----------------------------------------------------------------------------------------------------------

python_ok() {
    "$1" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2> /dev/null
}

find_python() {
    local candidate
    for candidate in python3 python3.13 python3.12 python3.11 python3.10 python3.9; do
        if command -v "$candidate" > /dev/null && python_ok "$candidate"; then
            command -v "$candidate"
            return 0
        fi
    done
    return 1
}

install_packages() {
    if command -v apt-get > /dev/null; then
        # apt-get update fails as a whole when one source is broken; try to install with what it has.
        apt-get update -qq || warn "some package sources could not be refreshed; trying to install anyway"
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
    elif command -v dnf > /dev/null; then
        dnf install -y -q "$@"
    elif command -v pacman > /dev/null; then
        pacman -S --noconfirm --needed "$@"
    elif command -v zypper > /dev/null; then
        zypper --non-interactive install "$@"
    else
        return 1
    fi
}

ensure_python() {
    if [ -n "${PYTHON:-}" ]; then
        python_ok "$PYTHON" || die "PYTHON=$PYTHON is not a Python 3.9+ interpreter"
        PYTHON="$(command -v "$PYTHON")"
    elif ! PYTHON="$(find_python)"; then
        local pkg="python3"
        command -v pacman > /dev/null && pkg="python"
        confirm "Python 3.9 or newer is required. Install it with the package manager now?" \
            || die "install Python 3.9+ and run this script again"
        install_packages "$pkg" || die "could not install Python automatically; install Python 3.9+ by hand"
        PYTHON="$(find_python)" || die "the Python of this system is older than 3.9; install Python 3.9+ and run this again with PYTHON=/path/to/python3"
    fi
    case "$(readlink -f "$PYTHON")" in
        /home/* | /root/*) die "$PYTHON is in a home folder; the service cannot use it. Use a Python installed system-wide." ;;
    esac
    # Debian and Ubuntu ship venv separately.
    if ! "$PYTHON" -c 'import venv, ensurepip' 2> /dev/null; then
        local version
        version="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
        confirm "The Python venv module is missing. Install it now?" \
            || die "install the venv module for $PYTHON (for example: apt install python$version-venv)"
        install_packages "python$version-venv" || install_packages python3-venv \
            || die "could not install the venv module; install python$version-venv by hand"
    fi
    info "Using $PYTHON ($("$PYTHON" --version 2>&1))"
}

# -- helpers ---------------------------------------------------------------------------------------------------------

as_user() { # USER COMMAND...: run a command as USER, keeping the environment
    local user="$1"
    shift
    if [ "$user" = root ]; then
        "$@"
    elif command -v runuser > /dev/null; then
        runuser -u "$user" -- "$@"
    else
        sudo -u "$user" -- "$@"
    fi
}

config_value() { # KEY [DEFAULT]: a value from the installed config.json
    "$PYTHON" -I - "$CONFIG" "$1" "${2:-}" <<'EOF'
import json, sys
try:
    value = json.load(open(sys.argv[1], encoding="utf-8-sig")).get(sys.argv[2])
except (OSError, ValueError, AttributeError):
    value = None
print(sys.argv[3] if value in (None, "") else value)
EOF
}

is_repopulse_folder() { [ -f "$1/repopulse/__init__.py" ] && [ -f "$1/repopulse/__main__.py" ]; }

stop_service() {
    if systemctl is-active --quiet "$SERVICE_NAME" 2> /dev/null; then
        info "Stopping the running RepoPulse service"
        systemctl stop "$SERVICE_NAME"
    fi
}

# -- moving an older install -----------------------------------------------------------------------------------------

old_data_dir() { # DIR: the data folder of an older RepoPulse folder (its config.json may name another one)
    local owner
    owner="$(stat -c %U "$1")"
    as_user "$owner" cat "$1/config.json" 2> /dev/null | "$PYTHON" -I -c '
import json, os, sys
folder, value = sys.argv[1], "data"
try:
    value = json.loads(sys.stdin.read().lstrip("﻿")).get("data_dir") or "data"
except (ValueError, AttributeError):
    pass
value = os.path.expanduser(str(value))
print(os.path.normpath(value if os.path.isabs(value) else os.path.join(folder, value)))' "$1"
}

has_database() { [ -f "$1/repopulse.db" ] && [ ! -L "$1/repopulse.db" ] && [ -s "$1/repopulse.db" ]; }

# Prints the older RepoPulse folders that have a database, one per line, the most recently used first.
find_old_installs() {
    local dirs=() dir db unit_dir seen="" data
    dirs+=("$SRC_DIR" "$INSTALL_DIR")
    if [ -f "$UNIT_FILE" ]; then
        unit_dir="$(sed -n 's/^WorkingDirectory=//p' "$UNIT_FILE" | head -n 1)"
        [ -n "$unit_dir" ] && dirs+=("$unit_dir")
    fi
    if [ -f "$UPDATE_CONF" ]; then
        unit_dir="$(sed -n 's/^APP_DIR=//p' "$UPDATE_CONF" | head -n 1)"
        [ -n "$unit_dir" ] && dirs+=("$unit_dir")
    fi
    while IFS= read -r -d '' db; do
        dirs+=("$(dirname "$(dirname "$db")")")
    done < <(find /home /root /opt /srv -maxdepth 6 -xdev -type f -name repopulse.db -path '*/data/repopulse.db' \
        -print0 2> /dev/null)
    for dir in "${dirs[@]}"; do
        dir="$(readlink -f "$dir" 2> /dev/null)" || continue
        if [ ! -d "$dir" ] || ! is_repopulse_folder "$dir"; then continue; fi
        case "$seen" in *"|$dir|"*) continue ;; esac
        seen="$seen|$dir|"
        data="$(old_data_dir "$dir")"
        if [ "$data" = "$DATA_DIR" ] || ! has_database "$data"; then continue; fi
        printf '%s %s\n' "$(stat -c %Y "$data/repopulse.db")" "$dir"
    done | sort -rn | cut -d' ' -f2-
}

# Copies the database (a consistent copy, even while an old RepoPulse still runs), the session key and the settings
# of an older folder. Everything there is read as the owner of that folder, never as root, so links in it cannot
# make root read other files.
migrate_from() {
    local dir="$1" data owner tmp mine
    data="$(old_data_dir "$dir")"
    has_database "$data" || die "no RepoPulse database in $data"
    owner="$(stat -c %U "$data/repopulse.db")"
    info "Copying the database, session key and settings of $dir"
    # tmp: where the owner writes the copy; mine: root's own folder next to the data folder, from which the files
    # are renamed into place (a rename never follows a link).
    tmp="$(mktemp -d)"
    chown "$owner" "$tmp"
    mine="$(mktemp -d "$(dirname "$DATA_DIR")/.repopulse-migrate.XXXXXX")"
    as_user "$owner" "$PYTHON" -I -c '
import sqlite3, sys
src = sqlite3.connect(sys.argv[1], timeout=30)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()' "$data/repopulse.db" "$tmp/repopulse.db" \
        || { rm -rf "$tmp" "$mine"; die "could not copy $data/repopulse.db"; }
    as_user "$owner" cat "$tmp/repopulse.db" > "$mine/repopulse.db"
    chown "$SERVICE_USER:$SERVICE_USER" "$mine/repopulse.db"
    chmod 640 "$mine/repopulse.db"
    mv -T "$mine/repopulse.db" "$DATA_DIR/repopulse.db"
    if [ -f "$data/secret.key" ] && [ ! -L "$data/secret.key" ]; then
        as_user "$owner" cat "$data/secret.key" > "$mine/secret.key"
        chown "$SERVICE_USER:$SERVICE_USER" "$mine/secret.key"
        chmod 600 "$mine/secret.key"
        mv -T "$mine/secret.key" "$DATA_DIR/secret.key"
    fi
    if [ -f "$dir/config.json" ] && [ ! -L "$dir/config.json" ]; then
        MIGRATED_CONFIG="$(as_user "$(stat -c %U "$dir")" cat "$dir/config.json" 2> /dev/null || true)"
    fi
    rm -rf "$tmp" "$mine"
    if [ "$(readlink -f "$dir")" != "$INSTALL_DIR" ]; then
        # shellcheck disable=SC2016 # $1 and $2 are expanded by that sh
        as_user "$owner" sh -c 'printf "%s\n" "$1" > "$2"' sh \
            "This RepoPulse data was copied to $DATA_DIR on $(date '+%Y-%m-%d %H:%M') and is no longer used. RepoPulse now runs as the repopulse service (sudo repopulse status). You can delete $dir." \
            "$data/MOVED.txt" 2> /dev/null || true
        MIGRATED_NOTE="$dir"
    fi
}


# -- automatic updates -----------------------------------------------------------------------------------------------
# Root runs the updater with the system Python, from root's own copy in $UPDATE_LIB. Everything it installs into
# (/opt/repopulse, /etc/repopulse) belongs to root; the service account only writes the data folder, where
# "Update now" on the admin page touches data/update-request (a systemd path unit watches it; root never reads it).

auto_update_on() { [ -f "$UPDATE_CONF" ]; }

require_root_python() {
    local real
    real="$(readlink -f "$PYTHON")"
    if [ "$(stat -c %u "$real")" != 0 ] || [ -n "$(find "$real" -maxdepth 0 -perm /022 2> /dev/null)" ]; then
        die "automatic updates run $real as root, but it is not root's alone; use a Python installed system-wide (PYTHON=/usr/bin/python3)"
    fi
}

install_updater() {
    require_root_python
    local f tmp
    install -d -m 755 -o root -g root "$UPDATE_LIB" "$CONF_DIR"
    for f in "$INSTALL_DIR/auto-update.sh" "$INSTALL_DIR/repopulse/updater.py"; do
        [ -f "$f" ] || die "this RepoPulse version has no updater ($f is missing)"
        tmp="$(mktemp "$UPDATE_LIB/.new.XXXXXX")"
        cp "$f" "$tmp"
        chmod 755 "$tmp"
        # a rename: an updater that is running right now keeps reading its old copy
        mv -f "$tmp" "$UPDATE_LIB/$(basename "$f")"
    done
    if [ -n "${UPDATER_GITHUB_TOKEN:-}" ]; then
        tmp="$(umask 077 && mktemp "$CONF_DIR/.updater-token.XXXXXX")"
        printf '%s\n' "$UPDATER_GITHUB_TOKEN" > "$tmp"
        chmod 600 "$tmp"
        mv -f "$tmp" "$UPDATE_TOKEN"
        echo "    stored the updater's GitHub token in $UPDATE_TOKEN (root only)"
    fi
    printf 'PYTHON=%s\nTOKEN_FILE=%s\n' "$(readlink -f "$PYTHON")" "$UPDATE_TOKEN" > "$UPDATE_CONF"
    chmod 644 "$UPDATE_CONF"
    # "Update now" on the admin page writes this file; the service account owns it, root only watches it
    # shellcheck disable=SC2016 # $1 is expanded by that sh
    as_user "$SERVICE_USER" sh -c ': >> "$1"' sh "$DATA_DIR/update-request"
    cat > "/etc/systemd/system/$UPDATE_UNIT.service" <<EOF
# Written by $INSTALL_DIR/install.sh
[Unit]
Description=RepoPulse automatic update
Documentation=https://github.com/dxcufgb/RepoPulse#automatic-updates
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$UPDATE_LIB/auto-update.sh --run
TimeoutStartSec=30min
UMask=0022
PrivateTmp=yes
EOF
    cat > "/etc/systemd/system/$UPDATE_UNIT.timer" <<EOF
[Unit]
Description=Daily check for a new RepoPulse release

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF
    cat > "/etc/systemd/system/$UPDATE_UNIT-now.path" <<EOF
[Unit]
Description=Update RepoPulse when the admin page asks for it

[Path]
PathModified=$DATA_DIR/update-request
Unit=$UPDATE_UNIT.service

[Install]
WantedBy=paths.target
EOF
    chmod 644 "/etc/systemd/system/$UPDATE_UNIT".{service,timer} "/etc/systemd/system/$UPDATE_UNIT-now.path"
    systemctl daemon-reload
    systemctl enable --quiet "$UPDATE_UNIT.timer" "$UPDATE_UNIT-now.path"
    systemctl start "$UPDATE_UNIT.timer" "$UPDATE_UNIT-now.path"
}

remove_updater() {
    local unit
    if [ -f "/etc/systemd/system/$UPDATE_UNIT.timer" ] || [ -f "/etc/systemd/system/$UPDATE_UNIT.service" ]; then
        info "Turning automatic updates off"
        systemctl disable --now "$UPDATE_UNIT.timer" "$UPDATE_UNIT-now.path" 2> /dev/null || true
        for unit in "$UPDATE_UNIT.service" "$UPDATE_UNIT.timer" "$UPDATE_UNIT-now.path"; do
            rm -f "/etc/systemd/system/$unit"
        done
        systemctl daemon-reload
    fi
    rm -rf "$UPDATE_LIB"
    rm -f "$UPDATE_CONF" "$UPDATE_TOKEN" "${DATA_DIR:-$DEFAULT_DATA_DIR}/update-request"
}

ask_notify() { # the update e-mails: from the environment, asked for at a terminal, or left to the admin page
    if [ -n "${REPOPULSE_NOTIFY_EMAILS:-}" ]; then
        "$WRAPPER" set-notify --from-env < /dev/null || warn "the update e-mail settings were not saved"
    elif interactive; then
        echo "RepoPulse can e-mail you when it installs an update or an update fails (empty = no e-mails)."
        "$WRAPPER" set-notify || true
    else
        echo "Set who gets the update e-mails on Admin, Settings, or with: sudo $INSTALL_DIR/install.sh --set-notify"
    fi
}

require_installed() {
    [ -x "$WRAPPER" ] && is_repopulse_folder "$INSTALL_DIR" && [ -x "$INSTALL_DIR/.venv/bin/python" ] \
        || die "RepoPulse is not installed in $INSTALL_DIR; run install.sh from the release folder first"
    PYTHON="$(find_python)" || die "no Python 3.9+ found"
    DATA_DIR="$(config_value data_dir "$DEFAULT_DATA_DIR")"
}

do_check_update() {
    require_installed
    local rc=0
    if auto_update_on; then
        "$UPDATE_LIB/auto-update.sh" --check || rc=$?
    else
        "$WRAPPER" check-update || rc=$?
    fi
    case "$rc" in
        0) echo "Up to date." ;;
        10) echo "A newer release is available: sudo $INSTALL_DIR/install.sh --update-now" ;;
        75) echo "Another update run is busy." ;;
        *) echo "Could not check." ;;
    esac
    exit "$rc"
}

do_update_now() {
    require_installed
    auto_update_on || die "the updater is not set up; turn it on with: sudo $INSTALL_DIR/install.sh --enable-auto-update"
    local since rc=0
    since="$(date +%s)"
    info "Updating RepoPulse (this can take a few minutes)"
    systemctl start "$UPDATE_UNIT.service" || rc=$?
    journalctl -u "$UPDATE_UNIT" --since "@$since" --no-pager -o cat || true
    [ "$rc" -eq 0 ] || die "the update failed (see above, or: journalctl -u $UPDATE_UNIT)"
}

# -- install ---------------------------------------------------------------------------------------------------------

write_config() {
    local tmp
    install -d -m 755 -o root -g root "$CONF_DIR"
    tmp="$(mktemp "$CONF_DIR/.config.XXXXXX")"
    MIGRATED_CONFIG="${MIGRATED_CONFIG:-}" "$PYTHON" -I - "$CONFIG" "$INSTALL_DIR/config.example.json" \
        "$DEFAULT_DATA_DIR" "$PORT" "$HOST" > "$tmp" <<'EOF' || { rm -f "$tmp"; die "could not write $CONFIG"; }
import json, os, sys
config, example, data_dir, port, host = sys.argv[1:6]
def load(text):
    try:
        value = json.loads(text.lstrip("﻿"))
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}
if os.path.exists(config):
    cfg = load(open(config, encoding="utf-8-sig").read())
else:
    cfg = load(open(example, encoding="utf-8").read())
    cfg["data_dir"] = data_dir
    # settings of the older install this one replaces; its data folder is not one of them
    old = load(os.environ.get("MIGRATED_CONFIG", ""))
    for key in ("host", "port", "behind_proxy", "secure_cookies", "allow_remote_setup", "github_api_url", "threads"):
        if key in old:
            cfg[key] = old[key]
if port:
    cfg["port"] = int(port)
if host:
    cfg["host"] = host
if not os.path.isabs(str(cfg.get("data_dir") or "")):
    cfg["data_dir"] = data_dir
print(json.dumps(cfg, indent=2))
EOF
    chown root:"$SERVICE_USER" "$tmp"
    chmod 640 "$tmp"
    mv -f "$tmp" "$CONFIG"
}

write_wrapper() {
    cat > "$WRAPPER" <<EOF
#!/bin/sh
# The RepoPulse command line (written by $INSTALL_DIR/install.sh). Runs as the $SERVICE_USER user with the
# installed settings, for example:  sudo repopulse status | create-admin | set-password | collect
# (repopulse --help lists the commands; "serve" is what the $SERVICE_NAME service runs).
set -e
cd $INSTALL_DIR
if [ "\$(id -u)" -eq 0 ]; then
    exec runuser -u $SERVICE_USER -- $INSTALL_DIR/.venv/bin/python -m repopulse --config $CONFIG "\$@"
elif [ "\$(id -un)" = $SERVICE_USER ]; then
    exec $INSTALL_DIR/.venv/bin/python -m repopulse --config $CONFIG "\$@"
fi
exec sudo --preserve-env=REPOPULSE_ADMIN_USERNAME,REPOPULSE_ADMIN_PASSWORD "\$0" "\$@"
EOF
    chown root:root "$WRAPPER"
    chmod 755 "$WRAPPER"
}

write_unit() {
    local port="$1" caps=""
    if [ "$port" -lt 1024 ]; then
        caps=$'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE'
    else
        caps="CapabilityBoundingSet="
    fi
    cat > "$UNIT_FILE" <<EOF
# Written by $INSTALL_DIR/install.sh; running it again rewrites this file.
[Unit]
Description=RepoPulse GitHub release download statistics
Documentation=https://github.com/dxcufgb/RepoPulse
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/.venv/bin/python -m repopulse --config $CONFIG serve
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
UMask=0027
$caps
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA_DIR
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "$UNIT_FILE"
}

port_in_use() {
    command -v ss > /dev/null || return 1
    [ -n "$(ss -Hltn "sport = :$1" 2> /dev/null)" ]
}

wait_until_up() { # URL
    local _
    for _ in $(seq 1 30); do
        if "$INSTALL_DIR/.venv/bin/python" -I -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=3)' \
            "$1" 2> /dev/null; then
            return 0
        fi
        systemctl is-active --quiet "$SERVICE_NAME" || sleep 2
        systemctl is-active --quiet "$SERVICE_NAME" || return 1
        sleep 1
    done
    return 1
}

do_install() {
    is_repopulse_folder "$SRC_DIR" || die "run install.sh from the extracted release folder"
    [ ! -e "$INSTALL_DIR/.git" ] || die "$INSTALL_DIR is a git checkout; move it away (this installer copies its data with --migrate-from DIR)"
    if [ -d "$INSTALL_DIR" ] && ! is_repopulse_folder "$INSTALL_DIR" && [ -n "$(ls -A "$INSTALL_DIR")" ]; then
        die "$INSTALL_DIR is not empty and is not a RepoPulse folder; move it away and run this again"
    fi
    if [ -n "$MIGRATE_FROM" ]; then
        MIGRATE_FROM="$(readlink -f "$MIGRATE_FROM")" || die "--migrate-from: no such folder"
        is_repopulse_folder "$MIGRATE_FROM" || die "--migrate-from: $MIGRATE_FROM is not a RepoPulse folder"
    fi
    # First interactive install: offer automatic updates. Upgrades keep whatever was chosen.
    if [ -z "$AUTO_UPDATE" ] && ! auto_update_on && [ ! -f "$CONFIG" ] && interactive; then
        local answer=""
        read -r -p "Install new RepoPulse releases automatically (checked daily)? [y/N] " answer || true
        case "$answer" in [Yy]*) AUTO_UPDATE=on ;; esac
    fi
    ensure_python
    if [ "$AUTO_UPDATE" = on ] || { [ -z "$AUTO_UPDATE" ] && auto_update_on; }; then
        require_root_python  # fail before changing anything
    fi

    # The data folder: the one in an existing config.json, else /var/lib/repopulse.
    DATA_DIR="$DEFAULT_DATA_DIR"
    if [ -f "$CONFIG" ]; then
        DATA_DIR="$(config_value data_dir "$DEFAULT_DATA_DIR")"
        case "$DATA_DIR" in
            /*) ;;
            *) DATA_DIR="$DEFAULT_DATA_DIR" ;;
        esac
    fi

    # Which older folder to take the data from (only while this install has no database of its own).
    local source="" others=""
    if has_database "$DATA_DIR"; then
        [ -z "$MIGRATE_FROM" ] || warn "$DATA_DIR already has a database; nothing copied from $MIGRATE_FROM"
    elif [ -n "$MIGRATE_FROM" ]; then
        source="$MIGRATE_FROM"
    elif [ "$MIGRATE" -eq 1 ]; then
        local found
        found="$(find_old_installs)"
        if [ -n "$found" ]; then
            source="$(printf '%s\n' "$found" | head -n 1)"
            others="$(printf '%s\n' "$found" | tail -n +2)"
            echo "Found an older RepoPulse with data in $source"
            if [ -n "$others" ]; then
                echo "  (also in: ${others//$'\n'/, }; this one was used most recently; pick another with --migrate-from DIR)"
            fi
            if ! confirm "Copy its database, session key and settings into the new install?"; then
                source=""
            fi
        fi
    fi

    if ! id "$SERVICE_USER" > /dev/null 2>&1; then
        info "Creating the system user '$SERVICE_USER'"
        useradd --system --user-group --home-dir "$DEFAULT_DATA_DIR" --no-create-home \
            --shell "$(command -v nologin || echo /bin/false)" "$SERVICE_USER"
    fi
    stop_service

    install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
    MIGRATED_CONFIG=""
    MIGRATED_NOTE=""
    if [ -n "$source" ]; then
        migrate_from "$source"
    fi

    # Program files: copy from the release folder (staged first, the release folder may be the install folder).
    local stage item
    stage="$(mktemp -d)"
    for item in "${APP_FILES[@]}"; do
        [ -e "$SRC_DIR/$item" ] && cp -R --preserve=mode,timestamps "$SRC_DIR/$item" "$stage/"
    done
    info "Installing the program into $INSTALL_DIR"
    install -d -m 755 -o root -g root "$INSTALL_DIR"
    # An older RepoPulse unpacked into this very folder kept its settings and data here: keep them aside.
    if [ -e "$INSTALL_DIR/data" ] || [ -e "$INSTALL_DIR/config.json" ]; then
        local aside
        aside="$INSTALL_DIR.old-$(date +%Y%m%d-%H%M%S)"
        install -d -m 700 -o root -g root "$aside"
        for item in data config.json; do
            if [ -e "$INSTALL_DIR/$item" ] || [ -L "$INSTALL_DIR/$item" ]; then
                mv -T "$INSTALL_DIR/$item" "$aside/$item"
            fi
        done
        echo "    the old data and config.json of $INSTALL_DIR are kept in $aside"
    fi
    for item in "${APP_FILES[@]}" "${OLD_FILES[@]}"; do
        rm -rf "${INSTALL_DIR:?}/$item"
    done
    for item in "${APP_FILES[@]}"; do
        [ -e "$stage/$item" ] && cp -R --preserve=mode,timestamps "$stage/$item" "$INSTALL_DIR/"
    done
    rm -rf "$stage"
    find "$INSTALL_DIR/repopulse" -name __pycache__ -type d -prune -exec rm -rf {} +

    # The virtual environment belongs to root; rebuilt when it is missing, broken or was not root's alone.
    local venv="$INSTALL_DIR/.venv"
    if [ -e "$venv" ] && { [ -L "$venv" ] || ! "$venv/bin/python" -c 'import sys' 2> /dev/null \
        || [ -n "$(find "$venv" ! -type l \( ! -user root -o -perm -o+w \) -print -quit)" ] \
        || [ "$(readlink -f "$venv/bin/python")" != "$(readlink -f "$PYTHON")" ]; }; then
        rm -rf "$venv"
    fi
    if [ ! -d "$venv" ]; then
        info "Creating the Python environment"
        "$PYTHON" -m venv "$venv" || die "could not create $venv"
    fi
    info "Installing the Python packages (Flask and Waitress)"
    PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1 "$venv/bin/python" -m pip install -q --upgrade pip
    PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1 "$venv/bin/python" -m pip install -q \
        -r "$INSTALL_DIR/requirements.txt" || die "installing the Python packages failed"
    # The service cannot write here, so compile the program once now instead of on every start.
    (cd / && "$venv/bin/python" -m compileall -q "$INSTALL_DIR/repopulse" > /dev/null) || true
    chown -R root:root "$INSTALL_DIR"
    chmod -R go-w "$INSTALL_DIR"
    chmod 755 "$INSTALL_DIR/install.sh"

    write_config
    DATA_DIR="$(config_value data_dir "$DEFAULT_DATA_DIR")"
    install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
    local port host
    port="$(config_value port 8080)"
    host="$(config_value host 0.0.0.0)"
    write_wrapper
    write_unit "$port"

    if port_in_use "$port"; then
        warn "another program already listens on port $port (an older RepoPulse started with run.sh?)."
        warn "Stop it, or choose another port with: sudo $INSTALL_DIR/install.sh --port N"
    fi
    info "Starting the $SERVICE_NAME service"
    systemctl daemon-reload
    systemctl enable --quiet "$SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"

    local check_host="$host"
    case "$host" in
        "" | 0.0.0.0) check_host=127.0.0.1 ;;
        "::") check_host="[::1]" ;;
        *:*) check_host="[$host]" ;;
    esac
    if ! wait_until_up "http://$check_host:$port/api/site"; then
        journalctl -u "$SERVICE_NAME" -n 20 --no-pager >&2 || true
        die "RepoPulse did not start (see above, or: journalctl -u $SERVICE_NAME -n 50)"
    fi

    local first_updates=0
    if [ "$AUTO_UPDATE" = on ] || { [ -z "$AUTO_UPDATE" ] && auto_update_on; }; then
        auto_update_on || first_updates=1
        info "Setting up automatic updates"
        install_updater
    elif [ "$AUTO_UPDATE" = off ]; then
        remove_updater
    fi

    # The admin account: from the environment, asked for, or left to the first-run page.
    local users
    users="$("$WRAPPER" status 2> /dev/null | sed -n 's/^Admin accounts: //p')"
    if [ "${users:-0}" = 0 ]; then
        if [ -n "${REPOPULSE_ADMIN_PASSWORD:-}" ] && [ -n "${REPOPULSE_ADMIN_USERNAME:-}" ]; then
            "$WRAPPER" create-admin < /dev/null || die "could not create the admin account"
        elif interactive; then
            info "Create the admin account (it signs in to /admin)"
            "$WRAPPER" create-admin || warn "no admin account created; run: sudo repopulse create-admin"
        else
            echo "No admin account yet: run  sudo repopulse create-admin  (or open /admin on this computer)."
        fi
    fi

    local shown="$host"
    case "$host" in "" | 0.0.0.0 | "::") shown="localhost" ;; esac
    echo
    echo "RepoPulse $(cd "$INSTALL_DIR" && "$INSTALL_DIR/.venv/bin/python" -c 'import repopulse; print(repopulse.__version__)') is installed and starts with the computer."
    echo "  Dashboard: http://$shown:$port/    Admin: http://$shown:$port/admin"
    echo "  Status:    systemctl status $SERVICE_NAME      Logs: journalctl -u $SERVICE_NAME -f"
    echo "  Commands:  sudo repopulse status | create-admin | set-password | collect"
    echo "  Settings:  $CONFIG (then: sudo systemctl restart $SERVICE_NAME)"
    echo "  Data:      $DATA_DIR (back up this folder)"
    if auto_update_on; then
        echo "  Updates:   automatic, daily (journalctl -u $UPDATE_UNIT; turn off with --disable-auto-update)"
    else
        echo "  Updates:   sudo $INSTALL_DIR/install.sh --check-update; automatic with --enable-auto-update"
    fi
    if [ "$first_updates" -eq 1 ]; then
        echo
        ask_notify
    fi
    if [ -n "$MIGRATED_NOTE" ]; then
        echo
        echo "The data of $MIGRATED_NOTE was copied. That folder is no longer used; delete it once you have"
        echo "checked that everything is here."
    fi
}

# -- uninstall -------------------------------------------------------------------------------------------------------

do_uninstall() {
    local data="$DEFAULT_DATA_DIR"
    if [ -f "$CONFIG" ] && PYTHON="$(find_python)"; then
        data="$(config_value data_dir "$DEFAULT_DATA_DIR")"
    fi
    DATA_DIR="$data"
    remove_updater
    if [ -f "$UNIT_FILE" ]; then
        info "Removing the $SERVICE_NAME service"
        systemctl disable --now "$SERVICE_NAME" 2> /dev/null || true
        rm -f "$UNIT_FILE"
        systemctl daemon-reload
    fi
    rm -f "$WRAPPER"
    if [ -d "$INSTALL_DIR" ] && is_repopulse_folder "$INSTALL_DIR"; then
        info "Deleting $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
    fi
    if [ "$PURGE" -eq 1 ]; then
        info "Deleting the settings ($CONF_DIR), the data ($data) and the user $SERVICE_USER"
        rm -rf "$CONF_DIR" "$UPDATE_BACKUPS"
        case "$data" in
            /var/lib/* | "$DEFAULT_DATA_DIR") rm -rf "$data" ;;
            *) warn "kept $data (not under /var/lib); delete it yourself if you want" ;;
        esac
        if id "$SERVICE_USER" > /dev/null 2>&1; then
            userdel "$SERVICE_USER" 2> /dev/null || true
        fi
    else
        echo "Kept the settings in $CONF_DIR and the data in $data (--uninstall --purge deletes them)."
    fi
    info "RepoPulse has been uninstalled"
}

case "$ACTION" in
    install) do_install ;;
    uninstall) do_uninstall ;;
    enable-update)
        require_installed
        first=0
        auto_update_on || first=1
        install_updater
        info "Automatic updates are on: a daily check, and Update now on Admin, Settings (journalctl -u $UPDATE_UNIT)"
        if [ "$first" -eq 1 ]; then ask_notify; fi
        ;;
    disable-update) DATA_DIR="$DEFAULT_DATA_DIR"; [ -f "$CONFIG" ] && require_installed; remove_updater; info "Automatic updates are off" ;;
    check-update) do_check_update ;;
    update-now) do_update_now ;;
    set-notify) require_installed; REPOPULSE_NOTIFY_EMAILS="${REPOPULSE_NOTIFY_EMAILS:-}"; ASSUME_YES=0; ask_notify ;;
esac
