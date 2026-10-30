"""The --config option, its settings, and creating the admin account without a terminal (the installers do that)."""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from repopulse import __main__ as cli
from repopulse import auth
from repopulse.config import load_config
from repopulse.db import Database

PASSWORD = "correct horse battery"


class ConfigFile(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="repopulse-cli-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = mock.patch.dict(os.environ, {k: v for k, v in os.environ.items() if not k.startswith("REPOPULSE_")},
                                   clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def write(self, values) -> Path:
        path = self.tmp / "etc" / "config.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(values), encoding="utf-8")
        return path

    def test_given_file_and_relative_data_dir(self):
        cfg = load_config(self.write({"port": 9100, "data_dir": "state", "trusted_proxies": ["10.0.0.0/8"]}))
        self.assertEqual(cfg.port, 9100)
        # relative to the configuration file's folder
        self.assertEqual(cfg.data_dir, self.tmp / "etc" / "state")
        self.assertEqual(cfg.trusted_proxies, ["10.0.0.0/8"])

    def test_missing_or_invalid_file(self):
        with self.assertRaises(SystemExit):
            load_config(self.tmp / "nope.json")
        for bad in ({"port": 0}, {"port": "x"}, {"threads": 0}, {"trusted_proxies": 5}, [1, 2]):
            with self.assertRaises(SystemExit, msg=bad):
                load_config(self.write(bad))

    def test_trusted_proxies_from_the_environment(self):
        os.environ["REPOPULSE_TRUSTED_PROXIES"] = "10.0.0.1, 192.168.0.0/16"
        cfg = load_config(self.write({"data_dir": str(self.tmp / "d")}))
        self.assertEqual(cfg.trusted_proxies, ["10.0.0.1", "192.168.0.0/16"])

    def run_cli(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out), mock.patch("sys.stdin", io.StringIO("")):
            code = cli.main(list(argv))
        return code, out.getvalue()

    def test_create_admin_from_the_environment(self):
        config = self.write({"data_dir": str(self.tmp / "data")})
        os.environ.update(REPOPULSE_ADMIN_USERNAME="boss", REPOPULSE_ADMIN_PASSWORD=PASSWORD)
        code, out = self.run_cli("--config", str(config), "create-admin")
        self.assertEqual(code, 0, out)
        db = Database(self.tmp / "data" / "repopulse.db")
        self.assertEqual(auth.user_count(db), 1)
        self.assertIsNotNone(db.query_one("SELECT 1 FROM users WHERE username = ?", ("boss",)))
        code, out = self.run_cli("--config", str(config), "status")
        self.assertIn("Admin accounts: 1", out)

    def test_no_terminal_and_no_password_is_an_error(self):
        config = self.write({"data_dir": str(self.tmp / "data")})
        with self.assertRaises(SystemExit) as caught:
            self.run_cli("--config", str(config), "create-admin", "--username", "boss")
        self.assertIn("REPOPULSE_ADMIN_PASSWORD", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
