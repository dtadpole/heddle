---
title: 85-trajectory-view — readings
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T08:41:35Z
level: L3
version: 1.4.0
description: The measured verdicts of 85-trajectory-view against the TypeScript build and the Rust binary.
status: unverified
grounded_in:
  - source: runs of the verifier on the owner's Mac, 2026-10-22, through verify.sh, run.mjs and lane.mjs
---

# Readings

| When (PDT, 2026-10-22) | Against | Verdict |
|---|---|---|
| about 20:20 | the TypeScript build, after the check moved onto `heddleCommand` (`67812c3`) | 2 of 2 |
| about 20:20 | a recording `HEDDLE_BIN` stand-in that runs the same build | 2 of 2; both server starts reached the stand-in |
| about 20:25 | the Rust binary, whose `--help` names no `web` | 2 of 2 unjudged |
| about 22:00 | main's binary at `a871aae`, by the lane gate | 2 of 2 unjudged, none failed |
| 22:10 to 22:24 | developer-two's `web` (22bd865) in the ui lane at `6910c6e`, release binary, by the lane gate — not on main | 0 of 2: no ledger view behind `?view=ledger` yet |
| 23:53 to 23:58 | main `b72cc1a`, which advertises `web` (D-048), release binary, by the lane gate | **2 of 2** |
| 01:01 to 01:06 | main `4fc75f1`, release binary, by the lane gate (written as main's per-check baseline) | **2 of 2** |
| 01:29 to 01:39 | main `33407a4`, release binary, by the lane gate, twice | **2 of 2 in both runs** |

**Met through `HEDDLE_BIN` on main `b72cc1a`, `4fc75f1` and `33407a4`**: both checks pass on the Rust binary.
The lane gate: `HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --json 80-web-ui 85-trajectory-view 87-resizable-panels 88-file-preview 90-web-ui-token`.
