---
title: The heddle-context engine oracle
created: 2026-10-24T05:14:04Z
modified: 2026-10-24T05:14:04Z
version: 1.0.0
description: The TypeScript build's recorded compaction scenarios and the script that records them, which engine-agreement.rs replays.
grounded_in:
  - source: src/context/compaction.ts, src/context/prune.ts and src/session/store.ts, run under Node with built-ins only
---

# `rust/crates/heddle-context/tests/fixtures`

| File | What it is |
|---|---|
| [`generate-engine-oracle.mjs`](generate-engine-oracle.mjs) | runs the TypeScript store and engine through four scenarios (an aimed cut and a refused summary, a landed compaction, a second compaction, a prune that clears the pressure) and prints every event, the surface and the derived messages |
| [`engine-oracle.json`](engine-oracle.json) | that output, checked in; regenerate it with `node rust/crates/heddle-context/tests/fixtures/generate-engine-oracle.mjs > rust/crates/heddle-context/tests/fixtures/engine-oracle.json` from the repository root |

The JSON is generated, never edited by hand; when the TypeScript build changes, regenerate it and let
[`../engine-agreement.rs`](../engine-agreement.rs) say what moved.

## Read next

[`../INDEX.md`](../INDEX.md) for the tests that read it.
