---
title: Rust port browser baselines
version: 0.5.0
description: The pinned reference pages the Rust port's Web UI is compared against - the TypeScript heddle page and DSH - measured with the browser-use tool, numbers only, and the records of the live deployment and its monitor.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-22, asking that heddle be verified with the browser-use tool and compared with DSH on localhost 8080 where needed
  - source: rust/ULTIMATE_GOAL.md, parts 9 to 11
created: 2026-10-23T00:39:00Z
modified: 2026-10-24T06:13:36Z
---

# Rust port browser baselines

The Rust port serves the **same page** as the TypeScript build, so its Web UI is judged against two pinned
references: the TypeScript page, the oracle while the port is incomplete, and DSH where the page follows it.
Each baseline names its build, because a stale page and a missing feature look alike.

**Surface: headless**, captured with `_tools_/browser-use` (`--session=hd-rust`). **Numbers
only**: captures show the owner's workspace and session names, kept out of this public repository.

## Baselines

| Taken | Page | URL | Build | Measured |
|---|---|---|---|---|
| 2026-10-22 | TypeScript heddle, live | `http://localhost:8082/` | page marker `dd6d45d28567` | title `Heddle`; 53 tree items; composer; seat in the composer |
| 2026-10-22 | DSH reference | `http://127.0.0.1:8080/` | `__DSH_BOOT__` keys `rev`, `entries`, `batches` | title `DeepSeek Harness`; no token wall; 10 workspaces; composer |
| 2026-10-22 | TypeScript stand-in on the build host, forward gone (D-020) | `http://localhost:8081/` | page marker `dd6d45d28567` | 401 without the token; with it title `Heddle`, composer, no workspaces, seat `scripted` |
| 2026-10-23 | Rust heddle preview | `http://127.0.0.1:3097/` | page marker `dd6d45d28567` | judged every pass in [`live-health`](live-health.md) |

## Records

- [`deployment-2026-10-22.md`](deployment-2026-10-22.md) — live-deploy's deployment record, with its
  [log](deployment-2026-10-22-log.jsonl), [incidents](deployment-incidents-2026-10-22.md) and
  [measurements](deployment-measurements-2026-10-22.md).
- [`live-health.md`](live-health.md) — how to read the monitor's record, [`live-health.jsonl`](live-health.jsonl).
- [`live-health-incidents-2026-10-22.md`](live-health-incidents-2026-10-22.md) — the monitor's incidents that evening.

## Read next

[`../../rust/ULTIMATE_GOAL.md`](../../rust/ULTIMATE_GOAL.md) for what the port must satisfy;
[`../../rust/INDEX.md`](../../rust/INDEX.md) for the build host.
