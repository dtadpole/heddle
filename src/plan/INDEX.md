---
title: Plan mode
created: 2026-10-29T13:32:04Z
modified: 2026-10-29T13:32:04Z
version: 0.1.0
description: Plan mode — the mode as a log fold, DSH's plan-mode policy on every request of a session in it, /plan, exit_plan_mode and its review, and the composer's Plan chip.
grounded_in:
  - source: the DSH package's dsh-plan-mode (lib/index.js) and the plan-mode row of dsh-base/cordis.patch.yml, read 2026-10-29
  - source: _projects_/heddle/_designs_/dsh-parity results-developer-twelve.md (C88, C89, R-developer-twelve-2)
---

# `plan`

Plan mode, modelled on DSH's `dsh-plan-mode`. Owner: developer-three (D-057).

**Guidance, not enforcement** — in DSH and here. While a session is in plan mode, every request the model receives
carries DSH's plan-mode policy section (explore, do not edit, submit the plan through `exit_plan_mode`); no tool is
removed or blocked, because the catalog stays the same across modes. The sandbox and the approval policy remain what
stops an edit.

| File | What it holds |
|---|---|
| [`mode.ts`](mode.ts) | `plan/mode {active}` (log-only), `planActive`, `setPlanMode`, and DSH's mode-change notice, appended as a `context/note` once the model has answered in the session |
| [`policy.ts`](policy.ts) | `PLAN_POLICY_SECTION`, verbatim from DSH's base profile, and `withPlanPolicy`, which adds it after a request's own system messages |
| [`tool.ts`](tool.ts) | `exit_plan_mode`: DSH's name, description, parameter and refusals; the `plan-review` question through a `PlanReviewChannel` |
| [`http.ts`](http.ts) | `GET /api/sessions/{id}/plan` → `{session, active}` |
| [`service.ts`](service.ts) | the `plan` plugin: `/plan` in the command registry, `exit_plan_mode` in the tools, the policy on `model/request` (`applyPlanPolicy`) |

## `/plan`

| Line | Effect | Sentence |
|---|---|---|
| `/plan` | enter | "Plan mode on. Use /plan off to leave." |
| `/plan <words>` | enter, then the page sends the words as a message (a `prompt` action) | the same |
| `/plan off` | leave | "Plan mode off." or "Plan mode is already inactive." |

heddle appends the mode event at once and every request reads the log, so a change made while a turn runs reaches
that turn's next model call — DSH's "applies from the next step", without a pending state.

## The review

`exit_plan_mode {plan}` refuses outside plan mode, without a `#` heading, and when no review channel is loaded
("no user-questions channel is available to review the plan; ask the user to switch the session mode instead"). The
channel is a cordis service `planReview` answering `review(session, {title, markdown}, signal)` with `approve`,
`keep-planning` (feedback back to the model) or `dismissed` (plan mode stays). It is to be provided over the
user-question tool (developer-eleven), which is not on main yet.

## The composer

The page lends `window.heddlePage.setModeChip` and `setPlaceholder`; the menu module (`src/commands/menu.js`) draws
DSH's blue **Plan** chip right after the access chip ("Plan mode on — click to turn off (/plan off)") and the
placeholder "describe your task to generate plan" (below the steer hint), reading the state on every shown session
and from `plan/mode` events. Clicking the chip runs `/plan off`.

Judged by `_verifiers_/80-web-ui/check-plan-mode.mjs`; unit tests in `test/plan.test.ts`.
