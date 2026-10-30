"""Update e-mails (repopulse/notify.py), update results, and the admin API for updates and notifications."""
from __future__ import annotations

import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

from repopulse import notify, updates
from tests.helpers import AppTestCase

GOOD = {"recipients": "a@example.com, b@example.org", "host": "smtp.example.com", "security": "starttls", "port": 587,
        "user": "me@example.com", "password": "pw-SECRET", "sender": ""}


class FakeSMTP:
    instances = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port, self.calls = host, port, []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def ehlo(self):
        self.calls.append("ehlo")

    def starttls(self, context=None):
        self.calls.append("starttls")

    def login(self, user, password):
        self.calls.append(("login", user, password))

    def send_message(self, msg, from_addr=None, to_addrs=None):
        self.calls.append(("send", from_addr, tuple(to_addrs), msg["Subject"]))
        self.msg = msg


class Settings(unittest.TestCase):
    def test_validate(self):
        problem, s = notify.validate(GOOD, dict(notify.DEFAULTS))
        self.assertIsNone(problem)
        self.assertEqual(s["recipients"], ["a@example.com", "b@example.org"])
        for bad in ({"recipients": "not-an-address"}, {"recipients": "a@example.com\r\nBcc: x@evil.com"},
                    {"host": "smtp example"}, {"security": "ssl"}, {"port": 70000}, {"port": "x"},
                    {"sender": "x"}, {"user": "a\nb"}, {"recipients": ",".join(f"u{i}@example.com" for i in range(11))},
                    {"security": "none", "password": "pw"}):
            self.assertIsNotNone(notify.validate(bad, s)[0], bad)
        # an empty password keeps the saved one; clear_password removes it
        self.assertEqual(notify.validate({"password": ""}, s)[1]["password"], "pw-SECRET")
        self.assertEqual(notify.validate({"clear_password": True}, s)[1]["password"], "")
        self.assertNotIn("password", notify.public(s))
        self.assertTrue(notify.public(s)["password_set"])

    def test_send_starttls_with_login(self):
        FakeSMTP.instances = []
        _, s = notify.validate(GOOD, dict(notify.DEFAULTS))
        self.assertEqual(notify.send(s, "subj", "body", smtp=FakeSMTP), 2)
        c = FakeSMTP.instances[-1]
        self.assertEqual((c.host, c.port), ("smtp.example.com", 587))
        self.assertLess(c.calls.index("starttls"), c.calls.index(("login", "me@example.com", "pw-SECRET")))
        self.assertEqual(c.calls[-1], ("send", "me@example.com", ("a@example.com", "b@example.org"), "subj"))

    def test_nothing_to_send(self):
        self.assertEqual(notify.send(dict(notify.DEFAULTS), "s", "b", smtp=FakeSMTP), 0)

    def test_errors_hide_the_password(self):
        _, s = notify.validate(GOOD, dict(notify.DEFAULTS))

        class Broken(FakeSMTP):
            def login(self, user, password):
                raise OSError(f"boom {password}")

        with self.assertRaises(notify.NotifyError) as cm:
            notify.send(s, "s", "b", smtp=Broken)
        self.assertNotIn("pw-SECRET", str(cm.exception))


