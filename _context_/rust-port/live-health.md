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
2. **process** — the process answering `3082` runs **this checkout's** `dist/cli.js`, read from
   `lsof` + `ps`. The marker binds the page bytes to a build; only the listener's command line binds
   the running process to the checkout, so a half-reloaded or repointed service is caught between two
   20-minute passes. A `heddle` binary instead of the checkout is unjudged here, not failed.
3. **door** — `3082/` refuses a bare request with `401` and the token form, and the current launch URL
   exchanges for a `303` with an `HttpOnly`, `SameSite=Strict` cookie. That is *load with the token*.
4. **marker** — the served `meta[name=heddle-page]` equals the first twelve hex of the sha256 of
   `~/heddle-live/dist/server/page.html`, which is how `markedPage` marks a build. The marker pins the
   **page bytes** to that checkout; the commit is pinned beside it (`HEAD`, `origin/main`, behind) and
   is deliberately not failed on lag — a deployment is allowed to trail main for one pass.
5. **turn** — one short prompt typed with trusted input, then the assistant row's text lengths as they
   grew. Recorded: user row, assistant row, the growth samples, time to first delta, time to settle.
6. **console** — error-level messages fail; warnings and verbose messages are kept as evidence. Read on
   load and again after the turn.
7. **DSH** — title, `window.__DSH_BOOT__` keys, composer count, console errors. Numbers only: a
   screenshot here would carry the owner's workspaces and session names into a public repository.

## Pinned passes

**The record is [`live-health.jsonl`](live-health.jsonl)**, appended by the scheduled pass every 20
minutes. Read it as a table with `node _tools_/live-health/summary.mjs` (`--last=12` for the newest);
the table is derived from the record, so it cannot fall behind it. The table below is the first evening
written by hand, kept for its annotations, and it stops at 20:34.

Times are PDT. `pass` = every judged check passed; `fail` = one failed (a dead address is a failure,
not an unknown); `----` = unjudged, a check that could not be decided although the deployment answered
(no built page to compare, no token readable).

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

**Open finding, ui lane: a failed model call is silent.** Passes 20:21 to 20:29 showed what a person
sees when the model boundary fails: the user row, then nothing — no answer row, no turn notice, a clean
console. The server recorded the failure (`compaction/recovery code=SCRIPT`) and the `/api/turn` stream
ended after the user event without an error event. The deployment cause is fixed (the fixture answers),
but the UI gap remains: a turn that fails at the model boundary should become a visible row or notice.
Reported to integrator-two with the evidence on 2026-10-22; owned by the ui lane, not by this seat.

**Two fields in the early entries are historical.** Passes before 2c8168e record `gate.proxyError:
true` with `firstLine: "<!doctype html>"`, because the healthy app shell contains the word
`heddle-proxy` once and the check matched the word rather than the gate's own 5xx sentence; and their
`turn.samples` describe the previous answer, because the turn had no baseline in the reused session.
The verdicts were unaffected (the gate still passed on `200` plus the app shell, and the turn's pass
needed the deployment's own chunk count), but the two fields were wrong. They are not rewritten in
place — a published record is not edited — and every pass from 2c8168e on carries the corrected
fields, with the rules and their tests deciding them.

**What the record does not carry.** No session ids and no absolute home paths: the repository is
public, paths are stated under `~`, and the repository's public-hygiene gate checks both before main.

## The DSH reference, measured

| Taken | Page | Measured |
|---|---|---|
| 2026-10-22 20:18 | `http://127.0.0.1:8080/` | title `DeepSeek Harness`; `window.__DSH_BOOT__` keys `rev`, `release`, `entries`, `batches`; 1 composer; 0 console errors |

The heddle page follows DSH for the composer, tree, trajectory and access control; the comparison
method is the seat's `ui-comparison` baseline, numbers only, recorded in
[`INDEX.md`](INDEX.md) and the parity skill. The counts move with **content** — each session in the
tree is a treeitem and each turn adds message controls — so a pass compares them at equal content, and
a move at equal content is the finding that goes to the ui lane. Measured flat (no session selected):
heddle 46 interactive / 18 enabled; DSH 139 / 17, with DSH's 1 hit-test miss and 1 clip on its own
gated surfaces.

## The monitor does not restore (D-045)

For a few hours on 2026-10-22 live-deploy delegated one action to this seat — a `launchctl kickstart`
when the deployment was down — and the record of that period is kept because it is why the delegation
ended:

- **03:42:20** — a pass found 3082 silent inside live-deploy's install window and kickstarted it
  (507 ms). The same pass then failed the door `401`: it still held the pre-restart launch token. That
  failure was the instrument's; the entry was removed rather than pinned as a deployment fault, and the
  pass now re-reads the token after any restart it observes.
- **03:54:07** — a manual smoke test ran with `--restore` six seconds after the deployment's page was
  rebuilt; `kickstart -k` SIGKILLed the server live-deploy's install had just started (`web.log`:
  *"node exited (SIGKILL) after 5380 ms"*).
- **03:57:36–03:58:47** — about 70 s without a server. live-deploy has since measured the cause: their
  own deliberate `kickstart -k` of a four-second-old job (to measure launchd's 10 s ThrottleInterval),
  extended by a reinstall that refused to render because main moved under it (fixed on their branch:
  render before bootout). The "~15 s to listen" this record first gave was that throttle wait, not the
  server's start time; a reinstall's measured silence is 288–364 ms. Nothing was run by this seat.

Three outages that night came from extra restorers and killers, so the coordinator's **D-045** gives the
live page one restore chain — the supervisor, then live-deploy's job-aware guard — and this seat
observes, pins and alerts. The restore code was removed from the probe, not disabled. An outage is
alerted to live-deploy with the agent's state, and to the coordinator if it lasts past one pass.

## Restarts are recorded, not alerted

live-deploy measured why short 502s happen now: the supervisor restarts a killed server in about a
second, and integrator-two's lane gate runs `95-web-daemon`, whose stays-up check kills the process on
the port. Since 2026-10-22 a pass watches any down reading for 20 s before pinning it; one that answers
again is recorded as `outage.kind = restart` with its recovery time and is not a failure. Restarts in
three consecutive passes would be a crash loop and are reported as one.

## How often

A `schedule_create` in this seat fires **every 20 minutes**: it runs the pass, pins the entry, and reports
only on a change — a new failure or a recovery goes to live-deploy, integrator-two and the coordinator
with the pinned numbers; a failure already reported is not re-alerted. A deployment that does not answer
at all is reported to live-deploy as **not up yet**, not as an alert, while it is being brought up.

## Read next

[`INDEX.md`](INDEX.md) for the pinned browser baselines; [`live-health.jsonl`](live-health.jsonl) for
every pass; [`../../_tools_/live-health/INDEX.md`](../../_tools_/live-health/INDEX.md) for the
instrument.
