---
title: 90-web-ui-token — readings
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T08:12:29Z
level: L3
version: 1.3.0
description: The measured verdicts of 90-web-ui-token against the TypeScript build and the Rust binary.
status: unverified
grounded_in:
  - source: runs of the verifier on the owner's Mac, 2026-10-22, through verify.sh, run.mjs and lane.mjs
---

# Readings

| When (PDT, 2026-10-22) | Against | Verdict |
|---|---|---|
| about 20:17 | the TypeScript build, after the check moved onto `heddleCommand` (`67812c3`) | 9 of 9, as at `origin/main` before the move |
| about 20:17 | a recording `HEDDLE_BIN` stand-in that runs the same build | 9 of 9; twelve server starts reached the stand-in |
| about 20:25 | the Rust binary, whose `--help` names no `web` | 9 of 9 unjudged |
| about 22:00 | main's binary at `a871aae`, by the lane gate | 9 of 9 unjudged, none failed |
| about 22:10 | developer-two's `web` (22bd865) in the ui lane at `6910c6e`, release binary, by the lane gate — not on main | **9 of 9** — the first ui part met through the Rust binary |
| 23:53 to 23:58 | main `b72cc1a`, which advertises `web` (D-048), release binary, by the lane gate | **9 of 9** |
| 01:01 to 01:06 | main `4fc75f1`, release binary, by the lane gate (written as main's per-check baseline) | **9 of 9** |

**Part 10 through `HEDDLE_BIN` is met on main `b72cc1a` and `4fc75f1`**: all nine checks pass on the Rust binary. The lane gate:
`HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --json 80-web-ui 85-trajectory-view 87-resizable-panels 88-file-preview 90-web-ui-token`.
