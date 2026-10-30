"""Automatic updates: find, download and verify the newest RepoPulse release on GitHub.

Run by the platform scripts (auto-update.sh on Linux as root, auto-update.ps1 on Windows as SYSTEM) as a plain
script in isolated mode, with a Python the user who runs RepoPulse cannot change::

    python3 -I updater.py --installed 1.2.0 [--token-file FILE] check
    python3 -I updater.py --installed 1.2.0 [--token-file FILE] download --dest EMPTY_DIR

``check`` only reports. ``download`` fetches the platform's archive and ``SHA256SUMS.txt``, checks the archive's
SHA-256, extracts it into ``--dest`` and prints the extracted release folder on the last line of standard output;
the script then copies the release over the installation. RepoPulse's own web server uses ``latest_release`` and
``is_newer`` for **Check for update** on the admin page.

Exit codes: 0 = a newer release is available (and, for ``download``, ready), 3 = up to date, 1 = error.
Standard library only, no imports from the rest of RepoPulse: root must never run code the service user can change.

The repository is public, so no token is needed (GitHub allows 60 unauthenticated API requests an hour per IP
address; a run makes at most three). An optional token (``--token-file``) is sent to api.github.com only, never to
the host GitHub redirects downloads to, and never logged. If GitHub rejects it (HTTP 401) the run goes on without it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Dict, Iterator, Optional, Tuple

log = logging.getLogger("repopulse.updater")

REPO = "dxcufgb/RepoPulse"
API_HOST = "api.github.com"
LATEST_URL = f"https://{API_HOST}/repos/{REPO}/releases/latest"
NAME = "repopulse"
CHECKSUMS = "SHA256SUMS.txt"
USER_AGENT = "RepoPulse-updater"
TIMEOUT = 60
MAX_JSON_BYTES = 5 * 1024 * 1024
MAX_ASSET_BYTES = 50 * 1024 * 1024
MAX_REDIRECTS = 5
MAX_NOTES_CHARS = 20_000
CHUNK = 64 * 1024

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_UP_TO_DATE = 3

_VERSION_RE = re.compile(r"^v?(\d+(?:\.\d+)*)$")
_SUM_RE = re.compile(r"^([0-9a-fA-F]{64}) [ *](.+)$")


class UpdateError(Exception):
    """Something went wrong; the message is safe to log (never contains the token)."""


# ---------------------------------------------------------------------------------------------- versions


def parse_version(text: str) -> Optional[Tuple[int, ...]]:
    """``"v2.10.0"`` -> ``(2, 10, 0)``. Pre-releases (``2.1.0-rc.1``) and anything else -> ``None``."""
    match = _VERSION_RE.match(str(text).strip())
    if not match:
        return None
    return tuple(int(part) for part in match.group(1).split("."))


def is_newer(candidate: str, installed: str) -> bool:
    """True only if ``candidate`` is a final release strictly newer than ``installed``."""
    new, old = parse_version(candidate), parse_version(installed)
    if new is None or old is None:
        return False
    width = max(len(new), len(old))
    return new + (0,) * (width - len(new)) > old + (0,) * (width - len(old))


def read_token(path: Path) -> str:
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise UpdateError(f"Cannot read the GitHub token file {path} ({exc.strerror or type(exc).__name__})") from None
    if not token or any(ch.isspace() for ch in token):
        raise UpdateError(f"The GitHub token file {path} is empty or malformed")
    return token


# ---------------------------------------------------------------------------------------------- HTTP


@dataclass
class Response:
    status: int
    headers: Dict[str, str]  # lower-case names
    chunks: Iterator[bytes]


# (url, headers, timeout) -> Response. Must NOT follow redirects; tests replace it with a fake.
Transport = Callable[[str, Dict[str, str], float], Response]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # urlopen then raises HTTPError for the 3xx, which we follow by hand


def urllib_transport(url: str, headers: Dict[str, str], timeout: float) -> Response:
    opener = urllib.request.build_opener(_NoRedirect())
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        resp = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        body = exc.read(4096) if exc.fp else b""
        exc.close()
        return Response(exc.code, {k.lower(): v for k, v in exc.headers.items()}, iter([body]))
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise UpdateError(f"Could not reach {urllib.parse.urlsplit(url).hostname}: {reason}") from None

    def chunks() -> Iterator[bytes]:
        with resp:
            while True:
                chunk = resp.read(CHUNK)
                if not chunk:
                    return
                yield chunk

    return Response(resp.status, {k.lower(): v for k, v in resp.headers.items()}, chunks())


class GitHub:
    def __init__(
        self, token: Optional[str] = None, transport: Transport = urllib_transport, timeout: float = TIMEOUT
    ) -> None:
        self._token = token or None  # None: unauthenticated (the repository is public)
        self._transport = transport
        self._timeout = timeout

    def _open(self, url: str, accept: str) -> Response:
        """GET ``url``, following redirects by hand. The token only ever goes to api.github.com over HTTPS."""
        for _ in range(MAX_REDIRECTS + 1):
            parts = urllib.parse.urlsplit(url)
            if parts.scheme != "https" or not parts.hostname:
                raise UpdateError(f"Refusing to download from a non-HTTPS URL ({parts.scheme}://{parts.hostname})")
            headers = {"Accept": accept, "User-Agent": USER_AGENT}
            api = parts.hostname.lower() == API_HOST and parts.port in (None, 443)
            authenticated = api and self._token is not None
            if api:
                headers["X-GitHub-Api-Version"] = "2022-11-28"
            if authenticated:
                headers["Authorization"] = f"Bearer {self._token}"
            resp = self._transport(url, headers, self._timeout)
            if resp.status == 401 and authenticated:
                # An expired or revoked token must not stop the updates of a public repository: go on without it.
                log.warning(
                    "GitHub rejected the updater's token (HTTP 401, expired or revoked?); continuing without one. The "
                    "repository is public, so no token is needed."
                )
                self._token = None
                continue  # the same URL again, unauthenticated
            if resp.status in (301, 302, 303, 307, 308):
                location = resp.headers.get("location")
                if not location:
                    raise UpdateError(f"HTTP {resp.status} from {parts.hostname} without a Location header")
                url = urllib.parse.urljoin(url, location)
                continue
            if resp.status == 200:
                return resp
            host = API_HOST if api else parts.hostname
            raise UpdateError(_http_error(resp.status, host, resp.headers, authenticated))
        raise UpdateError("Too many redirects")

    def get_json(self, url: str) -> dict:
        data = b"".join(_capped(self._open(url, "application/vnd.github+json").chunks, MAX_JSON_BYTES))
        try:
            value = json.loads(data)
        except ValueError:
            raise UpdateError(f"GitHub returned invalid JSON for {url}") from None
        if not isinstance(value, dict):
            raise UpdateError(f"Unexpected answer from GitHub for {url}")
        return value

    def download(self, url: str, dest: Path, max_bytes: int = MAX_ASSET_BYTES) -> str:
        """Save a release asset (API URL) to ``dest``; returns its SHA-256 hex digest."""
        digest = hashlib.sha256()
        with dest.open("xb") as f:
            for chunk in _capped(self._open(url, "application/octet-stream").chunks, max_bytes):
                digest.update(chunk)
                f.write(chunk)
        return digest.hexdigest()


def _capped(chunks: Iterator[bytes], limit: int) -> Iterator[bytes]:
    total = 0
    for chunk in chunks:
        total += len(chunk)
        if total > limit:
            raise UpdateError(f"Download is larger than the {limit:,}-byte limit")
        yield chunk


def _http_error(status: int, host: str, headers: Optional[Dict[str, str]] = None, authenticated: bool = False) -> str:
    headers = headers or {}
    if host != API_HOST:
        return f"HTTP {status} from {host}"
    if status == 401:
        return "GitHub answered HTTP 401 (authentication required) for a request without a token."
    if status == 404:
        if authenticated:
            return (
                f"GitHub returned 404: {REPO} has no published release yet, or the token cannot read it "
                "(it needs read-only Contents access to that repository)."
            )
        return f"GitHub returned 404: {REPO} has no published release yet, or it is not public (then it needs a token)."
    if status in (403, 429):
        if status == 429 or headers.get("x-ratelimit-remaining") == "0" or "retry-after" in headers:
            limit = "the token's hourly limit" if authenticated else "60 requests an hour per IP address, no token"
            return f"GitHub's API rate limit is used up (HTTP {status}; {limit}). {_retry_hint(headers)}"
        if authenticated:
            return f"GitHub refused the request (HTTP {status}; the token may lack read-only Contents access)."
        return f"GitHub refused the request (HTTP {status})."
    return f"HTTP {status} from {host}"


def _retry_hint(headers: Dict[str, str]) -> str:
    """When to try again, from GitHub's ``retry-after`` / ``x-ratelimit-reset`` headers."""
    retry_after = headers.get("retry-after", "").strip()
    if retry_after.isdigit():
        return f"Try again in {int(retry_after)} seconds; the next daily check retries anyway."
    reset = headers.get("x-ratelimit-reset", "").strip()
    if reset.isdigit():
        when = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(int(reset)))
        return f"Try again after {when}; the next daily check retries anyway."
    return "Try again later; the next daily check retries anyway."


