"""Command line: python -m repopulse <command>

  serve            start the web server (default)
  collect          collect download numbers now and exit
  create-admin     create an admin account
  set-password     change an admin account's password
  status           show tracked repos and the latest collection
"""
from __future__ import annotations

import argparse
import getpass
import logging
import sys

from . import __version__, auth
from .config import load_config


def _ask_credentials(args, confirm: bool = True) -> tuple[str, str]:
    username = args.username or input("Admin username: ").strip()
    password = args.password
    if not password:
        while True:
            password = getpass.getpass("Password (min %d characters): " % auth.MIN_PASSWORD)
            if confirm and getpass.getpass("Repeat password: ") != password:
                print("Passwords do not match, try again.")
                continue
            break
    return username, password


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="repopulse", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", action="version", version=f"RepoPulse {__version__}")
    sub = parser.add_subparsers(dest="command")
    serve = sub.add_parser("serve", help="start the web server")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.add_argument("--no-scheduler", action="store_true",
                       help="do not collect automatically every day")
    sub.add_parser("collect", help="collect download numbers now")
    for name in ("create-admin", "set-password"):
        p = sub.add_parser(name)
        p.add_argument("--username")
        p.add_argument("--password", help="avoid on shared machines; you will be asked otherwise")
    sub.add_parser("status", help="show tracked repos and last run")
    args = parser.parse_args(argv)
    command = args.command or "serve"

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("waitress.queue").setLevel(logging.ERROR)
    cfg = load_config()

    if command == "serve":
        if args.host:
            cfg.host = args.host
        if args.port:
            cfg.port = args.port
        from waitress import serve as waitress_serve
        from .app import create_app
        app = create_app(cfg, start_scheduler=not args.no_scheduler)
        db = app.extensions["repopulse"].db
        shown = "localhost" if cfg.host in ("0.0.0.0", "::", "") else cfg.host
        print(f"\n  RepoPulse {__version__} is running")
        print(f"  Dashboard: http://{shown}:{cfg.port}/")
        print(f"  Admin:     http://{shown}:{cfg.port}/admin")
        print(f"  Data:      {cfg.db_path}")
        if auth.user_count(db) == 0:
            print("\n  No admin account yet: open the Admin link on this computer to create one,")
            print("  or run:  python -m repopulse create-admin")
        if cfg.host not in ("127.0.0.1", "::1", "localhost") and not cfg.secure_cookies:
            print("\n  WARNING: serving on a network address over plain HTTP — the admin password and")
            print("           session cookie cross the network unencrypted. Put RepoPulse behind HTTPS")
            print("           and set secure_cookies=true, or bind host to 127.0.0.1 for local use.")
        print("  Press Ctrl+C to stop.\n")
        waitress_serve(app, host=cfg.host, port=cfg.port, threads=cfg.threads, ident="RepoPulse")
        return 0

    from .collector import Collector
    from .db import Database
    db = Database(cfg.db_path)

    if command == "collect":
        run_id = Collector(db, cfg.github_api_url).run("command line", wait=True)
        row = db.query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
        print(f"Run {run_id}: {row['status']} — {row['repos_ok']} ok, {row['repos_failed']} failed")
        if row["message"]:
            print(row["message"])
        return 0 if row["status"] == "ok" else 1

    if command == "create-admin":
        username, password = _ask_credentials(args)
        problem = auth.validate_new_password(username, password)
        if problem:
            print(problem)
            return 1
        if db.query_one("SELECT 1 FROM users WHERE username = ?", (username,)):
            print(f"User '{username}' already exists; use set-password to change it.")
            return 1
        auth.create_user(db, username, password)
        print(f"Admin account '{username}' created.")
        return 0

    if command == "set-password":
        username, password = _ask_credentials(args)
        problem = auth.validate_new_password(username, password)
        if problem:
            print(problem)
            return 1
        if not auth.set_password(db, username, password):
            print(f"No user called '{username}'.")
            return 1
        print(f"Password for '{username}' changed.")
        return 0

    if command == "status":
        from . import stats
        data = stats.dashboard_data(db, include_hidden=True)
        print(f"Database: {cfg.db_path}")
        print(f"Admin accounts: {auth.user_count(db)}")
        print(f"Last update: {data['last_update'] or 'never'}")
        for repo in data["repos"]:
            h = data["history"][repo["id"]]
            total = h[-1][1] if h else "-"
            print(f"  {repo['full_name']:<50} downloads: {total}  ({len(h)} days of history)")
        return 0
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
