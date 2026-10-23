---
title: The heddle-web-trajectory crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T05:10:00Z
version: 0.4.0
description: The Rust port of the Trajectory view's server side — the ledger, the ?view=ledger body, the log download and the composer dock's statistics.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/server/ledger.ts, src/server/log-download.ts, src/server/tool-inspector.ts and the ledger, stats and log branches of src/server/web.ts
  - source: _verifiers_/85-trajectory-view/check.mjs; _verifiers_/80-web-ui/check-trajectory-view.mjs, check-runtime-context.mjs, check-composer.mjs (the dock)
---

# `rust/crates/heddle-web-trajectory`

The Trajectory view's server side. Almost all of it is a **pure projection** of one session's recorded events,
read as the JSON objects the log holds (key order kept), so it depends on no session type: the same events always
give the same ledger, rows, timeline and statistics.

| | |
|---|---|
| Ported from | `src/server/ledger.ts`, `log-download.ts`, `tool-inspector.ts` |
| Judged by | `85-trajectory-view`; `80-web-ui` check-trajectory-view, check-runtime-context, check-composer's dock — through the `heddle` binary |
| Status | implemented; 69 unit and 6 verifier-expectation tests; matches the TypeScript build through the real `heddle-server`. Waits on the binary's `heddle web` |

## What is here

| Path | What it is |
|---|---|
| [`src/`](src/INDEX.md) | the projections, the inspector, the download and the routes |
| [`API.md`](API.md) | the public API, what it needs from other crates, and the known divergences |
| [`VERIFICATION.md`](VERIFICATION.md) | the evidence that it matches the TypeScript build, and how to repeat it |
| [`tests/`](tests/INDEX.md) | the verifiers' API expectations, judged on recorded logs |
| [`examples/`](examples/INDEX.md) | the differential tool |

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
