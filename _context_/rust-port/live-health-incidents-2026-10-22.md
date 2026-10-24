---
title: Live health - incidents of 2026-10-22
level: L2
version: 1.2.0
description: What went wrong on the first evening of live monitoring - in the deployment, in the monitor's own actions and in the instrument - with the evidence and the fix for each.
status: unverified
grounded_in:
  - source: the passes pinned in live-health.jsonl on 2026-10-22
  - source: the deployment's web.log, guard.log and session logs, read that evening
  - source: live-deploy's measurements, reported through the team inbox
created: 2026-10-23T05:10:55Z
modified: 2026-10-24T06:05:05Z
---

# Incidents of 2026-10-22

Times are UTC; the passes are in [`live-health.jsonl`](live-health.jsonl), read through
[`live-health.md`](live-health.md).

## In the deployment

- **03:16:49-03:21:41, the server down.** Gate `502`, ECONNREFUSED on 3082: live-deploy's
  cleanup of a hand-started probe killed the agent's process, which launchd here does not restart; their
  interim guard kickstarted it (`guard.log`).
- **03:21-03:29, silent turns.** The session log shows `model/request endpoint=scripted`, then
  `compaction/recovery code=SCRIPT`: the default endpoint reads `scripted.json` from the server's directory,
  which the checkout lacks. D-030 gave it an offline fixture at 03:34. **Open for the ui lane:** a failed model call
  renders as silence (reported to integrator-two).
- **03:57:36-03:58:47, about 70 s down.** live-deploy's `kickstart -k` of a four-second-old job met
  launchd's 10 s throttle and a reinstall refused to render; fixed on their side. A reinstall's gap is
  288-364 ms.

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
