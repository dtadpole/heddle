---
title: 90-web-ui-token — readings
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T05:06:41Z
level: L3
version: 1.0.0
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

**Part 10 through `HEDDLE_BIN` is not met**: unjudged is not passing, and the part waits on the binary serving `web`.
It is the first ui part to attempt when `web` starts, because its checks need only the door. The lane gate:
`HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --json 80-web-ui 85-trajectory-view 87-resizable-panels 88-file-preview 90-web-ui-token`.
