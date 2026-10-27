"""Repository names, asset filters, configuration and a collection run against a fake GitHub."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from repopulse import config as config_module
from repopulse.collector import Collector, Scheduler
from repopulse.db import Database, glob_clause
from repopulse.github import GitHubClient, GitHubError, parse_repo
from repopulse.stats import asset_counted, history
from tests.helpers import AppTestCase, close_db


class ParseRepo(unittest.TestCase):
    def test_accepted_forms(self):
        for text in ("octocat/Hello-World", " octocat/Hello-World/ ", "github.com/octocat/Hello-World",
                     "https://github.com/octocat/Hello-World", "https://www.github.com/octocat/Hello-World.git",
                     "https://github.com/octocat/Hello-World/releases?x=1#y"):
            self.assertEqual(parse_repo(text), ("octocat", "Hello-World"), text)
        self.assertEqual(parse_repo("a/.github"), ("a", ".github"))
        self.assertEqual(parse_repo("a/b..c"), ("a", "b..c"))

    def test_rejected(self):
        for text in ("", "octocat", "-bad/x", "a" * 40 + "/x", "o/" + "n" * 101, "o/na me", "o/..", "o/.",
                     "https://github.com/o/../x", "o/%2e%2e", "ow ner/x"):
            with self.assertRaises(ValueError, msg=text):
                parse_repo(text)


class AssetFilter(unittest.TestCase):
    NAMES = ["module.zip", "Module.ZIP", "module.json", "app-1.0-setup.exe", "notes.txt", "a[1].zip"]
    FILTERS = ["", "*.zip", "*.zip, *.exe", "!module.json", "*.zip; !module.zip", "module.*, !*.json", "!", " , "]

    def test_sql_and_python_agree(self):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE t(asset TEXT)")
        con.executemany("INSERT INTO t VALUES(?)", [(n,) for n in self.NAMES])
        for flt in self.FILTERS:
            sql, params = glob_clause(flt)
            # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- test of glob_clause's own output; values are parameters
            in_sql = {r[0] for r in con.execute("SELECT asset FROM t WHERE 1=1" + sql, params)}
            in_py = {n for n in self.NAMES if asset_counted(n, flt)}
            self.assertEqual(in_sql, in_py, flt)

    def test_examples(self):
        self.assertTrue(asset_counted("module.zip", "*.zip"))
        self.assertFalse(asset_counted("module.json", "*.zip"))
        self.assertFalse(asset_counted("module.json", "!module.json"))
        self.assertTrue(asset_counted("anything", ""))

    def test_filter_is_passed_as_parameters(self):
        sql, params = glob_clause("x') OR 1=1 --")
        self.assertNotIn("1=1", sql)
        self.assertEqual(params, ["x') or 1=1 --"])


class LoadConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="repopulse-cfg-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def load(self, file_values=None, env=None):
        cfg_file = self.tmp / "config.json"
        if file_values is not None:
            cfg_file.write_text(json.dumps(file_values), encoding="utf-8")
        clean = {k: v for k, v in os.environ.items() if not k.startswith("REPOPULSE_")}
        clean.update(env or {})
        with mock.patch.object(config_module, "CONFIG_FILE", cfg_file), \
                mock.patch.object(config_module, "PROJECT_ROOT", self.tmp), \
                mock.patch.dict(os.environ, clean, clear=True):
            return config_module.load_config()

    def test_defaults(self):
        cfg = self.load()
        self.assertEqual((cfg.host, cfg.port), ("0.0.0.0", 8080))
        self.assertFalse(cfg.behind_proxy or cfg.secure_cookies or cfg.allow_remote_setup)
        self.assertEqual(cfg.data_dir, self.tmp / "data")
        self.assertTrue(cfg.data_dir.is_dir())

    def test_file_then_environment(self):
        cfg = self.load({"port": 9000, "data_dir": "store", "secure_cookies": True, "github_api_url": "https://ghe/api/v3/"},
                        {"REPOPULSE_PORT": "9100", "REPOPULSE_BEHIND_PROXY": "yes"})
        self.assertEqual(cfg.port, 9100)
        self.assertTrue(cfg.behind_proxy)
        self.assertTrue(cfg.secure_cookies)
        self.assertEqual(cfg.data_dir, self.tmp / "store")
        self.assertEqual(cfg.github_api_url, "https://ghe/api/v3")
        self.assertEqual(cfg.db_path, self.tmp / "store" / "repopulse.db")


class FakeGitHub:
    def __init__(self, downloads=10, error=None):
        self.downloads, self.error, self.calls = downloads, error, []

    def repo(self, owner, name):
        self.calls.append(("repo", owner, name))
        if self.error:
            raise self.error
        return {"full_name": f"{owner}/{name}", "description": "d", "html_url": f"https://github.com/{owner}/{name}",
                "stargazers_count": 3, "forks_count": 1, "subscribers_count": 2, "open_issues_count": 0}

    def releases(self, owner, name):
        return [
            {"tag_name": "v1.0.0", "name": "One", "published_at": "2026-01-01T00:00:00Z", "assets": [
                {"name": "module.zip", "download_count": self.downloads},
                {"name": "module.json", "download_count": 1000}]},
            {"tag_name": "v2.0.0", "draft": True, "assets": [{"name": "module.zip", "download_count": 99}]},
        ]


class Collection(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="repopulse-db-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.db = Database(self.tmp / "repopulse.db")
        self.addCleanup(close_db, self.db)
        self.db.execute("INSERT INTO repos(owner, name, added_at, asset_filter) VALUES('o', 'r', 'x', '*.zip')")
        self.collector = Collector(self.db, "https://api.github.com")

    def test_run_stores_counts_and_skips_drafts(self):
        fake = FakeGitHub(downloads=42)
        with mock.patch.object(Collector, "client", return_value=fake):
            run_id = self.collector.run("test", wait=True)
        run = self.db.query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
        self.assertEqual((run["status"], run["repos_ok"], run["repos_failed"]), ("ok", 1, 0))
        tags = [r["tag"] for r in self.db.query("SELECT tag FROM releases")]
        self.assertEqual(tags, ["v1.0.0"])
        repo = self.db.query_one("SELECT * FROM repos WHERE id = 1")
        # only module.zip counts with the *.zip filter
        self.assertEqual(history(self.db, repo)[-1][1], 42)
        self.assertFalse(self.collector.busy)

    def test_failed_repository_is_logged_not_raised(self):
        fake = FakeGitHub(error=GitHubError("Repository not found", 404))
        with mock.patch.object(Collector, "client", return_value=fake):
            run_id = self.collector.run("test", wait=True)
        run = self.db.query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
        self.assertEqual(run["status"], "failed")
        self.assertIn("Repository not found", run["message"])
        self.assertEqual(self.db.query_one("SELECT last_error FROM repos")["last_error"], "Repository not found")

    def test_only_one_run_at_a_time(self):
        self.assertTrue(self.collector._lock.acquire(blocking=False))
        try:
            self.assertIsNone(self.collector.run("test", wait=True))
        finally:
            self.collector._lock.release()

    def test_scheduler_runs_once_a_day_after_the_time(self):
        sched = Scheduler(self.db, self.collector)
        self.db.set_setting("collection_time", "03:00")
        self.assertFalse(sched.due(datetime(2026, 5, 1, 2, 59)))
        self.assertTrue(sched.due(datetime(2026, 5, 1, 3, 0)))
        self.db.set_setting("last_scheduled_run", "2026-05-01")
        self.assertFalse(sched.due(datetime(2026, 5, 1, 23, 0)))
        self.assertTrue(sched.due(datetime(2026, 5, 2, 3, 30)))


class Client(unittest.TestCase):
    def test_token_is_sent_only_as_a_header(self):
        seen = {}

        class Resp:
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"resources": {"core": {"limit": 5000}}}'

        def fake_urlopen(req, timeout):
            seen["url"], seen["auth"], seen["timeout"] = req.full_url, req.get_header("Authorization"), timeout
            return Resp()

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            core = GitHubClient("https://api.github.com/", " secret-token ", timeout=7).rate_limit()
        self.assertEqual(core, {"limit": 5000})
        self.assertEqual(seen["url"], "https://api.github.com/rate_limit")
        self.assertEqual(seen["auth"], "Bearer secret-token")
        self.assertEqual(seen["timeout"], 7)


class AdminRepositories(AppTestCase):
    def test_add_rejects_bad_names_before_calling_github(self):
        from repopulse import auth
        auth.create_user(self.db, "admin", "correct horse battery")
        csrf = self.login()
        with mock.patch.object(GitHubClient, "repo", side_effect=AssertionError("no network in tests")):
            res = self.client.post("/api/admin/repos", json={"repos": ["o/..", "not a repo"], "collect": False},
                                   headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(len(res.get_json()["errors"]), 2)
        self.assertEqual(self.db.query("SELECT * FROM repos"), [])

    def test_add_and_update(self):
        from repopulse import auth
        auth.create_user(self.db, "admin", "correct horse battery")
        csrf = self.login()
        info = {"full_name": "Octo/Hello", "description": "x", "html_url": "https://github.com/Octo/Hello"}
        with mock.patch.object(GitHubClient, "repo", return_value=info):
            res = self.client.post("/api/admin/repos", json={"repo": "octo/hello", "collect": False},
                                   headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.status_code, 200, res.get_json())
        repo_id = res.get_json()["added"][0]["id"]
        bad = self.client.patch(f"/api/admin/repos/{repo_id}", json={"color": "red;"}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(bad.status_code, 400)
        ok = self.client.patch(f"/api/admin/repos/{repo_id}", json={"color": "#4F7CFF", "hidden": True, "label": "L"},
                               headers={"X-CSRF-Token": csrf})
        self.assertEqual(ok.status_code, 200)
        row = self.db.query_one("SELECT * FROM repos WHERE id = ?", (repo_id,))
        self.assertEqual((row["owner"], row["name"], row["color"], row["hidden"], row["label"]),
                         ("Octo", "Hello", "#4F7CFF", 1, "L"))

    def test_layout_size_limits(self):
        from repopulse import auth
        auth.create_user(self.db, "admin", "correct horse battery")
        csrf = self.login()
        for layout in (None, [], {"widgets": "x"}, {"widgets": [{}] * 61}):
            res = self.client.put("/api/admin/layout", json={"layout": layout}, headers={"X-CSRF-Token": csrf})
            self.assertEqual(res.status_code, 400, layout)
        res = self.client.put("/api/admin/layout", json={"layout": {"widgets": [{"type": "total"}]}},
                              headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.status_code, 200)


if __name__ == "__main__":
    unittest.main()
