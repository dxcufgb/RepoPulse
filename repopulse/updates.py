"""What the web server knows about automatic updates (Admin, Settings, Updates).

The server never updates itself: it has no rights to. The installer sets up an updater that runs as root (Linux,
systemd) or SYSTEM (Windows, Task Scheduler); **Update now** only asks that updater to run:

- Linux: the server writes the time into ``data/update-request``; the systemd path unit
  ``repopulse-update-now.path`` sees the change and starts ``repopulse-update.service``. Root never reads the file.
- Windows: the server starts the scheduled task ``RepoPulse-UpdateNow`` (it runs as SYSTEM, like the server).

Nothing the server sends can change what the updater does: it only ever installs a strictly newer,
checksum-verified release of this repository.
"""
from __future__ import annotations

import subprocess  # nosec B404 - only fixed schtasks commands, no shell
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from . import __version__
from . import updater

SYSTEMD_DIR = Path("/etc/systemd/system")
TIMER = "repopulse-update.timer"
NOW_PATH_UNIT = "repopulse-update-now.path"
TASK_DAILY = "RepoPulse-Update"
TASK_NOW = "RepoPulse-UpdateNow"
REQUEST_FILE = "update-request"
REQUEST_EVERY = 120  # seconds between two Update now requests
CHECK_CACHE = 600    # seconds a Check for update answer is reused

_lock = threading.Lock()
_last_request = 0.0
_cached: Dict[str, Any] = {}


def _schtasks_exists(name: str) -> bool:
    try:
        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit -- fixed program and task name, no shell
        res = subprocess.run(["schtasks", "/Query", "/TN", name], capture_output=True, timeout=15, check=False)  # nosec B603 B607
    except (OSError, subprocess.SubprocessError):
        return False
    return res.returncode == 0


def setup(data_dir: Path) -> Dict[str, Any]:
    """{platform, daily, now}: whether the daily updates and the Update now button are set up on this machine."""
    if sys.platform == "win32":
        return {"platform": "windows", "daily": _schtasks_exists(TASK_DAILY), "now": _schtasks_exists(TASK_NOW)}
    if sys.platform.startswith("linux"):
        daily = (SYSTEMD_DIR / "timers.target.wants" / TIMER).exists()
        now = (SYSTEMD_DIR / NOW_PATH_UNIT).exists() and (data_dir / REQUEST_FILE).is_file()
        return {"platform": "linux", "daily": daily, "now": now}
    return {"platform": sys.platform, "daily": False, "now": False}


def request_now(data_dir: Path) -> Optional[str]:
    """Asks the updater to run now; an error message, or None when the request went out."""
    global _last_request
    with _lock:
        wait = REQUEST_EVERY - (time.monotonic() - _last_request)
        if _last_request and wait > 0:
            return f"An update was requested a moment ago. Try again in {int(wait) + 1} seconds."
        info = setup(data_dir)
        if not info["now"]:
            return "Update now is not set up on this machine. Run the installer again with automatic updates on."
        if info["platform"] == "windows":
            try:
                # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit -- fixed program and task name, no shell
                res = subprocess.run(["schtasks", "/Run", "/TN", TASK_NOW], capture_output=True, timeout=30, check=False)  # nosec B603 B607
            except (OSError, subprocess.SubprocessError) as exc:
                return f"Could not start the update task: {type(exc).__name__}"
            if res.returncode != 0:
                return "Could not start the update task (schtasks failed)."
        else:
            path = data_dir / REQUEST_FILE
            try:
                # the file exists (the installer made it); writing it is what the path unit watches for
                with open(path, "r+", encoding="utf-8") as fh:
                    fh.seek(0)
                    fh.write(time.strftime("%Y-%m-%dT%H:%M:%S\n"))
                    fh.truncate()
            except OSError as exc:
                return f"Could not write {path.name}: {exc.strerror or type(exc).__name__}"
        _last_request = time.monotonic()
    return None


def check_latest(force: bool = False) -> Dict[str, Any]:
    """{installed, latest, newer, url, notes, error}. GitHub is asked at most every ten minutes unless forced."""
    with _lock:
        if not force and _cached and time.monotonic() - _cached["_at"] < CHECK_CACHE:
            return {k: v for k, v in _cached.items() if k != "_at"}
    out: Dict[str, Any] = {"installed": __version__, "latest": None, "newer": False, "url": "", "notes": "", "error": ""}
    try:
        release = updater.latest_release(updater.GitHub(None, timeout=20))
        if release:
            out.update(latest=release.version, newer=updater.is_newer(release.version, __version__),
                       url=release.html_url, notes=release.body[:4000])
    except updater.UpdateError as exc:
        out["error"] = str(exc)
    with _lock:
        _cached.clear()
        _cached.update(out, _at=time.monotonic())
    return out
