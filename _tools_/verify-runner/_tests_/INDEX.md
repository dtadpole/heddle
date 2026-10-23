---
title: Verify Runner Tests
version: 1.0.0
description: The runner's own _tests_ type folder, holding the suites for the verdict mapping and the check library.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, keeping a tool's tests under the tool
---

# `_tests_`

Instance-level `_tests_` type folder for [`_tools_/verify-runner/`](../../INDEX.md).

| Instance | The suite |
|---|---|
| [`verdict-rules/`](verdict-rules/INDEX.md) | `classify`, `tapCounts` and `collectNames` — the mapping every verifier's result passes through |
| [`lane-rules/`](lane-rules/INDEX.md) | `laneVerdict`, `parseArgs` and `parseVerdictLine` — the lane gate's decision and its command line |
| [`helper-rules/`](helper-rules/INDEX.md) | the check library — transcript finding and decoding, session listing, JSON extraction, fingerprints, `skipUnless` |
