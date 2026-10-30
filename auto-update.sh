#!/usr/bin/env bash
# RepoPulse automatic update for Linux. Set up by ./install.sh --auto-update; run as root by systemd
# (repopulse-update.service: daily by repopulse-update.timer, at once by repopulse-update-now.path) from the
# root-owned copy in /usr/local/lib/repopulse-update/, never from the installation folder.
#
#   auto-update.sh --run     install a newer release if there is one
#   auto-update.sh --check   exit 0 = up to date, 10 = update available, 1 = could not check, 75 = another run is busy
#
# What --run does: asks GitHub for the latest release of dxcufgb/RepoPulse (updater.py, run by the system Python in
# isolated mode), downloads it and checks its SHA-256, backs the current files up to data/update-backup, copies the
# release over the installation, updates the Python packages, restarts repopulse.service and checks that the new
# version answers. If anything fails, the previous files are put back and RepoPulse is restarted again. Every copy,
# pip and Python step inside the installation folder runs as the account RepoPulse runs as, so root never runs or
# parses what that account can change. config.json, data/ and .venv are never replaced. The result is recorded and
# e-mailed by "python -m repopulse update-event" (Admin, Settings, Notifications).
set -euo pipefail
umask 022

CONF=/etc/repopulse/auto-update.conf
LIB_DIR=/usr/local/lib/repopulse-update
LOCK=/run/repopulse-update.lock
SERVICE=repopulse.service
MODE="${1:---run}"
case "$MODE" in --run|--check) ;; *) echo "usage: $0 --run|--check" >&2; exit 2 ;; esac

if [ "$(id -u)" != 0 ]; then echo "auto-update.sh must run as root" >&2; exit 1; fi
if [ ! -f "$CONF" ]; then echo "Automatic updates are not set up ($CONF is missing). Run ./install.sh --auto-update." >&2; exit 1; fi

APP_DIR="" RUN_USER="" PYTHON="" TOKEN_FILE=""
while IFS='=' read -r key value; do
  case "$key" in
    APP_DIR) APP_DIR="$value" ;;
    RUN_USER) RUN_USER="$value" ;;
    PYTHON) PYTHON="$value" ;;
    TOKEN_FILE) TOKEN_FILE="$value" ;;
  esac
done < "$CONF"
[[ "$APP_DIR" == /* && -d "$APP_DIR" ]] || { echo "APP_DIR in $CONF is not a folder: $APP_DIR" >&2; exit 1; }
id -u "$RUN_USER" >/dev/null 2>&1 || { echo "RUN_USER in $CONF is not an account: $RUN_USER" >&2; exit 1; }
[[ "$PYTHON" == /* && -x "$PYTHON" ]] || { echo "PYTHON in $CONF is not a program: $PYTHON" >&2; exit 1; }
VENV_PY="$APP_DIR/.venv/bin/python"
TOKEN_ARGS=()
if [ -n "$TOKEN_FILE" ] && [ -f "$TOKEN_FILE" ]; then TOKEN_ARGS=(--token-file "$TOKEN_FILE"); fi
cd /

as_user() {
  if [ "$RUN_USER" = root ]; then "$@"; else runuser -u "$RUN_USER" -- "$@"; fi
}
# python -m repopulse ... in the installation, as the service account
repopulse_cli() { as_user env PYTHONPATH="$APP_DIR" "$VENV_PY" -m repopulse "$@"; }

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Another update run is busy; not starting a second one."
  if [ "$MODE" = --check ]; then exit 75; fi
  exit 0
fi

WORK="$(mktemp -d /tmp/repopulse-update.XXXXXX)"
LOGF="$WORK/update.log"
trap 'rm -rf "$WORK"' EXIT
log() { printf '%s\n' "$*" | tee -a "$LOGF"; }

record() {  # outcome [from] [to]: stores the result and e-mails it (never fails the run)
  tail -n 60 "$LOGF" 2>/dev/null | repopulse_cli update-event --outcome "$1" --from "${2:-}" --to "${3:-}" --message-stdin \
    || echo "Could not record the result of the update (python -m repopulse update-event failed)."
}

if [ -e "$APP_DIR/.git" ]; then
  log "$APP_DIR is a git checkout; update it with git pull instead. Nothing changed."
  [ "$MODE" = --check ] && exit 1
  exit 0
fi

CUR="$(as_user cat "$APP_DIR/repopulse/__init__.py" 2>/dev/null | sed -n 's/^__version__ = "\([0-9A-Za-z.+-]*\)"$/\1/p' | head -n 1)" || true
if [ -z "$CUR" ]; then
  log "Cannot tell which version is installed in $APP_DIR."
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

log "Installed: RepoPulse $CUR in $APP_DIR (runs as $RUN_USER)"
set +e
OUT="$("$PYTHON" -I "$LIB_DIR/updater.py" --installed "$CUR" "${TOKEN_ARGS[@]}" download --dest "$WORK/dl" 2> >(tee -a "$LOGF" >&2))"
rc=$?
set -e
if [ "$rc" = 3 ]; then
  repopulse_cli update-event --outcome current --from "$CUR" </dev/null >/dev/null 2>&1 || true
  exit 0
fi
REL="$(printf '%s\n' "$OUT" | tail -n 1)"
if [ "$rc" != 0 ] || [[ "$REL" != "$WORK/dl/release/repopulse-"* ]] || [ ! -d "$REL" ]; then
  log "The update check or download failed; nothing was changed."
  record failed "$CUR"
  exit 1
fi
NEW="${REL##*/repopulse-}"
log "Installing RepoPulse $NEW"

# The service account reads the verified release from here; it cannot change it.
chmod 755 "$WORK" "$WORK/dl" "$WORK/dl/release"
chmod -R a+rX "$REL"

ENTRIES=()
while IFS= read -r -d '' path; do
  name="${path##*/}"
  case "$name" in data|config.json|.venv|.git) continue ;; esac
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { log "Unexpected file name in the release: $name"; record failed "$CUR" "$NEW"; exit 1; }
  ENTRIES+=("$name")
