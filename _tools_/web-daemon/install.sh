#!/bin/sh
# Install, inspect or remove the heddle Web UI as a launchd user agent.
#
#   ./install.sh            write the agent for this machine and load it
#   ./install.sh --status   say whether it is loaded and whether the port answers
#   ./install.sh --restart  unload and load it again
#   ./install.sh --uninstall  unload it and remove the file
#
# The file is written into ~/Library/LaunchAgents, which the account owns, so none of this needs sudo.
# Every step is idempotent: running it twice leaves one agent, and the paths it fills in come from the
# machine it runs on rather than from the repository.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
label="com.dtadpole.heddle-web"
port="${HEDDLE_WEB_PORT:-3082}"
target="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/.heddle/web.log"
domain="gui/$(id -u)"

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

node_bin() {
  # The real binary, not the Volta shim: launchd has no shell to resolve a shim through.
  if [ -n "${HEDDLE_NODE:-}" ] && [ -x "$HEDDLE_NODE" ]; then printf '%s' "$HEDDLE_NODE"; return; fi
  resolved=$(command -v node || true)
  if [ -n "$resolved" ]; then
    real=$(readlink -f "$resolved" 2>/dev/null || true)
    # volta-shim is a wrapper; the interpreter it runs is what a launchd job must exec.
    case "${real:-$resolved}" in
      *volta-shim*|*volta/bin/node)
        image=$(ls -d "$HOME"/.volta/tools/image/node/*/bin/node 2>/dev/null | tail -1 || true)
        [ -n "$image" ] && printf '%s' "$image" && return
        ;;
    esac
    printf '%s' "${real:-$resolved}"
    return
  fi
  echo "install.sh: no node binary found; set HEDDLE_NODE" >&2
  exit 2
}

bin_for() {
  # The built CLI, because the daemon must not depend on a shell to strip types.
  if [ -f "$repo/dist/cli.js" ]; then printf '%s' "$repo/dist/cli.js"; return; fi
  echo "install.sh: $repo/dist/cli.js is missing; run 'npm run build' first" >&2
  exit 2
}

require_committed_main() {
  # The daemon serves one checkout, and that checkout must contain only committed `main`: a working tree with a
  # feature branch or uncommitted changes is a workspace, not a deployment. `HEDDLE_ALLOW_DIRTY_INSTALL=1` is the
  # development escape hatch; it is never what a deployment uses.
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  [ "${HEDDLE_ALLOW_DIRTY_INSTALL:-0}" = "1" ] && return 0
  branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [ "$branch" != "main" ]; then
    echo "install.sh: $repo is on '$branch', not main." >&2
    echo "  The daemon must run from a checkout that only contains committed main." >&2
    echo "  (HEDDLE_ALLOW_DIRTY_INSTALL=1 overrides, for a development machine.)" >&2
    exit 2
  fi
  dirty=$(git -C "$repo" status --porcelain 2>/dev/null || true)
  if [ -n "$dirty" ]; then
    echo "install.sh: $repo has uncommitted changes, so it is a workspace rather than a deployment checkout." >&2
    echo "  Commit or stash them, then install from a clean checkout of main." >&2
    echo "  (HEDDLE_ALLOW_DIRTY_INSTALL=1 overrides, for a development machine.)" >&2
    exit 2
  fi
}

write_plist() {
  require_committed_main
  node=$(node_bin)
  bin=$(bin_for)
  mkdir -p "$HOME/.heddle" "$HOME/Library/LaunchAgents"
  sed \
    -e "s|@LABEL@|$label|g" \
    -e "s|@NODE@|$node|g" \
    -e "s|@NODE_DIR@|$(dirname -- "$node")|g" \
    -e "s|@BIN@|$bin|g" \
    -e "s|@REPO@|$repo|g" \
    -e "s|@PORT@|$port|g" \
    -e "s|@LOG@|$log|g" \
    -e "s|@HOME@|$HOME/.heddle|g" \
    -e "s|@HOME_DIR@|$HOME|g" \
    "$here/heddle-web.plist.template" > "$target"
  echo "wrote $target"
}

loaded() {
  launchctl print "$domain/$label" >/dev/null 2>&1
}

case "${1:-}" in
  --status)
    if loaded; then echo "agent $label: loaded"; else echo "agent $label: not loaded"; fi
    if curl -fsS -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      echo "port $port: answering"
      curl -fsS -m 2 "http://127.0.0.1:$port/healthz"
    else
      echo "port $port: no answer"
    fi
    ;;
  --restart)
    if loaded; then launchctl bootout "$domain/$label" >/dev/null 2>&1 || true; fi
    write_plist
    launchctl bootstrap "$domain" "$target"
    echo "restarted $label"
    ;;
  --uninstall)
    if loaded; then launchctl bootout "$domain/$label" >/dev/null 2>&1 || true; fi
    rm -f "$target"
    echo "removed $label"
    ;;
  --help|-h)
    usage
    ;;
  "")
    # Idempotent: an existing agent is replaced rather than duplicated.
    if loaded; then launchctl bootout "$domain/$label" >/dev/null 2>&1 || true; fi
    write_plist
    launchctl bootstrap "$domain" "$target"
    echo "loaded $label on port $port"
    echo "log:  $log"
    # The token is minted per process and printed once, into the log — it is deliberately not stored, so
    # the log line is where a person gets it. Say that rather than printing a URL without one.
    echo "URL:  http://127.0.0.1:$port/"
    echo "token: the launch token is printed once per start; read it with:"
    echo "       grep -o 'token=[A-Za-z0-9_-]*' $log | tail -1"
    ;;
  *)
    echo "install.sh: unknown option $1" >&2
    usage >&2
    exit 2
    ;;
esac
