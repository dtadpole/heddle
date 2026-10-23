---
title: Web Daemon
version: 1.4.0
description: The supervised user service — a launchd agent on macOS, a systemd user unit on Linux — that keeps the heddle Web UI running at the documented port, with either build.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for a daemon on 3082
  - source: rust/ULTIMATE_GOAL.md part 11, the same daemon pointed at the Rust binary, and the Rust port's deployment work, which keeps the server up on a Linux host
---

# `web-daemon`

Holds the definition that makes the Web UI a **service** rather than a command someone runs: a launchd
agent template for macOS, a systemd user unit template for Linux, an installer that fills in the right one
for the machine it runs on, and the reader both daemon verifiers share.

## What belongs in it

| File | What it is |
|---|---|
| [`heddle-web.plist.template`](heddle-web.plist.template) | the macOS agent, with placeholders for the program, the checkout and the port |
| [`heddle-web.service.template`](heddle-web.service.template) | the Linux user unit, with the same placeholders and the same arguments |
| [`install.sh`](install.sh) | writes the service for this machine and loads it; `--status`, `--restart`, `--uninstall`, and `--print` to show the definition without touching anything. It **refuses** a checkout that is not committed `main` — on `main`, or detached exactly at `origin/main` — so the service cannot be installed from a workspace (`HEDDLE_ALLOW_DIRTY_INSTALL=1` is the development override). |
| [`service.mjs`](service.mjs) | reads the installed service on either platform — the deployment's, or a scratch one `HEDDLE_WEB_LABEL` names (`serviceTarget`), which only `95-web-daemon` honours — — its program, checkout, port, log, pid and the process owning its port — and decides whether a checkout is committed main; [`95-web-daemon`](../../_verifiers_/95-web-daemon/INDEX.md) and [`96-deployment`](../../_verifiers_/96-deployment/INDEX.md) both read through it |
| [`supervisor.mjs`](supervisor.mjs) | the inner supervisor: runs the server and puts it back when it exits, with a bounded backoff and a loud give-up. `install.sh` puts it in front of the program on macOS, where launchd was measured not to restart a job; Linux keeps systemd alone |
| [`guard.sh`](guard.sh) | the outer layer: one probe of the port, and a platform start when nothing answers. Run from cron once a minute on a host whose launchd never starts the agent at login; `install.sh --guard` adds that line, `--guard-uninstall` removes it |
| [`rehearse.sh`](rehearse.sh) | installs the same definition under a scratch label, port, state directory and log, measures six claims (started, kill, guard, reinstall, agent gone, and `95-web-daemon` itself judging the scratch service), and removes it. **Every experiment on the service runs here, never on the live agent**; it refuses the deployment's label, unit and ports |
| [`_tests_/`](_tests_/INDEX.md) | the component suites: the reader's rules, the supervisor, and the installer run in throwaway checkouts with stand-in supervisors |

## Either build, either platform

`HEDDLE_BIN=/abs/path/heddle` makes the service run that binary instead of `node <checkout>/dist/cli.js`, with the
same arguments (`web --host 127.0.0.1 --port <port> --config <checkout>/cordis.yml`), which is the seam every
verifier judges through: the Rust port's part 11 is this daemon pointed at the binary, not a second daemon.

| | macOS | Linux |
|---|---|---|
| supervisor | launchd agent `com.dtadpole.heddle-web`, `~/Library/LaunchAgents` | systemd user unit `heddle-web.service`, `~/.config/systemd/user` |
| default port | 3082, behind the gate on 8082 the browser uses | 8082, owned by the server itself: nothing fronts it, and it is the port the owner's SSH forward reaches |
| keeps it up | `KeepAlive`, `ThrottleInterval`, and [`supervisor.mjs`](supervisor.mjs) inside them (see below) | `Restart=always`, a fixed `RestartSec`, `StartLimitIntervalSec=0` |
| survives logout and boot | an agent starts at login | only if the account lingers — the installer refuses one that does not (`HEDDLE_ALLOW_NO_LINGER=1` overrides) |
| logs | `~/.heddle/web.log` | `~/.heddle/web.log`, appended |

On Linux the start limit is switched off on purpose: systemd's default stops restarting after a burst of starts and
leaves the service dead, so a port that was taken for a few seconds would become an outage; launchd never gives up,
and neither does this unit — `RestartSec` is the bound. The delay is fixed rather than growing (`RestartSteps`),
because systemd counts restarts for the unit's lifetime, and a growing delay would make a service killed a few times
over a week slow to come back for good.

A deployment **worktree** is detached at `origin/main`, because git checks a branch out in one worktree at a time
and the base clone holds `main`. The installer accepts that shape only when HEAD is exactly the fetched tip, which
is a stricter reading of "main" than a local branch that can lag it.

## Why an agent and not a daemon

The convention is explicit: a **LaunchDaemon** is boot-level and needs root, a **LaunchAgent** needs no
privileges and starts at login. `~/Library/LaunchAgents` is owned by the account the service runs as, so
installing, inspecting and removing this needs no `sudo` — and a file the operator can read is worth more
than a unit they have to be told about.

## What keeps it up, and how that is judged

`KeepAlive` is the supervisor half of the convention, with `ThrottleInterval` bounding a crash loop, and
the working directory is what makes the default profile load — a daemon started elsewhere would boot an
empty tree, which is a real failure mode this repository has already met once.

**On this Mac that half was measured not to work**, and the service carries its own answer (2026-10-22,
macOS 27.0, 26A428). A plain `sleep 300` under `RunAtLoad` + `KeepAlive` reproduces all three, so it is the host
rather than this service:

