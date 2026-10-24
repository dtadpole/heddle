#!/bin/sh
# Move the deployment checkout to the fetched origin/main, rebuild it, restart its service, and judge it.
#
#   ./redeploy.sh                 redeploy this checkout when origin/main has moved; judge it either way
#   ./redeploy.sh --check         say whether the deployment is behind origin/main, and change nothing
#   ./redeploy.sh --repo DIR ...  act on the deployment checkout DIR instead of the one this script lives in
#   ./redeploy.sh --force         rebuild and restart even when no file the server loads at start changed
#
# Exit 0 when the deployment is at origin/main and 96-deployment holds, 1 when a step or the verifier failed, 2 when
# it refused to start (an edited checkout), 10 from --check when the deployment is behind.
#
# **Why a script.** Every redeploy tonight was the same five commands, and both outages came from running them in a
# different order: an install from a checkout behind a freshly fetched origin/main (the installer refused after it had
# stopped the service), and measurements on the live agent. This is the one order, written down so it is the only one:
# fetch, move the checkout, build, install **with the installer from the new checkout**, wait for the port, judge it
# with that checkout's own 96-deployment. 95's stays-up check is not run here: it kills the server (D-042), and it is
# judged on a scratch agent by rehearse.sh.
set -eu

if [ -z "${HEDDLE_REDEPLOY_COPY:-}" ]; then
  # `git checkout` replaces this very file while the shell is still reading it, so run from a private copy.
  here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  copy=$(mktemp "${TMPDIR:-/tmp}/heddle-redeploy.XXXXXX")
  cp "$0" "$copy"
  HEDDLE_REDEPLOY_COPY="$copy" HEDDLE_REDEPLOY_HOME="$here" exec sh "$copy" "$@"
fi
trap 'rm -f "$HEDDLE_REDEPLOY_COPY"' EXIT

repo=$(CDPATH= cd -- "$HEDDLE_REDEPLOY_HOME/../.." && pwd)
check=no
force=no
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check=yes ;;
    --repo)
      [ $# -ge 2 ] || { echo "redeploy.sh: --repo needs a directory" >&2; exit 2; }
      repo=$(CDPATH= cd -- "$2" && pwd)
      shift
      ;;
    --force) force=yes ;;
    --help|-h) sed -n '2,9p' "$HEDDLE_REDEPLOY_COPY" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "redeploy.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

port="${HEDDLE_WEB_PORT:-3082}"
say() { printf 'redeploy: %s\n' "$*"; }
git_at() { git -C "$repo" "$@"; }

git_at rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "redeploy.sh: $repo is not a git checkout" >&2; exit 2; }
dirty=$(git_at status --porcelain)
if [ -n "$dirty" ]; then
  # A deployment is never edited, so a change in it is somebody's work or an accident; either way not ours to discard.
  echo "redeploy.sh: $repo has uncommitted changes; a deployment checkout is never edited, so nothing was changed:" >&2
  printf '%s\n' "$dirty" | head -5 >&2
  exit 2
fi

git_at fetch --quiet origin
tip=$(git_at rev-parse refs/remotes/origin/main)
head=$(git_at rev-parse HEAD)
short() { printf '%s' "$1" | cut -c1-7; }

if [ "$check" = yes ]; then
  if [ "$head" = "$tip" ]; then say "current at $(short "$tip")"; exit 0; fi
  behind=$(git_at rev-list --count "$head..$tip")
  say "behind: deployment $(short "$head"), origin/main $(short "$tip") ($behind commits)"
  exit 10
fi

if [ "$head" = "$tip" ]; then
  say "already at origin/main $(short "$tip"); judging it"
else
  # Which changed files make the running server stale. The server loads its build (dist/, from src/ and the package
  # files), the root configuration layers and, through the agent, the supervisor and the definition the installer
  # renders from its templates — all of them at start. The paths below are the ones it never loads at start: the Rust
  # port, verifiers, records, other tools, docs, and the rest of this tool (preview.sh, rehearse.sh, this script, the
  # guard, the tests). Only a move made entirely of those skips the rebuild and the restart; anything else, or a
  # missing build, takes the full path. Every restart mints a new launch token, so the owner's link stops working:
  # measured 2026-10-23, a preview.sh-only merge restarted the live server for nothing.
  stale=$(git_at diff --name-only "$head" "$tip" | awk '
    /^(rust|_verifiers_|_context_|_skills_|_conventions_|_logs_|test)\// { next }
    /^_tools_\/web-daemon\/(supervisor\.mjs|install\.sh|heddle-web\.plist\.template|heddle-web\.service\.template)$/ { print; next }
    /^_tools_\// { next }
    /^src\// { print; next }
    /\.md$/ { next }
    NF { print }
  ')
  if [ "$force" = no ] && [ -z "$stale" ] && [ -f "$repo/dist/cli.js" ] && [ -z "${HEDDLE_BIN:-}" ]; then
    say "moving $(short "$head") -> $(short "$tip"); nothing the server loads at start changed, so no rebuild or restart"
    git_at checkout --quiet --detach "$tip"
    restart=no
  else
    restart=yes
  fi
fi

if [ "$head" != "$tip" ] && [ "$restart" = yes ]; then
  say "moving $(short "$head") -> $(short "$tip")"
  git_at checkout --quiet --detach "$tip"
  if [ -z "${HEDDLE_BIN:-}" ]; then
    # The TypeScript build. With HEDDLE_BIN the binary is built in a lane and serves src/server/page.html directly.
    (cd "$repo" && npm ci --no-audit --no-fund --silent && npm run --silent build) || { echo "redeploy.sh: the build failed at $(short "$tip"); the service still runs the previous build" >&2; exit 1; }
  fi
  # The installer from the new checkout: its rules are main's, and it renders before it stops anything.
  sh "$repo/_tools_/web-daemon/install.sh" --restart >/dev/null || { echo "redeploy.sh: install.sh refused or failed; see its message above" >&2; exit 1; }
fi

waited=0
until curl -fsS -m 1 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; do
  waited=$((waited + 1))
  [ "$waited" -ge 40 ] && { echo "redeploy.sh: port $port did not answer within 20 s" >&2; exit 1; }
  sleep 0.5
done

verdict_json=$(sh "$repo/_verifiers_/96-deployment/verify.sh" --json 2>/dev/null | tail -1 || true)
verdict=$(printf '%s' "$verdict_json" | sed -n 's/.*"verdict":\([0-9]\).*/\1/p')
counts=$(printf '%s' "$verdict_json" | sed -n 's/.*"tests":\([0-9]*\),"pass":\([0-9]*\).*/\2\/\1/p')
if [ "$verdict" = 0 ]; then
  say "deployment at $(short "$tip"), port $port answering, 96-deployment ${counts:-?} held"
  exit 0
fi
say "deployment at $(short "$tip"), port $port answering, 96-deployment verdict ${verdict:-none} (${counts:-?})"
exit 1
