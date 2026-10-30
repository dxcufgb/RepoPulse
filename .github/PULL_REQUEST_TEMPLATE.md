## What changed

<!-- One or two sentences on what this does and why. -->

## Checked

- [ ] `python -m unittest discover -s tests -t .` passes
- [ ] `shellcheck install.sh auto-update.sh scripts/*.sh` is clean (if a shell script changed)
- [ ] Tried on a real machine: Linux (`sudo ./install.sh`) / Windows (`repopulse-setup.exe`, built by `packaging\windows\build-setup.ps1`) (if an installer changed)
- [ ] README and CLAUDE.md updated if behaviour, settings, the API, the installers or the release process changed
- [ ] New `/api/admin/` routes have `@auth.admin_required`; values reach the page only through `markup` or `esc()`
- [ ] Nothing here lets the GitHub token reach a response, a log line, a URL or any host other than the configured API
