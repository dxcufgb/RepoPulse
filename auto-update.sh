#!/usr/bin/env bash
# RepoPulse automatic update for Linux. Set up by install.sh --auto-update; run as root by systemd
# (repopulse-update.service: daily by repopulse-update.timer, at once by repopulse-update-now.path when Update now is
# pressed on Admin, Settings) from root's own copy in /usr/local/lib/repopulse-update/.
#
#   auto-update.sh --run     install a newer release if there is one
#   auto-update.sh --check   exit 0 = up to date, 10 = update available, 1 = could not check, 75 = another run is busy
#
# What --run does: asks GitHub for the latest release of dxcufgb/RepoPulse (updater.py, run by the system Python in
# isolated mode; only strictly newer final releases), downloads repopulse-X.Y.Z-linux.tar.gz and checks it against
# SHA256SUMS.txt, backs up /opt/repopulse to /var/backups/repopulse-update, runs that release's install.sh --yes (which
# replaces the program files and the Python packages and restarts repopulse.service; /etc/repopulse and the data
# folder are kept) and checks that the new version answers. If it does not, the backup is put back and RepoPulse is
# restarted. Everything root runs or reads belongs to root: the program folder, the settings and the verified release;
# the result is recorded and e-mailed by "repopulse update-event", which runs as the service account.
set -euo pipefail
umask 022

INSTALL_DIR=/opt/repopulse
CONF=/etc/repopulse/auto-update.conf
CONFIG=/etc/repopulse/config.json
LIB_DIR=/usr/local/lib/repopulse-update
BACKUP_ROOT=/var/backups/repopulse-update
WRAPPER=/usr/local/bin/repopulse
LOCK=/run/repopulse-update.lock
SERVICE=repopulse.service
MODE="${1:---run}"
case "$MODE" in --run | --check) ;; *) echo "usage: $0 --run|--check" >&2; exit 2 ;; esac

if [ "$(id -u)" != 0 ]; then echo "auto-update.sh must run as root" >&2; exit 1; fi
if [ ! -f "$CONF" ]; then echo "Automatic updates are not set up ($CONF is missing): sudo $INSTALL_DIR/install.sh --enable-auto-update" >&2; exit 1; fi

PYTHON="" TOKEN_FILE=""
while IFS='=' read -r key value; do
    case "$key" in
        PYTHON) PYTHON="$value" ;;
        TOKEN_FILE) TOKEN_FILE="$value" ;;
    esac
