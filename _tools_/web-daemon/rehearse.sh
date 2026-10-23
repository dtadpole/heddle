#!/bin/sh
# Rehearse the Web UI service on a scratch agent and a scratch port, and measure what the deployment would do.
#
#   ./rehearse.sh            install a scratch service from this checkout, measure it, and remove it
#   ./rehearse.sh --keep     the same, but leave the scratch service running (remove it with --cleanup)
#   ./rehearse.sh --cleanup  remove a scratch service a --keep run left behind
#
# HEDDLE_REHEARSE_PORT (3096) and HEDDLE_REHEARSE_LABEL (com.dtadpole.heddle-web.rehearsal) name the scratch service;
# HEDDLE_BIN rehearses the binary exactly as install.sh would serve it.
#
# **Why it exists.** Every measurement of the service so far has been made somewhere, and twice that somewhere was
# the owner's page: a guard experiment kicked the live supervisor mid-restart, and a reinstall measured during a
# push to main booted the live agent out and left it down for about seventy seconds (2026-10-23). The rule since is
# that experiments run on a scratch agent and the live agent is touched only by a real redeploy. This makes that the
# easy way: one command installs the same definition install.sh writes, under another label, port, state directory
# and log — the 8082 gate reads the newest launch token from the deployment's log, so a scratch server must never
# write there — measures the claims the deployment depends on, and removes everything it created.
#
# The claims, each a line of output and each able to fail:
#   started        the service answers /healthz after install
#   kill           the process owning the port is SIGKILLed and a new pid answers within 20 s
#   guard          a guard run during that restart takes no action (it acts on the job, not on the port)
#   reinstall      install.sh --restart leaves the port silent for less than 5 s
#   agent gone     after a bootout, one guard run brings the service back within 20 s
#   95-web-daemon  the verifier itself, judging the scratch service (its stays-up check kills the scratch server)
# Exit 0 when every claim held, 1 when one failed, 2 when the rehearsal refused to start, 3 when this host
# cannot be judged (no supervisor command).
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
live_label="com.dtadpole.heddle-web"
label="${HEDDLE_REHEARSE_LABEL:-com.dtadpole.heddle-web.rehearsal}"
unit="${HEDDLE_REHEARSE_UNIT:-heddle-web-rehearsal.service}"
port="${HEDDLE_REHEARSE_PORT:-3096}"
state_file="${TMPDIR:-/tmp}/heddle-rehearsal.$(id -u).home"
mode="${1:-run}"

platform="${HEDDLE_WEB_PLATFORM:-$(uname -s)}"
case "$platform" in
  Darwin|darwin) platform=darwin; command -v launchctl >/dev/null 2>&1 || { echo "rehearse.sh: no launchctl here" >&2; exit 3; } ;;
  Linux|linux) platform=linux; command -v systemctl >/dev/null 2>&1 || { echo "rehearse.sh: no systemctl here" >&2; exit 3; } ;;
  *) echo "rehearse.sh: no supervisor for platform '$platform'" >&2; exit 3 ;;
esac

refuse() {
  echo "rehearse.sh: $*" >&2
  exit 2
}

# The refusals come first and touch nothing: they are what keeps a rehearsal from becoming an experiment on the
# deployment, which is the whole point of the tool.
[ "$label" = "$live_label" ] && refuse "the label $label is the deployment's; a rehearsal needs its own"
[ "$unit" = "heddle-web.service" ] && refuse "the unit $unit is the deployment's; a rehearsal needs its own"
case "$port" in
  3082|8082) refuse "port $port belongs to the deployment (3082 the server, 8082 the gate)" ;;
  ''|*[!0-9]*) refuse "HEDDLE_REHEARSE_PORT must be a number, got '$port'" ;;
esac

now_ms() {
  perl -MTime::HiRes=time -e 'printf("%d\n", time() * 1000)' 2>/dev/null || echo "$(( $(date +%s) * 1000 ))"
}

answering() {
  curl -fsS -m 1 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1
}

