#!/bin/sh
# Start the heddle Web UI service when nothing is running it.
#
#   ./guard.sh            one probe: act only when the service is not running at all
#   ./guard.sh --status   what the probe sees, changing nothing
#
# Run it from cron, once a minute, on a host whose launchd leaves a bootstrapped agent's nondemand spawn pending:
# then a login, or a supervisor that died, leaves the service down with nothing to bring it back. On a host whose
# platform starts the job at login (Linux systemd, or a macOS whose launchd behaves) the probe's first branch
# answers and the guard does nothing at all, so the same line is harmless there.
#
# **What it acts on, and what it deliberately leaves alone.** The layering is: launchd (or systemd) starts the
# agent, `supervisor.mjs` inside it restarts the *server*, and this is the last resort for the case where the
# agent itself is gone. So a silent port is **not** the trigger: the trigger is the job not running. Measured
# 2026-10-22, that distinction is the difference between a guard and a restart loop — a port probe alone kicks a
# supervisor that is already restarting the server (a one-second window), which kills the fresh server and makes
# the restart start over. `guard.log` at 03:39–03:41Z shows three restores 75 s and 15 s apart, each of them the
# restore of a deliberate kill by `95-web-daemon`'s stays-up check run by the lane gate against this deployment;
# with the supervisor installed, each of those windows is under a second and this guard does not touch them.
#
# A cooldown (`HEDDLE_GUARD_COOLDOWN`, 20 s) bounds it further: however wrong its reading is, it cannot act twice
# in a row. Every action it takes is appended to `~/.heddle/guard.log` with the reading that caused it, and the
# outcome is recorded once it knows it.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
# The same overrides install.sh takes, so a scratch service (rehearse.sh) is guarded with its own label, state and
# logs, and an experiment's guard never reads or writes the deployment's.
label="${HEDDLE_WEB_LABEL:-com.dtadpole.heddle-web}"
unit="${HEDDLE_WEB_UNIT:-heddle-web.service}"
heddle_home="${HEDDLE_WEB_HOME:-$HOME/.heddle}"
log="$heddle_home/guard.log"
running_log="${HEDDLE_WEB_LOG:-$heddle_home/web.log}"
stamp="$heddle_home/guard.last"
cooldown="${HEDDLE_GUARD_COOLDOWN:-20}"
wait_seconds="${HEDDLE_GUARD_WAIT:-10}"

# The platform decides the supervisor, and HEDDLE_WEB_PLATFORM exists so the guard's tests can drive both branches
# on one machine with stand-in commands — the same override `install.sh` takes.
platform="${HEDDLE_WEB_PLATFORM:-$(uname -s)}"
case "$platform" in
  Darwin|darwin) platform=darwin; port="${HEDDLE_WEB_PORT:-3082}" ;;
  Linux|linux) platform=linux; port="${HEDDLE_WEB_PORT:-8082}" ;;
  *)
    echo "guard.sh: no supervisor to guard on $platform" >&2
    exit 2
    ;;
esac

probe() {
  # Port ownership, not a process name: an answer on the port is the one thing a dead service cannot fake.
  if curl -fsS -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then printf 'answering'; else printf 'silent'; fi
}

job_state() {
  # The platform's own answer about the **job**: `running`/`active` means the supervisor (or systemd) is alive and
  # charged with the server, so a silent port is a restart in flight rather than an abandoned service.
  if [ "$platform" = darwin ]; then
    launchctl print "gui/$(id -u)/$label" 2>/dev/null | awk -F'= ' '/^[[:space:]]*state = /{print $2; exit}' || true
  else
    systemctl --user is-active "$unit" 2>/dev/null || true
  fi
}

loaded() {
  if [ "$platform" = darwin ]; then
    launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1
  else
    systemctl --user is-enabled --quiet "$unit" >/dev/null 2>&1
  fi
}

within_cooldown() {
  [ -f "$stamp" ] || return 1
  last=$(cat "$stamp" 2>/dev/null || true)
  case "$last" in ''|*[!0-9]*) return 1 ;; esac
  now=$(date +%s)
  [ $((now - last)) -lt "$cooldown" ]
}

say() {
  mkdir -p "$heddle_home"
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$log"
}

if [ "${1:-}" = "--status" ]; then
  echo "port $port: $(probe)"
  echo "service: $(job_state)"
  echo "log: $log"
  exit 0
fi

if [ "$(probe)" = answering ]; then exit 0; fi

state=$(job_state)
case "$state" in
  running|active)
    # Alive and charged with the server: restarting it is the supervisor's job, and acting here would race it.
    exit 0
    ;;
esac

if within_cooldown; then exit 0; fi

if [ "$platform" = darwin ]; then
  target="$HOME/Library/LaunchAgents/$label.plist"
  if ! loaded; then
    if [ -f "$target" ]; then
      say "port $port silent and the agent is not loaded; bootstrapping $target"
      launchctl bootstrap "gui/$(id -u)" "$target" >> "$log" 2>&1 || true
    else
      say "port $port silent and no agent is installed; run $repo/_tools_/web-daemon/install.sh"
      exit 1
    fi
  else
    say "port $port silent and the agent is loaded but not running; kickstarting it"
  fi
  launchctl kickstart -k "gui/$(id -u)/$label" >> "$log" 2>&1 || true
else
  say "port $port silent and $unit is not active; starting it"
  systemctl --user start "$unit" >> "$log" 2>&1 || true
fi
mkdir -p "$heddle_home"
date +%s > "$stamp"

# Say what the start achieved, so the log distinguishes "it came back" from "it was asked to".
i=0
while [ "$i" -lt "$wait_seconds" ]; do
  i=$((i + 1))
  sleep 1
  if [ "$(probe)" = answering ]; then
    say "port $port answering again"
    exit 0
  fi
done
say "port $port still silent ${wait_seconds}s after a start; see $running_log"
exit 1
