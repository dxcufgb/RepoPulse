#!/usr/bin/env bash
# Builds the release files into OUT_DIR, with VERSION stamped into repopulse/__init__.py and the
# cache-busting ?v= of repopulse/static/index.html (the repository's own version is not the release version):
#
#   scripts/build-release.sh OUT_DIR VERSION        (VERSION like 1.2.3 or v1.2.3; 1.2.3-rc.1 for a pre-release)
#
#   repopulse-VERSION-linux.tar.gz   folder repopulse-VERSION/ (Linux, Raspberry Pi; sudo ./install.sh)
#   repopulse-linux.tar.gz           the same archive under a fixed name, so
#                                    .../releases/latest/download/repopulse-linux.tar.gz always is the newest release
#   SHA256SUMS.txt                   checksums of both
#
# The Windows installer (repopulse-VERSION-setup.exe, repopulse-setup.exe) is built on Windows by
# packaging/windows/build-setup.ps1; release.yml adds it and writes SHA256SUMS.txt over all files.
#
# Only files tracked by git go in (no data/, config.json, .venv or caches), and not the repository tooling (.github,
# tests, scripts, packaging). The output is reproducible: same commit and version, same bytes. Needs git, GNU tar,
# gzip, python3. The file names are part of the release contract (README, release notes, the updater, the one-line
# installer of dxcufgb/install): do not rename them.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 OUT_DIR VERSION" >&2
  exit 2
fi
OUT="$1"
VERSION="${2#v}"
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  echo "version '$2' is not MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-PRERELEASE" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="repopulse-$VERSION"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# The files of the release, as committed (a tracked file deleted in the working tree makes cp fail, on purpose).
cd "$ROOT"
mkdir -p "$STAGE/$NAME"
git ls-files -z -- README.md LICENSE requirements.txt config.example.json install.sh auto-update.sh repopulse \
  | while IFS= read -r -d '' f; do
      mkdir -p "$STAGE/$NAME/$(dirname "$f")"
      cp -p "$f" "$STAGE/$NAME/$f"
    done
test -f "$STAGE/$NAME/repopulse/__init__.py" || { echo "repopulse/__init__.py is not tracked by git" >&2; exit 1; }

# Stamp the version.
python3 - "$STAGE/$NAME" "$VERSION" <<'EOF'
import pathlib, re, sys
root, version = pathlib.Path(sys.argv[1]), sys.argv[2]
init = root / "repopulse" / "__init__.py"
text, n = re.subn(r'^__version__ = "[^"]*"$', f'__version__ = "{version}"', init.read_text(encoding="utf-8"), flags=re.M)
if n != 1:
    sys.exit("no __version__ line in repopulse/__init__.py")
init.write_bytes(text.encode("utf-8"))
index = root / "repopulse" / "static" / "index.html"
index.write_bytes(re.sub(r"\?v=[0-9A-Za-z.-]+", f"?v={version}", index.read_text(encoding="utf-8")).encode("utf-8"))
EOF
chmod 755 "$STAGE/$NAME/install.sh" "$STAGE/$NAME/auto-update.sh"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
rm -f "$OUT/$NAME-linux.tar.gz" "$OUT/repopulse-linux.tar.gz" "$OUT/SHA256SUMS.txt"

# Fixed timestamps, owners and order, so the archives do not depend on when or where they were built.
EPOCH="$(git log -1 --format=%ct HEAD 2>/dev/null || echo 315532800)"
(cd "$STAGE" && tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner --format=gnu -cf - "$NAME" | gzip -n -9 > "$OUT/$NAME-linux.tar.gz")

cp "$OUT/$NAME-linux.tar.gz" "$OUT/repopulse-linux.tar.gz"
(cd "$OUT" && sha256sum "$NAME-linux.tar.gz" repopulse-linux.tar.gz > SHA256SUMS.txt)
echo "Built in $OUT:"
cat "$OUT/SHA256SUMS.txt"
