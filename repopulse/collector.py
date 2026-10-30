"""Daily data collection and the background scheduler."""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime

from .db import Database
from .github import GitHubClient, GitHubError, parse_repo

log = logging.getLogger("repopulse.collector")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


class Collector:
    def __init__(self, db: Database, api_url: str):
        self.db = db
        self.api_url = api_url
        self._lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self.pending: set[int] = set()  # repositories to collect once the current run is done
        self.current_run: int | None = None

    def mark_interrupted(self) -> None:
        """Runs still 'running' when the server starts were cut off by a stop or crash; close them."""
        self.db.execute("UPDATE runs SET status = 'failed', finished_at = ?, "
                        "message = COALESCE(message || char(10), '') || ? WHERE status = 'running'",
                        (now_iso(), "Interrupted: the server stopped during this run."))

    def client(self) -> GitHubClient:
        return GitHubClient(self.api_url, self.db.get_setting("github_token", "") or "")

    @property
    def busy(self) -> bool:
        return self._lock.locked()

    # ------------------------------------------------------------------
    def collect_repo(self, client: GitHubClient, repo, date: str) -> None:
        info = client.repo(repo["owner"], repo["name"])
        releases = [r for r in client.releases(repo["owner"], repo["name"])
                    if not r.get("draft")]
        stamp = now_iso()
        with self.db.transaction() as con:
            # GitHub may have renamed/moved the repo; follow it.
            full = info.get("full_name")
            try:
                if not isinstance(full, str) or full.count("/") != 1:
                    raise ValueError(full)
                owner, name = parse_repo(full)
            except ValueError:
                owner, name = repo["owner"], repo["name"]
            clash = con.execute("SELECT id FROM repos WHERE lower(owner) = lower(?) AND lower(name) = lower(?) "
                                "AND id != ?", (owner, name, repo["id"])).fetchone()
            if clash:
                owner, name = repo["owner"], repo["name"]
            con.execute(
                "UPDATE repos SET owner = ?, name = ?, description = ?, html_url = ?, "
                "last_collected = ?, last_error = NULL WHERE id = ?",
                (owner, name, info.get("description") or "", info.get("html_url") or "",
                 stamp, repo["id"]))
            con.execute(
                "INSERT INTO snapshots(repo_id, date, stars, forks, watchers, open_issues, "
                "release_count, collected_at) VALUES(?,?,?,?,?,?,?,?) "
                "ON CONFLICT(repo_id, date) DO UPDATE SET stars=excluded.stars, "
                "forks=excluded.forks, watchers=excluded.watchers, "
                "open_issues=excluded.open_issues, release_count=excluded.release_count, "
                "collected_at=excluded.collected_at",
                (repo["id"], date, info.get("stargazers_count", 0), info.get("forks_count", 0),
                 info.get("subscribers_count", info.get("watchers_count", 0)),
                 info.get("open_issues_count", 0), len(releases), stamp))
            con.execute("DELETE FROM asset_snapshots WHERE repo_id = ? AND date = ?",
                        (repo["id"], date))
            for rel in releases:
                tag = rel.get("tag_name") or str(rel.get("id"))
                con.execute(
                    "INSERT INTO releases(repo_id, tag, name, published_at, prerelease, html_url) "
                    "VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id, tag) DO UPDATE SET "
                    "name=excluded.name, published_at=excluded.published_at, "
                    "prerelease=excluded.prerelease, html_url=excluded.html_url",
                    (repo["id"], tag, rel.get("name") or tag,
                     rel.get("published_at") or rel.get("created_at"),
                     1 if rel.get("prerelease") else 0, rel.get("html_url")))
                for asset in rel.get("assets") or []:
                    con.execute(
                        "INSERT INTO asset_snapshots(repo_id, date, tag, asset, downloads) "
                        "VALUES(?,?,?,?,?) ON CONFLICT DO UPDATE SET downloads=excluded.downloads",
                        (repo["id"], date, tag, asset.get("name") or "?",
                         int(asset.get("download_count") or 0)))

    def run(self, trigger: str = "manual", repo_ids: list[int] | None = None,
            wait: bool = True, queue: bool = False) -> int | None:
        """Collect now. Returns the run id, or None if a run is already going. With `queue` and `repo_ids`,
        those repositories are then collected in a run of their own as soon as the current one ends."""
        with self._pending_lock:
            if not self._lock.acquire(blocking=False):
                if queue and repo_ids:
                    self.pending.update(repo_ids)
                return None
        try:
            started = now_iso()
            with self.db.transaction() as con:
                run_id = con.execute(
                    "INSERT INTO runs(started_at, trigger, status) VALUES(?,?, 'running')",
                    (started, trigger)).lastrowid
            self.current_run = run_id
        except BaseException:
            self._lock.release()
            raise

        def work():
            ok = failed = 0
            status = "failed"
            errors: list[str] = []
            try:
                client = self.client()
                sql = "SELECT * FROM repos WHERE enabled = 1"
                params: list = []
                if repo_ids:
                    sql = "SELECT * FROM repos WHERE id IN (%s)" % ",".join("?" * len(repo_ids))
                    params = list(repo_ids)
                repos = self.db.query(sql + " ORDER BY sort_order, id", params)
                date = today()
                for repo in repos:
                    try:
                        self.collect_repo(client, repo, date)
                        ok += 1
                    except (GitHubError, ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
                        failed += 1
                        msg = f"{repo['owner']}/{repo['name']}: {exc}"
                        errors.append(msg)
                        log.warning("Collect failed: %s", msg)
                        self.db.execute("UPDATE repos SET last_error = ? WHERE id = ?",
                                        (str(exc), repo["id"]))
                        if isinstance(exc, GitHubError) and exc.status in (401, 403, 429):
                            # Token or rate-limit problem: no point hammering the rest.
                            if "rate limit" in str(exc).lower() or exc.status == 401:
                                remaining = len(repos) - ok - failed
                                if remaining:
                                    errors.append(f"Stopped early; {remaining} repo(s) skipped.")
                                break
                status = "ok" if failed == 0 else ("partial" if ok else "failed")
                if not repos:
                    status, errors = "ok", ["No repositories to collect."]
            except Exception as exc:  # pragma: no cover - unexpected
                log.exception("Collection crashed")
                status = "failed"
                errors.append(f"Unexpected error: {exc}")
            finally:
                self.db.execute(
                    "UPDATE runs SET finished_at = ?, status = ?, repos_ok = ?, "
                    "repos_failed = ?, message = ? WHERE id = ?",
                    (now_iso(), status, ok, failed,
                     "\n".join(errors) or None, run_id))
                self.current_run = None
                with self._pending_lock:
                    queued, self.pending = sorted(self.pending), set()
                    self._lock.release()
                log.info("Collection run %s finished: %s ok, %s failed", run_id, ok, failed)
                if queued:
                    self.run("repo added", repo_ids=queued, wait=False, queue=True)

        if wait:
            work()
        else:
            threading.Thread(target=work, name="collector", daemon=True).start()
        return run_id


class Scheduler(threading.Thread):
    """Runs the collector once a day at the configured local time.

    If the server was off at that time, the run happens as soon as it starts
    again (once per day).
    """

    def __init__(self, db: Database, collector: Collector, interval: int = 30):
        super().__init__(name="scheduler", daemon=True)
        self.db = db
        self.collector = collector
        self.interval = interval
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def due(self, now: datetime | None = None) -> bool:
        now = now or datetime.now()
        when = str(self.db.get_setting("collection_time", "03:00") or "03:00")
        try:
            hh, mm = (int(x) for x in when.split(":")[:2])
        except ValueError:
            hh, mm = 3, 0
        if (now.hour, now.minute) < (hh, mm):
            return False
        return self.db.get_setting("last_scheduled_run", "") != now.strftime("%Y-%m-%d")

    def run(self) -> None:
        log.info("Scheduler started")
        while not self._stop.is_set():
            try:
                if self.due() and not self.collector.busy:
                    day = datetime.now().strftime("%Y-%m-%d")
                    # only a run that really started counts; if another just began, try again next time
                    if self.collector.run("scheduled", wait=True) is not None:
                        self.db.set_setting("last_scheduled_run", day)
            except Exception:  # pragma: no cover
                log.exception("Scheduler error")
            self._stop.wait(self.interval)
