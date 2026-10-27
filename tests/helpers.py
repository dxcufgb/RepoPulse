"""Shared test setup: an app on a throw-away data folder, no scheduler, no network."""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from repopulse import auth
from repopulse.app import create_app
from repopulse.config import Config

PASSWORD = "correct horse battery"


def close_db(db):
    """Closes this thread's SQLite connection (the test client runs requests on the test's thread)."""
    con = getattr(db._local, "con", None)
    if con is not None:
        con.close()
        db._local.con = None


class AppTestCase(unittest.TestCase):
    """self.app / self.db / self.client; build_app(**config) to change the server settings."""

    config: dict = {}

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="repopulse-test-"))
        # SQLite keeps the file open per thread; on Windows that blocks removal, which is harmless here.
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.build_app(**self.config)

    def build_app(self, **overrides):
        cfg = Config(data_dir=self.tmp / f"data{len(list(self.tmp.iterdir()))}")
        cfg.data_dir.mkdir(parents=True)
        for key, value in overrides.items():
            setattr(cfg, key, value)
        self.cfg = cfg
        self.app = create_app(cfg, start_scheduler=False)
        self.app.testing = True
        self.db = self.app.extensions["repopulse"].db
        self.addCleanup(close_db, self.db)
        self.client = self.app.test_client()
        return self.app

    def add_admin(self, username="admin", password=None):
        auth.create_user(self.db, username, password or PASSWORD)

    def login(self, client=None, username="admin", password=None, remote="127.0.0.1"):
        """Logs in and returns the CSRF token."""
        client = client or self.client
        password = password or PASSWORD
        res = client.post("/api/auth/login", json={"username": username, "password": password},
                          environ_base={"REMOTE_ADDR": remote})
        self.assertEqual(res.status_code, 200, res.get_json())
        return res.get_json()["csrf"]
