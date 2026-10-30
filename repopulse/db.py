"""SQLite storage.

One small file (data/repopulse.db) holds everything:

  repos            the repositories being tracked
  snapshots        one row per repo per day: stars, forks, watchers ...
  asset_snapshots  one row per release asset per repo per day: download count
  releases         release metadata (tag, name, publish date)
  settings         key/value settings edited from the admin pages
  users            admin accounts
  runs             log of collection runs

Download totals are computed from asset_snapshots so a repo's asset filter
(for example "only count *.zip files") can be changed later and the whole
history is recalculated with it.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS repos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    owner           TEXT NOT NULL,
    name            TEXT NOT NULL,
    label           TEXT,
    color           TEXT,
    description     TEXT,
    html_url        TEXT,
    asset_filter    TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 1,
    hidden          INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    added_at        TEXT NOT NULL,
    last_collected  TEXT,
    last_error      TEXT,
    layout          TEXT,
    UNIQUE(owner, name) ON CONFLICT ABORT
);

CREATE TABLE IF NOT EXISTS snapshots (
    repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    date          TEXT NOT NULL,
    stars         INTEGER NOT NULL DEFAULT 0,
    forks         INTEGER NOT NULL DEFAULT 0,
    watchers      INTEGER NOT NULL DEFAULT 0,
    open_issues   INTEGER NOT NULL DEFAULT 0,
    release_count INTEGER NOT NULL DEFAULT 0,
    collected_at  TEXT NOT NULL,
    PRIMARY KEY (repo_id, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS asset_snapshots (
    repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    tag         TEXT NOT NULL,
    asset       TEXT NOT NULL,
    downloads   INTEGER NOT NULL,
    PRIMARY KEY (repo_id, date, tag, asset)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS releases (
    repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    tag          TEXT NOT NULL,
    name         TEXT,
    published_at TEXT,
    prerelease   INTEGER NOT NULL DEFAULT 0,
    html_url     TEXT,
    PRIMARY KEY (repo_id, tag)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_login    TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    trigger      TEXT NOT NULL,
    status       TEXT NOT NULL,
    repos_ok     INTEGER NOT NULL DEFAULT 0,
    repos_failed INTEGER NOT NULL DEFAULT 0,
    message      TEXT
);

CREATE INDEX IF NOT EXISTS idx_asset_repo_date ON asset_snapshots(repo_id, date);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    "site_title": "RepoPulse",
    "site_subtitle": "Download statistics for my GitHub projects",
    "collection_time": "03:00",
    "github_token": "",
    "public_dashboard": True,
    "last_scheduled_run": "",
    "layout": None,       # overview page; the frontend's starter layout until saved
    "repo_layout": None,  # shared layout for repository pages
    "appearance": None,   # page-wide look (appearance.py); the built-in look until saved
}


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._local = threading.local()
        self.write_lock = threading.Lock()
        with self.connect() as con:
            con.executescript(SCHEMA)
            self._migrate(con)
            # nosemgrep: python.lang.security.audit.formatted-sql-query, python.sqlalchemy.security.sqlalchemy-execute-raw-query -- SCHEMA_VERSION is an int constant; PRAGMA takes no parameters
            con.execute("PRAGMA user_version = %d" % SCHEMA_VERSION)

    @staticmethod
    def _migrate(con: sqlite3.Connection) -> None:
        """Bring databases created by older versions up to date."""
        cols = {r[1] for r in con.execute("PRAGMA table_info(repos)")}
        if "layout" not in cols:  # v2: per-repository page layout
            con.execute("ALTER TABLE repos ADD COLUMN layout TEXT")

    def _new_connection(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.path, timeout=30, isolation_level=None,
                              check_same_thread=False)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("PRAGMA journal_mode = WAL")
        con.execute("PRAGMA synchronous = NORMAL")
        return con

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        """A connection reused per thread."""
        con = getattr(self._local, "con", None)
        if con is None:
            con = self._new_connection()
            self._local.con = con
        yield con

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.write_lock, self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            try:
                yield con
            except BaseException:
                con.execute("ROLLBACK")
                raise
            else:
                con.execute("COMMIT")

    # ---- helpers -------------------------------------------------------
    def query(self, sql: str, params: tuple | list = ()) -> list[sqlite3.Row]:
        with self.connect() as con:
            return con.execute(sql, params).fetchall()

    def query_one(self, sql: str, params: tuple | list = ()) -> sqlite3.Row | None:
        with self.connect() as con:
            return con.execute(sql, params).fetchone()

    def execute(self, sql: str, params: tuple | list = ()) -> sqlite3.Cursor:
        with self.transaction() as con:
            return con.execute(sql, params)

    # ---- settings ------------------------------------------------------
    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self.query_one("SELECT value FROM settings WHERE key = ?", (key,))
        if row is None:
            return DEFAULT_SETTINGS.get(key, default) if default is None else default
        try:
            return json.loads(row["value"])
        except ValueError:
            return row["value"]

    def set_setting(self, key: str, value: Any) -> None:
        self.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )

    def set_settings(self, values: dict[str, Any]) -> None:
        """Several settings in one transaction: all of them are saved or none."""
        if not values:
            return
        with self.transaction() as con:
            for key, value in values.items():
                con.execute("INSERT INTO settings(key, value) VALUES(?, ?) "
                            "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, json.dumps(value)))

    def all_settings(self) -> dict[str, Any]:
        out = dict(DEFAULT_SETTINGS)
        for row in self.query("SELECT key, value FROM settings"):
            try:
                out[row["key"]] = json.loads(row["value"])
            except ValueError:
                out[row["key"]] = row["value"]
        return out


def literal_brackets(pattern: str) -> str:
    """"[" and "]" match themselves. SQLite GLOB and Python's fnmatch disagree on character classes ("[!x]" negates
    in fnmatch, "[^x]" in GLOB), so the file filter has none and both sides get the same "[[]" escape."""
    return pattern.replace("[", "[[]")


def split_filter(asset_filter: str) -> tuple[list[str], list[str]]:
    """(includes, excludes), lower-case, with "[" escaped; a lone "!" is ignored."""
    includes, excludes = [], []
    for part in (asset_filter or "").replace(";", ",").split(","):
        part = part.strip()
        if part.startswith("!"):
            if part[1:].strip():
                excludes.append(literal_brackets(part[1:].strip().lower()))
        elif part:
            includes.append(literal_brackets(part.lower()))
    return includes, excludes


def glob_clause(asset_filter: str) -> tuple[str, list[str]]:
    """Turn "*.zip, module.json" into an SQL fragment using SQLite GLOB.

    Patterns starting with "!" exclude matching assets, e.g. "!module.json".
    """
    includes, excludes = split_filter(asset_filter)
    sql, params = "", []
    if includes:
        sql += " AND (" + " OR ".join("lower(asset) GLOB ?" for _ in includes) + ")"
        params += includes
    for pattern in excludes:
        sql += " AND lower(asset) NOT GLOB ?"
        params.append(pattern)
    return sql, params