done < <(find "$REL" -mindepth 1 -maxdepth 1 -print0 | sort -z)

BACKUP="$APP_DIR/data/update-backup"
as_user rm -rf "$BACKUP"
as_user mkdir -p "$BACKUP"
for name in "${ENTRIES[@]}"; do
  if as_user test -e "$APP_DIR/$name"; then
    as_user cp -R --preserve=mode,timestamps "$APP_DIR/$name" "$BACKUP/$name"
  fi
done
log "Backed up the current files to $BACKUP"

PORT="" HOST=""
read_address() {
  local line
  line="$(as_user env PYTHONPATH="$APP_DIR" "$VENV_PY" -c 'from repopulse.config import load_config; c = load_config(); print(c.port, c.host)' 2>/dev/null | tail -n 1)" || true
  PORT="${line%% *}"; HOST="${line#* }"
  [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || PORT=8080
  case "$HOST" in ""|0.0.0.0|::|"$PORT") HOST=127.0.0.1 ;; esac
  [[ "$HOST" =~ ^[A-Za-z0-9.:-]+$ ]] || HOST=127.0.0.1
}

answers_with() {  # version: waits up to 90 s for RepoPulse to answer with that version
  local want="$1" got _
  for _ in $(seq 1 45); do
    got="$("$PYTHON" -I -c 'import json, sys, urllib.request
host = sys.argv[1] if ":" not in sys.argv[1] else "[" + sys.argv[1] + "]"
try:
    with urllib.request.urlopen("http://%s:%s/api/site" % (host, sys.argv[2]), timeout=5) as r:
        print(json.loads(r.read(65536).decode("utf-8")).get("version", ""))
except Exception:
    pass' "$HOST" "$PORT")" || true
    if [ "$got" = "$want" ]; then return 0; fi
    sleep 2
  done
  return 1
}

# (called from "if", where set -e does not apply: every step checks for itself)
install_files() {
  local name
  for name in "${ENTRIES[@]}"; do
    as_user rm -rf "$APP_DIR/$name" || return 1
    as_user cp -R --preserve=mode,timestamps "$REL/$name" "$APP_DIR/$name" || return 1
  done
  as_user "$VENV_PY" -m pip install --disable-pip-version-check --no-cache-dir -q -r "$APP_DIR/requirements.txt" || return 1
  as_user env PYTHONPATH="$APP_DIR" "$VENV_PY" -c 'import repopulse.app' || return 1
}

restore_files() {
  local name
  for name in "${ENTRIES[@]}"; do  # files that are new in the release are removed, the others restored
    as_user rm -rf "$APP_DIR/$name"
    if as_user test -e "$BACKUP/$name"; then as_user cp -R --preserve=mode,timestamps "$BACKUP/$name" "$APP_DIR/$name"; fi
  done
  as_user "$VENV_PY" -m pip install --disable-pip-version-check --no-cache-dir -q -r "$APP_DIR/requirements.txt" || true
}

if install_files >>"$LOGF" 2>&1; then
  read_address
  systemctl restart "$SERVICE" 9>&-
  if answers_with "$NEW"; then
    # the next run uses the new release's updater (renamed into place: this running script is not touched)
    for f in auto-update.sh repopulse/updater.py; do
      if [ -f "$REL/$f" ]; then
        cp "$REL/$f" "$LIB_DIR/.${f##*/}.new" && chmod 755 "$LIB_DIR/.${f##*/}.new" && mv -f "$LIB_DIR/.${f##*/}.new" "$LIB_DIR/${f##*/}"
      fi
    done
    log "RepoPulse $NEW is installed and running (was $CUR)."
    record updated "$CUR" "$NEW"
    exit 0
  fi
  log "RepoPulse $NEW did not answer on $HOST:$PORT after the restart."
else
  log "Installing the files of $NEW failed:"
  grep -v "^Installed: \|^Installing RepoPulse \|^Backed up " "$LOGF" | tail -n 12 >&2 || true
fi

log "Putting $CUR back"
restore_files >>"$LOGF" 2>&1
read_address
systemctl restart "$SERVICE" 9>&- || true
if answers_with "$CUR"; then
  log "RepoPulse $CUR is running again."
  record rolled-back "$CUR" "$NEW"
else
  log "ROLLBACK FAILED: RepoPulse does not answer. The previous files are in $BACKUP; copy them back into $APP_DIR and run: sudo systemctl restart $SERVICE"
  record failed "$CUR" "$NEW"
fi
exit 1
