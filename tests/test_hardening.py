"""Proxy trust, first-run setup, stale sessions, throttling, GitHub client errors and bad request bodies."""
from __future__ import annotations

import http.client
import http.server
import os
import shutil
import socket
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from unittest import mock

from repopulse import auth
from repopulse.collector import Collector, Scheduler
from repopulse.db import Database, glob_clause
from repopulse.github import GitHubClient, GitHubError, _RedirectHandler
from repopulse.stats import asset_counted
from tests.helpers import PASSWORD, AppTestCase, close_db

REMOTE = "203.0.113.7"
SETUP = {"username": "admin", "password": PASSWORD}


def token():
    # built at run time so no token-shaped literal ends up in the repository
    return "_".join(["ghp", "Z9y8X7w6" * 4 + "abcd"])


class Redirects(unittest.TestCase):
    """The token goes only to the configured API host, and never over plain http."""

    def follow(self, url, newurl, api="https://api.github.com"):
        req = urllib.request.Request(url)
        req.add_header("Authorization", "Bearer secret")
        return _RedirectHandler(api).redirect_request(req, None, 301, "Moved", {}, newurl)

    def test_same_host_keeps_the_token(self):
        new = self.follow("https://api.github.com/repos/a/b", "https://api.github.com/repositories/1")
        self.assertEqual(new.get_header("Authorization"), "Bearer secret")

    def test_other_host_drops_the_token(self):
        for newurl in ("https://example.org/x", "https://api.github.com:8443/x", "https://evil.api.github.com/x"):
            new = self.follow("https://api.github.com/repos/a/b", newurl)
            self.assertIsNone(new.get_header("Authorization"), newurl)

    def test_no_downgrade_to_http(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.follow("https://api.github.com/repos/a/b", "http://api.github.com/repos/a/c")

    def test_real_redirects(self):
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.headers.get("Host", "").split(":")[0], self.path, self.headers.get("Authorization")))
                port = self.server.server_address[1]
                if self.path.startswith("/repos/old/name"):
                    self.send_response(301)
                    self.send_header("Location", f"http://127.0.0.1:{port}/repos/new/name")
                elif self.path.startswith("/repos/away/name"):
                    self.send_response(302)
                    self.send_header("Location", f"http://localhost:{port}/elsewhere")
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                body = b'{"full_name": "new/name"}'
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        client = GitHubClient(f"http://127.0.0.1:{server.server_address[1]}", "secret", timeout=5)
        with mock.patch.dict(os.environ, {"no_proxy": "*", "NO_PROXY": "*"}):
            self.assertEqual(client.repo("old", "name")["full_name"], "new/name")
            client.repo("away", "name")
        self.assertEqual([(h, p.split("?")[0], a) for h, p, a in seen], [
            ("127.0.0.1", "/repos/old/name", "Bearer secret"),
            ("127.0.0.1", "/repos/new/name", "Bearer secret"),
            ("127.0.0.1", "/repos/away/name", "Bearer secret"),
            ("localhost", "/elsewhere", None),
        ])


class ClientErrors(unittest.TestCase):
    def test_low_level_errors_become_github_errors_without_the_token(self):
        secret = token()
        for exc in (socket.timeout("timed out"), ConnectionResetError("reset"), http.client.IncompleteRead(b"x"),
                    ValueError(f"Invalid header value b'Bearer {secret}\\n'")):
            with mock.patch("repopulse.github._open", side_effect=exc):
                with self.assertRaises(GitHubError) as ctx:
                    GitHubClient("https://api.github.com", secret).rate_limit()
            self.assertNotIn(secret, str(ctx.exception), exc)

    def test_token_with_a_line_break_never_reaches_a_message(self):
        secret = token() + "\nX-Injected: 1"
        with mock.patch.dict(os.environ, {"no_proxy": "*", "NO_PROXY": "*"}):
            with self.assertRaises(GitHubError) as ctx:
                GitHubClient("http://127.0.0.1:9", secret, timeout=2).rate_limit()
        self.assertNotIn(token(), str(ctx.exception))


class FakeGitHub:
    def __init__(self, fail=(), full_names=None):
        self.fail, self.full_names = set(fail), full_names or {}

    def repo(self, owner, name):
        if name in self.fail:
            raise GitHubError("GitHub did not answer in time")
        return {"full_name": self.full_names.get(name, f"{owner}/{name}"), "stargazers_count": 1}

    def releases(self, owner, name):
        return []


