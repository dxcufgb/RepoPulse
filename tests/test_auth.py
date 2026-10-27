"""Login, first-run setup, sessions, CSRF and the admin API's access checks."""
from __future__ import annotations

import unittest

from repopulse import auth
from tests.helpers import PASSWORD, AppTestCase

REMOTE = "203.0.113.7"


class FirstRunSetup(AppTestCase):
    def test_site_asks_for_setup_on_the_server_itself(self):
        data = self.client.get("/api/site").get_json()
        self.assertTrue(data["needs_setup"])
        self.assertTrue(data["setup_allowed"])
        self.assertIsNone(data["user"])
        self.assertIsNone(data["csrf"])

    def test_setup_from_another_computer_is_refused(self):
        res = self.client.post("/api/auth/setup", json={"username": "admin", "password": PASSWORD},
                               environ_base={"REMOTE_ADDR": REMOTE})
        self.assertEqual(res.status_code, 403)
        self.assertEqual(auth.user_count(self.db), 0)
        site = self.client.get("/api/site", environ_base={"REMOTE_ADDR": REMOTE}).get_json()
        self.assertFalse(site["setup_allowed"])

    def test_forwarded_request_through_an_unconfigured_proxy_is_not_local(self):
        # A reverse proxy on the same machine connects from 127.0.0.1; without behind_proxy the forwarded
        # header must not let a remote visitor claim the first admin account.
        for header in ("X-Forwarded-For", "X-Real-IP"):
            res = self.client.post("/api/auth/setup", json={"username": "admin", "password": PASSWORD},
                                   headers={header: REMOTE})
            self.assertEqual(res.status_code, 403, header)
        self.assertEqual(auth.user_count(self.db), 0)

    def test_behind_a_proxy_the_forwarded_address_decides(self):
        self.build_app(behind_proxy=True)
        res = self.client.post("/api/auth/setup", json={"username": "admin", "password": PASSWORD},
                               headers={"X-Forwarded-For": REMOTE})
        self.assertEqual(res.status_code, 403)
        res = self.client.post("/api/auth/setup", json={"username": "admin", "password": PASSWORD},
                               headers={"X-Forwarded-For": "127.0.0.1"})
        self.assertEqual(res.status_code, 200)

    def test_allow_remote_setup(self):
        self.build_app(allow_remote_setup=True)
        res = self.client.post("/api/auth/setup", json={"username": "admin", "password": PASSWORD},
                               environ_base={"REMOTE_ADDR": REMOTE})
        self.assertEqual(res.status_code, 200)

    def test_setup_creates_the_account_once_and_logs_in(self):
        res = self.client.post("/api/auth/setup", json={"username": "admin", "password": PASSWORD})
        self.assertEqual(res.status_code, 200)
        csrf = res.get_json()["csrf"]
        self.assertTrue(csrf)
        self.assertEqual(self.client.get("/api/admin/settings").status_code, 200)
        again = self.client.post("/api/auth/setup", json={"username": "other", "password": PASSWORD})
        self.assertEqual(again.status_code, 409)
        self.assertEqual(auth.user_count(self.db), 1)

    def test_setup_validates_username_and_password(self):
        for username, password in (("admin", "short"), ("bad name", PASSWORD), ("", PASSWORD),
                                   ("x" * 65, PASSWORD)):
            res = self.client.post("/api/auth/setup", json={"username": username, "password": password})
            self.assertEqual(res.status_code, 400, (username, password))
        self.assertEqual(auth.user_count(self.db), 0)


class Login(AppTestCase):
    def setUp(self):
        super().setUp()
        self.add_admin()

    def test_wrong_password_and_unknown_user(self):
        for username, password in (("admin", "wrong password"), ("nobody", PASSWORD)):
            res = self.client.post("/api/auth/login", json={"username": username, "password": password})
            self.assertEqual(res.status_code, 401)
            self.assertEqual(res.get_json()["error"], "Wrong username or password")

    def test_five_failures_lock_the_address_out(self):
        for _ in range(5):
            res = self.client.post("/api/auth/login", json={"username": "admin", "password": "nope nope"},
                                   environ_base={"REMOTE_ADDR": REMOTE})
            self.assertEqual(res.status_code, 401)
        locked = self.client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD},
                                  environ_base={"REMOTE_ADDR": REMOTE})
        self.assertEqual(locked.status_code, 429)
        # another address is not affected
        self.login(remote="198.51.100.2")

    def test_login_resets_the_failure_count(self):
        for _ in range(4):
            self.client.post("/api/auth/login", json={"username": "admin", "password": "nope nope"})
        self.login()
        self.client.post("/api/auth/logout")
        for _ in range(4):
            res = self.client.post("/api/auth/login", json={"username": "admin", "password": "nope nope"})
            self.assertEqual(res.status_code, 401)

    def test_username_is_case_insensitive(self):
        self.login(username="ADMIN")

    def test_logout(self):
        self.login()
        self.assertEqual(self.client.post("/api/auth/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/admin/settings").status_code, 401)


