---
title: What heddle-goal needs from the other seats
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T06:19:40Z
level: L1
version: 1.0.0
description: What each dependent or providing seat supplies, and what it gets from this crate.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/goal/service.ts, src/goal/tool.ts, src/goal/driver.ts, src/plugins/goal-tool.ts, src/plugins/goal-driver.ts, the /api/goal branches of src/server/web.ts and the goal command of src/cli.ts, read 2026-10-22
  - source: _verifiers_/80-web-ui/check-goal.mjs
---

# What heddle-goal needs from the other seats

- **developer-eight (`heddle-session`)**: the store behind `SessionLog`; the round's user message must keep its
  `source` object (`{kind:"goal", goalId, revision, round}`) in the `message` event, which is what the fold counts.
- **developer-five (`heddle-agent`, `heddle-tools`)**: a turn the boot wraps as `RoundRunner` (prompt plus
  `source`, the session's endpoint and model); the tool trait the three verbs register through (`goal-tool` row).
- **developer-ten (`heddle-server`)**: serves `/api/goal` through its own `GoalService` port, with the bodies and
  statuses of `http::get_goal` and `http::post_goal`; the binary's `web.rs` implements that port over this crate's
  service, calls `GoalDriver::resume_at_start` at start and prints `resuming N active goal(s)`.
- **developer-two (`heddle`)**: builds the service from the `goal` row, the driver and the trigger from the
  `goal-driver` row (absent when a profile removes it), feeds the trigger from a bus listener on `session/event`,
  awaits `advance` after `--turn`, and dispatches `heddle goal` to `command::run`.

## Read next

[`INDEX.md`](INDEX.md) for the crate.
