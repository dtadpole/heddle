---
title: The heddle-plan crate
created: 2026-10-29T13:40:00Z
modified: 2026-10-31T14:24:07Z
version: 0.1.0
description: The Rust port crate for plan mode — the mode fold, the notice, DSH's plan-mode policy section, /plan, exit_plan_mode and GET /api/sessions/{id}/plan — its public API, what it needs from other crates, how the binary mounts it, and where it differs from the TypeScript build.
grounded_in:
  - source: src/plan/mode.ts, src/plan/policy.ts, src/plan/tool.ts, src/plan/service.ts (with questionsReviewChannel) and src/plan/http.ts, read 2026-10-29
  - source: test/plan.test.ts
  - source: _verifiers_/80-web-ui/check-plan-mode.mjs
---

# `rust/crates/heddle-plan`

The Rust port of plan mode, modelled (through the TypeScript build) on DSH's `dsh-plan-mode`. Plan mode is
**guidance, not enforcement**: a session is in plan mode when its log's last `plan/mode` event says `active: true`;
while it is, every request the model receives carries DSH's `plan:policy` section as a system message after the
request's own; no tool is removed or blocked, so `exit_plan_mode` is in the catalog in every mode.

| | |
|---|---|
| Ported from | `src/plan/` (`mode.ts`, `policy.ts`, `tool.ts`, `service.ts`, `http.ts`) |
| Judged by | `_verifiers_/80-web-ui/check-plan-mode.mjs`, through the `heddle` binary (`HEDDLE_BIN`) |
| Sources | [`src/`](src/INDEX.md) |
| Status | loaded by the binary's `plan` row (`rust/crates/heddle`, `PlanComponent`); unit tests port `test/plan.test.ts` case by case |
| Owner | `developer-three` (D-057), with the TypeScript layer |

## What it does

| Piece | Behaviour |
|---|---|
| The mode | `plan/mode {active}`, log-only (no `surfaceOp`), folded last-wins; off when absent; only the boolean `true` is on |
| A change | writes nothing when the session is already in that mode; otherwise the mode event, then — only if the log already holds a `model/request` — a `context/note` `{message: {role: "user", content: [{type: "text", text}]}, origin: "plan-mode"}` appended with `surfaceOp: "append"`, DSH's "The user switched this session to plan mode." / "…back to the default mode." |
| The policy | `PLAN_POLICY_SECTION`, byte-identical to `policy.ts` (a test compares them), inserted as a system message after the request's leading system messages |
| The hook | on the model service's `model/request` waterfall: runs the rest of the chain, then adds the section when the request's `session_id` names a session in plan mode |
| `/plan` | label `Plan`, section `add`, input `{hint: "[off|message]", attachments: true}`; `/plan` → "Plan mode on. Use /plan off to leave."; `/plan off` → "Plan mode off." or "Plan mode is already inactive."; `/plan <words>` enters and answers `action: {kind: "prompt", text}` |
| `exit_plan_mode` | DSH's name, description and `{plan}` parameter; refuses `PLAN_NO_SESSION`, `PLAN_NOT_ACTIVE`, `PLAN_NO_HEADING`, `PLAN_NO_REVIEW_CHANNEL` (DSH's sentence); a review answers approve (leaves plan mode, `data.approved: true`), keep planning (`PLAN_KEEP_PLANNING` with the feedback), or dismissed (`data.approved: false`) |
| The route | `GET /api/sessions/{id}/plan` → `200 {"session", "active"}`; `400 not a session id`; `404 no session <id>`; pretty JSON plus a newline, `cache-control: no-store` |

## Public API

| Item | What it is |
|---|---|
| `plan_active`, `set_plan_mode` → `PlanChange`, `PlanLog`, `PlanSessions`, `PLAN_EVENT`, `PLAN_ON_NOTICE`, `PLAN_OFF_NOTICE`, `PLAN_NOTICE_ORIGIN` | the fold and the change (`mode.rs`) |
| `PLAN_POLICY_SECTION`, `with_plan_policy`, `with_policy_section` | the section and its placement (`policy.rs`) |
| `exit_plan_mode_tool`, `exit_plan_mode_spec`, `PlanToolHost`, `PlanReviewChannel`, `PlanReviewAnswer`, `PlanForReview`, `PLAN_REVIEW`, `plan_title` | the tool (`tool.rs`) |
| `plan_command`, `apply_plan_policy`, `PlanPolicyHook`, `PlanService` | the command, the request rewrite, the hook and the service the binary holds (`service.rs`) |
| `questions_review_channel`, `QuestionAsker`, `QuestionOutcome`, `QuestionAnswer`, `AskOptions` | the review over a question service: one `plan-review` question with the plan under it, no time limit; Approve approves, Keep planning or typed words keep planning, a skip or a `pending` dismisses (`review.rs`) |
| `router`, `PlanRouteHost`, `PLAN_ROUTE`, `ROUTES` | the route (`routes.rs`) |

## What it needs from other crates

| From | What |
|---|---|
| `heddle-session` | `SessionStore` (`open`, `read`, `append` with `AppendOptions { surface_op: Some(SurfaceOp::Append) }`) |
| `heddle-llm` | `GenerateRequest` (its `session_id`, set by `heddle-agent`'s turn), `Message`, `ModelHooks` |
| `heddle-tools` | `Tool`, `ToolResult`, `ToolRunContext`, `CancellationToken` |
| `heddle-commands` | `CommandDefinition`, `CommandAction::Prompt`, and `routes::json_pretty` |

No third-party dependency beyond the workspace's `axum`, `futures` and `serde_json`.

## Mounting

The binary's `plan` row (`rust/crates/heddle/src/adapters.rs`, `PlanComponent`; spec `plan/service`, requires
`session`, `commands`, `tools`) builds one `PlanService` over the session row's store, registers
`exit_tool()` in the tool registry and `model_hooks()` on the model service — whichever of the plan and model rows
starts second registers the hook — and provides the service as `plan`. `heddle web` (`web.rs`) then passes
`command()` to `heddle-commands` (`Commands::with_contributed`) and merges `router()` behind the server's door, each only
when the row is loaded.

## Deviations from the TypeScript build

- The hook is on the model service's own waterfall (`ModelService::add_hooks`, as `web.rs`'s session-selection
  rule is), not a bus listener: a bus listener would send every model call of every process through the bus's
  blocking dispatch. It still runs the rest of the chain first, as the TypeScript listener does.
- A log that cannot be read counts as the default mode for the hook and the route's `active`, where the TypeScript
  store's throw would fail the request.
- A path whose id segment holds a `/` never reaches the route (axum matches one segment), so the server answers its
  `404` where `http.ts` answers `400`; an id that does not percent-decode is `400` where `decodeURIComponent` throws.
- The review channel is provided to the service (`provide_review_channel`, e.g. with `questions_review_channel`)
  rather than looked up as the `questions` service; it is still read per call. The binary's `plan` and `questions`
  rows hand it over, whichever starts second; without a `questions` row none is provided and the tool answers DSH's
  sentence, as the TypeScript build does without `questions`.

## Read next

[`src/INDEX.md`](src/INDEX.md) for the files; [`../heddle-commands/`](../heddle-commands/INDEX.md) for the registry
`/plan` joins.
