---
title: 80-web-ui — readings
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T08:12:29Z
level: L3
version: 1.3.0
description: The measured verdicts of 80-web-ui against the TypeScript build and the Rust binary, with the commits that changed them.
status: unverified
grounded_in:
  - source: runs of the verifier on the owner's Mac, 2026-10-22, through verify.sh, run.mjs and lane.mjs
---

# Readings

| When (PDT, 2026-10-22) | Against | Verdict |
|---|---|---|
| about 20:20 | the TypeScript build, after the checks moved onto `heddleCommand` (`67812c3`) | 14 of 14 files pass (86 checks); through a recording `HEDDLE_BIN` stand-in that runs the same build, the same verdicts, with every server start reaching the stand-in |
| 20:25 to 22:00 | the Rust binary before it served `web` | first 4 files hung past a 60 s alarm; after `d28625d` they failed in 15 to 20 s; after the `web` probe (`5ed8deb`) all 14 files were unjudged |
| about 21:05 | the TypeScript build, with the listener release (`d28625d`) | every file passes; check-chat-view gave 17 of 18 once and 18 of 18 on the re-run (check 11, the scroll-follow timing, is intermittent with and without the change) |
| about 21:20 | check-team-view, against a harness that exits after the browser opens | before `c4c9292` it ran past a 45 s alarm; after, it fails in 5 s with "the server did not start" |
| about 21:58 | the TypeScript build, with the `web` probe (`5ed8deb`) | the eight probed files pass in full: access 4, approval 3, composer 25, goal 4, model-switcher 5, runtime-context 1, team-view 1, todo 2 |
| 22:10 to 22:24 | developer-two's `web` (22bd865) in the ui lane at `6910c6e`, release binary, by the lane gate — not on main | 14 files: 14 checks pass, 61 fail (chat-view 4 of 18, composer 6 of 25, check.mjs 4 of 5; the other eleven files pass none). Every argument shape the checks use printed its URL; the failures are in the served app |
| about 22:40 | the TypeScript build, with the start timer unref'd (`cb6b392`) | same verdicts; check-context-view finishes in 0.5 s instead of 15 s |
| 23:53 to 23:58 | main `b72cc1a`, which advertises `web` (D-048), release binary, by the lane gate | 70 of 75: chat-view #15 (the weaving clock), composer #13 (the context gauge), context-view #1 and #2 (the context row) and file-view #1 (the highlighter) fail; nine of fourteen files pass in full |
| 01:01 to 01:06 | main `4fc75f1`, release binary, by the lane gate (written as main's per-check baseline) | 73 of 75: chat-view #15 (weaving clock) and goal #4 fail. Alone after the readiness fix: goal #4 0 of 12; goal #1 1 of 12, a 404 "no session" on completing right after a restart |

**Part 9 through `HEDDLE_BIN` is not met on main `4fc75f1`**: 80 passes 73 of its 75 checks (70 at `b72cc1a`), with
the failures and their owners in `rust/INDEX.md`; 85, 87 and 88, the rest of part 9, pass in full.

The commands: `sh verify.sh --json` for the TypeScript build; the same with `HEDDLE_BIN` set to the binary for the
port; and the lane gate, `HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --json 80-web-ui 85-trajectory-view 87-resizable-panels 88-file-preview 90-web-ui-token`, which was green at `a871aae`: 18 files, 90 checks, all unjudged.
