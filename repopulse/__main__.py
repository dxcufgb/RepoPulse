"""Command line: python -m repopulse <command>

  serve            start the web server (default)
  collect          collect download numbers now and exit
  create-admin     create an admin account
  set-password     change an admin account's password
  status           show tracked repos and the latest collection
  check-update     ask GitHub whether a newer release exists (exit 10 = yes, 0 = no, 1 = could not check)
  set-notify       set who gets the update e-mails and the mail server (asks, or --from-env)
  test-email       send a test e-mail with the saved settings
  update-event     record the result of an automatic update and e-mail it (used by auto-update.sh/.ps1)
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
    sub.add_parser("check-update", help="ask GitHub whether a newer release exists")
    sn = sub.add_parser("set-notify", help="set the update e-mail recipients and mail server")
    sn.add_argument("--from-env", action="store_true",
                    help="read REPOPULSE_NOTIFY_EMAILS, REPOPULSE_SMTP_HOST, _PORT, _SECURITY, _USER, _PASSWORD, _FROM")
    sub.add_parser("test-email", help="send a test e-mail")
    ev = sub.add_parser("update-event", help="record an automatic update's result (used by the update scripts)")
    ev.add_argument("--outcome", required=True, choices=("updated", "failed", "rolled-back", "current"))
    ev.add_argument("--from", dest="old", default="")
    ev.add_argument("--to", dest="new", default="")
    ev.add_argument("--message-stdin", action="store_true", help="read the details from standard input")
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

    if command == "check-update":
        from . import updates
        info = updates.check_latest(force=True)
        if info["error"]:
            print(f"Could not check: {info['error']}")
            return 1
        if info["newer"]:
            print(f"RepoPulse {info['latest']} is available (installed: {info['installed']}). {info['url']}")
            return 10
        print(f"RepoPulse {info['installed']} is up to date (latest release: {info['latest'] or 'none'}).")
        return 0

    if command == "set-notify":
        from . import notify
        if args.from_env:
            import os
            env = {"recipients": "REPOPULSE_NOTIFY_EMAILS", "host": "REPOPULSE_SMTP_HOST", "port": "REPOPULSE_SMTP_PORT",
                   "security": "REPOPULSE_SMTP_SECURITY", "user": "REPOPULSE_SMTP_USER",
                   "password": "REPOPULSE_SMTP_PASSWORD", "sender": "REPOPULSE_SMTP_FROM"}
            data = {k: os.environ[v] for k, v in env.items() if os.environ.get(v)}
            if not data:
                print("No REPOPULSE_NOTIFY_EMAILS / REPOPULSE_SMTP_* variables set; nothing changed.")
                return 0
        else:
            cur = notify.settings(db)
            ask = lambda label, value: input(f"{label} [{value}]: ").strip() or value  # noqa: E731
            data = {"recipients": ask("E-mail addresses (comma separated, empty = no e-mails)", ", ".join(cur["recipients"]))}
            if data["recipients"]:
                data["host"] = ask("Mail server (e.g. smtp.gmail.com)", cur["host"])
                data["security"] = ask("Security: starttls, tls or none", cur["security"])
                data["port"] = ask("Port", str(cur["port"] if cur["host"] else notify.DEFAULT_PORTS.get(data["security"], 587)))
                data["user"] = ask("User name (empty = no login)", cur["user"])
                if data["user"]:
                    data["password"] = getpass.getpass("Password (empty = keep the saved one): ")
                data["sender"] = ask("Sender address (empty = the user name)", cur["sender"])
        problem, merged = notify.validate(data, notify.settings(db))
        if problem:
            print(problem)
            return 1
        db.set_setting("notify", merged)
        print(f"Saved: {len(merged['recipients'])} recipient(s)" + (f", mail server {merged['host']}" if merged["host"] else ""))
        return 0

    if command == "test-email":
        from . import notify
        try:
            sent = notify.send(notify.settings(db), f"RepoPulse ({notify.host_label()}): test e-mail",
                               "This is a test e-mail from RepoPulse." + notify.footer())
        except notify.NotifyError as exc:
            print(f"Not sent: {exc}")
            return 1
        print(f"Sent to {sent} recipient(s)." if sent else "No recipients or no mail server set; nothing sent.")
        return 0

    if command == "update-event":
        from . import notify
        from .collector import now_iso
        message = sys.stdin.read(20000) if args.message_stdin else ""
        event = notify.record_update(db, args.outcome, args.old, args.new, message, now=now_iso())
        if event["email_error"]:
            print(f"notify: e-mail not sent: {event['email_error']}")
        elif event["emailed"]:
            print(f"notify: e-mail sent to {event['emailed']} recipient(s)")
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
