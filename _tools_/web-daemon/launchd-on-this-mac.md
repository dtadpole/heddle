---
title: Web daemon — what launchd does on this Mac, and the rules it forced
created: 2026-10-23T04:42:38Z
modified: 2026-10-23T04:42:38Z
level: L3
version: 1.0.0
description: The launchd behaviours measured on the owner's Mac (macOS 27.0, 26A428) and the rule each one put into install.sh, supervisor.mjs, guard.sh and 95-web-daemon.
status: unverified
grounded_in:
  - source: measurements on the owner's Mac, 2026-10-22 and 2026-10-23, with a plain sleep job and on scratch agents
  - source: the live deployment's outages of 2026-10-23, recorded in _context_/rust-port/
---

# What launchd does on this Mac, and the rules it forced

Measured on macOS 27.0 (26A428). A plain `sleep 300` agent reproduces the first four rows, so they belong to the
host, not to this service.

| Measured | Rule |
|---|---|
| `bootstrap` leaves the job `not running`, `runs = 0`, `pended nondemand spawn`: `RunAtLoad` does not fire | `install.sh` **kickstarts** after bootstrapping; a demand start works |
| a `KeepAlive` job killed with SIGKILL stays `not running` | the agent runs [`supervisor.mjs`](supervisor.mjs), which restarts the server itself |
| a `StartInterval` job never fires | no launchd timer can be the outer layer |
| `crontab -` from automation answers `Operation not permitted` (TCC) | `install.sh --guard` fails loudly; the account owner adds the cron line |
| `bootout` returns before the job is gone; a `bootstrap` in that window fails with `5: Input/output error` | `install.sh` waits up to 10 s for the old job, retries a refused bootstrap ten times, then exits 1 saying the agent is not loaded |
| `kickstart -k` on a job younger than `ThrottleInterval` (10 s) waits out the throttle: about 10 s of silence | a restorer must not kick a job that is already restarting |
| a SIGKILL or SIGTERM of the job's process takes its process group down and the job stays `not running` | `AbandonProcessGroup`: the server outlives a killed supervisor; the next supervisor reclaims it |
| a hung server keeps its port and the job reads `running` | the supervisor probes `/healthz` and replaces a server that misses three probes |

**The supervisor** restarts at once after a run that lasted, with backoff for failed starts, and retries every 60 s
after ten failures, because here an exit is permanent. Before each start it reclaims a listener on its port running
exactly its command, and a pidfile lock keeps a second supervisor of the service from running beside it.

**The guard acts on the job, not the port.** A silent port with the job running is the supervisor mid-restart;
kicking it then kills the fresh server. On 2026-10-23 a port-only guard produced three restores 75 s and 15 s apart.
[`guard.sh`](guard.sh) acts only when the job is not loaded or not running, with a 20 s cooldown, and logs every
action to `~/.heddle/guard.log`.

**The installer renders before it stops anything.** It once booted the live agent out and then refused a checkout
one commit behind a freshly fetched `origin/main`, leaving 8082 down for about 70 s.

**The token log is mode 600.** It carries the launch token, and the gate refuses a log others can read; a 644 log
looks like a stopped server.

**95 kills the process that owns the port**, since that death is the outage whichever layer replaces it. It runs
against a scratch agent, never the live one.
