"""Tiny GitHub REST client using only the standard library."""
from __future__ import annotations

import http.client
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

USER_AGENT = "RepoPulse-download-tracker"
REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
# "." and ".." are not repository names; they would change the API path (/repos/owner/..).
NAME_RE = re.compile(r"^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$")


class GitHubError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def parse_repo(text: str) -> tuple[str, str]:
    """Accept "owner/repo", "github.com/owner/repo" or a full URL."""
    value = (text or "").strip()
    value = re.sub(r"^(https?://)?(www\.)?github\.com/", "", value, flags=re.I)
    value = value.split("?")[0].split("#")[0].strip("/")
    if value.endswith(".git"):
        value = value[:-4]
    parts = [p for p in value.split("/") if p]
    if len(parts) < 2:
        raise ValueError("Enter the repository as owner/name, e.g. octocat/Hello-World")
    owner, name = parts[0], parts[1]
    if not REPO_RE.match(owner) or not NAME_RE.match(name):
        raise ValueError(f"'{owner}/{name}' is not a valid GitHub repository name")
    return owner, name


def _origin(url: str) -> tuple[str, str, int | None]:
    parts = urllib.parse.urlsplit(url)
    scheme = parts.scheme.lower()
    try:
        port = parts.port
    except ValueError:
        port = None
    return scheme, (parts.hostname or "").lower(), port or {"https": 443, "http": 80}.get(scheme)


class _RedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follows GitHub's redirects (301 for a renamed repository) but sends the token only to the configured API:
    urllib would copy the Authorization header to any host, and it never follows https to http."""

    def __init__(self, api_url: str):
        super().__init__()
        self.api_origin = _origin(api_url)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_origin = _origin(newurl)
        if _origin(req.full_url)[0] == "https" and new_origin[0] != "https":
            raise urllib.error.HTTPError(newurl, code, "Refusing a redirect from https to " + new_origin[0],
                                         headers, fp)
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and new_origin != self.api_origin:
            for key in [k for k in new.headers if k.lower() == "authorization"]:
                del new.headers[key]
            new.unredirected_hdrs.pop("Authorization", None)
        return new


def _open(req: urllib.request.Request, api_url: str, timeout: float):
    opener = urllib.request.build_opener(_RedirectHandler(api_url))
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- the configured GitHub API base URL plus fixed paths
    return opener.open(req, timeout=timeout)


@dataclass
class RateLimit:
    remaining: int | None = None
    reset: int | None = None


class GitHubClient:
    def __init__(self, api_url: str = "https://api.github.com", token: str = "",
                 timeout: int = 30):
        self.api_url = api_url.rstrip("/")
        self.token = token.strip()
        self.timeout = timeout
        self.rate = RateLimit()

    def _request(self, path: str, params: dict | None = None) -> tuple[Any, dict]:
        url = self.api_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        })
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with _open(req, self.api_url, self.timeout) as resp:
                headers = {k.lower(): v for k, v in resp.headers.items()}
                body = resp.read().decode("utf-8")
            data = json.loads(body) if body else None
        except urllib.error.HTTPError as exc:
            headers = {k.lower(): v for k, v in (exc.headers or {}).items()}
            self._update_rate(headers)
            detail = ""
            try:
                detail = json.loads(exc.read().decode("utf-8")).get("message", "")
            except Exception:
                pass
            if exc.code == 404:
                raise GitHubError("Repository not found (or it is private and the token "
                                  "has no access to it)", 404) from None
            if exc.code in (403, 429) and (headers.get("x-ratelimit-remaining") == "0"
                                          or "rate limit" in detail.lower()):
                raise GitHubError("GitHub API rate limit reached. Add a GitHub token in "
                                  "Settings to raise the limit from 60 to 5000 "
                                  "requests per hour.", exc.code) from None
            if exc.code == 401:
                raise GitHubError("GitHub rejected the token (401 Bad credentials). "
                                  "Check the token in Settings.", 401) from None
            raise GitHubError(f"GitHub API error {exc.code}: {detail or exc.reason}",
                              exc.code) from None
        except urllib.error.URLError as exc:
            raise GitHubError(f"Could not reach GitHub: {exc.reason}") from None
        except TimeoutError:  # socket.timeout is an OSError but not a TimeoutError on Python 3.9
            raise GitHubError("GitHub did not answer in time") from None
        except OSError as exc:
            if "timed out" in str(exc).lower():
                raise GitHubError("GitHub did not answer in time") from None
            raise GitHubError(f"Could not reach GitHub ({type(exc).__name__})") from None
        except http.client.HTTPException as exc:
            raise GitHubError(f"The connection to GitHub broke off ({type(exc).__name__})") from None
        except ValueError:
            # An invalid header (e.g. a token with a line break) or a response that is not JSON; the exception's
            # text can contain the header value, so it is never shown.
            raise GitHubError("Invalid request or response; check the GitHub token and API URL") from None
        self._update_rate(headers)
        return data, headers

    def _update_rate(self, headers: dict) -> None:
        try:
            if "x-ratelimit-remaining" in headers:
                self.rate.remaining = int(headers["x-ratelimit-remaining"])
            if "x-ratelimit-reset" in headers:
                self.rate.reset = int(headers["x-ratelimit-reset"])
        except ValueError:
            pass

    def _paged(self, path: str, max_pages: int = 20) -> list[Any]:
        items: list[Any] = []
        for page in range(1, max_pages + 1):
            data, headers = self._request(path, {"per_page": 100, "page": page})
            if not isinstance(data, list):
                break
            items.extend(data)
            if len(data) < 100 or 'rel="next"' not in headers.get("link", ""):
                break
        return items

    # ---- public API ----------------------------------------------------
    def repo(self, owner: str, name: str) -> dict:
        data, _ = self._request(f"/repos/{owner}/{name}")
        return data

    def releases(self, owner: str, name: str) -> list[dict]:
        return self._paged(f"/repos/{owner}/{name}/releases")

    def owner_repos(self, owner: str) -> list[dict]:
        """Public repos of a user or organisation (all repos for the token owner)."""
        try:
            return self._paged(f"/users/{owner}/repos", max_pages=10)
        except GitHubError as exc:
            if exc.status == 404:
                raise GitHubError(f"No GitHub user or organisation called '{owner}'", 404)
            raise

    def rate_limit(self) -> dict:
        data, _ = self._request("/rate_limit")
        return data.get("resources", {}).get("core", {}) if data else {}
