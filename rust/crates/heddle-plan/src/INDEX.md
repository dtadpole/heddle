---
title: The heddle-plan sources
created: 2026-10-29T13:40:00Z
modified: 2026-10-29T13:40:00Z
version: 0.1.0
description: The sources of the heddle-plan crate, with unit tests beside the code.
grounded_in:
  - source: src/plan/mode.ts, src/plan/policy.ts, src/plan/tool.ts, src/plan/service.ts, src/plan/http.ts, read 2026-10-29
  - source: test/plan.test.ts
---

# `rust/crates/heddle-plan/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation, the re-exports and `ROUTES` |
| [`mode.rs`](mode.rs) | `plan_active`, `set_plan_mode`, the `plan/mode` event, the two notices, `PlanLog` and `PlanSessions` (ports `mode.ts`) |
| [`policy.rs`](policy.rs) | `PLAN_POLICY_SECTION`, compared byte for byte with `policy.ts`, and `with_plan_policy` (ports `policy.ts`) |
| [`tool.rs`](tool.rs) | `exit_plan_mode`: its spec, refusals and review outcomes, `PlanReviewChannel`, `plan_title` (ports `tool.ts`) |
| [`service.rs`](service.rs) | `/plan`, `apply_plan_policy`, the `model/request` hook and `PlanService` (ports `service.ts`) |
| [`review.rs`](review.rs) | `questions_review_channel`: the review as DSH's one `plan-review` question to a question service, and how its answer is read (ports `questionsReviewChannel` in `service.ts`) |
| [`routes.rs`](routes.rs) | `GET /api/sessions/{id}/plan` (ports `http.ts`) |
| [`text.rs`](text.rs) | the JavaScript behaviours reproduced: `String#trim`, the `\s` class, the session-id shape |
| [`test_support.rs`](test_support.rs) | a real session store in a temporary folder and the in-process router call (`#[cfg(test)]` only) |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, what judges it, and how it is mounted.
