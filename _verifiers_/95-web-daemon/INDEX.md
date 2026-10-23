---
title: Verifier 11 — Web Daemon
version: 1.5.0
description: a supervised user service — a launchd agent on macOS, a systemd user unit on Linux — keeps the Web UI running at the documented port, survives a kill, and does not weaken the token.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for a daemon on 3082
  - source: rust/ULTIMATE_GOAL.md part 11, and the Rust port's deployment work, which asks for a Linux branch of this verifier
---

# `95-web-daemon`

Instance of this project's `_verifiers_`. **The claim it decides:** the harness is arranged to be
**running** at the documented port without anyone starting it — and the arrangement is complete enough to
hold on a machine that installs it, not only on this one.

It sits beside [`80-web-ui`](../80-web-ui/INDEX.md) because it judges a different thing. That part judges
the **server**: what it answers, on an ephemeral port and on the default. This part judges the **daemon**:
a definition, an installer, a supervisor that restarts it, and a liveness decision that a process name
cannot fake.

## Where it runs

**No browser.** The checks read the repository, the platform's supervisor and the port; nothing here needs
a display or a window. On macOS the supervisor is launchd, on Linux the systemd user manager; both are read
through [`_tools_/web-daemon/service.mjs`](../../_tools_/web-daemon/service.mjs), the reader
[`96-deployment`](../96-deployment/INDEX.md) uses too.

## What decides it

`check.mjs` has four checks, and they answer different questions:

1. **The agent definition is complete** — a launchd agent with a working directory, `KeepAlive`, a throttle,
   real log paths, the loopback host and a port placeholder; an installer that fails loudly, offers
   status/restart/uninstall, works twice, and resolves the real interpreter rather than handing launchd a
   shell shim. Judged from the repository, so it holds anywhere.
2. **The Linux unit definition is complete** — the same properties in systemd's words, read as values through
   a unit parser: the harness's launcher on loopback with a port placeholder and the profile named,
   `WorkingDirectory`, `Restart=always` at a fixed `RestartSec` with no start limit, logs appended to a file,
   `HEDDLE_HOME`, `WantedBy=default.target`; and an installer that reloads, enables, restarts, uninstalls
   with `--now` and checks lingering. Also judged from the repository.
3. **This machine runs it** — read from the supervisor and from the port, with the answer's service name
   checked, because something listening is not the same as *this* listening. The installed service must be
   written for the documented port — **3082 on macOS**, behind the 8082 gate, **8082 on Linux**, where the
   server itself owns the port the owner's SSH forward reaches — and its page and API must still refuse a
   request without a session. A host with no service installed reports **unjudged**.
4. **It stays up** — the process that **owns the port** is killed and required to be answering again within
   twenty seconds, from a new pid, which is the difference between "it is running" and "it will be running". The
   port owner is the server, so the kill is the one whose death is an outage; which layer replaces it is not this
   check's business — launchd, systemd, or [`supervisor.mjs`](../../_tools_/web-daemon/INDEX.md) inside the macOS
   agent, which exists because launchd on the owner's Mac was measured not to restart a loaded job at all. The
   kill is real: it interrupts the live service for a few seconds (3 s measured on the Linux host, and the Mac,
   2026-10-22).

## Judging it without killing the owner's server

Check 4 kills the process that owns the port, so run against the deployment it is an outage on the owner's page
(the ui lane gate stopped doing that under D-042). The same four checks judge a **scratch** service instead when
`HEDDLE_WEB_LABEL` names one: `_tools_/web-daemon/rehearse.sh` installs the deployment's definition as
`com.dtadpole.heddle-web.rehearsal` on port 3096 and runs this verifier against it as its last claim. Only a scratch
label lets `HEDDLE_WEB_PORT` set the documented port; with the deployment's label the port stays 3082 (macOS) or 8082
(Linux), so the environment cannot weaken the deployment's claim. Measured 2026-10-23 on the owner's Mac: 4 checks,
4 passed against the scratch service, while the live server kept its pid and token.

## The Rust branch

Part 11's Rust shape is the **same daemon pointed at the binary** (`rust/ULTIMATE_GOAL.md`): `HEDDLE_BIN` makes
`install.sh` render that binary as the program, with the same arguments, and the supervisor in front of it runs the
binary exactly as it runs node. Nothing in the definition is node-specific except the interpreter the installer
resolves. So the binary deployment needs no second definition and no second verifier: install with
`HEDDLE_BIN=/abs/path/heddle`, and checks 1 and 2 judge the rendered definition, checks 3 and 4 the service that is
installed. The served build is [`96-deployment`](../96-deployment/INDEX.md)'s claim, and it knows the binary serves
the repository's `src/server/page.html` rather than a `dist/` copy.

**The Rust branch today, rehearsed.** `HEDDLE_BIN=<binary> sh _tools_/web-daemon/rehearse.sh` installs exactly that
service on a scratch agent. Run 2026-10-22 at 21:23 PDT with the ui and backend lanes' release binary (sha256
`a355a0aa1fc4…`, built 21:14 PDT): **started failed** in 20 s, and the scratch log says why — `heddle: not ported to
Rust yet: web`, exit 2 after 4 ms, retried by the supervisor with backoff; the other five claims, this verifier's
four checks among them, are **unjudged**, because there is no server to judge. So part 11 through `HEDDLE_BIN` is
not met and cannot be judged until the binary serves `web`; when it does, the same command is the first reading, and
the deployment switches with `HEDDLE_BIN=… sh _tools_/web-daemon/install.sh --restart` from `~/heddle-live`.

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A host without the
service installed is the `3` case, and it says how to install it.

**Measured** on the Linux deployment host on 2026-10-22, against the hand-written unit `install.sh` now renders
(TypeScript build, `~/heddle-live`, 127.0.0.1:8082): 4 checks, 4 passed.

**Measured on the owner's Mac, 2026-10-22** — the deployment at `1bcff7e` with the agent running
[`supervisor.mjs`](../../_tools_/web-daemon/INDEX.md) in front of it: **4 checks, 4 passed**. Then with the agent
booted out, the same run answers **verdict 3** (`2 of 4 check(s) could not be judged`: the two definition checks
still judge the repository, and the live and stays-up checks skip) — an absent service is unjudged, never a pass.

## What it deliberately does not judge

- **That a browser renders the page.** The daemon is judged over HTTP; a browser is still the missing
  check, and the roadmap says so.
- **A supervisor the platform lacks.** launchd and systemd are the two this repository carries. The
  cron-plus-supervisord arrangement the convention describes is for hosts with neither, and it is not here.
- **Which checkout the service runs.** That is [`96-deployment`](../96-deployment/INDEX.md)'s claim.
- **The token.** Reading data still requires it, and that is [`90-web-ui-token`](../90-web-ui-token/INDEX.md)'s
  claim; this part only asserts that the daemon does not weaken it.

## Read next

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../_tools_/web-daemon/INDEX.md`](../../_tools_/web-daemon/INDEX.md) for the mechanism.
