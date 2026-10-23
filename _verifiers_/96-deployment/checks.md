---
title: 96-deployment — the three checks and the rules behind them
created: 2026-10-23T04:42:38Z
modified: 2026-10-23T04:42:38Z
level: L3
version: 1.0.0
description: What each check in check-deployment.mjs asserts, where the owner's URL is on each platform, and why a detached checkout, a supervisor and a scratch environment do not change the claim.
status: unverified
grounded_in:
  - source: _verifiers_/96-deployment/check-deployment.mjs and _tools_/web-daemon/service.mjs
  - source: D-015, a deployment worktree detached at origin/main
---

# The three checks and the rules behind them

| Check | Asserts |
|---|---|
| the live service runs the deployment checkout's build | the process owning the service's port executes that checkout's `dist/cli.js`, or the binary the service names; on Linux it is also inside `heddle-web.service`'s control group, so a hand-started server from the same checkout fails |
| the page the owner sees is this build | the owner's URL answers 200 with exactly that checkout's page (`dist/server/page.html` for the TypeScript build, `src/server/page.html` for the binary), only its `heddle-page` marker filled with the file's own sha256 prefix |
| the checkout contains only committed main | on `main` at its tip, or detached exactly at `origin/main`, with `git status --porcelain` empty |

**The checkout comes from the installed service** — the agent's `ProgramArguments`, or the unit's `ExecStart` and
`WorkingDirectory` — not from the repository the check runs in, so any checkout judges the same fact.

**The owner's URL.** On macOS the gate at `http://127.0.0.1:8082/` is fetched. On Linux the server owns 8082 behind
the owner's SSH forward, so the check opens a session with the newest launch token from the service's log.

**Detached at `origin/main`** is the only shape a deployment worktree can have: git checks a branch out in one
worktree, and the base clone holds `main`. HEAD must equal the fetched tip, which is stricter than a local `main`. Any
seat's fetch moves that tip, so a deployment one commit behind fails until it is redeployed. The installer refuses any other shape;
this check fails one that is served anyway.

**A supervisor does not change the claim.** The command line after `supervisor.mjs --` and the pid that owns the port
are what is judged; the front of the command line would make `node` the entry and pass for any node process.

**Always the deployment.** The scratch overrides (`HEDDLE_WEB_LABEL`, `HEDDLE_WEB_UNIT`) are blanked here, so a run
from a rehearsal's environment still reads the deployment's agent.

**Unjudged, never passing.** With no installed or no live service every check reports 3, because an unobservable
deployment is not a verified one.
