#!/usr/bin/env bash
# Creates the GitHub repository for RepoPulse (or re-applies its settings) with the same rules as the other dxcufgb
# repositories: commits what is not committed yet to main, creates the repository, pushes main, then applies the
# repository and security settings, the rulesets in .github/ (protected main: pull requests, squash merge, required
# checks; protected release tags) and starts the Release workflow. Safe to re-run: every step checks what is there.
#
#   scripts/setup-repo.sh [--owner dxcufgb] [--repo RepoPulse] [--private] [--release 1.1.0 | --no-release]
#                         [--yes] [--dry-run]
#
#   --private      create a private repository (default public; CodeQL and secret scanning are free only on public
#                  ones). An existing repository keeps its visibility unless --public or --private is given.
#   --release V    version of the first release (default: __version__ in repopulse/__init__.py); --no-release skips it
#   --yes          do not ask before committing
#   --dry-run      show what would change, change nothing (the read-only GitHub lookups still run)
#
# Needs git and the GitHub CLI (https://cli.github.com), logged in as the owner with the repo and workflow scopes:
#   gh auth login --scopes repo,workflow
# Optional: CLAUDE_CODE_OAUTH_TOKEN in the environment is stored as the repository secret of the same name (Claude
# reviews, .github/workflows/claude.yml); gitleaks on PATH scans the commits before anything is pushed.
# Works in Git Bash on Windows too. Run it from anywhere inside the RepoPulse folder.
set -euo pipefail

OWNER="dxcufgb"
REPO="RepoPulse"
VISIBILITY="public"
VISIBILITY_GIVEN=0
RELEASE=""
DO_RELEASE=1
YES=0
DRY=0
DESCRIPTION="Self-hosted dashboard of GitHub release download counts: collects them every day, keeps the history in SQLite and shows charts and tables on a public page, with an admin area to pick repositories and arrange widgets."
TOPICS=(github github-releases download-statistics dashboard self-hosted flask python sqlite)
COMMIT_MESSAGE="Repository setup: CI, security scans, release workflow, rulesets and tests"

die() { echo "Error: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
# Commands that change something go through run, so --dry-run can show them instead.
run() {
  if [[ $DRY -eq 1 ]]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="${2:?--owner needs a value}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --private) VISIBILITY="private"; VISIBILITY_GIVEN=1; shift ;;
    --public) VISIBILITY="public"; VISIBILITY_GIVEN=1; shift ;;
    --release) RELEASE="${2:?--release needs a version}"; shift 2 ;;
    --no-release) DO_RELEASE=0; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
[[ "$OWNER" =~ ^[A-Za-z0-9-]{1,39}$ ]] || die "'$OWNER' is not a GitHub user or organisation name"
[[ "$REPO" =~ ^[A-Za-z0-9._-]{1,100}$ && "$REPO" != "." && "$REPO" != ".." ]] || die "'$REPO' is not a repository name"
FULL="$OWNER/$REPO"
URL="https://github.com/$FULL.git"

command -v git >/dev/null || die "git is required"
command -v gh >/dev/null || die "the GitHub CLI (gh) is required: https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "log in first: gh auth login --scopes repo,workflow"
# A classic token lists its scopes; pushing .github/workflows/ needs "workflow". (Fine-grained tokens list none.)
SCOPES="$(gh api -i user 2>/dev/null | tr -d '\r' | sed -n 's/^[Xx]-[Oo][Aa]uth-[Ss]copes: //p' || true)"
if [[ -n "$SCOPES" && ",$(tr -d ' ' <<<"$SCOPES")," != *",workflow,"* ]]; then
  die "the gh login lacks the workflow scope (needed to push .github/workflows): gh auth refresh --scopes workflow"
fi
# git uses gh's login for this push only; the global git configuration is not changed.
GIT_GH=(git -c credential.helper= -c "credential.helper=!gh auth git-credential")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f repopulse/__init__.py && -f requirements.txt ]] || die "$ROOT does not look like the RepoPulse folder"
for f in .github/workflows/ci.yml .github/workflows/security.yml .github/workflows/release.yml \
         .github/ruleset-protect-main.json .github/ruleset-protect-release-tags.json; do
  [[ -f "$f" ]] || die "$f is missing: the .github folder (workflows and rulesets) has to be in place first"
