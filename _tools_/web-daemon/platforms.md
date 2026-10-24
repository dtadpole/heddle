---
title: Web daemon — either build, either platform
created: 2026-10-23T04:42:38Z
modified: 2026-10-23T04:42:38Z
level: L3
version: 1.0.0
description: What the service runs and under which supervisor on macOS and Linux, with the reasons for the Linux start limit, the detached deployment worktree and the agent-not-daemon choice.
status: unverified
grounded_in:
  - source: _tools_/web-daemon/install.sh and its two templates
  - source: rust/ULTIMATE_GOAL.md part 11, the same daemon pointed at the binary
---

# Either build, either platform

**The program.** `HEDDLE_BIN=/abs/path/heddle` runs that binary instead of `node <checkout>/dist/cli.js`, with the same
arguments (`web --host 127.0.0.1 --port <port> --config <checkout>/cordis.yml`). That is the seam every verifier
judges through, so part 11's Rust shape is this daemon pointed at the binary, not a second daemon.

| | macOS | Linux |
|---|---|---|
| supervisor | launchd agent `com.dtadpole.heddle-web` in `~/Library/LaunchAgents`, running [`supervisor.mjs`](supervisor.mjs) in front of the server | systemd user unit `heddle-web.service` in `~/.config/systemd/user` |
| default port | 3082, behind the 8082 gate the browser uses | 8082, owned by the server: nothing fronts it |
| keeps it up | `KeepAlive`, `ThrottleInterval`, and the supervisor ([why](launchd-on-this-mac.md)) | `Restart=always`, fixed `RestartSec`, `StartLimitIntervalSec=0` |
| survives logout and boot | an agent starts at login | only if the account lingers; the installer refuses otherwise (`HEDDLE_ALLOW_NO_LINGER=1` overrides) |
| log | `~/.heddle/web.log`, mode 600 | `~/.heddle/web.log`, appended |

**Linux never stops restarting.** systemd's default start limit gives up after a burst and leaves the service dead,
so a port taken for a few seconds would become an outage; `RestartSec` is the bound instead. The delay is fixed,
not growing, because systemd counts restarts for the unit's lifetime.

**A deployment worktree is detached at `origin/main`.** Git checks a branch out in one worktree at a time and the
base clone holds `main`. The installer accepts that shape only when HEAD is exactly the fetched tip, a stricter
reading of "main" than a local branch that can lag it. Anything else, or uncommitted changes, is refused
(`HEDDLE_ALLOW_DIRTY_INSTALL=1` is the development override).

**An agent, not a daemon.** A LaunchDaemon is boot-level and needs root; a LaunchAgent needs no privileges and starts
at login, in a folder the account owns, so installing, inspecting and removing it needs no `sudo`.

**Scratch services.** `HEDDLE_WEB_LABEL`, `HEDDLE_WEB_UNIT`, `HEDDLE_WEB_HOME` and `HEDDLE_WEB_LOG` name another
service; [`rehearse.sh`](rehearse.sh) uses them so an experiment never shares the live agent's state or token log.
