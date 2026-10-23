---
title: Live health — the deployment at 127.0.0.1:8082
version: 1.1.0
description: What the live-monitor pass judges every 20 minutes, the topology it judges it through, and the pinned passes — the gate, the token door, the build marker, a streamed turn, a clean console, and the DSH reference.
level: L2
status: unverified
created: 2026-10-23T03:18:00Z
modified: 2026-10-23T03:35:00Z
grounded_in:
  - source: [hd] Live Monitor responsibilities, 2026-10-22
  - source: heddle-web-gate INDEX (dsh-web-ops), read 2026-10-22: 8082 is the token-supplying gate over heddle's 3082, token read from ~/.heddle/web.log
  - source: the pinned passes in live-health.jsonl, 2026-10-22
---

# Live health

The owner asked one seat to **watch the live deployment**: "drive `127.0.0.1:8082` with
`_tools_/browser-use` on a schedule, judge load-with-token, the build marker against the deployed
commit, a streamed turn, and a clean console, compare with DSH, and alert the owners of what breaks."
This file is that seat's record: what each pass judges, and what the passes measured.

The instrument is [`_tools_/live-health/probe.mjs`](../../_tools_/live-health/INDEX.md); each run
appends one JSON object to [`live-health.jsonl`](live-health.jsonl). A pass is pinned with its times,
so a later reader can tell a stale record from a live one — the page keeps changing while the port
number does not.

## The topology the pass judges

| Hop | Address | What it is | What breaks there |
|---|---|---|---|
| owner's URL | `http://127.0.0.1:8082/` | the **heddle Web Gate** (dsh-web-ops): reads the deployment's launch token, exchanges it for heddle's cookie, forwards to 3082 | `502` + `heddle-proxy: the upstream did not answer …` — the page the owner would see |
| deployment | `http://127.0.0.1:3082/` | the deployed server from `~/heddle-live` (detached at `origin/main`); its launch token is printed to `~/.heddle/web.log` | `401` + token form bare; `303` + cookie with the current token |
| reference | `http://127.0.0.1:8080/` | DSH, the UI this page follows | title, `window.__DSH_BOOT__`, composer, console |

The pass reads the launch token from `~/.heddle/web.log` — the same line the gate reads — rather than
from a file of its own: it is the credential the owner's URL is served with, and it keeps the
deployment checkout clean for `96-deployment`.

## What a pass decides

1. **gate** — `8082/` answers `200` with the app shell (`#log`, `#prompt textarea`, `#send`).
2. **door** — `3082/` refuses a bare request with `401` and the token form, and the current launch URL
   exchanges for a `303` with an `HttpOnly`, `SameSite=Strict` cookie. That is *load with the token*.
3. **marker** — the served `meta[name=heddle-page]` equals the first twelve hex of the sha256 of
   `~/heddle-live/dist/server/page.html`, which is how `markedPage` marks a build. The marker pins the
   **page bytes** to that checkout; the commit is pinned beside it (`HEAD`, `origin/main`, behind) and
   is deliberately not failed on lag — a deployment is allowed to trail main for one pass.
4. **turn** — one short prompt typed with trusted input, then the assistant row's text lengths as they
   grew. Recorded: user row, assistant row, the growth samples, time to first delta, time to settle.
5. **console** — error-level messages fail; warnings and verbose messages are kept as evidence. Read on
   load and again after the turn.
6. **DSH** — title, `window.__DSH_BOOT__` keys, composer count, console errors. Numbers only: a
   screenshot here would carry the owner's workspaces and session names into a public repository.

## Pinned passes

Times are PDT. `pass` = every judged check passed; `fail` = one failed; `----` = unjudged (the address
did not answer, or no token was readable). The full record is [`live-health.jsonl`](live-health.jsonl).

