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
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
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

| System | File | This release | Always the latest |
| --- | --- | --- | --- |
| Windows 10/11 (64-bit) | Installer (includes Python) | [$NAME-setup.exe]($DL/$NAME-setup.exe) | [repopulse-setup.exe]($LATEST/repopulse-setup.exe) |
| Linux / Raspberry Pi (systemd, Python 3.9+) | Archive with \`install.sh\` | [$NAME-linux.tar.gz]($DL/$NAME-linux.tar.gz) | [repopulse-linux.tar.gz]($LATEST/repopulse-linux.tar.gz) |

Checksums of all files: [SHA256SUMS.txt]($DL/SHA256SUMS.txt).

### Windows

Run \`$NAME-setup.exe\` (it asks for administrator rights). It installs RepoPulse in \`C:\\Program Files\\RepoPulse\`
with its own Python, keeps the settings and data in \`C:\\ProgramData\\RepoPulse\`, and starts it with Windows. Running a
newer installer updates it and keeps the settings and data.

### Linux / Raspberry Pi

\`\`\`sh
curl -fL -O $DL/$NAME-linux.tar.gz -O $DL/SHA256SUMS.txt
sha256sum --check --ignore-missing SHA256SUMS.txt
tar xzf $NAME-linux.tar.gz
cd $NAME
sudo ./install.sh          # installs the repopulse service: /opt/repopulse, /etc/repopulse, /var/lib/repopulse
\`\`\`

Upgrading: run the new release's \`sudo ./install.sh\` (or \`sudo /opt/repopulse/install.sh --update-now\` with
automatic updates on); the settings and data are kept. **Coming from a RepoPulse you started from an unpacked folder?**
Both installers find it, copy its database, settings and admin account, and leave the old folder alone.
EOF
