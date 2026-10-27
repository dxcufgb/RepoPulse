# RepoPulse

A small self-hosted dashboard that tracks how often the releases of your GitHub
repositories are downloaded. It collects the numbers once a day, keeps the
history in a single SQLite file, and shows it on a public page with charts and
tables. An admin area behind a login lets you add or remove repositories and
build the dashboard from widgets.

Runs on Windows and Linux (including a Raspberry Pi) with Python 3.9 or newer.
Nothing is loaded from the internet by the page itself: fonts and Chart.js are
included.

## What you get

- **Public dashboard** with a range switch (7 days to all time), CSV download,
  light and dark theme, and a layout that works on phones.
- **Widgets you can arrange:** headline total with a daily pulse, single numbers
  (new downloads, downloads per day, stars, forks, most downloaded repository…),
  line, area and bar charts over time (per day, week or month, per repository or
  combined), per-repository bars or ring charts, per-release charts for one
  repository, sortable tables, and text notes. Every chart can switch to a
  table view.
- **A page per repository** with downloads per release tag, how each release is
  picked up over time, downloads per file and more. Click any repository on the
  dashboard to open it.
- **Admin area** (login required): add repositories by name or link, browse
  all public repositories of a user or organisation and pick several at once,
  rename and recolour them, pause collection, hide them from the public page,
  choose which release files count, reorder them, run a collection by hand,
  see the collection log, change the collection time, GitHub token and password.

## Install

### Windows

1. Install Python 3.9+ from <https://www.python.org/downloads/> and tick
   **Add python.exe to PATH** in the installer.
2. Unzip RepoPulse somewhere permanent, for example `C:\RepoPulse`.
3. Double-click **install.bat**. It creates a private Python environment in
   `.venv`, installs the two dependencies (Flask and Waitress), creates
   `config.json` and asks for an admin username and password.
4. Double-click **run.bat** and open <http://localhost:8080/>.

To start RepoPulse automatically with Windows (runs in the background through
Task Scheduler), open PowerShell **as administrator** in the folder and run:

```powershell
.\install.ps1 -Service -OpenFirewall     # -OpenFirewall lets other computers reach it
.\install.ps1 -RemoveService             # undo
```

### Linux / Raspberry Pi

```bash
sudo apt install python3 python3-venv     # Debian, Ubuntu, Raspberry Pi OS
cd repopulse
./install.sh                # environment, config.json, admin account
./run.sh                    # start in the foreground
```

To run it as a background service that starts at boot:

```bash
./install.sh --service           # installs and starts repopulse.service (asks for sudo)
journalctl -u repopulse -f       # logs
./install.sh --remove-service    # undo
```

Use `--port 9000` with either installer to pick another port than 8080.

## First steps

1. Open `/admin` and log in. If you skipped the admin account during install,
   open `http://localhost:8080/admin` **on the server itself** to create it (for
   safety this is refused from other machines), or run
   `python -m repopulse create-admin`.
2. Under **Repositories**, paste repositories (`owner/name` or GitHub links,
   one per line) or use **Browse a user or organisation**. They are collected
   straight away.
3. Under **Settings**, add a GitHub token (optional but recommended) and pick
   the time of the daily collection.
4. Under **Dashboard layout**, choose **Edit layout** to add, edit, reorder
   (drag the grip or use the arrows), duplicate and remove widgets, then
   **Save layout**. A starter layout is used until you save your own.

## Repository pages

Every repository has its own page at `/repo/<owner>/<name>`. Open it by
clicking the repository in a table, a chart legend, a bar or a ring slice, or
with the repository menu at the top of any repository page. It shows:

- a header with the name, description, total and new downloads, stars, forks,
  newest release and a pulse of new downloads per day;
- downloads per release tag, as bars or a table;
- **releases over time**: how each release tag is picked up, day by day, which
  shows how quickly people move to a new version;
- **downloads per file**, including which files count towards the totals;
- the running total over time and a full release list.

The widgets are the same kind as on the overview, plus three that only make
sense for one repository (repository header, releases over time, files). On a
repository page every widget automatically shows the repository being viewed.

