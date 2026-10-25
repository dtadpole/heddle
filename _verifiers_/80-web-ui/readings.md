---
title: 80-web-ui — readings
created: 2026-10-23T05:06:41Z
modified: 2026-10-25T14:45:16Z
level: L3
version: 1.12.0
description: The measured verdicts of 80-web-ui against the TypeScript build and the Rust binary, with the commits that changed them.
status: unverified
grounded_in:
  - source: runs of the verifier on the owner's Mac, 2026-10-22, through verify.sh, run.mjs and lane.mjs
---

# Readings

| When (PDT, 2026-10-22) | Against | Verdict |
|---|---|---|
| about 20:20 | the TypeScript build, after the checks moved onto `heddleCommand` (`67812c3`) | 14 of 14 files pass (86 checks); through a recording `HEDDLE_BIN` stand-in that runs the same build, the same verdicts, with every server start reaching the stand-in |
| 20:25 to 01:06 | the Rust binary on its way to `web`, release builds, by the lane gate | unjudged until the `web` probe (`5ed8deb`); developer-two's `web` (`22bd865`, not on main) 14 of 75; main `b72cc1a` 70 of 75, `4fc75f1` 73 of 75 — the misses were in the served app (weaving clock, context gauge and row, highlighter, goal #4) |
| 21:05 to 22:40 | the TypeScript build, as the checks' own fixes landed (`d28625d` the listener release, `c4c9292` team-view's early-exit hang, `5ed8deb` the `web` probe, `cb6b392` the start timer) | every file passes after each; chat-view #11 is intermittent (17 of 18 once) |
| 01:29 to 01:39 | main `33407a4`, release binary, by the lane gate, twice | **75 of 75 in both runs** |
| 2026-10-23, 04:16 to 10-25, 06:22 | chat-view #16 alone, repeated, release binaries | before the delivery mark 4 in 106; with it (`30f8e5d`) 1 in 150; with Nagle off (`eb9cbf2`) 0 of 60; with `done` unwaited (`381d378`) 1 of 40. Always a prefix: `renderSettledAnswers` overwrote late deltas. With the page fix (`901fc48`) 0 of 40 |
| 2026-10-25, 07:16 to 07:44 | the page fix `66612b5` on main `9d7e1ed` (landed as `901fc48`): Rust by the lane gate; TypeScript with `dist` built in scratch checkouts | Rust 89 of 90, none regressed (the miss, chat-view #11, also main's); TypeScript 72 of 75 against main's 73: #11 failed 10 of 20 alone on main, 8 patched, and both miss the approval pair |

**Part 9 through `HEDDLE_BIN` is met on main `33407a4`, and again on `06cacfa`, `eb9cbf2` and `381d378`**: 80 passes all 75 checks, and 85, 87 and 88
pass in full. Chat-view #11 is intermittent on both builds, and #16 has not failed since the page fix (`901fc48`); both are
listed with their owners through `rust/INDEX.md`.

The commands: `sh verify.sh --json` for the TypeScript build; the same with `HEDDLE_BIN` set to the binary for the
port; and the lane gate, `HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --json 80-web-ui 85-trajectory-view 87-resizable-panels 88-file-preview 90-web-ui-token`, which was green at `a871aae`: 18 files, 90 checks, all unjudged.
