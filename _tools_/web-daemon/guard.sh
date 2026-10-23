#!/bin/sh
# Start the heddle Web UI service when nothing is running it.
#
#   ./guard.sh            one probe: answer, or ask the platform to start the service
#   ./guard.sh --status   what the probe sees, changing nothing
#
# Run it from cron, once a minute, on a host whose launchd leaves a bootstrapped agent's nondemand spawn pending:
# then a login, or a supervisor that died, leaves the service down with nothing to bring it back. On a host whose
# platform starts the job at login (Linux systemd, or a macOS whose launchd behaves) the probe's first branch
# answers and the guard does nothing at all, so the same line is harmless there.
#
# It is the **outer** layer, below the supervisor `install.sh` puts in front of the server: the supervisor puts a
# killed server back within seconds, and this puts the supervisor back when its own process is gone. A guard that
# quietly did nothing would look exactly like a healthy service, so every action it takes is appended to
# `~/.heddle/guard.log`, with the reading that caused it.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
label="com.dtadpole.heddle-web"
unit="heddle-web.service"
log="$HOME/.heddle/guard.log"
running_log="$HOME/.heddle/web.log"

platform=$(uname -s)
case "$platform" in
  Darwin) port="${HEDDLE_WEB_PORT:-3082}" ;;
  Linux) port="${HEDDLE_WEB_PORT:-8082}" ;;
  *) echo "guard.sh: no supervisor to guard on $platform" >&2; exit 2 ;;
esac

probe() {
  # Port ownership, not a process name: an answer on the port is the one thing a dead service cannot fake.
  if curl -fsS -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then printf 'answering'; else printf 'silent'; fi
}

loaded() {
  if [ "$platform" = Darwin ]; then
    launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1
  else
    systemctl --user is-active --quiet "$unit" >/dev/null 2>&1
  fi
}

say() {
  mkdir -p "$HOME/.heddle"
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$log"
}

if [ "${1:-}" = "--status" ]; then
  echo "port $port: $(probe)"
  if loaded; then echo "service: loaded"; else echo "service: not loaded"; fi
  echo "log: $log"
  exit 0
fi

if [ "$(probe)" = answering ]; then exit 0; fi

if [ "$platform" = Darwin ]; then
  target="$HOME/Library/LaunchAgents/$label.plist"
  if ! loaded; then
    # Not registered at all: a first run after login, or an agent removed under a running service. Register it
    # from the file `install.sh` wrote, then start it — bootstrap alone is not enough on this host.
    if [ -f "$target" ]; then
      say "port $port silent and the agent is not loaded; bootstrapping $target"
      launchctl bootstrap "gui/$(id -u)" "$target" >> "$log" 2>&1 || true
    else
      say "port $port silent and no agent is installed; run $repo/_tools_/web-daemon/install.sh"
      exit 1
    fi
  else
    say "port $port silent but the agent is loaded; kickstarting it"
  fi
  # A demand start, which this host honours even when it leaves a nondemand spawn pending.
  launchctl kickstart -k "gui/$(id -u)/$label" >> "$log" 2>&1 || true
else
  say "port $port silent; starting $unit"
  systemctl --user start "$unit" >> "$log" 2>&1 || true
fi

# Say what the start achieved, so the log distinguishes "it came back" from "it was asked to".
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  [ "$(probe)" = answering ] && { say "port $port answering again"; exit 0; }
done
say "port $port still silent ten seconds after a start; see $running_log"
exit 1
