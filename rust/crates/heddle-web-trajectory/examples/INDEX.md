---
title: heddle-web-trajectory examples
created: 2026-10-23T05:09:00Z
modified: 2026-10-23T05:09:00Z
version: 1.0.0
description: The two halves of the differential that compares this crate's projections with src/server/ledger.ts on any decoded session log.
grounded_in:
  - source: src/server/ledger.ts
---

# `examples`

The differential: the same decoded log, projected by this crate and by the TypeScript build, then compared.

| Path | What it is |
|---|---|
| [`project_log.rs`](project_log.rs) | this crate's `{ ledger, rows, timeline, stats }` for one JSONL log |
| [`ts_projection.mjs`](ts_projection.mjs) | the same from `src/server/ledger.ts` (Node 24, from source); given the Rust output too, it compares them and exits `0` when equal |

```sh
_tools_/local-build/run run -q --example project_log -p heddle-web-trajectory -- <log.jsonl> > rust.json
node rust/crates/heddle-web-trajectory/examples/ts_projection.mjs <log.jsonl> rust.json
```

Decode a stored log first with `zstd -dc <session>.v2.jsonl.zstd > <log.jsonl>`.

## Read next

[`../VERIFICATION.md`](../VERIFICATION.md).
