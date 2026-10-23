---
title: 80-web-ui — readings
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T05:36:13Z
level: L3
version: 1.1.0
description: The measured verdicts of 80-web-ui against the TypeScript build and the Rust binary, with the commits that changed them.
status: unverified
grounded_in:
  - source: runs of the verifier on the owner's Mac, 2026-10-22, through verify.sh, run.mjs and lane.mjs
---

# Readings

| When (PDT, 2026-10-22) | Against | Verdict |
|---|---|---|
| about 20:20 | the TypeScript build, after the checks moved onto `heddleCommand` (`67812c3`) | 14 of 14 files pass (86 checks); through a recording `HEDDLE_BIN` stand-in that runs the same build, the same verdicts, with every server start reaching the stand-in |
| about 20:25 | the Rust binary, whose `web` exits 2 | 6 files unjudged, 4 fail, and 4 never exit: check-access, check-composer, check-model-switcher and check-runtime-context ran past a 60 s alarm |
| about 21:05 | the TypeScript build, with the listener release (`d28625d`) | every file passes; check-chat-view gave 17 of 18 once and 18 of 18 on the re-run (check 11, the scroll-follow timing, is intermittent with and without the change) |
| about 21:10 | main's binary at `d28625d` | 6 files unjudged and 8 fail, each in 15 to 20 s; none hangs |
| about 21:20 | check-team-view, against a harness that exits after the browser opens | before `c4c9292` it ran past a 45 s alarm; after, it fails in 5 s with "the server did not start" |
| about 21:58 | the TypeScript build, with the `web` probe (`5ed8deb`) | the eight probed files pass in full: access 4, approval 3, composer 25, goal 4, model-switcher 5, runtime-context 1, team-view 1, todo 2 |
| about 22:00 | main's binary at `a871aae`, by the lane gate | 14 files, every check unjudged, none failed |
| 22:10 to 22:24 | developer-two's `web` (22bd865) in the ui lane at `6910c6e`, release binary, by the lane gate — not on main | 14 files: 14 checks pass, 61 fail (chat-view 4 of 18, composer 6 of 25, check.mjs 4 of 5; the other eleven files pass none). Every argument shape the checks use printed its URL; the failures are in the served app |
| about 22:40 | the TypeScript build, with the start timer unref'd (`cb6b392`) | same verdicts; check-context-view finishes in 0.5 s instead of 15 s |

**Part 9 through `HEDDLE_BIN` is not met.** Unjudged is not passing; the part cannot be judged until the binary
serves `web`.

The commands: `sh verify.sh --json` for the TypeScript build; the same with `HEDDLE_BIN` set to the binary for the
port; and the lane gate, `HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --json 80-web-ui 85-trajectory-view 87-resizable-panels 88-file-preview 90-web-ui-token`, which was green at `a871aae`: 18 files, 90 checks, all unjudged.
