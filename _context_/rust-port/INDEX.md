---
title: Rust port browser baselines
version: 0.1.0
description: The pinned reference pages the Rust port's Web UI is compared against — the TypeScript heddle page and DSH — measured with the browser-use tool, numbers only.
level: L2
status: unverified
grounded_in:
  - source: owner statement in the dsh session, 2026-10-22, asking that heddle be verified with the browser-use tool and compared with DSH on localhost 8080 where needed
  - source: rust/ULTIMATE_GOAL.md, parts 9 to 11
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
| — | Rust heddle, served from the build host | `http://localhost:8081/` (SSH forward) | `meta[name=heddle-page]` | not yet served: the binary answers only `--help` |

## Read next

[`../../rust/ULTIMATE_GOAL.md`](../../rust/ULTIMATE_GOAL.md) for what the port must satisfy;
[`../../rust/INDEX.md`](../../rust/INDEX.md) for the forward and the build host.