done < "$CONF"
[[ "$PYTHON" == /* && -x "$PYTHON" ]] || { echo "PYTHON in $CONF is not a program: $PYTHON" >&2; exit 1; }
TOKEN_ARGS=()
if [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ]; then TOKEN_ARGS=(--token-file "$TOKEN_FILE"); fi
cd /

exec 9> "$LOCK"
if ! flock -n 9; then
    echo "Another update run is busy; not starting a second one."
    if [ "$MODE" = --check ]; then exit 75; fi
    exit 0
fi

WORK="$(mktemp -d /tmp/repopulse-update.XXXXXX)"
LOGF="$WORK/update.log"
trap 'rm -rf "$WORK"' EXIT
log() { printf '%s\n' "$*" | tee -a "$LOGF"; }

record() { # outcome [from] [to]: stores the result and e-mails it (never fails the run)
    tail -n 60 "$LOGF" 2> /dev/null | "$WRAPPER" update-event --outcome "$1" --from "${2:-}" --to "${3:-}" --message-stdin \
        || echo "Could not record the result of the update (repopulse update-event failed)."
}

CUR="$(sed -n 's/^__version__ = "\([0-9A-Za-z.+-]*\)"$/\1/p' "$INSTALL_DIR/repopulse/__init__.py" 2> /dev/null | head -n 1)" || true
if [ -z "$CUR" ]; then
    log "Cannot tell which version is installed in $INSTALL_DIR."
    [ "$MODE" = --check ] && exit 1
    record failed
    exit 1
fi

if [ "$MODE" = --check ]; then
    set +e
    "$PYTHON" -I "$LIB_DIR/updater.py" --installed "$CUR" "${TOKEN_ARGS[@]}" check
    rc=$?
    set -e
    case "$rc" in 0) exit 10 ;; 3) exit 0 ;; *) exit 1 ;; esac
fi

log "Installed: RepoPulse $CUR in $INSTALL_DIR"
set +e
OUT="$("$PYTHON" -I "$LIB_DIR/updater.py" --installed "$CUR" "${TOKEN_ARGS[@]}" download --dest "$WORK/dl" 2> >(tee -a "$LOGF" >&2))"
rc=$?
set -e
if [ "$rc" = 3 ]; then
    "$WRAPPER" update-event --outcome current --from "$CUR" < /dev/null > /dev/null 2>&1 || true
    exit 0
fi
REL="$(printf '%s\n' "$OUT" | tail -n 1)"
if [ "$rc" != 0 ] || [[ "$REL" != "$WORK/dl/release/repopulse-"* ]] || [ ! -f "$REL/install.sh" ]; then
    log "The update check or download failed; nothing was changed."
    record failed "$CUR"
    exit 1
fi
NEW="${REL##*/repopulse-}"
log "Installing RepoPulse $NEW"

read_address() { # sets URL from the settings (root's own file)
    local line port host
    line="$("$PYTHON" -I -c 'import json, sys
try:
    c = json.load(open(sys.argv[1], encoding="utf-8-sig"))
except (OSError, ValueError):
    c = {}
print(c.get("port", 8080), c.get("host", "0.0.0.0"))' "$CONFIG")" || true
    port="${line%% *}"
    host="${line#* }"
    [[ "$port" =~ ^[0-9]{1,5}$ ]] || port=8080
    case "$host" in "" | 0.0.0.0 | "$port") host=127.0.0.1 ;; "::") host=::1 ;; esac
    [[ "$host" =~ ^[A-Za-z0-9.:-]+$ ]] || host=127.0.0.1
    case "$host" in *:*) host="[$host]" ;; esac
    URL="http://$host:$port/api/site"
}

answers_with() { # version: waits up to 90 s for RepoPulse to answer with that version
    local want="$1" got _
    read_address
    for _ in $(seq 1 45); do
        got="$("$PYTHON" -I -c 'import json, sys, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1], timeout=5) as r:
        print(json.loads(r.read(65536).decode("utf-8")).get("version", ""))
except Exception:
    pass' "$URL")" || true
        if [ "$got" = "$want" ]; then return 0; fi
        sleep 2
    done
    return 1
}

BACKUP="$BACKUP_ROOT/repopulse"
install -d -m 700 -o root -g root "$BACKUP_ROOT"
rm -rf "$BACKUP"
cp -a "$INSTALL_DIR" "$BACKUP"
log "Backed up $INSTALL_DIR to $BACKUP"

# The release's own installer: same steps as a manual upgrade, no questions, no looking for older folders.
if (cd "$REL" && bash ./install.sh --yes --no-migrate) >> "$LOGF" 2>&1 9>&- && answers_with "$NEW"; then
    log "RepoPulse $NEW is installed and running (was $CUR)."
    record updated "$CUR" "$NEW"
    exit 0
fi
log "Installing RepoPulse $NEW failed:"
grep -v "^Installed: \|^Installing RepoPulse \|^Backed up " "$LOGF" | tail -n 15 >&2 || true

log "Putting $CUR back"
systemctl stop "$SERVICE" 9>&- || true
rm -rf "$INSTALL_DIR"
cp -a "$BACKUP" "$INSTALL_DIR"
systemctl restart "$SERVICE" 9>&- || true
if answers_with "$CUR"; then
    log "RepoPulse $CUR is running again."
    record rolled-back "$CUR" "$NEW"
else
    log "ROLLBACK FAILED: RepoPulse does not answer. The previous program is in $BACKUP; copy it to $INSTALL_DIR (cp -a) and run: sudo systemctl restart $SERVICE"
    record failed "$CUR" "$NEW"
fi
exit 1
