---
title: Web daemon rehearsal rules
version: 1.1.0
description: Component tests for rehearse.sh's refusals — a rehearsal pointed at the deployment's label, unit or ports, or at a port already in use, refuses before it calls anything.
grounded_in:
  - source: _tools_/web-daemon/rehearse.sh
  - source: the coordinator's rule of 2026-10-23 that experiments run on a scratch agent, never on the live one
---

# `rehearse-rules`

[`rehearse.sh`](../../rehearse.sh) installs the deployment's definition under a scratch label, port, state
directory and log, measures the claims the deployment depends on, and removes everything. The measurements need a
real launchd and are made on the host; what these tests judge is the part that must never fail open: **a rehearsal
aimed at the deployment refuses before it calls anything.**

| Case | Expected |
|---|---|
| label `com.dtadpole.heddle-web` or unit `heddle-web.service` | exit 2, no platform command called |
| port 3082 or 8082, or a port that is not a number | exit 2, no platform command called |
| a port something already answers on | exit 2, no agent file written |
| `--cleanup` with nothing installed; an unknown option | exit 0 with a sentence; exit 2 |
| a platform with no supervisor | exit 3, unjudged |
| a service that never answers (the Rust binary's `web` today) | `started` failed, the other claims unjudged, exit 1, and the scratch agent removed |

```bash
node --test _tools_/web-daemon/_tests_/rehearse-rules/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