class AdminAccess(AppTestCase):
    def setUp(self):
        super().setUp()
        self.add_admin()

    def test_admin_routes_need_a_login(self):
        for method, path in (("get", "/api/admin/repos"), ("get", "/api/admin/settings"),
                             ("get", "/api/admin/runs"), ("put", "/api/admin/settings"),
                             ("post", "/api/admin/repos"), ("delete", "/api/admin/repos/1"),
                             ("post", "/api/admin/password"), ("put", "/api/admin/layout")):
            res = getattr(self.client, method)(path, json={})
            self.assertEqual(res.status_code, 401, f"{method} {path}")

    def test_changes_need_the_csrf_token(self):
        csrf = self.login()
        body = {"site_title": "Changed"}
        self.assertEqual(self.client.put("/api/admin/settings", json=body).status_code, 403)
        wrong = self.client.put("/api/admin/settings", json=body, headers={"X-CSRF-Token": "x" + csrf})
        self.assertEqual(wrong.status_code, 403)
        self.assertEqual(self.db.get_setting("site_title"), "RepoPulse")
        ok = self.client.put("/api/admin/settings", json=body, headers={"X-CSRF-Token": csrf})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(self.db.get_setting("site_title"), "Changed")

    def test_site_returns_the_csrf_token_only_when_logged_in(self):
        self.assertIsNone(self.client.get("/api/site").get_json()["csrf"])
        csrf = self.login()
        self.assertEqual(self.client.get("/api/site").get_json()["csrf"], csrf)

    def test_password_change_ends_every_other_session(self):
        other = self.app.test_client()
        self.login(client=other)
        csrf = self.login()
        res = self.client.post("/api/admin/password", json={"current": PASSWORD, "new": "a new password"},
                               headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self.client.get("/api/admin/settings").status_code, 200)
        self.assertEqual(other.get("/api/admin/settings").status_code, 401)
        self.login(client=other, password="a new password")

    def test_password_change_needs_the_current_password(self):
        csrf = self.login()
        res = self.client.post("/api/admin/password", json={"current": "wrong one", "new": "a new password"},
                               headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.status_code, 400)
        self.login(client=self.app.test_client())

    def test_password_reset_from_the_command_line_ends_sessions(self):
        self.login()
        auth.set_password(self.db, "admin", "reset from cli")
        self.assertEqual(self.client.get("/api/admin/settings").status_code, 401)

    def test_deleted_account_loses_its_session(self):
        self.login()
        self.db.execute("DELETE FROM users")
        self.assertEqual(self.client.get("/api/admin/repos").status_code, 401)

    def test_github_token_never_leaves_the_server(self):
        # built at run time so no token-shaped literal ends up in the repository (or in a .pyc)
        token = "_".join(["ghp", "A1b2C3d4" * 4 + "wxyz"])
        self.db.set_setting("github_token", token)
        self.login()
        for path in ("/api/admin/settings", "/api/site", "/api/dashboard"):
            text = self.client.get(path).get_data(as_text=True)
            self.assertNotIn(token, text, path)
            self.assertNotIn(token[:-4], text, path)
        settings = self.client.get("/api/admin/settings").get_json()
        self.assertTrue(settings["github_token_set"])
        self.assertEqual(settings["github_token_hint"], "…wxyz")


class PrivateDashboard(AppTestCase):
    def test_private_dashboard_needs_a_login(self):
        self.add_admin()
        self.db.set_setting("public_dashboard", False)
        for path in ("/api/dashboard", "/api/export.csv", "/api/repos/1/page", "/api/repos/1/releases"):
            self.assertEqual(self.client.get(path).status_code, 401, path)
        self.login()
        self.assertEqual(self.client.get("/api/dashboard").status_code, 200)

    def test_hidden_repository_is_not_public(self):
        self.db.execute("INSERT INTO repos(owner, name, added_at, hidden) VALUES('o', 'secret', 'x', 1)")
        self.assertEqual(self.client.get("/api/repos/1/page").status_code, 404)
        names = [r["name"] for r in self.client.get("/api/dashboard").get_json()["repos"]]
        self.assertNotIn("secret", names)
        self.assertNotIn("secret", self.client.get("/api/export.csv").get_data(as_text=True))


class Headers(AppTestCase):
    def test_security_headers(self):
        for path in ("/", "/admin", "/api/site"):
            res = self.client.get(path)
            self.assertIn("default-src 'self'", res.headers["Content-Security-Policy"])
            self.assertIn("script-src 'self'", res.headers["Content-Security-Policy"])
            self.assertEqual(res.headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(res.headers["X-Frame-Options"], "SAMEORIGIN")
            res.close()
        self.assertEqual(self.client.get("/api/site").headers["Cache-Control"], "no-store")

    def test_session_cookie_flags(self):
        self.build_app(secure_cookies=True)
        self.add_admin()
        res = self.client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
        cookie = res.headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Secure", cookie)
        self.assertIn("SameSite=Lax", cookie)

    def test_static_files_stay_inside_the_static_folder(self):
        for path in ("/static/../app.py", "/static/..%2fapp.py", "/static/%2e%2e/config.py"):
            res = self.client.get(path)
            res.close()
            self.assertIn(res.status_code, (400, 404), path)


if __name__ == "__main__":
    unittest.main()
