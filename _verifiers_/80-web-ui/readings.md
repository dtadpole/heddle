---
title: 80-web-ui — readings
created: 2026-10-23T05:06:41Z
modified: 2026-10-29T15:30:00Z
level: L3
version: 1.15.0
description: The measured verdicts of 80-web-ui against the TypeScript build and the Rust binary, with the commits that changed them.
status: unverified
grounded_in:
  - source: runs of the verifier on the owner's Mac, 2026-10-22, through verify.sh, run.mjs and lane.mjs
---

# Readings

| When (PDT, 2026-10-22) | Against | Verdict |
|---|---|---|
| about 20:20 | the TypeScript build on `heddleCommand` (`67812c3`) | 14 of 14 files pass (86 checks) |
| 20:25 to 01:06 | the Rust binary on its way to `web` | unjudged until `5ed8deb`; then 70, 73 of 75 |
| 21:05 to 22:40 | the TypeScript build, as the checks' fixes landed | every file passes; chat-view #11 intermittent |
| 01:29 to 01:39 | main `33407a4`, release binary, by the lane gate, twice | **75 of 75 in both runs** |
| 2026-10-23, 04:16 to 10-25, 06:22 | chat-view #16 alone, repeated, release binaries | before the delivery mark 4 in 106; with it (`30f8e5d`) 1 in 150; with Nagle off (`eb9cbf2`) 0 of 60; with `done` unwaited (`381d378`) 1 of 40. Always a prefix: `renderSettledAnswers` overwrote late deltas. With the page fix (`901fc48`) 0 of 40 |
| 2026-10-25, 07:16 to 07:44 | the page fix `66612b5` on main `9d7e1ed` (landed as `901fc48`): Rust by the lane gate; TypeScript with `dist` built in scratch checkouts | Rust 89 of 90, none regressed (the settled-answer miss then passed 20 of 20 alone); TypeScript 72 of 75 against 73: #11 failed 10 of 20 alone on main, 8 patched; the approval pair, see below |
| 2026-10-28, 22:03 to 22:40 | the workspace-tree left column, main `01994534` as landed (`ae3079f8` and its part-70 fix `0bc592b5`) | Rust 92 of 92 against main's 88 (the two new workspace-tree checks, the minimap, the resizable sidebar), none regressed; part 70 45 of 45; TypeScript 75 of 77 against 72 of 75, the approval pair as below |
| 2026-10-29, before 04:05 | workspace add, rename and delete, `3d57f624` (landed as `b8ad7d1d`), by the coordinator's G4 agent | Rust 78 of 78, part 70 46 of 46; TypeScript 78 of 78 |
| 2026-10-29, 05:23 to 08:24 | R-16 `b16d7fde`, R-10 `9ed4ec93`, then the stack `88384e37`, `51093b40`, `9b9b8375` (landed as `99e7c710`) | none regressed in any; the stack: Rust 97 of 99 against 92 (two flaky on re-run), part 70 49 of 49, TypeScript 83 of 83 against 81 of 81 from checkouts outside `/tmp` |

**Part 9 through `HEDDLE_BIN` is met on main `33407a4`, and again on `06cacfa`, `eb9cbf2`, `381d378`, `01994534`, (by G4's run) `3d57f624`, and `99e7c710`**: 80 passes all its checks, and 85, 87 and 88
pass in full. The approval pair (Reject, Stop) failed only from TypeScript checkouts under `/tmp`, which `workspace-write` makes writable; outside it main reads 81 of 81. Chat-view #11 is intermittent on both builds, and #16 has not failed since the page fix (`901fc48`); both are
listed with their owners through `rust/INDEX.md`.

The commands: `sh verify.sh --json` for the TypeScript build; the same with `HEDDLE_BIN` set to the binary for the
port; and the lane gate, `HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --json 80-web-ui 85-trajectory-view 87-resizable-panels 88-file-preview 90-web-ui-token`, green at `a871aae`.