**Editing them:** in the admin area, open **Dashboard layout** and pick a
repository from **Open a repository page**, or click **Page** next to a
repository under **Repositories**. Choose **Edit repository pages**, change the
widgets, then:

- **Save for all repositories** sets the layout every repository page shares;
- **Save for &lt;repository&gt; only** gives that one repository its own layout
  (marked "own page layout" in the repository list). **Use the shared layout**
  removes it again.

Until you save anything, repository pages use a starter layout.

## How the numbers work

- GitHub reports, for every file attached to a release, a running total of
  downloads. RepoPulse stores those totals per file per day; *new downloads* on a
  day is the difference from the previous collection. If the server was off for a
  few days, the difference is spread evenly over those days.
- History starts the day a repository is added; GitHub doesn't provide past
  daily numbers. The total itself (all downloads since the release was
  published) is right from day one.
- Only release assets are counted. Clones, source-code archives (the automatic
  "Source code (zip)" links) and package registries are not part of GitHub's
  download counts.
- **Counting only some files:** a repository's *Files to count* setting takes
  patterns such as `*.zip`, `module.zip, *.exe`, or exclusions such as
  `!module.json`. Changing it recalculates the whole history. For FoundryVTT
  modules, `*.zip` is usually what you want: the `module.json` manifest is
  typically fetched on every update check, which inflates its count.

## GitHub token

Without a token GitHub allows 60 API requests per hour per IP address, which is
about 30 repositories per collection (two requests each). With a token it is 5,000 per hour, and
private repositories become readable. A fine-grained personal access token with
read-only access to public repositories is enough
(GitHub → Settings → Developer settings → Personal access tokens). The token is
stored in the database on your server and never sent to the browser.

## Configuration

`config.json` holds the server settings (everything else is edited in the admin
area). Each value can also be set with an environment variable such as
`REPOPULSE_PORT=9000`.

| Setting | Default | Meaning |
|---|---|---|
| `host` | `0.0.0.0` | Network address to listen on. `127.0.0.1` = this computer only. |
| `port` | `8080` | Port number. |
| `data_dir` | `data` | Folder for the database and the session key. |
| `behind_proxy` | `false` | Set to `true` behind nginx, Caddy, IIS or similar so client addresses and https are detected. |
| `secure_cookies` | `false` | Set to `true` when the site is served over https. |
| `allow_remote_setup` | `false` | Allow creating the first admin account from another computer. |
| `github_api_url` | `https://api.github.com` | Change for GitHub Enterprise Server. |
| `threads` | `8` | Web server worker threads. |

If the dashboard is reachable from the internet, put it behind a reverse proxy
with https and set `behind_proxy` and `secure_cookies` to `true`. Example for
Caddy: `stats.example.com { reverse_proxy localhost:8080 }`.

## Command line

Run these in the RepoPulse folder with `.venv/bin/python` (Linux) or
`.venv\Scripts\python` (Windows):

```
python -m repopulse serve [--port 9000] [--no-scheduler]
python -m repopulse collect          # collect now, e.g. from cron
python -m repopulse create-admin
python -m repopulse set-password     # also the way to reset a forgotten password
python -m repopulse status
```

## Data and backups

Everything lives in `data/repopulse.db` (plus `data/secret.key`, which signs
login sessions). Copy the `data` folder to back up; the admin Settings page and
the public dashboard also offer a CSV export.

## Updating

Stop RepoPulse, replace the program files (keep `data/` and `config.json`),
run the installer again, start it.

## Security notes

- Passwords are hashed (PBKDF2-SHA256, 600,000 rounds). Five failed logins from
  one address lock that address out for five minutes.
- Admin requests need both the session cookie and a CSRF token; the page sends a
  strict Content-Security-Policy.
- The public dashboard can be switched off in Settings, which puts the whole
  page behind the login.

## Licences

Included third-party files: Chart.js (MIT,
`repopulse/static/vendor/chart.js.LICENSE.md`), Bricolage Grotesque and
Instrument Sans (SIL Open Font License, `repopulse/static/fonts/`).