class Api(AppTestCase):
    def setUp(self):
        super().setUp()
        self.add_admin()
        self.csrf = self.login()
        self.h = {"X-CSRF-Token": self.csrf}

    def test_notify_settings(self):
        res = self.client.put("/api/admin/notify", json=GOOD, headers=self.h)
        self.assertEqual(res.status_code, 200, res.get_json())
        got = self.client.get("/api/admin/notify").get_json()
        self.assertEqual(got["recipients"], ["a@example.com", "b@example.org"])
        self.assertTrue(got["password_set"])
        self.assertNotIn("pw-SECRET", self.client.get("/api/admin/notify").get_data(as_text=True))
        self.assertEqual(self.client.put("/api/admin/notify", json={"recipients": "nope"}, headers=self.h).status_code, 400)
        self.assertEqual(self.client.put("/api/admin/notify", json=GOOD).status_code, 403)  # no CSRF token

    def test_test_email(self):
        self.assertEqual(self.client.post("/api/admin/notify/test", headers=self.h).status_code, 400)
        self.client.put("/api/admin/notify", json=GOOD, headers=self.h)
        with mock.patch.object(notify, "send", return_value=2) as send:
            res = self.client.post("/api/admin/notify/test", headers=self.h)
        self.assertEqual(res.get_json(), {"ok": True, "sent": 2})
        self.assertIn("test e-mail", send.call_args[0][1])
        with mock.patch.object(notify, "send", side_effect=notify.NotifyError("refused")):
            self.assertEqual(self.client.post("/api/admin/notify/test", headers=self.h).status_code, 502)

    def test_update_routes_need_admin(self):
        other = self.app.test_client()
        for method, url in (("get", "/api/admin/update"), ("post", "/api/admin/update/check"), ("post", "/api/admin/update/now"),
                            ("get", "/api/admin/notify"), ("post", "/api/admin/notify/test")):
            self.assertEqual(getattr(other, method)(url).status_code, 401, url)

    def test_update_status_and_now(self):
        with mock.patch.object(updates, "setup", return_value={"platform": "linux", "daily": False, "now": False}):
            res = self.client.get("/api/admin/update").get_json()
            self.assertEqual(res["setup"]["now"], False)
            self.assertEqual(self.client.post("/api/admin/update/now", headers=self.h).status_code, 409)
        # set up: the request file is written, and a second request right after is refused
        (self.cfg.data_dir / "update-request").write_text("")
        updates._last_request = 0.0
        with mock.patch.object(updates, "setup", return_value={"platform": "linux", "daily": True, "now": True}):
            self.assertEqual(self.client.post("/api/admin/update/now", headers=self.h).status_code, 200)
            self.assertTrue((self.cfg.data_dir / "update-request").read_text().strip())
            self.assertEqual(self.client.post("/api/admin/update/now", headers=self.h).status_code, 409)
        updates._last_request = 0.0

    def test_check(self):
        fake = {"installed": "1.1.0", "latest": "1.2.0", "newer": True, "url": "u", "notes": "", "error": ""}
        with mock.patch.object(updates, "check_latest", return_value=fake):
            self.assertEqual(self.client.post("/api/admin/update/check", json={}, headers=self.h).get_json(), fake)


class Events(AppTestCase):
    def test_record_update(self):
        sent = []
        sender = lambda s, subject, body: sent.append((subject, body)) or 1  # noqa: E731
        notify.record_update(self.db, "current", "1.1.0", now="t1", sender=sender)
        self.assertEqual(sent, [])
        self.assertIsNone(self.db.get_setting("last_update", None))
        self.assertEqual(self.db.get_setting("last_update_check", None)["at"], "t1")
        ev = notify.record_update(self.db, "updated", "1.1.0", "1.2.0", "log", now="t2", sender=sender)
        self.assertEqual(ev["emailed"], 1)
        self.assertIn("updated to 1.2.0", sent[0][0])
        self.assertIn("releases/tag/v1.2.0", sent[0][1])
        notify.record_update(self.db, "rolled-back", "1.2.0", "1.3.0", now="t3", sender=sender)
        self.assertIn("1.2.0 restored", sent[1][0])

        def failing(*a):
            raise notify.NotifyError("no server")

        ev = notify.record_update(self.db, "failed", "1.2.0", now="t4", sender=failing)
        self.assertEqual(ev["email_error"], "no server")
        self.assertEqual(self.db.get_setting("last_update", None)["outcome"], "failed")
        # odd values from the command line never get in
        ev = notify.record_update(self.db, "failed", "1.2.0\nX", "<b>", now="t5", sender=sender)
        self.assertEqual((ev["from"], ev["to"]), ("", ""))

    def test_cli_update_event(self):
        from repopulse.__main__ import main
        with mock.patch("repopulse.__main__.load_config", return_value=self.cfg), \
                mock.patch("sys.stdin", io.StringIO("details")), redirect_stdout(io.StringIO()):
            self.assertEqual(main(["update-event", "--outcome", "failed", "--from", "1.1.0", "--message-stdin"]), 0)
        self.assertEqual(self.db.get_setting("last_update", None)["message"], "details")


if __name__ == "__main__":
    unittest.main()
