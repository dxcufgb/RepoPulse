#!/usr/bin/env bash
# Builds the release files into OUT_DIR, with VERSION stamped into repopulse/__init__.py and the
# cache-busting ?v= of repopulse/static/index.html (the repository's own version is not the release version):
#
#   scripts/build-release.sh OUT_DIR VERSION        (VERSION like 1.2.3 or v1.2.3; 1.2.3-rc.1 for a pre-release)
#
#   repopulse-VERSION-linux.tar.gz   folder repopulse-VERSION/ (Linux, macOS, Raspberry Pi; ./install.sh)
#   repopulse-VERSION-windows.zip    the same files (install.bat / install.ps1)
#   repopulse-linux.tar.gz, repopulse-windows.zip   the same archives under fixed names, so
#                                    .../releases/latest/download/<name> always points at the newest release
#   SHA256SUMS.txt                   checksums of the four archives
#
# Only files tracked by git go in (no data/, config.json, .venv or caches), and not the repository tooling (.github,
# tests, scripts). The output is reproducible: same commit and version, same bytes. Needs git, GNU tar, gzip, python3.
# The file names are part of the release contract (README, release notes): do not rename them.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 OUT_DIR VERSION" >&2
  exit 2
fi
OUT="$1"
VERSION="${2#v}"
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
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
git ls-files -z -- README.md LICENSE requirements.txt config.example.json \
  install.sh install.ps1 install.bat run.sh run.bat repopulse \
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
chmod 755 "$STAGE/$NAME/install.sh" "$STAGE/$NAME/run.sh"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
rm -f "$OUT/$NAME-linux.tar.gz" "$OUT/$NAME-windows.zip" "$OUT/repopulse-linux.tar.gz" "$OUT/repopulse-windows.zip" "$OUT/SHA256SUMS.txt"

# Fixed timestamps, owners and order, so the archives do not depend on when or where they were built.
EPOCH="$(git log -1 --format=%ct HEAD 2>/dev/null || echo 315532800)"
(cd "$STAGE" && tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner --format=gnu -cf - "$NAME" | gzip -n -9 > "$OUT/$NAME-linux.tar.gz")
python3 - "$STAGE" "$NAME" "$OUT/$NAME-windows.zip" "$EPOCH" <<'EOF'
import os, sys, time, zipfile
stage, name, out, epoch = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
stamp = time.gmtime(max(epoch, 315532800))[:6]  # zip cannot store dates before 1980
files = []
for folder, dirs, names in os.walk(os.path.join(stage, name)):
    files += [os.path.join(folder, n) for n in names]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for path in sorted(files, key=lambda p: os.path.relpath(p, stage).replace(os.sep, "/")):
        info = zipfile.ZipInfo(os.path.relpath(path, stage).replace(os.sep, "/"), stamp)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o755 if os.access(path, os.X_OK) else 0o644) << 16
        with open(path, "rb") as fh:
            zf.writestr(info, fh.read())
EOF

cp "$OUT/$NAME-linux.tar.gz" "$OUT/repopulse-linux.tar.gz"
cp "$OUT/$NAME-windows.zip" "$OUT/repopulse-windows.zip"
(cd "$OUT" && sha256sum "$NAME-linux.tar.gz" "$NAME-windows.zip" repopulse-linux.tar.gz repopulse-windows.zip > SHA256SUMS.txt)
echo "Built in $OUT:"
cat "$OUT/SHA256SUMS.txt"
