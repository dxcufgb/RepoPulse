"""Admin accounts, sessions, CSRF protection and login throttling."""
from __future__ import annotations

import functools
import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque

from flask import abort, current_app, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from .db import Database

MIN_PASSWORD = 8


def pw_fingerprint(password_hash: str) -> str:
    """Short, non-reversible tag of the stored hash. Put in the session so that changing the
    password invalidates every other session (the signed cookie's tag stops matching the DB)."""
    return hashlib.sha256((password_hash or "").encode("utf-8")).hexdigest()[:16]


def hash_password(password: str) -> str:
    return generate_password_hash(password, method="pbkdf2:sha256:600000")


def validate_new_password(username: str, password: str) -> str | None:
    if not username or len(username) > 64 or not username.replace("_", "").replace("-", "").replace(".", "").isalnum():
        return "Username may only contain letters, digits, '.', '-' and '_'"
    if len(password or "") < MIN_PASSWORD:
        return f"Password must be at least {MIN_PASSWORD} characters"
    return None


def create_user(db: Database, username: str, password: str) -> None:
    from .collector import now_iso
    db.execute("INSERT INTO users(username, password_hash, created_at) VALUES(?,?,?)",
               (username, hash_password(password), now_iso()))


def set_password(db: Database, username: str, password: str) -> bool:
    cur = db.execute("UPDATE users SET password_hash = ? WHERE username = ?",
                     (hash_password(password), username))
    return cur.rowcount > 0


def user_count(db: Database) -> int:
    return db.query_one("SELECT COUNT(*) AS n FROM users")["n"]


def verify(db: Database, username: str, password: str):
    row = db.query_one("SELECT * FROM users WHERE username = ?", (username or "",))
    if row is None:
        # Spend the same time as a real check so usernames can't be probed.
        check_password_hash(_DUMMY_HASH, password or "")
        return None
    return row if check_password_hash(row["password_hash"], password or "") else None


_DUMMY_HASH = hash_password(secrets.token_hex(8))


class LoginThrottle:
    """At most `limit` failed logins per IP per `window` seconds."""

    def __init__(self, limit: int = 5, window: int = 300):
        self.limit, self.window = limit, window
        self.failures: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def _trim(self, ip: str) -> deque:
        q = self.failures[ip]
        cutoff = time.monotonic() - self.window
        while q and q[0] < cutoff:
            q.popleft()
        return q

    def blocked_for(self, ip: str) -> int:
        with self.lock:
            q = self._trim(ip)
            if len(q) < self.limit:
                return 0
            return int(q[0] + self.window - time.monotonic()) + 1

    def fail(self, ip: str) -> None:
        with self.lock:
            self._trim(ip).append(time.monotonic())

    def reset(self, ip: str) -> None:
        with self.lock:
            self.failures.pop(ip, None)


def start_session(user, remember: bool) -> str:
    session.clear()
    session["uid"] = user["id"]
    session["user"] = user["username"]
    session["csrf"] = secrets.token_urlsafe(32)
    session["pv"] = pw_fingerprint(user["password_hash"])
    session.permanent = bool(remember)
    return session["csrf"]


def current_user() -> str | None:
    return session.get("user")


def is_local_request() -> bool:
    if (request.remote_addr or "") not in {"127.0.0.1", "::1", "localhost"}:
        return False
    # A loopback remote_addr behind an *unconfigured* reverse proxy (behind_proxy off, so ProxyFix is
    # not applied) would otherwise mark every forwarded request "local". If forwarding headers are
    # present but the app was not told it sits behind a proxy, do not trust the address.
    if not current_app.config.get("BEHIND_PROXY") and (
        request.headers.get("X-Forwarded-For") or request.headers.get("X-Real-IP")
    ):
        return False
    return True


def admin_required(view):
    """Logged in + CSRF token header for anything that changes data."""

    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get("uid"):
            return jsonify(error="Please log in"), 401
        db: Database = current_app.extensions["repopulse"].db
        row = db.query_one("SELECT password_hash FROM users WHERE id = ?", (session["uid"],))
        if row is None or session.get("pv") != pw_fingerprint(row["password_hash"]):
            session.clear()
            return jsonify(error="Please log in"), 401
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            token = request.headers.get("X-CSRF-Token", "")
            if not token or not secrets.compare_digest(token, session.get("csrf", "")):
                abort(403, description="Invalid or missing CSRF token. Reload the page.")
        return view(*args, **kwargs)

    return wrapper
