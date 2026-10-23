---
title: 87-resizable-panels — readings
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T05:06:41Z
level: L3
version: 1.0.0
description: The measured verdicts of 87-resizable-panels against the TypeScript build and the Rust binary.
status: unverified
grounded_in:
  - source: runs of the verifier on the owner's Mac, 2026-10-22, through verify.sh, run.mjs and lane.mjs
---

# Readings

| When (PDT, 2026-10-22) | Against | Verdict |
|---|---|---|
| about 20:25 | the TypeScript build, with the page marker read from `src/server/page.html` (`aec8b84`) | 1 of 1 |
| about 20:25 | a recording `HEDDLE_BIN` stand-in that runs the same build | 1 of 1; the server start reached the stand-in |
| about 20:25 | the Rust binary, whose `--help` names no `web` | 1 of 1 unjudged |
| about 22:00 | main's binary at `a871aae`, by the lane gate | 1 of 1 unjudged, none failed |

**Not met through `HEDDLE_BIN`**: unjudged is not passing, and the part waits on the binary serving `web`.
The lane gate: `HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --json 80-web-ui 85-trajectory-view 87-resizable-panels 88-file-preview 90-web-ui-token`.
