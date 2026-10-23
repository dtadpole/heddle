#!/bin/sh
# Install, inspect or remove the heddle Web UI as a supervised user service:
# a launchd agent on macOS, a systemd user unit on Linux.
#
#   ./install.sh              write the service for this machine and load it
#   ./install.sh --status     say whether it is loaded and whether the port answers
#   ./install.sh --restart    write it again and restart it (after a build or a new binary)
#   ./install.sh --uninstall  stop it and remove the file
#   ./install.sh --print      print the definition this machine would get, and change nothing
#   ./install.sh --guard      add the once-a-minute guard that starts the service when nothing is running it
#   ./install.sh --guard-uninstall  remove that guard line, and nothing else
#
# HEDDLE_BIN=/abs/path/heddle serves with that binary instead of `node dist/cli.js`. HEDDLE_WEB_PORT overrides
# the port: 3082 on macOS, behind the 8082 gate; 8082 on Linux, where nothing fronts the server.
# HEDDLE_WEB_LABEL, HEDDLE_WEB_UNIT, HEDDLE_WEB_HOME and HEDDLE_WEB_LOG name a scratch service instead of the
# deployment's; rehearse.sh uses them, so an experiment never touches the live agent.
# The file is written under the account's own home, so none of this needs sudo. Every step is idempotent:
# running it twice leaves one service, and the paths it fills in come from the machine it runs on rather
# than from the repository.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
label="${HEDDLE_WEB_LABEL:-com.dtadpole.heddle-web}"
unit="${HEDDLE_WEB_UNIT:-heddle-web.service}"
# Where the service keeps its state and writes its log. Overridable so a **scratch** service (rehearse.sh) never
# shares them with the deployment: the 8082 gate reads the newest launch token from the deployment's log, so a
# rehearsal server that printed its token there would hand the gate a token the live server does not know.
heddle_home="${HEDDLE_WEB_HOME:-$HOME/.heddle}"
log="${HEDDLE_WEB_LOG:-$heddle_home/web.log}"

# The platform decides the supervisor. HEDDLE_WEB_PLATFORM exists for the installer's own tests, which render
# and drive both branches on one machine with stand-in launchctl, systemctl and loginctl commands.
platform="${HEDDLE_WEB_PLATFORM:-$(uname -s)}"
case "$platform" in
  Darwin|darwin)
    platform=darwin
    port="${HEDDLE_WEB_PORT:-3082}"
    target="$HOME/Library/LaunchAgents/$label.plist"
    domain="gui/$(id -u)"
    ;;
  Linux|linux)
    platform=linux
    # No gate runs on a Linux host: the server owns the port the owner's forward reaches.
    port="${HEDDLE_WEB_PORT:-8082}"
    target="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit"
    ;;
  *)
    echo "install.sh: no supervisor for platform '$platform' (launchd on macOS, systemd on Linux)" >&2
    exit 2
    ;;
esac

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
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