| At | Deployment | Gate | Door | Load | Marker | Turn | Console | Verdict |
|---|---|---|---|---|---|---|---|---|
| 20:15:44 (manual) | `a5b0c66`, clean, main tip | `200` app shell | — | app served | `dd6d45d28567` = built page | — | — | observed serving |
| 20:18:14 | `a5b0c66` | **`502`** upstream refused | `----` 3082 down | `----` | `----` | `----` | `----` | **fail** — flap |
| 20:21:30 | `a5b0c66` | pass | pass | pass | pass | **fail** — no answer, no notice | pass | **fail** |
| 20:24:14 | `a5b0c66` | pass | pass | pass | pass | **fail** — no answer | pass | **fail** |
| 20:25:44 | `a5b0c66` | pass | pass | pass | pass | **fail** — no answer | pass | **fail** |
| 20:28:29 | `a5b0c66` | pass | pass | pass | pass | **fail** — no answer | pass | **fail** |
| 20:29:28 | `b4f8abf` | pass | pass | pass | pass | **fail** — no answer | pass | **fail** |
| 20:31:01 | `eaaa6bb` | pass | pass | pass | pass | pass — reused session, 2 chunks | pass | **pass** |
| 20:32:04 | `eaaa6bb` | pass | pass | pass | pass | pass — 2 chunks | pass | **pass** |
| 20:34:03 | `eaaa6bb` | pass | pass | pass | pass | pass — 2 chunks, fixture reply | pass | **pass** |

**The flap.** 20:15:44 the gate served the app; 20:16:49 it answered `502` with
`heddle-proxy: the upstream did not answer (ECONNREFUSED 127.0.0.1:3082)`. `~/.heddle/guard.log` reads
`2026-10-23T03:21:41Z port 3082 silent, kickstarting`: launchd on this Mac loads the agent but never
restarts it, and live-deploy's interim guard brought 3082 back. Not a build fault; the deployment's
supervisor fix is in `hd/live-deploy` awaiting merge.

**The turns that failed.** From 20:21 to 20:29 a turn drew the user row and nothing else — no answer,
no notice, a clean console. The deployment's own session log recorded `model/request
endpoint=scripted` then `compaction/recovery code=SCRIPT retry=false reason='not a window overflow'`,
which is what `src/context/service.ts` appends on a non-window `agent/request-error`. The cause was
configuration, not the build: the default `scripted` endpoint resolves `scripted.json` from the
server's cwd, `~/heddle-live` carries no such file, and invoking the deployed adapter says exactly
`the script for 'scripted' could not be read at scripted.json`. Live-deploy fixed it by decision
(D-030) with two files **outside** the checkout — `~/.heddle/deployment-scripted.json` and
`~/.heddle/heddle.json` — so turns now answer with a labelled offline fixture whose first line is
`scripted endpoint: offline fixture reply, not a model`. The record keeps that line
(`answerHead`) so a pass can show that no model answered.

**The note that overstated a pass.** The 20:21:30 entry first read "first healthy pass" while its own
`turn` check said `fail`; the coordinator's review caught the contradiction (20:27) and the note was
corrected in the record. A note must never be kinder than the checks.

**One health session, not one per pass.** The pass continues the session titled
`live health check …` (the composer's turned into it; the tree row is clicked when drawn, and the
page's own `showSession` selects it when it is not), so the owner's session list does not fill with
monitor rows.

**What the record does not carry.** No session ids and no absolute home paths: the repository is
public, paths are stated under `~`, and the repository's public-hygiene gate checks both before main.

## The DSH reference, measured

| Taken | Page | Measured |
|---|---|---|
| 2026-10-22 20:18 | `http://127.0.0.1:8080/` | title `DeepSeek Harness`; `window.__DSH_BOOT__` keys `rev`, `release`, `entries`, `batches`; 1 composer; 0 console errors |

The heddle page follows DSH for the composer, tree, trajectory and access control; the comparison
method is the seat's `ui-comparison` baseline, numbers only, recorded in
[`INDEX.md`](INDEX.md) and the parity skill.

## How often

A `schedule_create` in this seat fires **every 20 minutes**: it runs the pass, pins the entry, and reports
only on a change — a new failure or a recovery goes to live-deploy, integrator-two and the coordinator
with the pinned numbers; a failure already reported is not re-alerted. A deployment that does not answer
at all is reported to live-deploy as **not up yet**, not as an alert, while it is being brought up.

## Read next

[`INDEX.md`](INDEX.md) for the pinned browser baselines; [`live-health.jsonl`](live-health.jsonl) for
every pass; [`../../_tools_/live-health/INDEX.md`](../../_tools_/live-health/INDEX.md) for the
instrument.
