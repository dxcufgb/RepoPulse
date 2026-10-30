"""The page-wide appearance: defaults, saving, validation, and the option lists the frontend shares."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from repopulse import appearance
from tests.helpers import AppTestCase

JS = Path(__file__).resolve().parent.parent / "repopulse" / "static" / "js" / "appearance.js"


class Appearance(AppTestCase):
    def setUp(self):
        super().setUp()
        self.add_admin()

    def put(self, data, csrf):
        return self.client.put("/api/admin/appearance", json={"appearance": data}, headers={"X-CSRF-Token": csrf})

    def test_defaults_until_saved(self):
        self.assertEqual(self.client.get("/api/site").get_json()["appearance"], appearance.DEFAULTS)

    def test_needs_admin_and_csrf(self):
        res = self.client.put("/api/admin/appearance", json={"appearance": {"theme": "dark"}})
        self.assertEqual(res.status_code, 401)
        csrf = self.login()
        self.assertEqual(self.put({"theme": "dark"}, "x" + csrf).status_code, 403)
        self.assertEqual(self.client.get("/api/site").get_json()["appearance"]["theme"], "system")

    def test_save_and_merge(self):
        csrf = self.login()
        res = self.put({"theme": "dark", "accent": "#C2185B", "palette": "vivid"}, csrf)
        self.assertEqual(res.status_code, 200, res.get_json())
        res = self.put({"density": "compact", "default_range": 90}, csrf)  # a number is accepted as its text
        saved = res.get_json()["appearance"]
        self.assertEqual((saved["theme"], saved["accent"], saved["palette"], saved["density"], saved["default_range"]),
                         ("dark", "#c2185b", "vivid", "compact", "90"))
        visitor = self.app.test_client().get("/api/site").get_json()["appearance"]
        self.assertEqual(visitor, saved)

    def test_rejects_bad_values(self):
        csrf = self.login()
        for bad in ({"theme": "neon"}, {"accent": "red"}, {"accent": "#12345"}, {"accent": "#123456;x"},
                    {"style": "x"}, {"font": "url(https://example.com/f.woff)"}, {"accent": 5}):
            self.assertEqual(self.put(bad, csrf).status_code, 400, bad)
        self.assertEqual(self.client.put("/api/admin/appearance", json={"appearance": []},
                                         headers={"X-CSRF-Token": csrf}).status_code, 400)
        self.assertEqual(self.client.get("/api/site").get_json()["appearance"], appearance.DEFAULTS)

    def test_clean_drops_what_it_does_not_know(self):
        self.db.set_setting("appearance", {"theme": "dark", "radius": "bogus", "extra": 1, "accent": "nope"})
        got = self.client.get("/api/site").get_json()["appearance"]
        self.assertEqual(got, {**appearance.DEFAULTS, "theme": "dark"})


class SameListsAsTheFrontend(unittest.TestCase):
    def test_choices_match_appearance_js(self):
        source = JS.read_text(encoding="utf-8")
        for key, values in appearance.CHOICES.items():
            m = re.search(r'\["%s", "[^"]*", "[^"]*", \[(.*?)\]\],?\n' % re.escape(key), source)
            self.assertIsNotNone(m, key)
            self.assertEqual(tuple(re.findall(r'\["([^"]+)", "', m.group(1))), values, key)
        for key in appearance.COLORS:
            self.assertIn(f"{key}: \"\"", source)


if __name__ == "__main__":
    unittest.main()
