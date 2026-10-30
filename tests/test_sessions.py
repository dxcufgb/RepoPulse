"""Server-side sessions: logging out (or changing the password) makes copies of the session cookie useless."""
from __future__ import annotations

from repopulse import auth
from tests.helpers import PASSWORD, AppTestCase


class Sessions(AppTestCase):
    def setUp(self):
        super().setUp()
        self.add_admin()

    def copy_cookie(self, client):
        """A second client holding the same session cookie (as if the cookie had been copied)."""
        other = self.app.test_client()
        name = self.app.config["SESSION_COOKIE_NAME"]
        cookie = client.get_cookie(name)
        self.assertIsNotNone(cookie)
        other.set_cookie(name, cookie.value)
        return other

    def admin_status(self, client, csrf):
        return client.get("/api/admin/repos", headers={"X-CSRF-Token": csrf}).status_code

    def test_logout_ends_copies_of_the_cookie(self):
        csrf = self.login()
        thief = self.copy_cookie(self.client)
        self.assertEqual(self.admin_status(thief, csrf), 200)
        self.assertEqual(self.client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}).status_code, 200)
        self.assertEqual(self.admin_status(thief, csrf), 401)
        self.assertIsNone(thief.get("/api/site").get_json()["user"])
        self.assertEqual(self.db.query_one("SELECT COUNT(*) AS n FROM sessions")["n"], 0)

    def test_logout_ends_only_that_session(self):
        csrf = self.login()
        laptop = self.app.test_client()
        laptop_csrf = self.login(laptop)
        self.client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf})
        self.assertEqual(self.admin_status(laptop, laptop_csrf), 200)

    def test_password_change_keeps_this_session_and_ends_the_others(self):
        csrf = self.login()
        laptop = self.app.test_client()
        laptop_csrf = self.login(laptop)
        thief = self.copy_cookie(laptop)
        res = self.client.post("/api/admin/password", headers={"X-CSRF-Token": csrf},
                               json={"current": PASSWORD, "new": "a brand new password"})
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual(self.admin_status(self.client, csrf), 200)
        self.assertEqual(self.admin_status(laptop, laptop_csrf), 401)
        self.assertEqual(self.admin_status(thief, laptop_csrf), 401)

    def test_set_password_from_the_command_line_ends_every_session(self):
        csrf = self.login()
        auth.set_password(self.db, "admin", "reset from the command line")
        self.assertEqual(self.admin_status(self.client, csrf), 401)
        self.assertEqual(self.db.query_one("SELECT COUNT(*) AS n FROM sessions")["n"], 0)

    def test_expired_or_unknown_session_is_refused(self):
        csrf = self.login()
        self.db.execute("UPDATE sessions SET expires_at = 0")
        self.assertEqual(self.admin_status(self.client, csrf), 401)
        # a cookie from before server-side sessions (no session id) counts as logged out
        csrf = self.login()
        with self.client.session_transaction() as sess:
            sess.pop("sid")
        self.assertEqual(self.admin_status(self.client, csrf), 401)

    def test_only_the_hash_of_the_session_id_is_stored(self):
        self.login()
        with self.client.session_transaction() as sess:
            sid = sess["sid"]
        stored = self.db.query_one("SELECT id FROM sessions")["id"]
        self.assertNotEqual(stored, sid)
        self.assertEqual(len(stored), 64)
