---
title: Web Daemon
created: 2026-10-11T20:54:23Z
modified: 2026-10-23T06:03:13Z
version: 2.2.0
description: The supervised user service that keeps the heddle Web UI running at its documented port, with either build, and the tools that install, rehearse and redeploy it.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for a daemon on 3082
  - source: rust/ULTIMATE_GOAL.md part 11, the same daemon pointed at the Rust binary
---

# `web-daemon`

Makes the Web UI a **service** rather than a command. Three layers keep it up: the platform starts it (launchd on
macOS, systemd on Linux), [`supervisor.mjs`](supervisor.mjs) restarts the server inside it, and
[`guard.sh`](guard.sh) restarts the job itself when it is gone.

| File | What it is |
|---|---|
| [`heddle-web.plist.template`](heddle-web.plist.template), [`heddle-web.service.template`](heddle-web.service.template) | the macOS agent and the Linux unit |
| [`install.sh`](install.sh) | renders, refuses a checkout that is not committed `main`, loads; `--status`, `--restart`, `--uninstall`, `--print`, `--guard` |
| [`supervisor.mjs`](supervisor.mjs) | restarts the server, replaces a hung one, reclaims a leftover, holds a lock |
| [`guard.sh`](guard.sh) | acts only when the job is not running, or a server answers without its supervisor |
| [`service.mjs`](service.mjs) | the reader `95-web-daemon` and `96-deployment` share |
| [`rehearse.sh`](rehearse.sh) | every experiment, on a scratch agent: six claims, including 95 |
| [`redeploy.sh`](redeploy.sh) | the deployment's redeploy, in its one order, judged by 96 |
| [`preview.sh`](preview.sh) | rebuilds the Rust preview (3097) from main when the binary's crates changed |
| [`_tests_/`](_tests_/INDEX.md) | the component suites |

## Read next

[`platforms.md`](platforms.md) for builds and platforms; [`launchd-on-this-mac.md`](launchd-on-this-mac.md) for the
measured defects behind each rule; [`serving-notes.md`](serving-notes.md) for liveness, the request fence, the token
and restarts; [`95-web-daemon`](../../_verifiers_/95-web-daemon/INDEX.md) and
[`96-deployment`](../../_verifiers_/96-deployment/INDEX.md) for the claims.
