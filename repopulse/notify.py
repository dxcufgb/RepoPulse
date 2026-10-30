"""E-mail notifications: automatic updates (installed, failed) and the test e-mail from the admin page.

The settings live in the database (``notify`` in ``settings``), set on Admin, Settings or with
``python -m repopulse set-notify``. The SMTP password is never sent back to the browser, logged or printed.
Standard library only (smtplib); the password only ever goes out over TLS.
"""
from __future__ import annotations

import logging
import re
import smtplib
import socket
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from typing import Any, Callable, Dict, List, Optional

log = logging.getLogger("repopulse.notify")

SECURITY = ("starttls", "tls", "none")
DEFAULT_PORTS = {"starttls": 587, "tls": 465, "none": 25}
EMAIL_RE = re.compile(r"^[^@\s,;<>\"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}$|^\[?[0-9A-Fa-f:.]{2,45}\]?$")
MAX_RECIPIENTS = 10
TIMEOUT = 30

DEFAULTS: Dict[str, Any] = {
    "recipients": [], "host": "", "port": 587, "security": "starttls", "user": "", "password": "", "sender": "",
}


class NotifyError(Exception):
    """Sending failed; the message never contains the password."""


def settings(db) -> Dict[str, Any]:
    stored = db.get_setting("notify", None)
    out = dict(DEFAULTS)
    if isinstance(stored, dict):
        out.update({k: stored[k] for k in DEFAULTS if k in stored})
    return out


def public(s: Dict[str, Any]) -> Dict[str, Any]:
    """What the admin page may see: everything but the password."""
    out = {k: v for k, v in s.items() if k != "password"}
    out["password_set"] = bool(s.get("password"))
    return out


def parse_recipients(value) -> List[str]:
    items = value if isinstance(value, list) else re.split(r"[,;\s]+", str(value or ""))
    return [str(x).strip() for x in items if str(x).strip()]


def validate(data: Dict[str, Any], current: Dict[str, Any]) -> "tuple[Optional[str], Dict[str, Any]]":
    """(error, merged settings). Keys left out keep their value; an empty or missing password keeps the saved one."""
    merged = dict(current)
    if "recipients" in data:
        recipients = parse_recipients(data["recipients"])
        bad = [r for r in recipients if not EMAIL_RE.match(r)]
        if bad:
            return f"Not an e-mail address: {bad[0][:80]}", current
        if len(recipients) > MAX_RECIPIENTS:
            return f"At most {MAX_RECIPIENTS} addresses", current
        merged["recipients"] = list(dict.fromkeys(recipients))
    if "host" in data:
        host = str(data["host"] or "").strip()
        if host and not HOST_RE.match(host):
            return "The mail server must be a host name or an IP address", current
        merged["host"] = host
    if "security" in data:
        if data["security"] not in SECURITY:
            return "Security must be starttls, tls or none", current
        merged["security"] = data["security"]
    if "port" in data:
        try:
            port = int(data["port"] or DEFAULT_PORTS[merged["security"]])
        except (TypeError, ValueError):
            return "The port must be a number", current
        if not 1 <= port <= 65535:
            return "The port must be between 1 and 65535", current
        merged["port"] = port
    for key, limit in (("user", 200), ("sender", 254)):
        if key in data:
            value = str(data[key] or "").strip()
            if len(value) > limit or "\r" in value or "\n" in value:
                return f"The {key} is too long or has line breaks", current
            merged[key] = value
    if merged["sender"] and not EMAIL_RE.match(merged["sender"]):
        return "The sender must be an e-mail address", current
    if data.get("password"):
        password = str(data["password"])
        if len(password) > 500 or "\r" in password or "\n" in password:
            return "The password is too long or has line breaks", current
        merged["password"] = password
    if data.get("clear_password"):
        merged["password"] = ""
    if merged["password"] and merged["security"] == "none":
        return "A password is only sent over TLS: choose starttls or tls, or remove the password", current
    return None, merged


SmtpFactory = Callable[..., smtplib.SMTP]


