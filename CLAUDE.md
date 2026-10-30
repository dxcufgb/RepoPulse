# RepoPulse

Self-hosted dashboard of GitHub release download counts: a Flask app served by Waitress, one SQLite file, a
single-page frontend without a build step. Python 3.9+; runtime dependencies are only Flask and Waitress
(`requirements.txt`).

## Commands

- `python -m unittest discover -s tests -t .` — the tests (standard library unittest; Flask's test client). Keep it green.
- `python -m repopulse [--config FILE] serve|collect|create-admin|set-password|status|...` — the command line
  (`repopulse/__main__.py`); installed: `sudo repopulse ...` (Linux), `repopulse.cmd ...` (Windows).
- `sudo ./install.sh [--yes] [--port N] [--auto-update] [--migrate-from DIR] [--uninstall [--purge]]` — the Linux
  server install (systemd); `packaging/windows/build-setup.ps1 -Version X.Y.Z` — the Windows installer (Inno Setup).
- `scripts/build-release.sh OUT_DIR VERSION` — the Linux release archive with the version stamped in.
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
- `repopulse/appearance.py` — the page-wide look (Admin, Appearance); same option lists as `static/js/appearance.js`.
- `repopulse/updater.py` — standalone (standard library only) release check/download/verify, run by root/SYSTEM with
  `-I`; never import RepoPulse in it. `auto-update.sh` / `packaging/windows/auto-update.ps1` — the update itself
  (backup of the program folder, the release's own `install.sh --yes` / `setup.exe /VERYSILENT`, answer check,
  rollback). `repopulse/updates.py` — what the server knows (set up?, Update now request, Check for update).
  `repopulse/notify.py` — update e-mails (smtplib) and the recorded result (`update-event` command).
- `repopulse/static/` — the frontend (ES modules, `markup`` ` templates in `js/util.js`), vendored fonts and Chart.js.
- `install.sh` — the Linux installer: `/opt/repopulse` (root), `/etc/repopulse/config.json` (root:repopulse 640),
  `/var/lib/repopulse` (the `repopulse` user), `/usr/local/bin/repopulse`, a sandboxed `repopulse.service`; moves the
  data of an older run-from-a-folder install (`find_old_installs`, read as the folder's owner, never as root).
- `packaging/windows/` — `RepoPulse.iss` (Inno Setup wizard, `C:\Program Files\RepoPulse`), `build-setup.ps1` (stages
  the program with the embeddable Python and Windows wheels in `lib\`), `install.ps1` (run by the setup: settings and
  data in `C:\ProgramData\RepoPulse` with ACLs, the `RepoPulse` task as LOCAL SERVICE, migration, firewall,
  uninstall), `auto-update.ps1`, `repopulse.cmd`.
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
  Sessions live in the `sessions` table too (only the SHA-256 of the cookie's `sid`): logout deletes the row
  (`auth.end_session`), a password change deletes the account's other rows and changes `pv`. Request bodies are
  user input.
- **First-run setup** is allowed only from the server itself (`is_local_request`: loopback peer, loopback Host header,
  no proxy headers) unless `allow_remote_setup`; forwarded headers count only with `behind_proxy` and only from
  loopback or `trusted_proxies` (`auth.TrustedProxyFix`). Sessions are checked with `auth.logged_in_user()` (`pv`).
- **Installers and automatic updates**: on Linux root must never run or parse files the service account can change:
  the program and settings belong to root, the service writes only `/var/lib/repopulse`, the updater runs from
  `/usr/local/lib/repopulse-update/` with the system Python, and `update-event` runs as `repopulse`. Files of an older
  install are read as their owner. On Windows LOCAL SERVICE may write only `ProgramData\RepoPulse\data` and start
  only `RepoPulse-UpdateNow`. Only strictly newer, checksum-verified final releases; settings and data are never
  replaced. Secrets (admin password, tokens, SMTP password) come from the environment, never from arguments or logs.
- **The GitHub token** stays on the server: never in a response (only `github_token_hint`), a log line or a URL; it
  goes only to the configured API URL as the Authorization header.
- **SQL** uses `?` parameters; the few formatted statements use fixed column names (annotated for Semgrep).
- **Frontend**: values go into HTML only through `markup`` ` (escaped) or `esc()`; the CSP allows only 'self'
  (plus GitHub avatars); nothing is loaded from the internet.
- **Repository names** from users pass `parse_repo` (no `.`/`..`), owners `^[A-Za-z0-9-]{1,39}$`.
- CI runs the tests on Python 3.9 and 3.13 (Linux and Windows), shellcheck, PSScriptAnalyzer, real installs (the
  release archive's install.sh under systemd and the Inno Setup installer, each moving an older install's data,
  upgrading and uninstalling), and the release build. Avoid Python features newer than 3.9. Release file names
  (`repopulse-X.Y.Z-linux.tar.gz`, `repopulse-X.Y.Z-setup.exe`, `SHA256SUMS.txt`) are read by the updater and the
  dxcufgb/install one-line installer: do not rename them.