| What was done | What launchd did |
|---|---|
| `launchctl bootstrap gui/501 <plist>` | `state = not running`, `runs = 0`, `pended nondemand spawn` — `RunAtLoad` did not fire |
| `launchctl kickstart -k gui/501/<label>` | started, so a **demand** spawn works even when a nondemand one is pending |
| kill that process with SIGKILL | stayed `not running`; `KeepAlive` never restarted it |
| a job with `StartInterval 5` | never fired; `runs = 0` after 13 s |

So, and each is a rule in this folder:

- `install.sh` **kickstarts** the agent after bootstrapping it, because bootstrap alone leaves a job on disk;
- the macOS agent runs [`supervisor.mjs`](supervisor.mjs), which restarts the server itself — quickly for a kill,
  with backoff for a crash loop, then a slow retry (every 60 s) after ten failed starts rather than an exit — on a
  host where nothing restarts the job, exiting would leave the page down after a transient cause cleared, and
  `--give-up` asks for the bounded behaviour where the platform does restart it;
- `install.sh` tightens `~/.heddle/web.log` to `600`, because it carries the launch token and the 8082 gate refuses
  to read a log other users can read — a 644 log there looks exactly like a stopped server;
- [`guard.sh`](guard.sh) is the outer layer, because a job that launchd never starts at login cannot be restarted
  by the supervisor living inside it. It acts on the **job**, not on the port: a silent port with the job running is
  a restart in flight by the supervisor, and acting there would kill the fresh server and start the restart over
  (measured 2026-10-23: three restores 75 s and 15 s apart from a port-only guard); a 20-second cooldown bounds it
  further. `install.sh --guard` adds one cron line (`* * * * * /bin/sh <checkout>/_tools_/web-daemon/guard.sh`);
  the probe answers on a host where the platform starts the job, so the line is harmless on Linux too. Every action
  it takes is written to `~/.heddle/guard.log` with the reading that caused it. **Installing that line needs the
  account's crontab permission**: measured 2026-10-22, `crontab -` from this repository's automation answered
  `Operation not permitted` (macOS TCC), so `install.sh --guard` fails loudly there and the line has to be added by
  the account owner or from a context that holds the permission. On such a host the layers above the cron line are
  the supervisor and the agent's start at login; `guard.sh` can also be run by hand, which is what an operator does
  after a 502;
- `95-web-daemon`'s stays-up check kills the process that **owns the port** and requires a new one within twenty
  seconds, because that is the process whose death is an outage, whichever layer is charged with replacing it.

**Two launchd behaviours the installer now waits out**, both found by `rehearse.sh` on a scratch agent rather than on
the owner's page: `bootout` returns before the job is gone, and a `bootstrap` of the same label in that window fails
with `5: Input/output error` — so `install.sh` waits (up to 10 s) for the old job to disappear and retries a refused
bootstrap (up to ten times, half a second apart), then exits 1 with a sentence if the agent is still not loaded; and
the render happens before anything is stopped, so a refused reinstall leaves the running agent alone.

**Liveness is port ownership**, never a process-name search. The convention is blunt about why: `pgrep -f`
matches the searching command's own line and has been measured concluding a dead service was up. A bound
port cannot be satisfied by our own argv and cannot be satisfied twice, and because the server is the
agent's only process there are no children to orphan.

The server answers `GET /healthz` with its own name and port and **nothing else** — no counts, no
version, no session data — which is the one route reachable without a token, so it is the one route that
must say nothing worth having. The definition and the server therefore agree on a single endpoint instead
of on parsing a banner.

## The request fence, and the viewer it used to break

heddle refuses a request whose `Host` is not loopback, and refuses one whose `Origin` names another
authority. A cross-site request may **read** and may not **change** anything — `GET` and `HEAD` pass,
everything else is refused.

That split is a correction. The fence first refused every cross-site request, and a viewer that embeds the
page in a **sandboxed iframe** has an opaque origin, so the browser marks its requests cross-site: measured,
`allow-same-origin` rendered heddle and a fully sandboxed frame received `refused: a cross-site request`.
heddle was unreachable from the sidebar it was meant to be watched in. Reads are safe to allow because the
credential cannot travel — the session cookie is `SameSite=Strict`, so a browser never attaches it to a
cross-site request, and the same read without the cookie is a `401`. A write must name this authority in
`Origin`, and an opaque origin's `null` matches nothing.

**This is why the gate is not a workaround for the fence.** The gate forwards the caller's `Sec-Fetch-Site`
untouched, so a sandboxed viewer reaches heddle through it only because heddle now permits the read.

## How the token works here

The launch token is minted **per process** and never stored, which does not change because the process is
supervised: each restart prints a new one into the log. The installer says so and gives the command that
reads the last one, rather than printing a URL whose token would be stale by the time it was used.

## A build is only visible after a restart

The agent runs the built files, and **the page and every module are read when the process starts**. After
`npm run build` — or a new Rust binary — restart the service (`sh install.sh --restart`; or `launchctl kickstart -k
gui/$UID/<label>` on macOS, `systemctl --user restart heddle-web.service` on Linux) or the browser keeps being
served the previous page and the previous projections.

Measured on 2026-10-17, and it cost a false bug report: the owner saw rounded panes and a duplicated
assistant row after the fixes had been committed, while the running process had started before the build
that carried them. Restarting the agent made the same browser show the fixed page — `aside` radius
`28px → 0px`, one assistant row per turn — with no code change in between. A stale process looks exactly
like a broken fix.

## Read next

[`../../_verifiers_/95-web-daemon/INDEX.md`](../../_verifiers_/95-web-daemon/INDEX.md) for the claim this
decides, [`../../_verifiers_/96-deployment/INDEX.md`](../../_verifiers_/96-deployment/INDEX.md) for which checkout
it serves, and [`../../src/server/INDEX.md`](../../src/server/INDEX.md) for the server it runs.