port_pid() {
  if [ "$platform" = darwin ]; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1
  else
    ss -ltnpH "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1
  fi
}

# Run a command with the scratch service's names, so install.sh and guard.sh act on it and only on it.
scratch() {
  HEDDLE_WEB_LABEL="$label" HEDDLE_WEB_UNIT="$unit" HEDDLE_WEB_PORT="$port" \
    HEDDLE_WEB_HOME="$home" HEDDLE_WEB_LOG="$home/web.log" HEDDLE_WEB_PLATFORM="$platform" \
    HEDDLE_ALLOW_DIRTY_INSTALL=1 HEDDLE_ALLOW_NO_LINGER="${HEDDLE_ALLOW_NO_LINGER:-0}" "$@"
}

cleanup() {
  [ -n "${home:-}" ] || return 0
  scratch sh "$here/install.sh" --uninstall >/dev/null 2>&1 || true
  case "$home" in
    "${TMPDIR:-/tmp}"/heddle-rehearsal.*) rm -rf "$home" ;;
  esac
  rm -f "$state_file"
}

if [ "$mode" = "--cleanup" ]; then
  home=$(cat "$state_file" 2>/dev/null || true)
  if [ -z "$home" ]; then echo "rehearse.sh: no rehearsal to clean up"; exit 0; fi
  cleanup
  echo "removed the rehearsal service $label and its state"
  exit 0
fi
case "$mode" in run|--keep) ;; *) refuse "unknown option $mode" ;; esac

answering && refuse "something already answers on port $port; pick another HEDDLE_REHEARSE_PORT"
[ -f "$state_file" ] && refuse "a rehearsal is already installed (state in $state_file); run --cleanup first"

home=$(mktemp -d "${TMPDIR:-/tmp}/heddle-rehearsal.XXXXXX")
printf '%s\n' "$home" > "$state_file"
if [ "$mode" != "--keep" ]; then trap cleanup EXIT INT TERM; fi

held=0
failed=0
unjudged=0
result() {
  # result <claim> <held|failed|unjudged> <detail>
  printf '%-14s %-8s %s\n' "$1" "$2" "$3"
  case "$2" in
    held) held=$((held + 1)) ;;
    unjudged) unjudged=$((unjudged + 1)) ;;
    *) failed=$((failed + 1)) ;;
  esac
}

# Wait until the port answers or `limit` ms pass; print the elapsed ms, or nothing on timeout.
wait_answer() {
  limit=$1
  start=$(now_ms)
  while :; do
    if answering; then echo $(( $(now_ms) - start )); return 0; fi
    [ $(( $(now_ms) - start )) -ge "$limit" ] && return 1
    sleep 0.1
  done
}

echo "rehearsal: label $label, port $port, state $home"
echo "program:   ${HEDDLE_BIN:-node $(CDPATH= cd -- "$here/../.." && pwd)/dist/cli.js}"

# started
scratch sh "$here/install.sh" >/dev/null 2>"$home/install.err" || { cat "$home/install.err" >&2; exit 1; }
if ms=$(wait_answer "${HEDDLE_REHEARSE_START_MS:-20000}"); then
  result started held "${ms} ms after install"
else
  result started failed "no answer within $(( ${HEDDLE_REHEARSE_START_MS:-20000} / 1000 )) s"
  # Nothing else can be judged without a server, so say why it did not start and stop here rather than spending
  # another minute failing claims that were never in question. The server's own words are in the scratch log.
  if [ -f "$home/web.log" ]; then
    echo "why: the scratch log ends with:"
    grep -v '^heddle-supervisor: restarting in' "$home/web.log" | tail -3 | sed 's/^/  /'
  fi
  for claim in kill guard reinstall "agent gone" 95-web-daemon; do result "$claim" unjudged "no server to judge"; done
  echo "verdict: $held held, $failed failed, $unjudged unjudged"
  exit 1
fi

# kill: the port's owner is the server, and its death is the outage the supervisor exists for.
sleep 6
before=$(port_pid)
if [ -z "$before" ]; then
  result kill failed "nothing owns port $port"
