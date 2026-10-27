"""Flask application: JSON API + the single-page frontend."""
from __future__ import annotations

import json
import logging
import re
import secrets
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory, session
from werkzeug.exceptions import HTTPException

from . import __version__, auth, stats
from .collector import Collector, Scheduler, now_iso
from .config import Config
from .db import Database
from .github import GitHubClient, GitHubError, parse_repo

STATIC = Path(__file__).resolve().parent / "static"
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
log = logging.getLogger("repopulse")


class Services:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.db = Database(cfg.db_path)
        self.collector = Collector(self.db, cfg.github_api_url)
        self.scheduler: Scheduler | None = None
        self.throttle = auth.LoginThrottle()

    def start_scheduler(self) -> None:
        if self.scheduler is None:
            self.scheduler = Scheduler(self.db, self.collector)
            self.scheduler.start()


def _secret_key(cfg: Config) -> bytes:
    if cfg.secret_file.exists():
        return cfg.secret_file.read_bytes()
    key = secrets.token_bytes(48)
    cfg.secret_file.write_bytes(key)
    try:
        cfg.secret_file.chmod(0o600)
    except OSError:
        pass
    return key


def create_app(cfg: Config, start_scheduler: bool = True) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config.update(
        SECRET_KEY=_secret_key(cfg),
        SESSION_COOKIE_NAME="repopulse_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=cfg.secure_cookies,
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
        MAX_CONTENT_LENGTH=2 * 1024 * 1024,
        JSON_SORT_KEYS=False,
    )
    if cfg.behind_proxy:
        from werkzeug.middleware.proxy_fix import ProxyFix
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    svc = Services(cfg)
    app.extensions["repopulse"] = svc
    db = svc.db
    if start_scheduler:
        svc.start_scheduler()

    # ---------------------------------------------------------------- utils
    def body() -> dict:
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}

    def can_view() -> bool:
        return bool(db.get_setting("public_dashboard", True)) or bool(session.get("uid"))

    def repo_or_404(repo_id: int):
        row = db.query_one("SELECT * FROM repos WHERE id = ?", (repo_id,))
        if row is None:
            return None
        return row

    def admin_repo(row) -> dict:
        item = stats.repo_public(row)
        item.update({
            "label_custom": row["label"] or "",
            "color_custom": row["color"] or "",
            "asset_filter": row["asset_filter"],
            "enabled": bool(row["enabled"]),
            "hidden": bool(row["hidden"]),
            "sort_order": row["sort_order"],
            "added_at": row["added_at"],
            "last_collected": row["last_collected"],
            "last_error": row["last_error"],
        })
        h = stats.history(db, row)
        item["downloads"] = h[-1][1] if h else None
        item["own_layout"] = bool(row["layout"])
        item["stars"] = h[-1][2] if h else None
        item["days"] = len(h)
        return item

    @app.after_request
    def security_headers(resp: Response):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: https://avatars.githubusercontent.com; "
            "font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; "
            "form-action 'self'")
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.errorhandler(HTTPException)
    def http_error(exc: HTTPException):
        if request.path.startswith("/api/"):
            return jsonify(error=exc.description or exc.name), exc.code
        return exc

    # ------------------------------------------------------------- frontend
    @app.get("/")
    @app.get("/admin")
    @app.get("/admin/<path:_sub>")
    @app.get("/repo/<path:_sub>")
    def index(_sub=None):
        return send_from_directory(STATIC, "index.html", max_age=0)

    @app.get("/static/<path:filename>")
    def static_files(filename):
        # App code is revalidated on every load so an update shows up at once;
        # fonts and vendored libraries never change between versions.
        age = 86400 if filename.startswith(("fonts/", "vendor/")) else 0
        return send_from_directory(STATIC, filename, max_age=age)

    @app.get("/favicon.svg")
    def favicon():
        return send_from_directory(STATIC, "favicon.svg", max_age=86400)

    # ----------------------------------------------------------- public API
    @app.get("/api/site")
    def site():
        settings = db.all_settings()
        return jsonify(
            title=settings["site_title"],
            subtitle=settings["site_subtitle"],
            public=bool(settings["public_dashboard"]),
            user=auth.current_user(),
            csrf=session.get("csrf") if session.get("uid") else None,
            needs_setup=auth.user_count(db) == 0,
            setup_allowed=auth.user_count(db) == 0 and (cfg.allow_remote_setup or auth.is_local_request()),
            version=__version__,
        )

    @app.get("/api/dashboard")
    def dashboard():
        if not can_view():
            return jsonify(error="This dashboard is private. Please log in."), 401
        data = stats.dashboard_data(db, include_hidden=bool(session.get("uid")) and
                                    request.args.get("all") == "1")
        data["layout"] = db.get_setting("layout", None)
        data["repo_layout"] = db.get_setting("repo_layout", None)
        return jsonify(data)

    @app.get("/api/repos/<int:repo_id>/page")
    def repo_page(repo_id: int):
        """Everything a repository page needs besides the overview data."""
        if not can_view():
            return jsonify(error="Please log in"), 401
        row = repo_or_404(repo_id)
        if row is None or (row["hidden"] and not session.get("uid")):
            return jsonify(error="Unknown repository"), 404
        custom = None
        if row["layout"]:
            try:
                custom = json.loads(row["layout"])
            except ValueError:
                custom = None
        return jsonify(layout=custom, shared_layout=db.get_setting("repo_layout", None),
                       releases=stats.releases(db, row),
                       release_history=stats.release_history(db, row))

    @app.get("/api/repos/<int:repo_id>/releases")
    def repo_releases(repo_id: int):
        if not can_view():
            return jsonify(error="Please log in"), 401
        row = repo_or_404(repo_id)
        if row is None or (row["hidden"] and not session.get("uid")):
            return jsonify(error="Unknown repository"), 404
        return jsonify(releases=stats.releases(db, row))

    @app.get("/api/export.csv")
    def export():
        if not can_view():
            return jsonify(error="Please log in"), 401
        text = stats.export_csv(db, include_hidden=bool(session.get("uid")))
        stamp = datetime.now().strftime("%Y-%m-%d")
        return Response(text, mimetype="text/csv", headers={
            "Content-Disposition": f'attachment; filename="repopulse-{stamp}.csv"'})

    # ----------------------------------------------------------------- auth
    @app.post("/api/auth/login")
    def login():
        ip = request.remote_addr or "?"
        wait = svc.throttle.blocked_for(ip)
        if wait:
            return jsonify(error=f"Too many failed attempts. Try again in {wait} seconds."), 429
        data = body()
        user = auth.verify(db, str(data.get("username", "")), str(data.get("password", "")))
        if user is None:
            svc.throttle.fail(ip)
            return jsonify(error="Wrong username or password"), 401
        svc.throttle.reset(ip)
        token = auth.start_session(user, bool(data.get("remember")))
        db.execute("UPDATE users SET last_login = ? WHERE id = ?", (now_iso(), user["id"]))
        return jsonify(user=user["username"], csrf=token)

    @app.post("/api/auth/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    @app.post("/api/auth/setup")
    def setup():
        if auth.user_count(db) > 0:
            return jsonify(error="An admin account already exists"), 409
        if not (cfg.allow_remote_setup or auth.is_local_request()):
            return jsonify(error="For safety the first admin account can only be created "
                                 "from the server itself (http://localhost:%d) or with "
                                 "'manage create-admin'." % cfg.port), 403
        data = body()
        username, password = str(data.get("username", "")).strip(), str(data.get("password", ""))
        problem = auth.validate_new_password(username, password)
        if problem:
            return jsonify(error=problem), 400
        auth.create_user(db, username, password)
        user = auth.verify(db, username, password)
        token = auth.start_session(user, True)
        return jsonify(user=username, csrf=token)

    # ---------------------------------------------------------------- admin
    @app.get("/api/admin/repos")
    @auth.admin_required
    def admin_repos():
        rows = db.query("SELECT * FROM repos ORDER BY sort_order, id")
        return jsonify(repos=[admin_repo(r) for r in rows], busy=svc.collector.busy)

    @app.post("/api/admin/repos")
    @auth.admin_required
    def add_repos():
        data = body()
        entries = data.get("repos") or [data.get("repo", "")]
        if isinstance(entries, str):
            entries = re.split(r"[\s,]+", entries)
        client = svc.collector.client()
        added, errors = [], []
        for entry in [e for e in entries if str(e).strip()][:100]:
            try:
                owner, name = parse_repo(str(entry))
                if db.query_one("SELECT 1 FROM repos WHERE lower(owner) = lower(?) AND "
                                "lower(name) = lower(?)", (owner, name)):
                    errors.append(f"{owner}/{name} is already tracked")
                    continue
                info = client.repo(owner, name)
                owner, name = info["full_name"].split("/", 1)
                order = db.query_one("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM repos")["n"]
                cur = db.execute(
                    "INSERT INTO repos(owner, name, description, html_url, sort_order, added_at, "
                    "asset_filter) VALUES(?,?,?,?,?,?,?)",
                    (owner, name, info.get("description") or "", info.get("html_url"), order,
                     now_iso(), str(data.get("asset_filter", "")).strip()[:200]))
                added.append(cur.lastrowid)
            except (ValueError, GitHubError) as exc:
                errors.append(f"{entry}: {exc}")
        if added and data.get("collect", True):
            svc.collector.run("repo added", repo_ids=added, wait=False)
        rows = [db.query_one("SELECT * FROM repos WHERE id = ?", (i,)) for i in added]
        status = 200 if added or not errors else 400
        return jsonify(added=[admin_repo(r) for r in rows if r], errors=errors), status

    @app.post("/api/admin/discover")
    @auth.admin_required
    def discover():
        owner = str(body().get("owner", "")).strip()
        owner = re.sub(r"^(https?://)?(www\.)?github\.com/", "", owner, flags=re.I).strip("/")
        if not re.match(r"^[A-Za-z0-9-]{1,39}$", owner):
            return jsonify(error="Enter a GitHub user or organisation name"), 400
        try:
            items = svc.collector.client().owner_repos(owner)
        except GitHubError as exc:
            return jsonify(error=str(exc)), 400
        tracked = {(r["owner"].lower(), r["name"].lower()) for r in db.query("SELECT owner, name FROM repos")}
        out = [{
            "full_name": i["full_name"], "description": i.get("description") or "",
            "stars": i.get("stargazers_count", 0), "fork": bool(i.get("fork")),
            "archived": bool(i.get("archived")), "pushed_at": i.get("pushed_at"),
            "tracked": tuple(i["full_name"].lower().split("/", 1)) in tracked,
        } for i in items]
        out.sort(key=lambda x: x["pushed_at"] or "", reverse=True)
        return jsonify(repos=out)

    @app.patch("/api/admin/repos/<int:repo_id>")
    @auth.admin_required
    def update_repo(repo_id: int):
        row = repo_or_404(repo_id)
        if row is None:
            return jsonify(error="Unknown repository"), 404
        data = body()
        fields, params = [], []
        if "label" in data:
            fields.append("label = ?"); params.append(str(data["label"]).strip()[:80] or None)
        if "color" in data:
            color = str(data["color"] or "").strip()
            if color and not HEX_COLOR.match(color):
                return jsonify(error="Colour must look like #4F7CFF"), 400
            fields.append("color = ?"); params.append(color or None)
        if "asset_filter" in data:
            fields.append("asset_filter = ?"); params.append(str(data["asset_filter"]).strip()[:200])
        for flag in ("enabled", "hidden"):
            if flag in data:
                fields.append(f"{flag} = ?"); params.append(1 if data[flag] else 0)
        if fields:
            db.execute(f"UPDATE repos SET {', '.join(fields)} WHERE id = ?", [*params, repo_id])
        return jsonify(repo=admin_repo(repo_or_404(repo_id)))

    @app.post("/api/admin/repos/order")
    @auth.admin_required
    def reorder():
        ids = [int(i) for i in body().get("ids", []) if str(i).isdigit()]
        with db.transaction() as con:
            for pos, rid in enumerate(ids, start=1):
                con.execute("UPDATE repos SET sort_order = ? WHERE id = ?", (pos, rid))
        return jsonify(ok=True)

    @app.delete("/api/admin/repos/<int:repo_id>")
    @auth.admin_required
    def delete_repo(repo_id: int):
        if repo_or_404(repo_id) is None:
            return jsonify(error="Unknown repository"), 404
        db.execute("DELETE FROM repos WHERE id = ?", (repo_id,))
        return jsonify(ok=True)

    @app.post("/api/admin/collect")
    @auth.admin_required
    def collect_now():
        ids = body().get("repo_ids") or None
        if ids:
            ids = [int(i) for i in ids]
        run_id = svc.collector.run("manual", repo_ids=ids, wait=False)
        if run_id is None:
            return jsonify(error="A collection is already running"), 409
        return jsonify(run_id=run_id)

    @app.get("/api/admin/runs")
    @auth.admin_required
    def runs():
        rows = db.query("SELECT * FROM runs ORDER BY id DESC LIMIT 50")
        settings = db.all_settings()
        return jsonify(runs=[dict(r) for r in rows], busy=svc.collector.busy,
                       next_run=next_run_time(settings))

    def next_run_time(settings) -> str:
        hh, mm = (int(x) for x in str(settings["collection_time"]).split(":"))
        now = datetime.now()
        when = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if settings.get("last_scheduled_run") == now.strftime("%Y-%m-%d"):
            when += timedelta(days=1)
        elif when <= now:
            when = now
        return when.astimezone().isoformat(timespec="minutes")

    @app.get("/api/admin/settings")
    @auth.admin_required
    def get_settings():
        s = db.all_settings()
        token = s.get("github_token") or ""
        return jsonify(
            site_title=s["site_title"], site_subtitle=s["site_subtitle"],
            collection_time=s["collection_time"], public_dashboard=bool(s["public_dashboard"]),
            github_token_set=bool(token), github_token_hint=("…" + token[-4:]) if token else "",
            next_run=next_run_time(s), timezone=datetime.now().astimezone().tzname(),
            user=auth.current_user(), version=__version__,
            server={"port": cfg.port, "data_dir": str(cfg.data_dir), "db": str(cfg.db_path)},
        )

    @app.get("/api/admin/rate-limit")
    @auth.admin_required
    def rate_limit():
        token = db.get_setting("github_token", "") or ""
        try:
            core = GitHubClient(cfg.github_api_url, token, timeout=10).rate_limit()
            return jsonify(limit=core.get("limit"), remaining=core.get("remaining"),
                           reset=core.get("reset"), authenticated=bool(token))
        except GitHubError as exc:
            return jsonify(error=str(exc), authenticated=bool(token))

    @app.put("/api/admin/settings")
    @auth.admin_required
    def put_settings():
        data = body()
        if "site_title" in data:
            db.set_setting("site_title", str(data["site_title"]).strip()[:80] or "RepoPulse")
        if "site_subtitle" in data:
            db.set_setting("site_subtitle", str(data["site_subtitle"]).strip()[:200])
        if "collection_time" in data:
            t = str(data["collection_time"]).strip()
            if not TIME_RE.match(t):
                return jsonify(error="Collection time must be HH:MM (24 h)"), 400
            if t != db.get_setting("collection_time"):
                db.set_setting("collection_time", t)
        if "public_dashboard" in data:
            db.set_setting("public_dashboard", bool(data["public_dashboard"]))
        if "github_token" in data:
            token = str(data["github_token"] or "").strip()
            if token:
                try:
                    GitHubClient(cfg.github_api_url, token, timeout=15).rate_limit()
                except GitHubError as exc:
                    return jsonify(error=f"Token check failed: {exc}"), 400
            db.set_setting("github_token", token)
        return get_settings()

    def valid_layout(layout) -> str | None:
        if not isinstance(layout, dict) or not isinstance(layout.get("widgets"), list):
            return "Invalid layout"
        if len(json.dumps(layout)) > 200_000 or len(layout["widgets"]) > 60:
            return "Layout too large"
        return None

    @app.put("/api/admin/layout")
    @auth.admin_required
    def put_layout():
        layout = body().get("layout")
        problem = valid_layout(layout)
        if problem:
            return jsonify(error=problem), 400
        db.set_setting("layout", layout)
        return jsonify(ok=True)

    @app.put("/api/admin/repo-layout")
    @auth.admin_required
    def put_repo_layout():
        """The layout every repository page uses unless it has its own."""
        layout = body().get("layout")
        problem = valid_layout(layout)
        if problem:
            return jsonify(error=problem), 400
        db.set_setting("repo_layout", layout)
        return jsonify(ok=True)

    @app.put("/api/admin/repos/<int:repo_id>/layout")
    @auth.admin_required
    def put_own_layout(repo_id: int):
        """A layout for one repository only; null goes back to the shared one."""
        if repo_or_404(repo_id) is None:
            return jsonify(error="Unknown repository"), 404
        layout = body().get("layout")
        if layout is not None:
            problem = valid_layout(layout)
            if problem:
                return jsonify(error=problem), 400
        db.execute("UPDATE repos SET layout = ? WHERE id = ?",
                   (json.dumps(layout) if layout is not None else None, repo_id))
        return jsonify(ok=True)

    @app.post("/api/admin/password")
    @auth.admin_required
    def change_password():
        data = body()
        user = auth.verify(db, session["user"], str(data.get("current", "")))
        if user is None:
            return jsonify(error="Current password is wrong"), 400
        problem = auth.validate_new_password(user["username"], str(data.get("new", "")))
        if problem:
            return jsonify(error=problem), 400
        auth.set_password(db, user["username"], str(data["new"]))
        return jsonify(ok=True)

    return app
