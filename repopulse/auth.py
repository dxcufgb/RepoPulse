"""Admin accounts, sessions, CSRF protection and login throttling."""
from __future__ import annotations

import functools
import hashlib
import ipaddress
import logging
import secrets
import threading
import time
from collections import OrderedDict, deque

from flask import abort, current_app, g, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from .db import Database

MIN_PASSWORD = 8
PROXY_HEADERS = ("Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP")
log = logging.getLogger("repopulse")


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


def set_password(db: Database, username: str, password: str, keep_sid: str | None = None) -> bool:
    """Changes the password and ends every session of the account (except `keep_sid`, the one that changed it)."""
    cur = db.execute("UPDATE users SET password_hash = ? WHERE username = ?",
                     (hash_password(password), username))
    if cur.rowcount > 0:
        keep = _sid_hash(keep_sid) if keep_sid else ""
        db.execute("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?) AND id != ?",
                   (username, keep))
    return cur.rowcount > 0


def create_first_user(db: Database, username: str, password: str) -> bool:
    """Creates the account only while there is none (one transaction, so two set-up requests at once can't both
    succeed). False when an account already exists."""
    from .collector import now_iso
    password_hash = hash_password(password)  # slow; outside the write lock
    with db.transaction() as con:
        cur = con.execute("INSERT INTO users(username, password_hash, created_at) SELECT ?,?,? "
                          "WHERE NOT EXISTS (SELECT 1 FROM users)", (username, password_hash, now_iso()))
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
    """At most `limit` password attempts per IP per `window` seconds (a successful login clears the count).

    The attempt is counted before the (slow) password check, so parallel requests can't get past the limit, and at
    most `max_keys` addresses are remembered (the least recently seen are dropped) so it can't grow without bound.
    """

    def __init__(self, limit: int = 5, window: int = 300, max_keys: int = 10000):
        self.limit, self.window, self.max_keys = limit, window, max_keys
        self.failures: "OrderedDict[str, deque]" = OrderedDict()
        self.lock = threading.Lock()

    def _trim(self, ip: str) -> deque:
        q = self.failures.get(ip)
        if q is None:
            return deque()
        cutoff = time.monotonic() - self.window
        while q and q[0] < cutoff:
            q.popleft()
        if not q:
            del self.failures[ip]
        return q

    def _wait(self, q: deque) -> int:
        if len(q) < self.limit:
            return 0
        return int(q[0] + self.window - time.monotonic()) + 1

    def blocked_for(self, ip: str) -> int:
        with self.lock:
            return self._wait(self._trim(ip))

    def attempt(self, ip: str) -> int:
        """Seconds to wait if `ip` is locked out; otherwise counts this attempt and returns 0."""
        with self.lock:
            q = self._trim(ip)
            wait = self._wait(q)
            if not wait:
                self._record(ip, q)
            return wait

    def fail(self, ip: str) -> None:
        with self.lock:
            self._record(ip, self._trim(ip))

    def _record(self, ip: str, q: deque) -> None:
        q.append(time.monotonic())
        self.failures[ip] = q
        self.failures.move_to_end(ip)
        while len(self.failures) > self.max_keys:
            self.failures.popitem(last=False)

    def reset(self, ip: str) -> None:
        with self.lock:
            self.failures.pop(ip, None)


def _sid_hash(sid: str) -> str:
    return hashlib.sha256(str(sid).encode("utf-8")).hexdigest()


def start_session(user, remember: bool) -> str:
    session.clear()
    g.pop("repopulse_user", None)
    db: Database = current_app.extensions["repopulse"].db
    now = int(time.time())
    lifetime = int(current_app.permanent_session_lifetime.total_seconds())
    sid = secrets.token_urlsafe(32)
    db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
    db.execute("INSERT INTO sessions(id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
               (_sid_hash(sid), user["id"], now, now + lifetime))
    session["sid"] = sid
    session["uid"] = user["id"]
    session["user"] = user["username"]
    session["csrf"] = secrets.token_urlsafe(32)
    session["pv"] = pw_fingerprint(user["password_hash"])
    session.permanent = bool(remember)
    return session["csrf"]


