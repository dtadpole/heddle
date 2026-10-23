---
title: Live health - incidents of 2026-10-22
level: L2
version: 1.0.0
description: What went wrong on the first evening of live monitoring - in the deployment, in the monitor's own actions and in the instrument - with the evidence and the fix for each.
status: unverified
grounded_in:
  - source: the passes pinned in live-health.jsonl on 2026-10-22
  - source: the deployment's web.log, guard.log and session logs, read that evening
  - source: live-deploy's measurements, reported through the team inbox
created: 2026-10-23T05:10:55Z
modified: 2026-10-23T05:10:55Z
---

# Incidents of 2026-10-22

Times are UTC; the full passes are in [`live-health.jsonl`](live-health.jsonl).

## In the deployment

- **03:16:49-03:21:41, the server down.** The gate answered `502` (ECONNREFUSED on 3082). live-deploy's
  cleanup of a hand-started probe also killed the agent's process, and launchd here does not restart a
  loaded agent; their interim guard kickstarted it (`guard.log`, 03:21:41Z).
- **03:21-03:29, turns that answered nothing.** The user row appeared, then nothing, with a clean console.
  The session log recorded `model/request endpoint=scripted`, then `compaction/recovery code=SCRIPT`: the
  default endpoint reads `scripted.json` from the server's directory, which the checkout lacks. D-030 gave
  the deployment a labelled offline fixture outside the checkout at 03:34; its answer begins
  `scripted endpoint: offline fixture reply, not a model`. **Open for the ui lane:** a failed model call
  renders as silence (reported to integrator-two).
- **03:57:36-03:58:47, about 70 s without a server.** live-deploy's deliberate `kickstart -k` of a
  four-second-old job (launchd's 10 s throttle) and a reinstall that refused to render; fixed on their side.
  A reinstall's silence measures 288-364 ms.

## In the monitor's own actions

- **03:42:20** - a pass kickstarted 3082 inside live-deploy's install window (507 ms).
- **03:54:07** - a manual run with the restore flag, six seconds after the page was rebuilt, SIGKILLed the
  server that install had just started (`web.log`, "exited (SIGKILL) after 5380 ms").

These ended the monitor's restore authority: D-045 gives the live page one restore chain, and the kickstart
was removed from the tool. The note pinned at 03:21:30 first called a pass healthy while its turn had
failed; it was corrected after the coordinator's review.

## In the instrument

| Hole | Effect | Fixed in |
|---|---|---|
| the door judged with the token read before a restart | a false `401`; that entry was removed | `101b2c5` |
| `heddle-proxy` matched as a word | every healthy pass pinned `proxyError: true` | `2c8168e` |
| no baseline for the turn in the reused session | samples and answer head from the previous turn | `2c8168e` |
| an unreadable console folded into a pass | unjudged read as clean | `2c8168e` |
| the restart watch polled only 3082 | a dead gate would have been a 0 ms "restart", never alerted | `f7e3060` |

## Read next

[`live-health.md`](live-health.md).