# ---------------------------------------------------------------------------------------------- releases


@dataclass(frozen=True)
class Release:
    tag: str
    version: str
    assets: Dict[str, str]  # asset name -> API download URL
    name: str = ""
    body: str = ""  # release notes (Markdown)
    html_url: str = ""


def latest_release(gh: GitHub) -> Optional[Release]:
    """The latest final release, or None if GitHub's latest is a draft/pre-release or has an odd tag."""
    data = gh.get_json(LATEST_URL)
    tag = str(data.get("tag_name") or "")
    if data.get("draft") or data.get("prerelease"):
        log.info("Latest release %s is a draft or pre-release; ignoring it", tag)
        return None
    if parse_version(tag) is None:
        log.info("Ignoring release with unexpected tag %r", tag)
        return None
    assets = {}
    for asset in data.get("assets") or []:
        if isinstance(asset, dict) and asset.get("name") and asset.get("url"):
            assets[str(asset["name"])] = str(asset["url"])
    url = str(data.get("html_url") or "")
    if not url.startswith(f"https://github.com/{REPO}/"):
        url = f"https://github.com/{REPO}/releases/tag/{tag}"
    return Release(tag=tag, version=tag[1:] if tag.startswith("v") else tag, assets=assets,
                   name=str(data.get("name") or ""), body=str(data.get("body") or "")[:MAX_NOTES_CHARS], html_url=url)


