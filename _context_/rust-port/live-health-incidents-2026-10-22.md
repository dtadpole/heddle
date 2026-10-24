---
title: Live health - incidents of 2026-10-22
level: L2
version: 1.3.0
description: What went wrong on the first evening of live monitoring - in the deployment, in the monitor's own actions and in the instrument - with the evidence and the fix for each.
status: unverified
grounded_in:
  - source: the passes pinned in live-health.jsonl on 2026-10-22
  - source: the deployment's web.log, guard.log and session logs, read that evening
  - source: live-deploy's measurements, reported through the team inbox
created: 2026-10-23T05:10:55Z
modified: 2026-10-24T06:13:36Z
---

# Incidents of 2026-10-22

Times are UTC; the passes are in [`live-health.jsonl`](live-health.jsonl), read through
[`live-health.md`](live-health.md). The deployment's incidents - the 03:16 and 03:57 outages, the silent turns
before D-030 - are live-deploy's record,
[`deployment-incidents-2026-10-22.md`](deployment-incidents-2026-10-22.md) (PDT), measured in
[`deployment-measurements-2026-10-22.md`](deployment-measurements-2026-10-22.md). This record keeps what the
monitor alone saw or did.

## What the monitor saw

- **03:21-03:29, silent turns.** With a clean console, the session log showed `model/request
  endpoint=scripted`, then `compaction/recovery code=SCRIPT`. **Open for the ui lane:** a failed model call
  renders as silence (reported to integrator-two).

## In the monitor's own actions

- **03:42:20** a pass kickstarted 3082 inside live-deploy's install window (507 ms); **03:54:07** a manual
  restore run SIGKILLed the server that install had just started (`web.log`, "exited (SIGKILL) after
  5380 ms"). This ended the monitor's restore authority: D-045 keeps one restore chain, and the kickstart
  left the tool. The 03:21:30 note had called a pass healthy while its turn failed; corrected on review.
- **06:48 and 07:08 the next day** the preview's first turns typed into the page's selected session and
  landed in live-deploy's test sessions `store check 2` and `check at 00:04`. Paused at 07:10, the sessions
  left to their owner; since 07:13 the probe starts its own session and proves the landing.

## In the instrument

| Hole | Effect | Fixed in |
|---|---|---|
| the door judged with the token read before a restart | a false `401`, removed | `101b2c5` |
| `heddle-proxy` matched as a word | every healthy pass pinned `proxyError: true` | `2c8168e` |
| no baseline for the turn in the reused session | samples and answer head from the previous turn | `2c8168e` |
| an unreadable console folded into a pass | unjudged read as clean | `2c8168e` |
| the restart watch polled only 3082 | a dead gate would read as a 0 ms restart | `f7e3060` |
| a new turn typed into the selected session | two preview turns in another seat's sessions | `7e543ca` |
