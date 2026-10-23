---
title: Rust port browser baselines
version: 0.2.0
description: The pinned reference pages the Rust port's Web UI is compared against — the TypeScript heddle page and DSH — measured with the browser-use tool, numbers only, and the records of the live deployment and its monitor.
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
| 2026-10-22 | TypeScript build as a stand-in on the build host, through the forward | `http://localhost:8081/` | `meta[name=heddle-page]` = `dd6d45d28567` | 401 without the token; with it title `Heddle`, composer present, no workspaces, seat `scripted` |
| — | Rust heddle, same address | `http://localhost:8081/` | `meta[name=heddle-page]` | not yet served |

The `8081` forward is gone with the devservers (D-020). The team's live address is now
`http://127.0.0.1:8082/`: the heddle Web Gate over the deployed server on `127.0.0.1:3082`, from
`~/heddle-live`. The monitor's own passes against it are pinned in
[`live-health.md`](live-health.md) and [`live-health.jsonl`](live-health.jsonl), and its first record
is the gate serving the app at 20:15:44 on 2026-10-22 (marker `dd6d45d28567` = the checkout's built
`dist/server/page.html`) and the gate answering `502` from 20:16:49 while the deployed server was down.

## Records

- [`deployment-2026-10-22.md`](deployment-2026-10-22.md) — the live deployment on this Mac: what runs
  where, the redeploy log, the outages and their fixes, and the scratch rehearsals (live-deploy's record).
- [`live-health.md`](live-health.md) — what the monitor's pass judges every 20 minutes, the topology it
  judges through, and the incidents it found.
- [`live-health.jsonl`](live-health.jsonl) — every pinned pass, append-only; read it as a table with
  `node _tools_/live-health/summary.mjs`.

## Read next

[`../../rust/ULTIMATE_GOAL.md`](../../rust/ULTIMATE_GOAL.md) for what the port must satisfy;
[`../../rust/INDEX.md`](../../rust/INDEX.md) for the forward and the build host;
[`live-health.md`](live-health.md) for the live deployment's pinned passes.
