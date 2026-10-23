---
title: Verifier 15 — Deployment
version: 1.4.0
description: the page the owner actually sees is the deployment checkout's build, served by a process running that checkout, and that checkout contains only committed main — on macOS behind the gate, on a Linux host behind the owner's SSH forward, with the TypeScript build or the binary HEDDLE_BIN names.
grounded_in:
  - source: owner statement 2026-10-17 that a worktree may carry initial verification but the job is not done until merged to main and the deployment is verified
  - source: owner report 2026-10-17 that the composer footer was not visible while every suite was green, because port 8082 served another worktree's build
  - source: the Rust port's deployment work, 2026-10-22, moving the deployment to a Linux host (~/heddle-live, 127.0.0.1:8082) reached from the owner's Mac through an SSH forward on 8081
---

# `96-deployment`

Instance of this project's `_verifiers_`. **The claim it decides:** the deployment the owner uses is **the
installed service's checkout's build** — the process behind the service's port runs that checkout's build, the page
the owner's URL answers with is that checkout's page byte for byte, and that checkout contains only committed
`main`.

The checkout is read from the installed service — the launchd agent's `ProgramArguments` on macOS, the systemd
user unit's `ExecStart` and `WorkingDirectory` on Linux, both through
[`_tools_/web-daemon/service.mjs`](../../_tools_/web-daemon/service.mjs) — not from the repository this check runs
in, so the same fact is judged from any working checkout.

It sits beside [`95-web-daemon`](../95-web-daemon/INDEX.md): that part judges that a daemon definition exists
and recovers; this part judges **which checkout the running daemon serves**. The two failures look identical
from the source tree, which is exactly why the second one needs its own instrument.

## Where it runs

**No browser, no build.** It reads the process owning the service's port (`lsof`/`ps` on macOS, `ss`/`/proc` on
Linux) and compares one HTTP response with the built page on disk. The served page is read per request by the
server, so a byte comparison is a statement about the deployment, not about timing.

## The checks

| Check | The claim |
|---|---|
| the live service runs the deployment checkout's build | the process listening on the service's port executes that checkout's `dist/cli.js`, or the binary the service names; on Linux it must also be inside `heddle-web.service`'s control group, so a server started by hand from the same checkout does not pass |
| the page the owner sees is this build | the owner's URL answers 200 with exactly that checkout's page — `dist/server/page.html` for the TypeScript build, `src/server/page.html` for the binary — with only its `heddle-page` marker filled in |
| the deployment checkout contains only committed main | that checkout is on `main` at its tip, **or detached exactly at `origin/main`**, and `git status --porcelain` is empty |

**A supervisor in front of the server does not change the claim.** The macOS agent runs
[`supervisor.mjs`](../../_tools_/web-daemon/INDEX.md), so the process launchd owns is not the process that serves.
The check reads the command line after the supervisor's `--` and the pid that owns the port, because those are the
process and the build the deployment claims; reading the front of the command line would make `node` the entry and
pass for any node process on the machine.

**The owner's URL.** On macOS the service sits on 3082 behind the gate on `http://127.0.0.1:8082/`, and the gate
is what is fetched. On a Linux host nothing fronts the server: it owns 8082, the port the owner's SSH forward
(`127.0.0.1:8081` on the owner's machine) reaches, and the forward's local end is out of the host's sight. There
the check opens a session the way a browser does — the newest launch token from the service's own log, exchanged
for the cookie — and compares the page the forward carries.

**Detached at `origin/main`.** A deployment *worktree* cannot be on `main`: git checks a branch out in one
worktree at a time, and the base clone holds it. Such a checkout passes only when HEAD is exactly the fetched
`origin/main`, which is stricter than a local `main` that can lag the remote. Measured on 2026-10-22: the Linux
deployment failed this check when another seat moved `main` (`detached at a8b08b7c403f, not at origin/main
8dbdcf83158f`) and passed again after the redeploy.

On a machine with no installed service or no live service every check reports **unjudged** (the project's 3): an
unobservable deployment is not a verified one, and silently passing would be the same mistake as calling a green
branch a deployment.

The third check is the owner's 2026-10-17 rule made mechanical: when the main working checkout is not clean, the
daemon must run from a folder that contains only committed main (a checkout outside the main working tree, e.g. `~/heddle-deploy`; the Linux deployment host: `~/heddle-live`). The installer refuses a non-main or dirty checkout, and this check fails one if
it is nonetheless served.

**Measured on the owner's Mac, 2026-10-22, 20:2x PDT** — the TypeScript build **as the oracle**, `~/heddle-live`
detached at `a5b0c66` (= `origin/main`), clean, built with `npm run build`, the agent `com.dtadpole.heddle-web` on
3082 and the gate on 8082:

```bash
cd ~/heddle-live && sh _verifiers_/96-deployment/verify.sh
# this branch's checks: 3 checks, 3 passed
# main's checks at a5b0c66: 2 passed, 1 failed — the third, "on main (it is on HEAD)"
```

The served page was 533,283 bytes against `dist/server/page.html` at 533,280: the 3-byte difference is the
`heddle-page` marker filled with `dd6d45d28567`, which is this build's own sha256 prefix. The one failure with
main's check is the deployment worktree's detached HEAD, which is the shape D-015 accepted and this branch's
third check reads as `detached exactly at origin/main`.

**Measured on the Linux deployment host on 2026-10-22** — that host's earlier arrangement (TypeScript build,
`~/heddle-live` detached at `origin/main`, the server owning 127.0.0.1:8082 behind the owner's SSH forward): 3
checks, 3 passed.

**Measured on the owner's Mac again after the tooling merge reached main** (deployment at `1bcff7e`, the agent
running `supervisor.mjs`): **3 checks, 3 passed** from `~/heddle-live`, and with the agent booted out the same run
answers **verdict 3** (`2 of 3 could not be judged`: the checkout check still passes, the live-service and page
checks skip). That is the third check passing on `main` for the first time — before this merge the check demanded a
local branch `main` that a deployment worktree cannot hold.

## Why this exists

The composer's bottom statistics were implemented, every suite was green, and the owner reported twice that
the footer was not visible: the launchd service had been repointed to another worktree and the 8082 proxy
faithfully served that build. The convention this verifier judges is
[`../../_conventions_/landed-and-deployed/`](../../_conventions_/landed-and-deployed/INDEX.md).
