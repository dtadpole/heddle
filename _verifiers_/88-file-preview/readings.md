---
title: 88-file-preview — readings
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T05:36:13Z
level: L3
version: 1.1.0
description: The measured verdicts of 88-file-preview against the TypeScript build and the Rust binary, and why it failed before its fixture.
status: unverified
grounded_in:
  - source: runs of the verifier on the owner's Mac, 2026-10-22, through verify.sh, run.mjs and lane.mjs
---

# Readings

| When (PDT, 2026-10-22) | Against | Verdict |
|---|---|---|
| about 20:20 | the TypeScript build, at `origin/main` and after the move onto `heddleCommand` alike | 1 of 3: the two preview checks registered another machine's checkout as their workspace, so every read answered nothing |
| about 20:50 | the TypeScript build, with the check's own fixture workspace (`d264f32`) | 3 of 3 |
| about 20:55 | the Rust binary, whose `--help` names no `web` | 3 of 3 unjudged |
| about 22:00 | main's binary at `a871aae`, by the lane gate | 3 of 3 unjudged, none failed |
| 22:10 to 22:24 | developer-two's `web` (22bd865) in the ui lane at `6910c6e`, release binary, by the lane gate — not on main | 0 of 3: the file routes are not mounted yet |

**Not met through `HEDDLE_BIN`**: unjudged is not passing, and the part waits on the binary serving `web`.
The lane gate: `HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --json 80-web-ui 85-trajectory-view 87-resizable-panels 88-file-preview 90-web-ui-token`.
