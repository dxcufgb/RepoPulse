"""Read-side queries that feed the dashboard."""
from __future__ import annotations

import csv
import fnmatch
import io
from datetime import date as Date, timedelta

from .db import Database, glob_clause, split_filter

SLOTS = 8  # the frontend owns the validated palette (light and dark steps)


def asset_counted(name: str, asset_filter: str) -> bool:
    # the same parsing as db.glob_clause, so the totals and the file list agree
    includes, excludes = split_filter(asset_filter)
    low = name.lower()
    if includes and not any(fnmatch.fnmatchcase(low, p) for p in includes):
        return False
    return not any(fnmatch.fnmatchcase(low, p) for p in excludes)


def repo_slot(repo) -> int:
    # Tied to the repo itself, so reordering or filtering never repaints a series.
    return (repo["id"] - 1) % SLOTS


def repo_public(repo) -> dict:
    return {
        "id": repo["id"],
        "owner": repo["owner"],
        "name": repo["name"],
        "full_name": f"{repo['owner']}/{repo['name']}",
        "label": repo["label"] or repo["name"],
        "color": repo["color"] or None,
        "slot": repo_slot(repo),
        "description": repo["description"] or "",
        "url": repo["html_url"] or f"https://github.com/{repo['owner']}/{repo['name']}",
    }


def history(db: Database, repo) -> list[list]:
    """[[date, downloads, stars, forks, releases], ...] oldest first."""
    clause, params = glob_clause(repo["asset_filter"])
    rows = db.query(
        "SELECT s.date, s.stars, s.forks, s.release_count, "
        "COALESCE((SELECT SUM(a.downloads) FROM asset_snapshots a "
        "          WHERE a.repo_id = s.repo_id AND a.date = s.date" + clause + "), 0) AS dl "
        "FROM snapshots s WHERE s.repo_id = ? ORDER BY s.date",
        [*params, repo["id"]])
    return [[r["date"], r["dl"], r["stars"], r["forks"], r["release_count"]] for r in rows]


def latest_release(db: Database, repo_id: int):
    row = db.query_one(
        "SELECT tag, name, published_at, html_url FROM releases WHERE repo_id = ? "
        "ORDER BY prerelease, published_at DESC LIMIT 1", (repo_id,))
    return dict(row) if row else None


def dashboard_data(db: Database, include_hidden: bool = False) -> dict:
    sql = "SELECT * FROM repos" + ("" if include_hidden else " WHERE hidden = 0")
    repos = db.query(sql + " ORDER BY sort_order, id")
    out_repos, hist = [], {}
    for repo in repos:
        item = repo_public(repo)
        h = history(db, repo)
        hist[repo["id"]] = h
        item["latest_release"] = latest_release(db, repo["id"])
        item["last_collected"] = repo["last_collected"]
        item["own_layout"] = bool(repo["layout"])
        item["hidden"] = bool(repo["hidden"])
        out_repos.append(item)
    last_run = db.query_one(
        "SELECT finished_at, status FROM runs WHERE finished_at IS NOT NULL "
        "AND status != 'failed' ORDER BY id DESC LIMIT 1")
    return {
        "repos": out_repos,
        "history": hist,
        "columns": ["date", "downloads", "stars", "forks", "releases"],
        "last_update": last_run["finished_at"] if last_run else None,
    }


def releases(db: Database, repo) -> list[dict]:
    """Per-release downloads at the latest snapshot, plus the last 7 days."""
    latest = db.query_one("SELECT MAX(date) AS d FROM asset_snapshots WHERE repo_id = ?",
                          (repo["id"],))["d"]
    if not latest:
        return []
    week_ago = (Date.fromisoformat(latest) - timedelta(days=7)).isoformat()
    prev = db.query_one("SELECT MAX(date) AS d FROM asset_snapshots WHERE repo_id = ? "
                        "AND date <= ?", (repo["id"], week_ago))["d"]
    prev_counts: dict[tuple, int] = {}
    if prev:
        for r in db.query("SELECT tag, asset, downloads FROM asset_snapshots "
                          "WHERE repo_id = ? AND date = ?", (repo["id"], prev)):
            prev_counts[(r["tag"], r["asset"])] = r["downloads"]
    meta = {r["tag"]: r for r in db.query("SELECT * FROM releases WHERE repo_id = ?",
                                           (repo["id"],))}
    by_tag: dict[str, dict] = {}
    for r in db.query("SELECT tag, asset, downloads FROM asset_snapshots "
                      "WHERE repo_id = ? AND date = ?", (repo["id"], latest)):
        m = meta.get(r["tag"])
        rel = by_tag.setdefault(r["tag"], {
            "tag": r["tag"],
            "name": (m["name"] if m else None) or r["tag"],
            "published_at": m["published_at"] if m else None,
            "prerelease": bool(m["prerelease"]) if m else False,
            "url": m["html_url"] if m else None,
            "downloads": 0, "last_7_days": 0 if prev else None, "assets": [],
        })
        counted = asset_counted(r["asset"], repo["asset_filter"])
        rel["assets"].append({"name": r["asset"], "downloads": r["downloads"],
                              "counted": counted})
        if counted:
            rel["downloads"] += r["downloads"]
            if prev:
                rel["last_7_days"] += max(0, r["downloads"] - prev_counts.get((r["tag"], r["asset"]), 0))
    # Releases without assets still deserve a row.
    for tag, m in meta.items():
        if tag not in by_tag:
            by_tag[tag] = {"tag": tag, "name": m["name"] or tag, "published_at": m["published_at"],
                           "prerelease": bool(m["prerelease"]), "url": m["html_url"],
                           "downloads": 0, "last_7_days": 0 if prev else None, "assets": []}
    return sorted(by_tag.values(), key=lambda x: x["published_at"] or "", reverse=True)


def release_history(db: Database, repo) -> dict[str, list[list]]:
    """{tag: [[date, downloads], ...]} with the repo's file filter applied."""
    clause, params = glob_clause(repo["asset_filter"])
    out: dict[str, list[list]] = {}
    for r in db.query("SELECT date, tag, SUM(downloads) AS dl FROM asset_snapshots "
                      "WHERE repo_id = ?" + clause + " GROUP BY date, tag ORDER BY date",
                      [repo["id"], *params]):
        out.setdefault(r["tag"], []).append([r["date"], r["dl"]])
    return out


def export_csv(db: Database, include_hidden: bool) -> str:
    data = dashboard_data(db, include_hidden)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "repository", "total_downloads", "new_downloads", "stars", "forks",
                "releases"])
    for repo in data["repos"]:
        prev = None
        for d, dl, stars, forks, rels in data["history"][repo["id"]]:
            new = "" if prev is None else max(0, dl - prev)
            w.writerow([d, repo["full_name"], dl, new, stars, forks, rels])
            prev = dl
    return buf.getvalue()
