---
title: Verifier 15 — Deployment
version: 1.0.0
description: the page the owner actually sees is the main checkout's build, served by a process running that checkout.
grounded_in:
  - source: owner statement 2026-10-17 that a worktree may carry initial verification but the job is not done until merged to main and the deployment is verified
  - source: owner report 2026-10-17 that the composer footer was not visible while every suite was green, because port 8082 served another worktree's build
---

# `96-deployment`

Instance of this project's `_verifiers_`. **The claim it decides:** the deployment the owner uses is **this
checkout's build** — the process behind the documented service port runs `/Users/zhenc/heddle/dist/cli.js`, and
the page the owner's URL answers with is `/Users/zhenc/heddle/dist/server/page.html`, byte for byte.

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
| the live service runs this checkout | the process answering on 3082 executes this checkout's `dist/cli.js` |
| the page the owner sees is this build | `http://127.0.0.1:8082/` answers 200 with exactly this checkout's `dist/server/page.html` |

On a machine with no live service both checks report **unjudged** (the project's 3): an unobservable deployment
is not a verified one, and silently passing would be the same mistake as calling a green branch a deployment.

## Why this exists

The composer's bottom statistics were implemented, every suite was green, and the owner reported twice that
the footer was not visible: the launchd service had been repointed to another worktree and the 8082 proxy
faithfully served that build. The convention this verifier judges is
[`../../_conventions_/landed-and-deployed/`](../../_conventions_/landed-and-deployed/INDEX.md).
