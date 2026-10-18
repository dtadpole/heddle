---
title: Verifier 15 — Deployment
version: 1.1.0
description: the page the owner actually sees is the deployment checkout's build, served by a process running that checkout, and that checkout contains only committed main.
grounded_in:
  - source: owner statement 2026-10-17 that a worktree may carry initial verification but the job is not done until merged to main and the deployment is verified
  - source: owner report 2026-10-17 that the composer footer was not visible while every suite was green, because port 8082 served another worktree's build
---

# `96-deployment`

Instance of this project's `_verifiers_`. **The claim it decides:** the deployment the owner uses is **the
installed agent's checkout's build** — the process behind the documented service port runs that checkout's
`dist/cli.js`, the page the owner's URL answers with is that checkout's `dist/server/page.html` byte for byte, and
that checkout contains only committed `main` (branch `main`, HEAD at its tip, no uncommitted changes).

The checkout is read from the installed agent's `ProgramArguments`, not from the repository this check runs in, so
the same fact is judged from any working checkout.

It sits beside [`95-web-daemon`](../95-web-daemon/INDEX.md): that part judges that a daemon definition exists
and recovers; this part judges **which checkout the running daemon serves**. The two failures look identical
from the source tree, which is exactly why the second one needs its own instrument.

## Where it runs

**No browser, no build.** It reads `lsof`/`ps` for the live process and compares one HTTP response with the
built page on disk. The served page is read per request by the server, so a byte comparison is a statement
about the deployment, not about timing.

## The checks

| Check | The claim |
|---|---|
| the live service runs the deployment checkout | the process answering on 3082 executes the agent's checkout's `dist/cli.js` |
| the page the owner sees is this build | `http://127.0.0.1:8082/` answers 200 with exactly that checkout's `dist/server/page.html` |
| the deployment checkout contains only committed main | that checkout is on `main`, its HEAD is main's tip, and `git status --porcelain` is empty |

On a machine with no installed agent or no live service every check reports **unjudged** (the project's 3): an
unobservable deployment is not a verified one, and silently passing would be the same mistake as calling a green
branch a deployment.

The third check is the owner's 2026-10-17 rule made mechanical: when the main working checkout is not clean, the
daemon must run from a folder that contains only committed main (this machine: `/Users/zhenc/heddle-deploy`). The
installer refuses a non-main or dirty checkout, and this check fails one if it is nonetheless served.

## Why this exists

The composer's bottom statistics were implemented, every suite was green, and the owner reported twice that
the footer was not visible: the launchd service had been repointed to another worktree and the 8082 proxy
faithfully served that build. The convention this verifier judges is
[`../../_conventions_/landed-and-deployed/`](../../_conventions_/landed-and-deployed/INDEX.md).
