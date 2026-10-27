# RepoPulse

Self-hosted dashboard of GitHub release download counts: a Flask app served by Waitress, one SQLite file, a
single-page frontend without a build step. Python 3.9+; runtime dependencies are only Flask and Waitress
(`requirements.txt`).

## Commands

- `python -m unittest discover -s tests -t .` — the tests (standard library unittest; Flask's test client). Keep it green.
- `python -m repopulse serve|collect|create-admin|set-password|status` — the command line (`repopulse/__main__.py`).
- `./install.sh [--service] [--port N]`, `.\install.ps1 [-Service] [-OpenFirewall] [-Port N]` — installers.
- `scripts/build-release.sh OUT_DIR VERSION` — the release archives with the version stamped in.
- `scripts/setup-repo.sh` — creates or re-applies the GitHub repository settings, rulesets and security settings.
- Security (`.github/workflows/security.yml`, required checks `Secrets (gitleaks)`, `Code (Semgrep)`,
  `Dependencies`): locally `gitleaks git --redact --log-opts="--full-history --diff-filter=tuxdb --diff-merges=first-parent HEAD" .`,
  `semgrep scan --metrics=off --error --severity WARNING --severity ERROR --config p/python --config p/javascript --config p/security-audit --config p/secrets --config p/github-actions --config r/bash`,
  and `pip-audit -r requirements.txt`. Semgrep false positives: `# nosemgrep: <rule-id>` (Python, shell, YAML) or
  `// nosemgrep: <rule-id>` (JavaScript) on the matched line or the line before it, with a reason.

## Layout

- `repopulse/app.py` — the Flask app and JSON API (`/api/...`), security headers, frontend routes.
- `repopulse/auth.py` — accounts (PBKDF2), sessions with a password fingerprint (`pv`), CSRF, login throttle,
  `is_local_request` for the first-run setup.
- `repopulse/db.py` — SQLite schema, migrations, settings (`DEFAULT_SETTINGS`), `glob_clause` for asset filters.
- `repopulse/collector.py` — the daily collection and the scheduler thread; `github.py` — the GitHub REST client.
- `repopulse/stats.py` — read-side queries for the dashboard and the CSV export.
- `repopulse/static/` — the frontend (ES modules, `markup`` ` templates in `js/util.js`), vendored fonts and Chart.js.
- `install.sh`, `install.ps1` (+ `install.bat`), `run.sh`, `run.bat` — install and start.
- `.github/` — workflows (`ci.yml`, `security.yml`, `release.yml`, `workflow-lint.yml`, `claude.yml`), the rulesets
  (`ruleset-protect-main.json`, `ruleset-protect-release-tags.json`), Dependabot, issue/PR templates, `SECURITY.md`;
  the same set-up as the other dxcufgb repositories. `.coderabbit.yaml` — CodeRabbit path instructions.
- `docs/` — the README's logo and screenshots (made-up example repositories; not part of the release archives).

## Conventions

- Match the surrounding style; standard library first, no new runtime dependency without a good reason.
- Never commit `config.json`, `data/` (database, `secret.key`), `.venv/` or tokens.
- Main is protected (`.github/ruleset-protect-main.json`): changes go through pull requests, squash-merged, with the
  required checks green. Keep the CI job names and the ruleset in step.
- Releases: Actions → Release → Run workflow → type the version. The version in `repopulse/__init__.py` is not
  bumped by hand; the build stamps it. Release file names are fixed (`scripts/build-release.sh`).
- Behaviour changes need tests and a README update.

## Review focus

- **Admin API**: every `/api/admin/` route has `@auth.admin_required`; changes need the `X-CSRF-Token` header.
  Changing a password ends every other session (`pw_fingerprint`). Request bodies are user input.
- **First-run setup** is allowed only from the server itself (`is_local_request`) unless `allow_remote_setup`;
  forwarded headers count only with `behind_proxy` (ProxyFix).
- **The GitHub token** stays on the server: never in a response (only `github_token_hint`), a log line or a URL; it
  goes only to the configured API URL as the Authorization header.
- **SQL** uses `?` parameters; the few formatted statements use fixed column names (annotated for Semgrep).
- **Frontend**: values go into HTML only through `markup`` ` (escaped) or `esc()`; the CSP allows only 'self'
  (plus GitHub avatars); nothing is loaded from the internet.
- **Repository names** from users pass `parse_repo` (no `.`/`..`), owners `^[A-Za-z0-9-]{1,39}$`.
- CI runs the tests on Python 3.9 and 3.13 (Linux and Windows), shellcheck, PSScriptAnalyzer, real installs with
  install.sh --service and install.ps1 -Service, and the release build. Avoid Python features newer than 3.9.