resolve_program() {
  # What the service executes: the binary HEDDLE_BIN names, or node running the built CLI. Both take the same
  # arguments, which is the seam every verifier already judges through.
  if [ -n "${HEDDLE_BIN:-}" ]; then
    case "$HEDDLE_BIN" in
      /*) ;;
      *) echo "install.sh: HEDDLE_BIN must be an absolute path, got '$HEDDLE_BIN'" >&2; exit 2 ;;
    esac
    if [ ! -f "$HEDDLE_BIN" ] || [ ! -x "$HEDDLE_BIN" ]; then
      echo "install.sh: HEDDLE_BIN is not an executable file: $HEDDLE_BIN" >&2
      exit 2
    fi
    exe="$HEDDLE_BIN"
    cli=""
  else
    exe=$(node_bin)
    cli=$(bin_for)
  fi
  node=$(node_bin)
  node_dir=$(dirname -- "$node")
  case "${HEDDLE_WEB_SUPERVISOR:-1}" in
    0|no|false) supervise=no ;;
    *) supervise=yes ;;
  esac
  # The supervisor is a macOS answer to a measured defect, not a second daemon layer: Linux's systemd
  # `Restart=always` already puts the process back, and an extra parent there would only add a process.
  [ "$platform" = darwin ] || supervise=no
}

require_committed_main() {
  # The daemon serves one checkout, and that checkout must contain only committed `main`: a working tree with a
  # feature branch or uncommitted changes is a workspace, not a deployment. `HEDDLE_ALLOW_DIRTY_INSTALL=1` is the
  # development escape hatch; it is never what a deployment uses.
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  [ "${HEDDLE_ALLOW_DIRTY_INSTALL:-0}" = "1" ] && return 0
  branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [ "$branch" = "HEAD" ]; then
    # A detached checkout is a deployment only when it sits exactly on the fetched main. This is the shape of a
    # deployment worktree: git lets one branch be checked out in one worktree, and the base clone holds `main`.
    head=$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)
    tip=$(git -C "$repo" rev-parse -q --verify refs/remotes/origin/main 2>/dev/null || true)
    if [ -z "$tip" ] || [ "$head" != "$tip" ]; then
      echo "install.sh: $repo is detached at ${head:-an unknown commit}, which is not origin/main (${tip:-no such ref})." >&2
      echo "  A detached deployment checkout must sit on the fetched main: git checkout --detach origin/main" >&2
      echo "  (HEDDLE_ALLOW_DIRTY_INSTALL=1 overrides, for a development machine.)" >&2
      exit 2
    fi
  elif [ "$branch" != "main" ]; then
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

render_plist() {
  # The job's arguments, one `<string>` per element. Two shapes: the supervisor in front of the program (macOS,
  # the default — see supervisor.mjs for the measurement it answers), or the program itself.
  args=$(mktemp "${TMPDIR:-/tmp}/heddle-web-args.XXXXXX") || exit 2
  trap 'rm -f "$args"' EXIT HUP INT TERM
  if [ "$supervise" = yes ]; then
    xml_strings "$node" "$here/supervisor.mjs" -- >> "$args"
  fi
  xml_strings "$exe" >> "$args"
  if [ -n "$cli" ]; then xml_strings "$cli" >> "$args"; fi
  xml_strings web --host 127.0.0.1 --port "$port" --config "$repo/cordis.yml" >> "$args"
  awk -v list="$args" '
    /@PROGRAM_ARGUMENTS@/ { while ((getline line < list) > 0) print line; close(list); next }
    { print }
  ' "$here/heddle-web.plist.template" |
    sed \
      -e "s|@LABEL@|$label|g" \
      -e "s|@NODE_DIR@|$node_dir|g" \
      -e "s|@REPO@|$repo|g" \
      -e "s|@PORT@|$port|g" \
      -e "s|@LOG@|$log|g" \
      -e "s|@HOME@|$heddle_home|g" \
      -e "s|@HOME_DIR@|$HOME|g"
}

# One plist argument, XML-escaped: a path with `&`, `<` or `>` would otherwise make the plist unreadable.
xml_strings() {
  for value in "$@"; do
    escaped=$(printf '%s' "$value" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
    printf '    <string>%s</string>\n' "$escaped"
  done
}

render_unit() {
  # systemd splits ExecStart on whitespace, so a path with a space would silently become two arguments.
  case "$exe$cli$repo$HOME" in
    *" "*|*"	"*)
      echo "install.sh: a path contains whitespace, which a systemd ExecStart line would split: $exe $cli $repo" >&2
      exit 2
      ;;
  esac
  program="$exe"
  if [ -n "$cli" ]; then program="$exe $cli"; fi
  sed \
    -e "s|@PROGRAM@|$program|g" \
    -e "s|@PROGRAM_DIR@|$(dirname -- "$exe")|g" \
    -e "s|@REPO@|$repo|g" \
    -e "s|@PORT@|$port|g" \
    -e "s|@LOG@|$log|g" \
    -e "s|@HOME@|$heddle_home|g" \
    -e "s|@HOME_DIR@|$HOME|g" \
    "$here/heddle-web.service.template"
}

render() {
  require_committed_main
  resolve_program
  if [ "$platform" = darwin ]; then render_plist; else render_unit; fi
}

prepare_definition() {
  # Rendered to a string first, and **before anything is stopped**: a refusal (a checkout that is not committed main,
  # a missing build, a bad HEDDLE_BIN) must leave both the installed file and the running service as they were.
  # Measured 2026-10-23, and it was an outage: `--restart` booted the live agent out, then the render refused a
  # deployment one commit behind a freshly fetched origin/main and exited, so nothing was loaded again — 8082
  # answered 502 for about forty seconds until the agent was bootstrapped by hand.
  definition=$(render)
}

write_definition() {
  mkdir -p "$heddle_home" "$(dirname -- "$log")" "$(dirname -- "$target")"
  printf '%s\n' "$definition" > "$target"
  echo "wrote $target"
}

require_linger() {
  # A user unit is stopped at logout and not started at boot unless the account lingers, which would make this a
  # session process rather than a service.
  [ "${HEDDLE_ALLOW_NO_LINGER:-0}" = "1" ] && return 0
  user=$(id -un)
  linger=$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)
  if [ "$linger" != "yes" ]; then
    echo "install.sh: $user does not linger, so systemd would stop this service at logout and not start it at boot." >&2
    echo "  Turn it on with: loginctl enable-linger $user" >&2
    echo "  (HEDDLE_ALLOW_NO_LINGER=1 overrides, for a development machine.)" >&2
    exit 2
  fi
}

loaded() {
  if [ "$platform" = darwin ]; then
    launchctl print "$domain/$label" >/dev/null 2>&1
  else
    systemctl --user is-active --quiet "$unit" >/dev/null 2>&1
  fi
}

bootstrap_agent() {
  # Load the agent, retrying a refusal for a few seconds: even after the old job is gone, launchd can still answer
  # `5: Input/output error` for a moment. A bootstrap that never succeeds is reported and exits non-zero, because an
  # installer that reports success with nothing loaded is the worst answer it can give.
  attempt=1
  while :; do
    if output=$(launchctl bootstrap "$domain" "$target" 2>&1); then return 0; fi
    if [ "$attempt" -ge "${HEDDLE_BOOTSTRAP_ATTEMPTS:-10}" ]; then
      echo "install.sh: launchctl bootstrap failed $attempt times; $label is NOT loaded: $output" >&2
      echo "  Load it by hand once launchd settles: launchctl bootstrap $domain $target && launchctl kickstart -k $domain/$label" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
}

load() {
  # Idempotent on both platforms: an existing service is replaced rather than duplicated.
  if [ "$platform" = darwin ]; then
    prepare_definition
    if loaded; then
      launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
      # `bootout` returns before launchd has finished removing the job, and a `bootstrap` of the same label in that
      # window fails with `5: Input/output error` — measured 2026-10-23 on a rehearsal agent, where it left nothing
      # loaded. So wait for the job to be gone (up to ten seconds) before loading it again.
      waited=0
      while loaded && [ "$waited" -lt 100 ]; do sleep 0.1; waited=$((waited + 1)); done
    fi
    write_definition
    bootstrap_agent
    # Measured on this Mac (macOS 27.0, 26A428, 2026-10-22): `bootstrap` registers the job but its nondemand
    # spawn stays pending — `RunAtLoad` does not fire, so the job is `state = not running` with `runs = 0` until
    # it is asked for. A demand start is what makes an install an install rather than a file on disk.
    launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
    # The log carries the launch token, and the 8082 gate refuses to read a log other users can read; a
    # 644 file here would look exactly like a stopped server. Tighten it before anyone needs the token.
    if [ -f "$log" ]; then chmod 600 "$log" 2>/dev/null || true; fi
  else
    require_linger
    prepare_definition
    write_definition
    systemctl --user daemon-reload
    systemctl --user enable --quiet "$unit"
    # restart, not start: a running service must pick up the new definition and the new build.
    systemctl --user restart "$unit"
  fi
}

name() {
  if [ "$platform" = darwin ]; then printf 'agent %s' "$label"; else printf 'unit %s' "$unit"; fi
}

# The guard line, and the crontab edits. Cron is the one scheduler this Mac was measured to run while launchd left
# a bootstrapped agent's nondemand spawn pending: an agent that is not started at login has nothing to bring it
# back, and no platform timer is available to ask. The line is added by exact match, so running --guard twice
# leaves one entry, and --guard-uninstall removes that entry and nothing else from the account's crontab.
guard_line="* * * * * /bin/sh $here/guard.sh >/dev/null 2>&1"

install_guard() {
  current=$(crontab -l 2>/dev/null || true)
  if printf '%s\n' "$current" | grep -Fqx "$guard_line"; then
    echo "guard already installed: $guard_line"
    return
  fi
  { printf '%s\n' "$current"; printf '%s\n' "$guard_line"; } | grep -v '^$' | crontab -
  echo "installed the guard: $guard_line"
}

uninstall_guard() {
  current=$(crontab -l 2>/dev/null || true)
  printf '%s\n' "$current" | grep -v '^$' | grep -Fvx "$guard_line" | crontab - || true
  echo "removed the guard line, if it was there: $guard_line"
}

case "${1:-}" in
  --status)
    if loaded; then echo "$(name): loaded"; else echo "$(name): not loaded"; fi
    if curl -fsS -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      echo "port $port: answering"
      curl -fsS -m 2 "http://127.0.0.1:$port/healthz"
    else
      echo "port $port: no answer"
    fi
    ;;
  --restart)
    load
    echo "restarted $(name)"
    ;;
  --uninstall)
    if [ "$platform" = darwin ]; then
      if loaded; then launchctl bootout "$domain/$label" >/dev/null 2>&1 || true; fi
      rm -f "$target"
    else
      systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
      rm -f "$target"
      systemctl --user daemon-reload
    fi
    echo "removed $(name)"
    ;;
  --print)
    render
    ;;
  --guard)
    install_guard
    ;;
  --guard-uninstall)
    uninstall_guard
    ;;
  --help|-h)
    usage
    ;;
  "")
    load
    echo "loaded $(name) on port $port"
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
