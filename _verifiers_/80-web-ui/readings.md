---
title: 80-web-ui — readings
created: 2026-10-23T05:06:41Z
modified: 2026-10-24T07:16:27Z
level: L3
version: 1.9.0
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
| 21:05 to 22:40 | the TypeScript build, as the checks' own fixes landed (`d28625d` the listener release, `c4c9292` team-view's early-exit hang, `5ed8deb` the `web` probe, `cb6b392` the start timer) | every file passes after each; chat-view #11 is intermittent (17 of 18 once) |
| 22:10 to 22:24 | developer-two's `web` (22bd865) in the ui lane at `6910c6e`, release binary, by the lane gate — not on main | 14 files: 14 checks pass, 61 fail (chat-view 4 of 18, composer 6 of 25, check.mjs 4 of 5; the other eleven files pass none). Every argument shape the checks use printed its URL; the failures are in the served app |
| 23:53 to 23:58 | main `b72cc1a`, which advertises `web` (D-048), release binary, by the lane gate | 70 of 75: chat-view #15 (the weaving clock), composer #13 (the context gauge), context-view #1 and #2 (the context row) and file-view #1 (the highlighter) fail; nine of fourteen files pass in full |
| 01:01 to 01:06 | main `4fc75f1`, release binary, by the lane gate (written as main's per-check baseline) | 73 of 75: chat-view #15 (weaving clock) and goal #4 fail. Alone after the readiness fix: goal #4 0 of 12; goal #1 1 of 12, a 404 "no session" on completing right after a restart |
| 01:29 to 01:39 | main `33407a4`, release binary, by the lane gate, twice | **75 of 75 in both runs** |
| 2026-10-23, 04:16 to 10-24, 00:20 | chat-view #16 alone, repeated, release binaries | before the delivery mark 4 in 106 (the take-counted flush `4c6b17e` 1 of 30); with the mark (`30f8e5d`) 1 in 150, a prefix; with Nagle off too (`eb9cbf2`) 0 of 60 |

**Part 9 through `HEDDLE_BIN` is met on main `33407a4`**: 80 passes all 75 checks in two runs, and 85, 87 and 88
pass in full. Two checks are intermittent through the binary — chat-view #11 and #16 (goal #1's torn read was
fixed in `4f65141`) — and are listed with their owners through `rust/INDEX.md`.

The commands: `sh verify.sh --json` for the TypeScript build; the same with `HEDDLE_BIN` set to the binary for the
port; and the lane gate, `HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --json 80-web-ui 85-trajectory-view 87-resizable-panels 88-file-preview 90-web-ui-token`, which was green at `a871aae`: 18 files, 90 checks, all unjudged.