else
  kill -9 "$before" 2>/dev/null || true
  start=$(now_ms)
  back=""
  while [ $(( $(now_ms) - start )) -lt 20000 ]; do
    pid=$(port_pid)
    if [ -n "$pid" ] && [ "$pid" != "$before" ] && answering; then back=$pid; break; fi
    sleep 0.1
  done
  if [ -n "$back" ]; then result kill held "$(( $(now_ms) - start )) ms to a new pid ($before -> $back)"; else result kill failed "no new pid answered within 20 s"; fi
fi

# guard: a run during a restart must leave the supervisor alone.
sleep 6
before=$(port_pid)
guard_lines() { if [ -f "$home/guard.log" ]; then wc -l < "$home/guard.log" | tr -d ' '; else echo 0; fi; }
lines_before=$(guard_lines)
if [ -n "$before" ]; then kill -9 "$before" 2>/dev/null || true; fi
scratch sh "$here/guard.sh" >/dev/null 2>&1 || true
lines_after=$(guard_lines)
if [ "$lines_after" -eq "$lines_before" ]; then result guard held "no action while the supervisor restarted the server"; else result guard failed "$(tail -1 "$home/guard.log")"; fi
wait_answer 20000 >/dev/null || true

# reinstall: the window a redeploy costs.
sleep 6
longest=0
silent=""
scratch sh "$here/install.sh" --restart >/dev/null 2>&1 &
installer=$!
start=$(now_ms)
while [ $(( $(now_ms) - start )) -lt 12000 ]; do
  t=$(now_ms)
  if answering; then
    if [ -n "$silent" ]; then d=$((t - silent)); [ "$d" -gt "$longest" ] && longest=$d; silent=""; fi
  else
    [ -z "$silent" ] && silent=$t
  fi
  sleep 0.1
done
wait "$installer" 2>/dev/null || true
if [ -n "$silent" ]; then longest=12000; fi
if [ "$longest" -lt 5000 ]; then result reinstall held "longest silence ${longest} ms"; else result reinstall failed "longest silence ${longest} ms"; fi

# agent gone: the case the guard is for.
sleep 6
if [ "$platform" = darwin ]; then
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
else
  systemctl --user stop "$unit" >/dev/null 2>&1 || true
fi
sleep 1
start=$(now_ms)
scratch sh "$here/guard.sh" >/dev/null 2>&1 || true
if ms=$(wait_answer 20000); then result "agent gone" held "guard restored it, $(( $(now_ms) - start )) ms"; else result "agent gone" failed "not answering 20 s after the guard ran"; fi

# 95-web-daemon: the verifier, pointed at the scratch service, so its kill never lands on the owner's page (D-042).
repo=$(CDPATH= cd -- "$here/../.." && pwd)
verifier="$repo/_verifiers_/95-web-daemon/verify.sh"
if [ -f "$verifier" ]; then
  sleep 6
  json=$(HEDDLE_WEB_LABEL="$label" HEDDLE_WEB_UNIT="$unit" HEDDLE_WEB_PORT="$port" sh "$verifier" --json 2>/dev/null | tail -1 || true)
  verdict=$(printf '%s' "$json" | sed -n 's/.*"verdict":\([0-9]\).*/\1/p')
  summary=$(printf '%s' "$json" | sed -n 's/.*"pass":\([0-9]*\).*"fail":\([0-9]*\).*"skipped":\([0-9]*\).*/\1 pass, \2 fail, \3 skipped/p')
  if [ "$verdict" = 0 ]; then result 95-web-daemon held "$summary"; else result 95-web-daemon failed "verdict ${verdict:-none}: ${summary:-$json}"; fi
fi

echo "verdict: $held held, $failed failed, $unjudged unjudged"
if [ "$mode" = "--keep" ]; then echo "kept: $label on $port; remove it with $0 --cleanup"; fi
[ "$failed" -eq 0 ]
