#!/usr/bin/env bash
# Prints the top of a release's notes: download links and install steps, as Markdown.
#
#   ./scripts/release-notes.sh VERSION OWNER/REPO > notes.md
#
# release.yml puts it in front of GitHub's generated notes (the list of merged pull requests), or in front of the notes
# of a release published by hand. The file names must match scripts/build-release.sh.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 VERSION OWNER/REPO" >&2
  exit 2
fi
VERSION="$1"
REPO="$2"
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "version '$VERSION' is not MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-PRERELEASE" >&2
  exit 1
fi
if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "repository '$REPO' is not OWNER/REPO" >&2
  exit 1
fi

TAG="v$VERSION"
NAME="repopulse-$VERSION"
BASE="https://github.com/$REPO/releases"
DL="$BASE/download/$TAG"
LATEST="$BASE/latest/download"

cat <<EOF
## Downloads

| OS | File | This release | Always the latest |
| --- | --- | --- | --- |
| Windows 10/11 (Python 3.9+ must be installed) | Archive with \`install.bat\` | [$NAME-windows.zip]($DL/$NAME-windows.zip) | [repopulse-windows.zip]($LATEST/repopulse-windows.zip) |
| Linux / Raspberry Pi / macOS (Python 3.9+) | Archive with \`install.sh\` | [$NAME-linux.tar.gz]($DL/$NAME-linux.tar.gz) | [repopulse-linux.tar.gz]($LATEST/repopulse-linux.tar.gz) |

Checksums of all files: [SHA256SUMS.txt]($DL/SHA256SUMS.txt).

### Linux / Raspberry Pi

\`\`\`sh
curl -fL -O $DL/$NAME-linux.tar.gz -O $DL/SHA256SUMS.txt
sha256sum --check --ignore-missing SHA256SUMS.txt
tar xzf $NAME-linux.tar.gz
cd $NAME
./install.sh              # add --service to start it at boot
\`\`\`

### Windows

Unzip \`$NAME-windows.zip\` somewhere permanent and double-click \`install.bat\`, then \`run.bat\`.
\`.\\install.ps1 -Service\` (PowerShell as administrator) starts it with Windows.

**Updating:** stop RepoPulse, replace the program files but keep \`data/\` and \`config.json\`, run the installer again.
EOF