class CollectorAndScheduler(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="repopulse-db-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.db = Database(self.tmp / "repopulse.db")
        self.addCleanup(close_db, self.db)
        for name in ("a", "b"):
            self.db.execute("INSERT INTO repos(owner, name, added_at) VALUES('o', ?, 'x')", (name,))
        self.collector = Collector(self.db, "https://api.github.com")

    def test_one_failing_repository_does_not_stop_the_others(self):
        with mock.patch.object(Collector, "client", return_value=FakeGitHub(fail={"a"})):
            run_id = self.collector.run("test")
        run = self.db.query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
        self.assertEqual((run["status"], run["repos_ok"], run["repos_failed"]), ("partial", 1, 1))

    def test_bad_full_name_from_github_is_not_stored(self):
        fake = FakeGitHub(full_names={"a": "o/..", "b": "x/y/z"})
        with mock.patch.object(Collector, "client", return_value=fake):
            self.collector.run("test")
        names = [(r["owner"], r["name"]) for r in self.db.query("SELECT owner, name FROM repos ORDER BY id")]
        self.assertEqual(names, [("o", "a"), ("o", "b")])

    def test_scheduled_run_is_not_lost_while_busy(self):
        self.db.set_setting("collection_time", "00:00")
        sched = Scheduler(self.db, self.collector, interval=0)
        self.assertTrue(self.collector._lock.acquire(blocking=False))
        try:
            with mock.patch.object(Collector, "busy", new_callable=mock.PropertyMock, return_value=False):
                with mock.patch.object(sched._stop, "is_set", side_effect=[False, True]):
                    sched.run()
        finally:
            self.collector._lock.release()
        self.assertEqual(self.db.get_setting("last_scheduled_run"), "")
        self.assertTrue(sched.due())
        with mock.patch.object(Collector, "client", return_value=FakeGitHub()):
            with mock.patch.object(sched._stop, "is_set", side_effect=[False, True]):
                sched.run()
        self.assertEqual(self.db.get_setting("last_scheduled_run"), datetime.now().strftime("%Y-%m-%d"))

    def test_runs_left_running_are_closed_at_start(self):
        self.db.execute("INSERT INTO runs(started_at, trigger, status) VALUES('x', 'manual', 'running')")
        Collector(self.db, "https://api.github.com").mark_interrupted()
        run = self.db.query_one("SELECT * FROM runs")
        self.assertEqual(run["status"], "failed")
        self.assertIn("Interrupted", run["message"])
        self.assertIsNotNone(run["finished_at"])

    def test_repositories_added_during_a_run_are_collected_after_it(self):
        started = threading.Event()
        release = threading.Event()
        fake = FakeGitHub()
        original = fake.repo

        def slow_repo(owner, name):
            started.set()
            release.wait(5)
            return original(owner, name)

        fake.repo = slow_repo
        with mock.patch.object(Collector, "client", return_value=fake):
            self.collector.run("first", repo_ids=[1], wait=False)
            self.assertTrue(started.wait(5))
            self.assertIsNone(self.collector.run("repo added", repo_ids=[2], wait=False, queue=True))
            release.set()
            for _ in range(200):
                runs = self.db.query("SELECT * FROM runs WHERE status != 'running' ORDER BY id")
                if len(runs) == 2:
                    break
                threading.Event().wait(0.05)
        self.assertEqual([r["trigger"] for r in runs], ["first", "repo added"])
        self.assertEqual(self.db.query_one("SELECT last_collected FROM repos WHERE id = 2")["last_collected"] is None,
                         False)


class AssetFilterBrackets(unittest.TestCase):
    def test_brackets_are_literal_in_sql_and_python(self):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        names = ["xb", "ab", "!b", "^b", "[!a]b", "[^a]b", "file[1].zip", "file1.zip", "a]b"]
        con.execute("CREATE TABLE t(asset TEXT)")
        con.executemany("INSERT INTO t VALUES(?)", [(n,) for n in names])
        for pattern in ("[!a]b", "[^a]b", "file[1].zip", "*[*", "a]b", "!*[!a]*", "[a-z]b"):
            clause, params = glob_clause(pattern)
            # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- glob_clause's fixed fragment; values are ? parameters
            sql = [r[0] for r in con.execute("SELECT asset FROM t WHERE 1" + clause + " ORDER BY rowid", params)]
            py = [n for n in names if asset_counted(n, pattern)]
            self.assertEqual(sql, py, pattern)
        self.assertTrue(asset_counted("file[1].zip", "file[1].zip"))
        self.assertFalse(asset_counted("file1.zip", "file[1].zip"))


class ThrottleUnit(unittest.TestCase):
    def test_attempts_are_counted_before_the_check(self):
        t = auth.LoginThrottle(limit=3)
        self.assertEqual([t.attempt("x") for _ in range(3)], [0, 0, 0])
        self.assertGreater(t.attempt("x"), 0)
        t.reset("x")
        self.assertEqual(t.attempt("x"), 0)

    def test_size_is_capped_and_old_entries_pruned(self):
        t = auth.LoginThrottle(limit=3, window=60, max_keys=100)
        for i in range(1000):
            t.attempt(f"10.0.{i // 256}.{i % 256}")
        self.assertEqual(len(t.failures), 100)
        t.window = -1  # everything expires
        self.assertEqual(t.blocked_for("10.0.3.231"), 0)
        self.assertNotIn("10.0.3.231", t.failures)

    def test_parallel_attempts_stay_within_the_limit(self):
        t = auth.LoginThrottle(limit=5)
        results = []
        threads = [threading.Thread(target=lambda: results.append(t.attempt("x"))) for _ in range(50)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(results.count(0), 5)


class ProxyTrust(AppTestCase):
    config = {"behind_proxy": True}

    def test_a_direct_client_cannot_pose_as_localhost(self):
        res = self.client.post("/api/auth/setup", json=SETUP, environ_base={"REMOTE_ADDR": REMOTE},
                               headers={"X-Forwarded-For": "127.0.0.1"})
        self.assertEqual(res.status_code, 403)
        self.assertEqual(auth.user_count(self.db), 0)

    def test_a_direct_client_cannot_rotate_addresses_around_the_throttle(self):
        self.add_admin()
        for i in range(5):
            self.client.post("/api/auth/login", json={"username": "admin", "password": "nope nope"},
                             environ_base={"REMOTE_ADDR": REMOTE}, headers={"X-Forwarded-For": f"198.51.100.{i}"})
        res = self.client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD},
                               environ_base={"REMOTE_ADDR": REMOTE}, headers={"X-Forwarded-For": "198.51.100.99"})
        self.assertEqual(res.status_code, 429)

    def test_trusted_proxies(self):
        self.build_app(behind_proxy=True, trusted_proxies=["203.0.113.0/24", "not an address"])
        res = self.client.post("/api/auth/setup", json=SETUP, environ_base={"REMOTE_ADDR": REMOTE},
                               headers={"X-Forwarded-For": "127.0.0.1"})
        self.assertEqual(res.status_code, 200)