def logged_in_user():
    """The signed-in account's row, or None. A session that was logged out (its row in `sessions` is gone or
    expired), whose account is gone, or whose password changed since it was started (the fingerprint `pv` no longer
    matches) is cleared. Checked once per request."""
    if "repopulse_user" in g:
        return g.repopulse_user
    row = None
    if session.get("uid"):
        db: Database = current_app.extensions["repopulse"].db
        row = db.query_one("SELECT id, username, password_hash FROM users WHERE id = ?", (session["uid"],))
        live = session.get("sid") and db.query_one(
            "SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND expires_at > ?",
            (_sid_hash(session["sid"]), session["uid"], int(time.time())))
        if (row is None or not live
                or not secrets.compare_digest(str(session.get("pv", "")), pw_fingerprint(row["password_hash"]))):
            session.clear()
            row = None
    g.repopulse_user = row
    return row


def end_session() -> None:
    """Logs this session out for good: its row goes, so a copy of the cookie no longer works either."""
    sid = session.get("sid")
    if sid:
        current_app.extensions["repopulse"].db.execute("DELETE FROM sessions WHERE id = ?", (_sid_hash(sid),))
    session.clear()
    g.pop("repopulse_user", None)


def current_user() -> str | None:
    row = logged_in_user()
    return row["username"] if row is not None else None


def _ip(value: str):
    try:
        ip = ipaddress.ip_address((value or "").split("%", 1)[0])
    except ValueError:
        return None
    if ip.version == 6 and ip.ipv4_mapped is not None:  # ::ffff:127.0.0.1
        ip = ip.ipv4_mapped
    return ip


def is_loopback(addr: str) -> bool:
    ip = _ip(addr)
    return ip is not None and ip.is_loopback


def _host_is_local(host: str) -> bool:
    """The Host header names this computer (localhost, 127.0.0.1, [::1]; any port). A DNS rebinding page sends its
    own host name here, so it can't use a browser on the server to create the first account."""
    host = (host or "").strip().lower()
    if host.startswith("["):
        host = host[1:].split("]", 1)[0]
    elif host.count(":") == 1:
        host = host.split(":", 1)[0]
    host = host.rstrip(".")
    return host == "localhost" or is_loopback(host)


def is_local_request() -> bool:
    if not is_loopback(request.remote_addr or ""):
        return False
    # A loopback remote_addr behind an *unconfigured* reverse proxy (behind_proxy off, so the forwarded headers are
    # not applied) would otherwise mark every forwarded request "local". If forwarding headers are present but the
    # app was not told it sits behind a proxy, do not trust the address.
    if not current_app.config.get("BEHIND_PROXY") and any(request.headers.get(h) for h in PROXY_HEADERS):
        return False
    return _host_is_local(request.host)


class TrustedProxyFix:
    """ProxyFix (X-Forwarded-For, -Proto, -Host) applied only to requests that come straight from a trusted proxy:
    this computer or an address in `trusted` (IPs or networks). Anyone else's forwarded headers are ignored, so a
    visitor can't pose as 127.0.0.1 or pick a new address for every login attempt."""

    def __init__(self, app, trusted=()):
        from werkzeug.middleware.proxy_fix import ProxyFix
        self.app = app
        self.fixed = ProxyFix(app, x_for=1, x_proto=1, x_host=1)
        self.networks = []
        for entry in trusted or ():
            try:
                self.networks.append(ipaddress.ip_network(str(entry).strip(), strict=False))
            except ValueError:
                log.warning("Ignoring trusted_proxies entry %r: not an IP address or network", entry)

    def trusted(self, addr: str) -> bool:
        ip = _ip(addr)
        if ip is None:
            return False
        return ip.is_loopback or any(ip.version == n.version and ip in n for n in self.networks)

    def __call__(self, environ, start_response):
        if self.trusted(environ.get("REMOTE_ADDR", "")):
            return self.fixed(environ, start_response)
        return self.app(environ, start_response)


def admin_required(view):
    """Logged in + CSRF token header for anything that changes data."""

    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if logged_in_user() is None:
            return jsonify(error="Please log in"), 401
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            token = request.headers.get("X-CSRF-Token", "")
            if not token or not secrets.compare_digest(token, session.get("csrf", "")):
                abort(403, description="Invalid or missing CSRF token. Reload the page.")
        return view(*args, **kwargs)

    return wrapper
