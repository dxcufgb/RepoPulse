"""Server-level configuration (host, port, data folder).

Values come from, in order of priority:
  1. environment variables (REPOPULSE_HOST, REPOPULSE_PORT, REPOPULSE_DATA_DIR, ...)
  2. config.json in the project folder
  3. built-in defaults

Everything that can be changed while the server runs (GitHub token, collection
time, site title, dashboard layout ...) lives in the database instead and is
edited from the admin pages.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = Path(os.environ.get("REPOPULSE_CONFIG", PROJECT_ROOT / "config.json"))


def _bool(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Config:
    host: str = "0.0.0.0"
    port: int = 8080
    # nosemgrep: python.lang.maintainability.return-not-in-function -- a lambda, not a return statement
    data_dir: Path = field(default_factory=lambda: PROJECT_ROOT / "data")
    # Set to true when the server sits behind nginx/Caddy/IIS etc. so client IPs
    # and https are detected from X-Forwarded-* headers.
    behind_proxy: bool = False
    # Mark the session cookie "Secure" (only sent over https). Turn on when you
    # serve the dashboard over https.
    secure_cookies: bool = False
    # Allow the first-run "create admin account" page from other machines than
    # the server itself. Off by default so nobody else can claim the admin login.
    allow_remote_setup: bool = False
    # Base URL of the GitHub REST API (change for GitHub Enterprise).
    github_api_url: str = "https://api.github.com"
    threads: int = 8

    @property
    def db_path(self) -> Path:
        return self.data_dir / "repopulse.db"

    @property
    def secret_file(self) -> Path:
        return self.data_dir / "secret.key"


def load_config() -> Config:
    cfg = Config()
    raw: dict = {}
    if CONFIG_FILE.exists():
        try:
            # utf-8-sig: Windows PowerShell 5.1 (install.ps1 -Port) and older Notepad save it with a BOM
            raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:  # pragma: no cover - user error
            raise SystemExit(f"Could not read {CONFIG_FILE}: {exc}")

    env = os.environ
    def pick(key: str, default):
        env_key = "REPOPULSE_" + key.upper()
        if env_key in env:
            return env[env_key]
        return raw.get(key, default)

    cfg.host = str(pick("host", cfg.host))
    cfg.port = int(pick("port", cfg.port))
    data_dir = Path(str(pick("data_dir", cfg.data_dir))).expanduser()
    cfg.data_dir = data_dir if data_dir.is_absolute() else (PROJECT_ROOT / data_dir)
    cfg.behind_proxy = _bool(pick("behind_proxy", cfg.behind_proxy))
    cfg.secure_cookies = _bool(pick("secure_cookies", cfg.secure_cookies))
    cfg.allow_remote_setup = _bool(pick("allow_remote_setup", cfg.allow_remote_setup))
    cfg.github_api_url = str(pick("github_api_url", cfg.github_api_url)).rstrip("/")
    cfg.threads = int(pick("threads", cfg.threads))
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    return cfg
