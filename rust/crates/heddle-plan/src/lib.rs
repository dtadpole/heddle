//! `heddle-plan` — plan mode: the mode as a log fold, the notice the model reads when the mode changes under it,
//! the policy section every request carries while it is on, `/plan`, `exit_plan_mode` and the plan route.
//!
//! Ported from the TypeScript build's `src/plan/` (`mode.ts`, `policy.ts`, `tool.ts`, `service.ts`, `http.ts`),
//! which is modelled on DSH's `dsh-plan-mode`. Judged through the `heddle` binary (`HEDDLE_BIN`) by
//! `_verifiers_/80-web-ui/check-plan-mode.mjs`; the unit tests port `test/plan.test.ts` case by case.
//!
//! # The one rule
//!
//! Plan mode is **guidance, not enforcement**, in DSH and here. A session is in plan mode when its log's last
//! `plan/mode` event says `active: true`; while it is, every request the model receives carries DSH's
//! `plan:policy` section as a system message after the request's own; no tool is removed or blocked, so the catalog
//! — `exit_plan_mode` included — is the same in every mode. The model leaves by presenting a plan through
//! `exit_plan_mode` and having it approved, or the person leaves with `/plan off`.
//!
//! | Module | Ports | What it is |
//! |---|---|---|
//! | [`mode`] | `mode.ts` | [`plan_active`], [`set_plan_mode`], the event and the two notices, [`PlanLog`] |
//! | [`policy`] | `policy.ts` | [`PLAN_POLICY_SECTION`] (byte-identical) and [`with_plan_policy`] |
//! | [`tool`] | `tool.ts` | `exit_plan_mode` ([`exit_plan_mode_tool`]), its refusals, [`PlanReviewChannel`] and [`plan_title`] |
//! | [`service`] | `service.ts` | [`plan_command`], [`apply_plan_policy`], the `model/request` hook and [`PlanService`] |
//! | [`review`] | `service.ts` (`questionsReviewChannel`) | the review as one question to a [`QuestionAsker`] |
//! | [`routes`] | `http.ts` | `GET /api/sessions/{id}/plan` |
//!
//! # Mounting
//!
//! The binary's `plan` row builds one [`PlanService`] over the shared session store, registers
//! [`PlanService::exit_tool`] in the tool registry and [`PlanService::model_hooks`] on the model service, and
//! provides the service as `plan`; `heddle web` adds [`PlanService::command`] to the command registry and merges
//! [`PlanService::router`] behind the server's door — each only when the row is loaded. [`ROUTES`] lists the route.

pub mod mode;
pub mod policy;
pub mod review;
pub mod routes;
pub mod service;
mod text;
pub mod tool;

#[cfg(test)]
pub(crate) mod test_support;

pub use mode::{
    MODEL_REQUEST_EVENT, NOTICE_EVENT, PLAN_EVENT, PLAN_NOTICE_ORIGIN, PLAN_OFF_NOTICE,
    PLAN_ON_NOTICE, PlanChange, PlanLog, PlanSessions, notice_message, plan_active, set_plan_mode,
};
pub use policy::{PLAN_POLICY_SECTION, with_plan_policy, with_policy_section};
pub use review::{
    AskOptions, QuestionAnswer, QuestionAsker, QuestionOutcome, questions_review_channel,
};
pub use routes::{PLAN_ROUTE, PlanRouteHost, router};
pub use service::{
    NAME, PLAN_DESCRIPTION, PlanPolicyHook, PlanService, apply_plan_policy, plan_command,
};
pub use tool::{
    EXIT_DESCRIPTION, EXIT_PLAN_MODE, NO_REVIEW_CHANNEL_MESSAGE, PLAN_KEEP_PLANNING,
    PLAN_NO_HEADING, PLAN_NO_REVIEW_CHANNEL, PLAN_NO_SESSION, PLAN_NOT_ACTIVE, PLAN_REVIEW,
    PlanForReview, PlanReviewAnswer, PlanReviewChannel, PlanReviewOption, PlanReviewQuestion,
    PlanToolHost, exit_plan_mode_spec, exit_plan_mode_tool, plan_title,
};

/// Every `(method, path)` [`router`] mounts, in axum 0.8 path syntax.
pub const ROUTES: &[(&str, &str)] = &[("GET", PLAN_ROUTE)];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_route_is_listed_and_names_its_session_segment_id() {
        assert_eq!(ROUTES, &[("GET", "/api/sessions/{id}/plan")]);
    }
}
