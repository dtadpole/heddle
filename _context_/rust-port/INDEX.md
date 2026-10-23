---
title: Rust port browser baselines
version: 0.3.0
description: The pinned reference pages the Rust port's Web UI is compared against - the TypeScript heddle page and DSH - measured with the browser-use tool, numbers only, and the records of the live deployment and its monitor.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-22, asking that heddle be verified with the browser-use tool and compared with DSH on localhost 8080 where needed
  - source: rust/ULTIMATE_GOAL.md, parts 9 to 11
created: 2026-10-23T00:39:00Z
modified: 2026-10-23T05:10:55Z
---

# Rust port browser baselines

The Rust port serves the **same page** as the TypeScript build, so its Web UI is judged against two pinned
references: the TypeScript page, the oracle while the port is incomplete, and DSH where the page follows it.
Each baseline records its build, because a stale page and a missing feature look alike.

**Browser mode: headless** — captured with `node _tools_/browser-use/cli.mjs --session=hd-rust`, started
with `--headless`.

**Numbers only, no screenshots here.** A capture of either page shows the owner's workspace and session
names, which this public repository does not carry; the images are kept in the owner's private records,
and what is cited from them is written below.

## Baselines

| Taken | Page | URL | Build pinned by | Measured |
|---|---|---|---|---|
| 2026-10-22 | TypeScript heddle, deployed on the Mac | `http://localhost:8082/` | `meta[name=heddle-page]` = `dd6d45d28567` | title `Heddle`; 53 tree items; composer present; seat shown in the composer |
| 2026-10-22 | DSH reference | `http://127.0.0.1:8080/` | `window.__DSH_BOOT__` keys `rev`, `entries`, `batches` | title `DeepSeek Harness`; no token wall; 10 workspaces; composer present |
| 2026-10-22 | TypeScript build as a stand-in on the build host, through the forward | `http://localhost:8081/` | `meta[name=heddle-page]` = `dd6d45d28567` | 401 without the token; with it title `Heddle`, composer present, no workspaces, seat `scripted` |
| — | Rust heddle, same address | `http://localhost:8081/` | `meta[name=heddle-page]` | not yet served |

The `8081` forward is gone with the devservers (D-020); the live address is `http://127.0.0.1:8082/`, the
gate over the server on `3082` from `~/heddle-live`.

## Records

- [`deployment-2026-10-22.md`](deployment-2026-10-22.md) — the live deployment: what runs where, the
  redeploys, the outages and their fixes (live-deploy's record).
- [`live-health.md`](live-health.md) — the monitor's record and how to read it;
  [`live-health.jsonl`](live-health.jsonl) is the record itself.
- [`live-health-incidents-2026-10-22.md`](live-health-incidents-2026-10-22.md) — the first evening's incidents.

## Read next

[`../../rust/ULTIMATE_GOAL.md`](../../rust/ULTIMATE_GOAL.md) for what the port must satisfy;
[`../../rust/INDEX.md`](../../rust/INDEX.md) for the build host.
