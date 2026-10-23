---
title: Web Daemon
version: 1.1.0
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
| [`service.mjs`](service.mjs) | reads the installed service on either platform — its program, checkout, port, log, pid and the process owning its port — and decides whether a checkout is committed main; [`95-web-daemon`](../../_verifiers_/95-web-daemon/INDEX.md) and [`96-deployment`](../../_verifiers_/96-deployment/INDEX.md) both read through it |
| [`_tests_/`](_tests_/INDEX.md) | the component suites: the reader's rules, and the installer run in throwaway checkouts with stand-in supervisors |

## Either build, either platform

`HEDDLE_BIN=/abs/path/heddle` makes the service run that binary instead of `node <checkout>/dist/cli.js`, with the
same arguments (`web --host 127.0.0.1 --port <port> --config <checkout>/cordis.yml`), which is the seam every
verifier judges through: the Rust port's part 11 is this daemon pointed at the binary, not a second daemon.

| | macOS | Linux |
|---|---|---|
| supervisor | launchd agent `com.dtadpole.heddle-web`, `~/Library/LaunchAgents` | systemd user unit `heddle-web.service`, `~/.config/systemd/user` |
| default port | 3082, behind the gate on 8082 the browser uses | 8082, owned by the server itself: nothing fronts it, and it is the port the owner's SSH forward reaches |
| keeps it up | `KeepAlive`, `ThrottleInterval` | `Restart=always`, a fixed `RestartSec`, `StartLimitIntervalSec=0` |
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