def send(s: Dict[str, Any], subject: str, body: str, smtp: Optional[SmtpFactory] = None,
         smtp_ssl: Optional[SmtpFactory] = None) -> int:
    """Sends one e-mail to every recipient; returns how many. 0 recipients or no server: nothing is sent."""
    recipients = s.get("recipients") or []
    if not recipients or not s.get("host"):
        return 0
    security = s.get("security", "starttls")
    host, port = s["host"], int(s.get("port") or DEFAULT_PORTS[security])
    user_address = s.get("user") if EMAIL_RE.match(s.get("user") or "") else ""
    sender = s.get("sender") or user_address or f"repopulse@{socket.gethostname() or 'localhost'}"
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=sender.split("@")[-1])
    msg.set_content(body)
    context = ssl.create_default_context()
    try:
        if security == "tls":
            client = (smtp_ssl or smtplib.SMTP_SSL)(host, port, timeout=TIMEOUT, context=context)
        else:
            client = (smtp or smtplib.SMTP)(host, port, timeout=TIMEOUT)
        with client:
            client.ehlo()
            if security == "starttls":
                client.starttls(context=context)
                client.ehlo()
            if s.get("user") and s.get("password"):
                if security == "none":
                    raise NotifyError("Refusing to send the password without TLS")
                client.login(s["user"], s["password"])
            client.send_message(msg, from_addr=sender, to_addrs=recipients)
    except NotifyError:
        raise
    except smtplib.SMTPAuthenticationError:
        raise NotifyError("The mail server did not accept the user name and password") from None
    except ssl.SSLError as exc:
        raise NotifyError(f"TLS with {host} failed: {exc.reason or exc}") from None
    except (smtplib.SMTPException, OSError) as exc:
        text = f"Sending through {host}:{port} failed: {type(exc).__name__}: {exc}"
        if s.get("password"):
            text = text.replace(str(s["password"]), "***")
        raise NotifyError(text) from None
    return len(recipients)


def host_label() -> str:
    return socket.gethostname() or "this server"


def footer() -> str:
    return (f"\n\n-- \nRepoPulse on {host_label()}\n"
            "Change who gets these e-mails under Admin, Settings, Notifications.\n")


# ------------------------------------------------------------------------------------------ update events
OUTCOMES = ("updated", "failed", "rolled-back", "current")
VERSION_RE = re.compile(r"^[0-9A-Za-z.+-]{1,40}$")


def record_update(db, outcome: str, old: str = "", new: str = "", message: str = "", now: str = "",
                  sender: Callable[[Dict[str, Any], str, str], int] = send) -> Dict[str, Any]:
    """Stores the result of an update run (shown on Admin, Settings) and e-mails it when it installed a version or
    failed. A failure to send is logged and never changes the outcome."""
    if outcome not in OUTCOMES:
        raise ValueError(f"unknown outcome {outcome!r}")
    old = old if VERSION_RE.match(old or "") else ""
    new = new if VERSION_RE.match(new or "") else ""
    message = str(message or "")[-4000:]
    event = {"outcome": outcome, "from": old, "to": new, "message": message, "at": now, "emailed": 0, "email_error": ""}
    if outcome in ("updated", "failed", "rolled-back"):
        subjects = {
            "updated": f"updated to {new}" if new else "updated",
            "failed": "automatic update failed",
            "rolled-back": f"update to {new} failed, {old} restored" if new and old else "update failed, previous version restored",
        }
        texts = {
            "updated": f"RepoPulse was updated from {old or 'an older version'} to {new}.",
            "failed": "The automatic update of RepoPulse failed. Nothing was changed, or the previous version was put back.",
            "rolled-back": f"RepoPulse {new} did not start, so {old or 'the previous version'} was put back and is running again.",
        }
        body = texts[outcome]
        if message:
            body += "\n\nDetails:\n" + message
        if new and outcome == "updated":
            body += f"\n\nRelease notes: https://github.com/dxcufgb/RepoPulse/releases/tag/v{new}"
        try:
            event["emailed"] = sender(settings(db), f"RepoPulse ({host_label()}): {subjects[outcome]}", body + footer())
        except NotifyError as exc:
            log.warning("Update e-mail not sent: %s", exc)
            event["email_error"] = str(exc)
    # the last check is always kept; the last run that did something stays until the next one
    db.set_setting("last_update_check", {"at": now, "outcome": outcome})
    if outcome not in ("current", "checked"):
        db.set_setting("last_update", event)
    return event