done
VERSION_IN_CODE="$(tr -d '\r' < repopulse/__init__.py | sed -n 's/^__version__ = "\(.*\)"$/\1/p')"
RELEASE="${RELEASE:-$VERSION_IN_CODE}"
RELEASE="${RELEASE#v}"
if [[ $DO_RELEASE -eq 1 && ! "$RELEASE" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  die "'$RELEASE' is not a version like 1.2.3"
fi

# What is on GitHub already (read-only): the repository and its rulesets.
EXISTS=0
MAIN_RULESET_ID=""
TAG_RULESET_ID=""
if gh repo view "$FULL" --json name >/dev/null 2>&1; then
  EXISTS=1
  RULESETS="$(gh api "repos/$FULL/rulesets" --jq '.[] | "\(.id)\t\(.name)"' 2>/dev/null || true)"
  MAIN_RULESET_ID="$(awk -F'\t' 'tolower($2) == "protect main" {print $1; exit}' <<<"$RULESETS")"
  TAG_RULESET_ID="$(awk -F'\t' 'tolower($2) == "protect release tags" {print $1; exit}' <<<"$RULESETS")"
fi

# --- 1. The local repository: main, with everything committed ----------------------------------------------------
say "1/7  Local repository ($ROOT)"
TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$TOP" ]]; then
  echo "No git repository yet: creating one with the branch main"
  run git init -q -b main
elif [[ "$(cd "$TOP" && pwd -P)" != "$(pwd -P)" ]]; then
  die "$ROOT is inside another git repository ($TOP); give RepoPulse its own folder"
fi
if [[ $DRY -eq 0 || -d .git ]]; then
  BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
  if [[ "$BRANCH" != "main" ]]; then
    if git rev-parse --verify -q refs/heads/main >/dev/null; then
      die "you are on '$BRANCH', not main: git switch main (and merge what should go in) first"
    fi
    echo "Renaming the branch '$BRANCH' to main"
    run git branch -M main
  fi
fi

# What must never go into the repository, whatever .gitignore says.
FORBIDDEN='^(config\.json|data/|\.venv/|venv/|.*\.db(-wal|-shm)?$|.*secret\.key$|\.env$|.*\.pem$|.*\.key$)'
CANDIDATES="$( { git ls-files 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u)"
if BAD="$(grep -E "$FORBIDDEN" <<<"$CANDIDATES")"; then
  awk '{print "  " $0}' <<<"$BAD" >&2
  die "these files hold local configuration, data or keys and must not be committed: untrack them (git rm --cached) and check .gitignore"
fi

PENDING="$(git status --porcelain --untracked-files=all 2>/dev/null || true)"
HAS_COMMIT=0
git rev-parse --verify -q HEAD >/dev/null 2>&1 && HAS_COMMIT=1
if [[ -n "$PENDING" && -n "$MAIN_RULESET_ID" ]]; then
  echo "main is protected on GitHub, so these changes are left uncommitted (put them on a branch and open a pull request):"
  awk '{print "  " $0}' <<<"$PENDING"
elif [[ -n "$PENDING" ]]; then
  if [[ $HAS_COMMIT -eq 0 ]]; then MESSAGE="RepoPulse $VERSION_IN_CODE"; else MESSAGE="$COMMIT_MESSAGE"; fi
  echo "Not committed yet ($(wc -l <<<"$PENDING" | tr -d ' ') files):"
  awk '{print "  " $0}' <<<"$PENDING"
  if [[ $YES -eq 0 && $DRY -eq 0 ]]; then
    read -r -p "Commit all of these to main as \"$MESSAGE\"? [y/N] " answer
    [[ "$answer" =~ ^[Yy] ]] || die "stopped; nothing was changed"
  fi
  run git add -A
  # Windows does not record the executable bit (core.filemode=false): set it in the index for the shell scripts.
  if [[ $DRY -eq 0 ]]; then
    git ls-files -z -- '*.sh' | xargs -0 -r git update-index --chmod=+x --
  fi
  run git commit -q -m "$MESSAGE"
elif [[ $HAS_COMMIT -eq 0 ]]; then
  die "nothing to commit and no commits: is this the right folder?"
else
  echo "Everything is committed ($(git log -1 --format='%h %s'))"
fi

if ! command -v gitleaks >/dev/null; then
  echo "gitleaks is not installed: skipping the local secret scan (the Security workflow scans every push)"
elif [[ $DRY -eq 1 && -n "$PENDING" ]]; then
  echo "  [dry-run] gitleaks git (after the commit)"
else
  echo "Scanning the commits for secrets (gitleaks)"
  gitleaks git --redact --no-banner --log-opts="--full-history HEAD" . || die "gitleaks found a possible secret; nothing was pushed"
fi

# --- 2. The GitHub repository and main ----------------------------------------------------------------------------
say "2/7  GitHub repository $FULL"
if [[ $EXISTS -eq 1 ]]; then
  echo "$FULL already exists"
else
  echo "Creating $FULL ($VISIBILITY)"
  run gh repo create "$FULL" "--$VISIBILITY" --description "$DESCRIPTION"
fi
if git remote get-url origin >/dev/null 2>&1; then
  [[ "$(git remote get-url origin)" == "$URL" ]] || run git remote set-url origin "$URL"
else
  run git remote add origin "$URL"
fi

REMOTE_MAIN="$("${GIT_GH[@]}" ls-remote "$URL" refs/heads/main 2>/dev/null | cut -f1 || true)"
LOCAL_MAIN="$(git rev-parse -q --verify refs/heads/main 2>/dev/null || echo "(new commit)")"
if [[ -z "$REMOTE_MAIN" ]]; then
  echo "Pushing main (before the rulesets, which then only allow pull requests)"
  run "${GIT_GH[@]}" push -u origin main
elif [[ "$REMOTE_MAIN" == "$LOCAL_MAIN" ]]; then
  echo "main on GitHub is up to date ($REMOTE_MAIN)"
elif [[ -n "$MAIN_RULESET_ID" ]]; then
  echo "main on GitHub differs from your main and is protected: push a branch and open a pull request instead:"
  echo "  git switch -c my-change && git push -u origin my-change && gh pr create --fill"
elif git merge-base --is-ancestor "$REMOTE_MAIN" main 2>/dev/null; then
  echo "Pushing the new commits on main"
  run "${GIT_GH[@]}" push -u origin main
else
  die "main on GitHub has commits that your main does not have: git pull --rebase origin main, then run this again"
fi

# --- 3. Repository settings (the same as the other dxcufgb repositories) -----------------------------------------
say "3/7  Repository settings"
EDIT_ARGS=()
for t in "${TOPICS[@]}"; do EDIT_ARGS+=(--add-topic "$t"); done
if [[ $EXISTS -eq 1 && $VISIBILITY_GIVEN -eq 1 ]]; then
  EDIT_ARGS+=(--visibility "$VISIBILITY" --accept-visibility-change-consequences)
fi
run gh repo edit "$FULL" \
  --description "$DESCRIPTION" \
  --default-branch main \
  --enable-issues --enable-projects --enable-wiki=false \
  --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false \
  --enable-auto-merge=false --delete-branch-on-merge \
  "${EDIT_ARGS[@]}"
# squash commits are titled and described from the pull request; "Update branch" is offered on pull requests
run gh api -X PATCH "repos/$FULL" --silent -F allow_update_branch=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
# Actions may run, use any action (they are pinned by commit in the workflows), and GITHUB_TOKEN is read-only by
# default (each workflow asks for what it needs) and cannot approve pull requests.
run gh api -X PUT "repos/$FULL/actions/permissions" --silent -F enabled=true -f allowed_actions=all
run gh api -X PUT "repos/$FULL/actions/permissions/workflow" --silent \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# --- 4. Security: secret scanning + push protection, Dependabot alerts and fixes, private vulnerability reports,
#        CodeQL default setup. Some of these need a public repository (or GitHub Advanced Security).
say "4/7  Security settings"
warn_failed() { echo "  could not $1 (on a private repository this needs GitHub Advanced Security)"; }
if [[ $DRY -eq 1 ]]; then
  run gh api -X PATCH "repos/$FULL" --input '{"security_and_analysis": {secret_scanning, secret_scanning_push_protection: enabled}}'
else
  gh api -X PATCH "repos/$FULL" --silent --input - <<'JSON' || warn_failed "turn on secret scanning"
{"security_and_analysis": {"secret_scanning": {"status": "enabled"}, "secret_scanning_push_protection": {"status": "enabled"}}}
JSON
fi
run gh api -X PUT "repos/$FULL/vulnerability-alerts" --silent || warn_failed "turn on Dependabot alerts"
run gh api -X PUT "repos/$FULL/automated-security-fixes" --silent || warn_failed "turn on Dependabot security updates"
run gh api -X PUT "repos/$FULL/private-vulnerability-reporting" --silent || warn_failed "turn on private vulnerability reporting"
run gh api -X PATCH "repos/$FULL/code-scanning/default-setup" --silent -f state=configured -f query_suite=default \
  || warn_failed "turn on CodeQL default setup"

# --- 5. Rulesets: protected main and release tags (.github/ruleset-*.json) ----------------------------------------
say "5/7  Rulesets"
apply_ruleset() { # name, existing id, file
  if [[ -n "$2" ]]; then
    echo "Updating ruleset '$1' ($2)"
    run gh api -X PUT "repos/$FULL/rulesets/$2" --silent --input "$3"
  else
    echo "Creating ruleset '$1'"
    run gh api -X POST "repos/$FULL/rulesets" --silent --input "$3"
  fi
}
apply_ruleset "Protect main" "$MAIN_RULESET_ID" .github/ruleset-protect-main.json
apply_ruleset "Protect release tags" "$TAG_RULESET_ID" .github/ruleset-protect-release-tags.json

# --- 6. Secrets for the workflows -------------------------------------------------------------------------------------
say "6/7  Workflow secrets"
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "Storing CLAUDE_CODE_OAUTH_TOKEN (from the environment) as a repository secret"
  if [[ $DRY -eq 1 ]]; then
    run gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$FULL" "<from the environment>"
  else
    printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$FULL"
  fi
elif gh secret list --repo "$FULL" 2>/dev/null | grep -q '^CLAUDE_CODE_OAUTH_TOKEN\b'; then
  echo "CLAUDE_CODE_OAUTH_TOKEN is set"
else
  echo "CLAUDE_CODE_OAUTH_TOKEN is not set: Claude reviews stay off until you run"
  echo "  claude setup-token   and then   gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo $FULL"
fi

# --- 7. First release ---------------------------------------------------------------------------------------------------
say "7/7  Release"
if [[ $DO_RELEASE -eq 0 ]]; then
  echo "Skipped (--no-release). Later: Actions -> Release -> Run workflow, or gh workflow run release.yml -f version=X.Y.Z"
elif gh release view "v$RELEASE" --repo "$FULL" >/dev/null 2>&1; then
  echo "Release v$RELEASE already exists"
else
  echo "Starting the Release workflow for $RELEASE: it runs the whole CI, builds the archives and publishes v$RELEASE"
  echo "when everything passed (about 10 minutes). Follow it with: gh run watch --repo $FULL"
  if [[ $DRY -eq 0 ]]; then
    # a just-pushed workflow file can take a moment to be registered
    for attempt in 1 2 3 4 5 6; do
      if gh workflow run release.yml --repo "$FULL" --ref main -f "version=$RELEASE" 2>/dev/null; then break; fi
      [[ $attempt -eq 6 ]] && die "could not start the Release workflow; start it under Actions -> Release"
      sleep 10
    done
  else
    run gh workflow run release.yml --repo "$FULL" --ref main -f "version=$RELEASE"
  fi
fi

echo
echo "Done: https://github.com/$FULL"
[[ $DRY -eq 1 ]] && echo "(dry run: nothing was changed)"
exit 0