class LocalSetup(AppTestCase):
    def test_any_proxy_header_without_behind_proxy_is_not_local(self):
        for header in ("Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto"):
            res = self.client.post("/api/auth/setup", json=SETUP, headers={header: "x"})
            self.assertEqual(res.status_code, 403, header)
        self.assertEqual(auth.user_count(self.db), 0)

    def test_host_must_name_this_computer(self):
        for host in ("evil.example", "evil.example:8080", "localhost.evil.example"):
            res = self.client.post("/api/auth/setup", json=SETUP, headers={"Host": host})
            self.assertEqual(res.status_code, 403, host)
        self.assertFalse(self.client.get("/api/site", headers={"Host": "evil.example"}).get_json()["setup_allowed"])
        for host in ("127.0.0.1:8080", "[::1]:8080", "LOCALHOST"):
            self.assertTrue(self.client.get("/api/site", headers={"Host": host}).get_json()["setup_allowed"], host)
        self.assertEqual(self.client.post("/api/auth/setup", json=SETUP,
                                          environ_base={"REMOTE_ADDR": "::ffff:127.0.0.1"}).status_code, 200)

    def test_allow_remote_setup_still_overrides(self):
        self.build_app(allow_remote_setup=True)
        res = self.client.post("/api/auth/setup", json=SETUP, headers={"Host": "dash.example"},
                               environ_base={"REMOTE_ADDR": REMOTE})
        self.assertEqual(res.status_code, 200)

    def test_only_one_first_account(self):
        self.assertTrue(auth.create_first_user(self.db, "admin", PASSWORD))
        self.assertFalse(auth.create_first_user(self.db, "other", PASSWORD))
        self.assertEqual(auth.user_count(self.db), 1)

    def test_parallel_setup_creates_one_account(self):
        def one(name):
            db = Database(self.db.path)
            try:
                results.append(auth.create_first_user(db, name, PASSWORD))
            finally:
                close_db(db)

        results = []
        threads = [threading.Thread(target=one, args=(f"admin{i}",)) for i in range(4)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(results.count(True), 1)
        self.assertEqual(auth.user_count(self.db), 1)


class StaleSession(AppTestCase):
    def setUp(self):
        super().setUp()
        self.add_admin()
        self.db.execute("INSERT INTO repos(owner, name, added_at, hidden) VALUES('o', 'secret', 'x', 1)")
        self.db.execute("INSERT INTO snapshots(repo_id, date, collected_at) VALUES(1, '2026-01-01', 'x')")
        self.login()
        auth.set_password(self.db, "admin", "changed elsewhere")

    def test_ended_session_sees_only_public_data(self):
        site = self.client.get("/api/site").get_json()
        self.assertIsNone(site["user"])
        self.assertIsNone(site["csrf"])
        self.assertNotIn("secret", self.client.get("/api/dashboard?all=1").get_data(as_text=True))
        self.assertNotIn("secret", self.client.get("/api/export.csv").get_data(as_text=True))
        self.assertEqual(self.client.get("/api/repos/1/page").status_code, 404)

    def test_ended_session_cannot_read_a_private_dashboard(self):
        self.db.set_setting("public_dashboard", False)
        for path in ("/api/dashboard", "/api/export.csv", "/api/repos/1/releases"):
            self.assertEqual(self.client.get(path).status_code, 401, path)


class BadBodies(AppTestCase):
    def setUp(self):
        super().setUp()
        self.add_admin()
        self.csrf = self.login()

    def send(self, method, path, **kw):
        return getattr(self.client, method)(path, headers={"X-CSRF-Token": self.csrf}, **kw)

    def test_wrong_types_are_400(self):
        with mock.patch.object(Collector, "run", return_value=None) as run:
            cases = [("post", "/api/admin/collect", {"repo_ids": "1"}),
                     ("post", "/api/admin/collect", {"repo_ids": [1, "x"]}),
                     ("post", "/api/admin/collect", {"repo_ids": [2 ** 70]}),
                     ("post", "/api/admin/collect", {"repo_ids": {"a": 1}}),
                     ("post", "/api/admin/repos/order", {"ids": "1,2"}),
                     ("post", "/api/admin/repos/order", {"ids": ["²"]}),
                     ("post", "/api/admin/repos", {"repos": {"a": 1}}),
                     ("post", "/api/admin/repos", {"repos": [1, 2]})]
            for method, path, data in cases:
                self.assertEqual(self.send(method, path, json=data).status_code, 400, (path, data))
            run.assert_not_called()

    def test_deeply_nested_json_is_400(self):
        deep = "[" * 100000 + "]" * 100000
        res = self.send("post", "/api/admin/collect", data=deep, content_type="application/json")
        self.assertEqual(res.status_code, 400)

    def test_settings_are_saved_all_or_nothing(self):
        res = self.send("put", "/api/admin/settings", json={"site_title": "New", "collection_time": "25:00"})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.db.get_setting("site_title"), "RepoPulse")

    def test_malformed_token_is_refused_before_calling_github(self):
        with mock.patch.object(GitHubClient, "rate_limit", side_effect=AssertionError("no network")):
            for bad in (token() + "\nX: y", "two words", "x" * 256, "tøken"):
                res = self.send("put", "/api/admin/settings", json={"github_token": bad, "site_title": "T"})
                self.assertEqual(res.status_code, 400, bad)
        self.assertEqual(self.db.get_setting("github_token"), "")
        self.assertEqual(self.db.get_setting("site_title"), "RepoPulse")

    def test_renamed_repository_already_tracked(self):
        info = {"full_name": "Octo/Hello", "html_url": "https://github.com/Octo/Hello"}
        with mock.patch.object(GitHubClient, "repo", return_value=info):
            self.assertEqual(self.send("post", "/api/admin/repos", json={"repo": "octo/hello", "collect": False})
                             .status_code, 200)
            res = self.send("post", "/api/admin/repos", json={"repos": ["octo/old-name", "octo/older"],
                                                              "collect": False})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(len(res.get_json()["errors"]), 2)
        self.assertIn("already tracked", res.get_json()["errors"][0])
        self.assertEqual(len(self.db.query("SELECT * FROM repos")), 1)

    def test_bad_full_name_from_github(self):
        with mock.patch.object(GitHubClient, "repo", return_value={"full_name": "o/.."}):
            res = self.send("post", "/api/admin/repos", json={"repo": "o/r", "collect": False})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.db.query("SELECT * FROM repos"), [])

    def test_added_while_busy_is_queued(self):
        info = {"full_name": "o/r"}
        with mock.patch.object(GitHubClient, "repo", return_value=info), \
                mock.patch.object(Collector, "run", return_value=None) as run:
            res = self.send("post", "/api/admin/repos", json={"repo": "o/r"})
        self.assertTrue(res.get_json()["queued"])
        self.assertTrue(run.call_args.kwargs["queue"])

    def test_current_password_check_is_throttled(self):
        for _ in range(5):
            res = self.send("post", "/api/admin/password", json={"current": "wrong one", "new": "a new password"})
            self.assertEqual(res.status_code, 400)
        res = self.send("post", "/api/admin/password", json={"current": PASSWORD, "new": "a new password"})
        self.assertEqual(res.status_code, 429)


if __name__ == "__main__":
    unittest.main()