def asset_name(version: str, platform: str) -> str:
    """The file to download: repopulse-X.Y.Z-linux.tar.gz (scripts/build-release.sh) or, on Windows, the installer
    repopulse-X.Y.Z-setup.exe (packaging/windows/build-setup.ps1)."""
    if platform == "windows":
        return f"{NAME}-{version}-setup.exe"
    if platform == "linux":
        return f"{NAME}-{version}-linux.tar.gz"
    raise UpdateError(f"Unknown platform {platform!r}")


def parse_checksums(text: str) -> Dict[str, str]:
    """``sha256sum`` output -> {file name: lower-case hex digest}."""
    sums = {}
    for line in text.splitlines():
        match = _SUM_RE.match(line.strip())
        if match:
            sums[match.group(2).strip()] = match.group(1).lower()
    return sums


# ---------------------------------------------------------------------------------------------- extraction


def _safe_member(name: str, prefix: str) -> PurePosixPath:
    path = PurePosixPath(name.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != prefix or re.match(r"^[A-Za-z]:", name):
        raise UpdateError(f"Unsafe path in the release archive: {name!r}")
    return path


def extract(archive: Path, dest: Path, prefix: str) -> Path:
    """Extract a release archive into the (empty) ``dest``. Only regular files and folders under ``prefix/``."""
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist():
                _safe_member(info.filename, prefix)
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise UpdateError(f"Symbolic link in the release archive: {info.filename!r}")
            zf.extractall(dest)
    else:
        with tarfile.open(archive, "r:gz") as tar:
            members = tar.getmembers()
            for member in members:
                _safe_member(member.name, prefix)
                if not (member.isfile() or member.isdir()):
                    raise UpdateError(f"Unsupported entry in the release archive: {member.name!r}")
            if hasattr(tarfile, "data_filter"):
                tar.extractall(dest, members=members, filter="data")
            else:  # pragma: no cover - older Pythons without the extraction filters
                tar.extractall(dest, members=members)  # nosemgrep: python.lang.security.audit.tarfile-extractall-traversal.tarfile-extractall-traversal -- every member was checked above
    root = dest / prefix
    if not (root / "repopulse" / "__init__.py").is_file() or not (root / "requirements.txt").is_file():
        raise UpdateError("The release archive does not contain RepoPulse")
    return root


# ---------------------------------------------------------------------------------------------- commands


def download_release(gh: GitHub, release: Release, platform: str, dest: Path) -> Path:
    """Download, verify and extract ``release`` into the empty ``dest``; returns the extracted release folder (Linux)
    or the verified installer (Windows)."""
    name = asset_name(release.version, platform)
    if name not in release.assets:
        raise UpdateError(f"Release {release.tag} has no {name}")
    if CHECKSUMS not in release.assets:
        raise UpdateError(f"Release {release.tag} has no {CHECKSUMS}; refusing to install an unverified download")
    dest.mkdir(parents=True, exist_ok=True)
    if any(dest.iterdir()):
        raise UpdateError(f"{dest} must be empty")
    downloads = dest / "download"
    downloads.mkdir()
    sums_file = downloads / CHECKSUMS
    gh.download(release.assets[CHECKSUMS], sums_file, max_bytes=1024 * 1024)
    expected = parse_checksums(sums_file.read_text(encoding="utf-8", errors="replace")).get(name)
    if not expected:
        raise UpdateError(f"{CHECKSUMS} of {release.tag} has no entry for {name}")
    archive = downloads / name
    log.info("Downloading %s", name)
    actual = gh.download(release.assets[name], archive)
    if actual != expected:
        archive.unlink()
        raise UpdateError(f"Checksum mismatch for {name}: expected {expected}, got {actual}")
    log.info("SHA-256 verified (%s)", actual)
    if name.endswith(".exe"):
        # the Windows installer is run as it is (auto-update.ps1); nothing to extract
        target = dest / "release" / name
        target.parent.mkdir()
        archive.replace(target)
        shutil.rmtree(downloads, ignore_errors=True)
        return target
    root = extract(archive, dest / "release", f"{NAME}-{release.version}")
    shutil.rmtree(downloads, ignore_errors=True)
    return root


def default_platform() -> str:
    return "windows" if sys.platform == "win32" else "linux"


def main(argv=None, transport: Transport = urllib_transport) -> int:
    parser = argparse.ArgumentParser(description="Check for and download RepoPulse releases.")
    parser.add_argument("--installed", required=True, help="the installed version, e.g. 1.2.0")
    parser.add_argument("--token-file", type=Path, help="file holding a GitHub token (optional: the repository is public)")
    parser.add_argument("--platform", choices=("linux", "windows"), default=default_platform())
    sub = parser.add_subparsers(dest="command")
    sub.required = True
    sub.add_parser("check", help="only report whether a newer release exists")
    download = sub.add_parser("download", help="download, verify and extract a newer release")
    download.add_argument("--dest", type=Path, required=True, help="empty folder to extract the release into")
    args = parser.parse_args(argv)

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False
    try:
        if parse_version(args.installed) is None:
            # a pre-release or a copy from git: never replaced automatically
            log.info("Installed version %r is not a final release; not updating it automatically", args.installed)
            return EXIT_UP_TO_DATE
        gh = GitHub(read_token(args.token_file) if args.token_file else None, transport)
        release = latest_release(gh)
        if release is None or not is_newer(release.version, args.installed):
            log.info("Installed version %s is up to date (latest release: %s)", args.installed, release.version if release else "none")
            return EXIT_UP_TO_DATE
        log.info("Update available: %s -> %s", args.installed, release.version)
        if args.command == "download":
            root = download_release(gh, release, args.platform, args.dest)
            print(os.fspath(root))
        else:
            print(release.version)
        return EXIT_OK
    except UpdateError as exc:
        log.error("%s", exc)
        return EXIT_ERROR
    except Exception:  # noqa: BLE001 - the script must always end with an exit code the wrapper understands
        log.exception("Unexpected error while checking for updates")
        return EXIT_ERROR
    finally:
        log.removeHandler(handler)


if __name__ == "__main__":
    sys.exit(main())
