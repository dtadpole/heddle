//! `exit_plan_mode`: the model presents its finished plan for review, and on approval the session leaves plan mode.
//!
//! Ported from `src/plan/tool.ts` — DSH's tool, re-read from `dsh-plan-mode` on 2026-10-29, with its name,
//! description, parameter and refusals. It is always registered — the catalog stays the same across modes — and
//! refuses outside plan mode, without a `#` heading, and when no review channel exists. The review itself is a
//! question to the person (`plan-review`: Approve / Keep planning), asked through the session's user-question
//! channel ([`PlanReviewChannel`]); until one is provided the tool answers with DSH's own sentence telling the model
//! to ask the person to switch the mode by hand.

use std::sync::Arc;

use futures::future::BoxFuture;
use heddle_session::SessionHandle;
use heddle_tools::{
    CancellationToken, Tool, ToolArgs, ToolFailure, ToolFuture, ToolResult, ToolRunContext,
    ToolSpec,
};
use serde_json::{Map, Value, json};

use crate::text;

/// The tool's name.
pub const EXIT_PLAN_MODE: &str = "exit_plan_mode";

/// The tool's description, DSH's word for word.
pub const EXIT_DESCRIPTION: &str = "Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode. The user may approve (carry out the plan from your next step) or keep planning — their feedback comes back in the tool result; revise and present again.";

/// The `plan` parameter's description.
pub const PLAN_PARAMETER_DESCRIPTION: &str =
    "The complete plan, as markdown, starting with a # heading that names it.";

/// The refusal outside a calling agent.
pub const PLAN_NO_SESSION: &str = "PLAN_NO_SESSION";
/// The refusal outside plan mode.
pub const PLAN_NOT_ACTIVE: &str = "PLAN_NOT_ACTIVE";
/// The refusal of a plan without a `#` heading.
pub const PLAN_NO_HEADING: &str = "PLAN_NO_HEADING";
/// The refusal while no review channel exists.
pub const PLAN_NO_REVIEW_CHANNEL: &str = "PLAN_NO_REVIEW_CHANNEL";
/// The answer when the person chose to keep planning.
pub const PLAN_KEEP_PLANNING: &str = "PLAN_KEEP_PLANNING";

/// DSH's sentence for a missing review channel.
pub const NO_REVIEW_CHANNEL_MESSAGE: &str = "no user-questions channel is available to review the plan; ask the user to switch the session mode instead";

/// One answer of the review question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanReviewOption {
    /// What the person reads on the button.
    pub label: &'static str,
    /// What choosing it does.
    pub description: &'static str,
}

/// The review question, as DSH asks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanReviewQuestion {
    /// `plan-review`.
    pub id: &'static str,
    /// `Plan review`.
    pub header: &'static str,
    /// The question.
    pub question: &'static str,
    /// Approve: leave plan mode.
    pub approve: PlanReviewOption,
    /// Keep planning: stay, with feedback.
    pub keep_planning: PlanReviewOption,
}

/// The review question, as DSH asks it (`PLAN_REVIEW`).
pub const PLAN_REVIEW: PlanReviewQuestion = PlanReviewQuestion {
    id: "plan-review",
    header: "Plan review",
    question: "Approve this plan and leave plan mode?",
    approve: PlanReviewOption {
        label: "Approve",
        description: "Leave plan mode; the plan is carried out from the next step.",
    },
    keep_planning: PlanReviewOption {
        label: "Keep planning",
        description: "Stay in plan mode; feedback goes back to the model.",
    },
};

/// What the person decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanReviewAnswer {
    /// `approve`: leave plan mode and carry out the plan.
    Approve,
    /// `keep-planning`: stay in plan mode; the feedback goes back to the model.
    KeepPlanning {
        /// What the person wrote, possibly nothing.
        feedback: String,
    },
    /// `dismissed`: the person closed the review to answer in their own words; plan mode stays on.
    Dismissed,
}

/// The plan as the review shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanForReview {
    /// The plan's first heading, or `Plan`.
    pub title: String,
    /// The plan, trimmed.
    pub markdown: String,
}

/// Where a plan is reviewed: the session's user-question channel.
///
/// An `Err` is the channel failing, which the tool reports as a failed call (`TOOL_FAILED`), as a rejected promise
/// is in the TypeScript build.
pub trait PlanReviewChannel: Send + Sync {
    /// Ask the person about `plan`; `cancel` is the call's Stop.
    fn review(
        &self,
        session: &SessionHandle,
        plan: PlanForReview,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'static, Result<PlanReviewAnswer, String>>;
}

/// What the tool reads and changes.
pub trait PlanToolHost: Send + Sync {
    /// Whether the session is in plan mode.
    fn active(&self, session: &SessionHandle) -> bool;
    /// Leave plan mode; an `Err` is the store refusing the write.
    fn leave(&self, session: &SessionHandle) -> Result<(), String>;
    /// The review channel, looked up per call; `None` while none is provided.
    fn channel(&self) -> Option<Arc<dyn PlanReviewChannel>>;
}

/// The plan's first markdown heading (any level), as DSH reads its title: `/^#{1,6}\s+(.+?)\s*$/` per line.
pub fn plan_title(plan: &str) -> Option<String> {
    plan.split('\n').find_map(heading_title)
}

/// One line against `/^#{1,6}\s+(.+?)\s*$/`: the captured title, or `None`.
fn heading_title(line: &str) -> Option<String> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest: Vec<char> = line.chars().skip(hashes).collect();
    let spaces = rest.iter().take_while(|c| text::is_space(**c)).count();
    if spaces == 0 {
        return None;
    }
    let body = &rest[spaces..];
    if body.is_empty() {
        // `\s+` gives a character back so `(.+?)` has one: the last whitespace that is not a line terminator, with at
        // least one whitespace left before it.
        return (1..spaces)
            .rev()
            .find(|at| !text::is_line_terminator(rest[*at]))
            .map(|at| rest[at].to_string());
    }
    // `(.+?)` is lazy and `\s*$` must take the rest, so the title is the body without its trailing whitespace — as
    // long as `.` can match all of it.
    let kept = body.len()
        - body
            .iter()
            .rev()
            .take_while(|c| text::is_space(**c))
            .count();
    let title = &body[..kept];
    if title.iter().any(|c| text::is_line_terminator(*c)) {
        return None;
    }
    Some(title.iter().collect())
}

/// Whether a trimmed plan opens with a `#` heading: `/^#\s+\S/` (a second `#` is not whitespace, so `## x` is not).
fn opens_with_heading(trimmed: &str) -> bool {
    let mut chars = trimmed.chars();
    if chars.next() != Some('#') {
        return false;
    }
    let after: Vec<char> = chars.collect();
    let spaces = after.iter().take_while(|c| text::is_space(**c)).count();
    spaces > 0 && after.get(spaces).is_some_and(|c| !text::is_space(*c))
}

/// The tool's spec: DSH's name, description and parameter.
pub fn exit_plan_mode_spec() -> ToolSpec {
    ToolSpec {
        name: EXIT_PLAN_MODE.to_owned(),
        description: EXIT_DESCRIPTION.to_owned(),
        parameters: json!({
            "type": "object",
            "properties": {
                "plan": { "type": "string", "description": PLAN_PARAMETER_DESCRIPTION },
            },
            "required": ["plan"],
            "additionalProperties": false,
        }),
    }
}

/// `exit_plan_mode` over `host`.
pub fn exit_plan_mode_tool(host: Arc<dyn PlanToolHost>) -> Arc<dyn Tool> {
    Arc::new(ExitPlanMode {
        spec: exit_plan_mode_spec(),
        host,
    })
}

/// The tool: a spec and the host it reads and changes.
struct ExitPlanMode {
    spec: ToolSpec,
    host: Arc<dyn PlanToolHost>,
}

fn approved(approved: bool) -> Map<String, Value> {
    Map::from_iter([("approved".to_owned(), Value::Bool(approved))])
}

impl Tool for ExitPlanMode {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn run<'a>(&'a self, args: ToolArgs, context: ToolRunContext) -> ToolFuture<'a> {
        Box::pin(async move {
            let Some(session) = context.session.clone() else {
                return Ok(ToolResult::refused(
                    PLAN_NO_SESSION,
                    format!("{EXIT_PLAN_MODE} requires a calling agent (no session to switch)"),
                ));
            };
            if !self.host.active(&session) {
                return Ok(ToolResult::refused(
                    PLAN_NOT_ACTIVE,
                    format!("{EXIT_PLAN_MODE} is only available in plan mode"),
                ));
            }
            let plan = args.get("plan").and_then(Value::as_str).unwrap_or("");
            let trimmed = text::trim(plan);
            if !opens_with_heading(trimmed) {
                return Ok(ToolResult::refused(
                    PLAN_NO_HEADING,
                    format!(
                        "{EXIT_PLAN_MODE} requires a non-empty markdown plan starting with a # heading"
                    ),
                ));
            }
            let Some(channel) = self.host.channel() else {
                return Ok(ToolResult::refused(
                    PLAN_NO_REVIEW_CHANNEL,
                    NO_REVIEW_CHANNEL_MESSAGE,
                ));
            };
            let review = PlanForReview {
                title: plan_title(plan).unwrap_or_else(|| "Plan".to_owned()),
                markdown: trimmed.to_owned(),
            };
            let answer = channel
                .review(&session, review, context.cancel.clone())
                .await
                .map_err(ToolFailure::Failed)?;
            match answer {
                PlanReviewAnswer::Approve => {
                    self.host.leave(&session).map_err(ToolFailure::Failed)?;
                    Ok(ToolResult::ok(
                        "Plan approved — plan mode exited; carry out the plan starting with your next step.",
                    )
                    .with_data(approved(true)))
                }
                PlanReviewAnswer::KeepPlanning { feedback } => {
                    let feedback = text::trim(&feedback);
                    Ok(ToolResult::refused(
                        PLAN_KEEP_PLANNING,
                        if feedback.is_empty() {
                            "The user chose to keep planning; revise the plan and present it again."
                                .to_owned()
                        } else {
                            format!("The user chose to keep planning; their feedback: {feedback}")
                        },
                    ))
                }
                PlanReviewAnswer::Dismissed => Ok(ToolResult::ok(
                    "The user dismissed the plan review to reply in their own words; plan mode remains active.",
                )
                .with_data(approved(false))),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::mode::{PlanLog, plan_active, set_plan_mode};
    use crate::test_support::Fixture;
    use heddle_tools::{SandboxMode, ToolContext};

    /// A channel that answers what it is told and records what it was shown.
    struct Scripted {
        answer: PlanReviewAnswer,
        shown: Mutex<Vec<PlanForReview>>,
    }

    impl Scripted {
        fn new(answer: PlanReviewAnswer) -> Arc<Self> {
            Arc::new(Self {
                answer,
                shown: Mutex::new(Vec::new()),
            })
        }
    }

    impl PlanReviewChannel for Scripted {
        fn review(
            &self,
            _session: &SessionHandle,
            plan: PlanForReview,
            _cancel: Option<CancellationToken>,
        ) -> BoxFuture<'static, Result<PlanReviewAnswer, String>> {
            self.shown.lock().unwrap().push(plan);
            let answer = self.answer.clone();
            Box::pin(async move { Ok(answer) })
        }
    }

    /// The tool over a log, as the TypeScript test builds it.
    struct Host {
        log: Arc<dyn PlanLog>,
        channel: Option<Arc<dyn PlanReviewChannel>>,
    }

    impl PlanToolHost for Host {
        fn active(&self, session: &SessionHandle) -> bool {
            self.log
                .read(session)
                .is_ok_and(|events| plan_active(events.as_slice()))
        }

        fn leave(&self, session: &SessionHandle) -> Result<(), String> {
            set_plan_mode(self.log.as_ref(), session, false).map(|_| ())
        }

        fn channel(&self) -> Option<Arc<dyn PlanReviewChannel>> {
            self.channel.clone()
        }
    }

    fn tool(fixture: &Fixture, channel: Option<Arc<dyn PlanReviewChannel>>) -> Arc<dyn Tool> {
        exit_plan_mode_tool(Arc::new(Host {
            log: fixture.store.clone(),
            channel,
        }))
    }

    fn args(plan: &str) -> ToolArgs {
        ToolArgs::from_iter([("plan".to_owned(), json!(plan))])
    }

    async fn run(
        tool: &Arc<dyn Tool>,
        args: ToolArgs,
        session: Option<&SessionHandle>,
    ) -> ToolResult {
        let mut context = ToolContext::new(std::env::temp_dir());
        if let Some(session) = session {
            context = context.with_session(session.clone());
        }
        tool.run(
            args,
            ToolRunContext::new(context, SandboxMode::WorkspaceWrite),
        )
        .await
        .expect("the tool answers")
    }

    const PLAN: &str = "# Ship the slash menu\n\n1. Registry\n2. Menu";

    #[test]
    fn exit_plan_mode_carries_dshs_name_description_and_parameter() {
        let fixture = Fixture::new("tool-spec");
        let tool = tool(&fixture, None);
        let spec = tool.spec();
        assert_eq!(spec.name, EXIT_PLAN_MODE);
        assert_eq!(spec.description, EXIT_DESCRIPTION);
        assert_eq!(
            spec.parameters,
            json!({
                "type": "object",
                "properties": { "plan": { "type": "string", "description": "The complete plan, as markdown, starting with a # heading that names it." } },
                "required": ["plan"],
                "additionalProperties": false,
            })
        );
        // The provider reads the schema's bytes: the TypeScript key order.
        assert_eq!(
            serde_json::to_string(&spec.parameters).unwrap(),
            r##"{"type":"object","properties":{"plan":{"type":"string","description":"The complete plan, as markdown, starting with a # heading that names it."}},"required":["plan"],"additionalProperties":false}"##
        );
        assert_eq!(PLAN_REVIEW.id, "plan-review");
        assert_eq!(PLAN_REVIEW.header, "Plan review");
        assert_eq!(
            PLAN_REVIEW.question,
            "Approve this plan and leave plan mode?"
        );
        assert_eq!(
            [PLAN_REVIEW.approve.label, PLAN_REVIEW.keep_planning.label],
            ["Approve", "Keep planning"]
        );
    }

    #[tokio::test]
    async fn exit_plan_mode_refuses_without_a_session_outside_plan_mode_without_a_heading_and_without_a_review_channel()
     {
        let fixture = Fixture::new("tool-refusals");
        let handle = &fixture.handle;
        let refuse = |result: ToolResult| {
            let error = result.error.expect("a refusal");
            (error.code, error.message)
        };
        let no_channel = tool(&fixture, None);
        assert_eq!(
            refuse(run(&no_channel, args(PLAN), None).await),
            (
                "PLAN_NO_SESSION".to_owned(),
                "exit_plan_mode requires a calling agent (no session to switch)".to_owned()
            )
        );
        assert_eq!(
            refuse(run(&no_channel, args(PLAN), Some(handle)).await),
            (
                "PLAN_NOT_ACTIVE".to_owned(),
                "exit_plan_mode is only available in plan mode".to_owned()
            )
        );
        set_plan_mode(fixture.log(), handle, true).unwrap();
        let no_heading = (
            "PLAN_NO_HEADING".to_owned(),
            "exit_plan_mode requires a non-empty markdown plan starting with a # heading"
                .to_owned(),
        );
        for plan in ["no heading here", "#", "## Two hashes", "#x", "", "   # "] {
            assert_eq!(
                refuse(run(&no_channel, args(plan), Some(handle)).await),
                no_heading,
                "{plan:?}"
            );
        }
        assert_eq!(
            refuse(run(&no_channel, ToolArgs::new(), Some(handle)).await),
            no_heading,
            "a missing plan is the empty plan"
        );
        assert_eq!(
            refuse(
                run(
                    &no_channel,
                    ToolArgs::from_iter([("plan".to_owned(), json!(7))]),
                    Some(handle)
                )
                .await
            ),
            no_heading,
            "a plan that is not a string is the empty plan"
        );
        assert_eq!(
            refuse(run(&no_channel, args(PLAN), Some(handle)).await),
            (
                "PLAN_NO_REVIEW_CHANNEL".to_owned(),
                "no user-questions channel is available to review the plan; ask the user to switch the session mode instead".to_owned()
            )
        );
        assert!(
            plan_active(fixture.events().as_slice()),
            "every refusal leaves plan mode on"
        );
        // `\s` takes a line feed too, so a heading whose title is on the next line passes the check.
        let channel = Scripted::new(PlanReviewAnswer::Dismissed);
        let reviewed = tool(&fixture, Some(channel.clone()));
        assert_eq!(
            run(&reviewed, args("#\nTitle below"), Some(handle))
                .await
                .error,
            None
        );
        assert_eq!(
            channel.shown.lock().unwrap()[0],
            PlanForReview {
                title: "Plan".to_owned(),
                markdown: "#\nTitle below".to_owned()
            },
            "no line is a heading, so the title is Plan"
        );
    }

    #[tokio::test]
    async fn an_approved_plan_leaves_plan_mode_keeping_on_planning_and_dismissing_do_not() {
        let approved_session = Fixture::new("tool-approve");
        set_plan_mode(approved_session.log(), &approved_session.handle, true).unwrap();
        let yes = Scripted::new(PlanReviewAnswer::Approve);
        let result = run(
            &tool(&approved_session, Some(yes.clone())),
            args(&format!("\n{PLAN}\n")),
            Some(&approved_session.handle),
        )
        .await;
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({ "output": "Plan approved — plan mode exited; carry out the plan starting with your next step.", "data": { "approved": true } })
        );
        assert_eq!(
            *yes.shown.lock().unwrap(),
            vec![PlanForReview {
                title: "Ship the slash menu".to_owned(),
                markdown: PLAN.to_owned()
            }]
        );
        assert!(!plan_active(approved_session.events().as_slice()));

        let kept = Fixture::new("tool-keep");
        set_plan_mode(kept.log(), &kept.handle, true).unwrap();
        let again = run(
            &tool(
                &kept,
                Some(Scripted::new(PlanReviewAnswer::KeepPlanning {
                    feedback: "  split the menu out  ".to_owned(),
                })),
            ),
            args(PLAN),
            Some(&kept.handle),
        )
        .await;
        let error = again.error.expect("keep planning is a refusal");
        assert_eq!(error.code, "PLAN_KEEP_PLANNING");
        assert_eq!(
            error.message,
            "The user chose to keep planning; their feedback: split the menu out"
        );
        let silent = run(
            &tool(
                &kept,
                Some(Scripted::new(PlanReviewAnswer::KeepPlanning {
                    feedback: String::new(),
                })),
            ),
            args(PLAN),
            Some(&kept.handle),
        )
        .await;
        assert_eq!(
            silent.error.unwrap().message,
            "The user chose to keep planning; revise the plan and present it again."
        );
        assert!(plan_active(kept.events().as_slice()));

        let dismissed = run(
            &tool(&kept, Some(Scripted::new(PlanReviewAnswer::Dismissed))),
            args(PLAN),
            Some(&kept.handle),
        )
        .await;
        assert_eq!(
            serde_json::to_value(&dismissed).unwrap(),
            json!({ "output": "The user dismissed the plan review to reply in their own words; plan mode remains active.", "data": { "approved": false } })
        );
        assert!(plan_active(kept.events().as_slice()));
    }

    #[tokio::test]
    async fn a_channel_that_fails_is_a_failed_call() {
        struct Broken;
        impl PlanReviewChannel for Broken {
            fn review(
                &self,
                _session: &SessionHandle,
                _plan: PlanForReview,
                _cancel: Option<CancellationToken>,
            ) -> BoxFuture<'static, Result<PlanReviewAnswer, String>> {
                Box::pin(async { Err("the question was withdrawn".to_owned()) })
            }
        }
        let fixture = Fixture::new("tool-broken");
        set_plan_mode(fixture.log(), &fixture.handle, true).unwrap();
        let tool = tool(&fixture, Some(Arc::new(Broken)));
        let context = ToolRunContext::new(
            ToolContext::new(std::env::temp_dir()).with_session(fixture.handle.clone()),
            SandboxMode::WorkspaceWrite,
        );
        let failure = tool.run(args(PLAN), context).await.expect_err("a failure");
        assert_eq!(failure.to_string(), "the question was withdrawn");
        assert!(plan_active(fixture.events().as_slice()));
    }

    #[test]
    fn a_plans_title_is_its_first_heading_at_any_level() {
        assert_eq!(
            plan_title("intro\n## Phase one  \n# Later"),
            Some("Phase one".to_owned())
        );
        assert_eq!(plan_title("no heading"), None);
        assert_eq!(
            plan_title("####### seven\n###### six"),
            Some("six".to_owned())
        );
        assert_eq!(plan_title("#title\n# Real"), Some("Real".to_owned()));
        assert_eq!(
            plan_title("# CRLF title\r\n"),
            Some("CRLF title".to_owned())
        );
        assert_eq!(plan_title("# a\rb\n# next"), Some("next".to_owned()));
        assert_eq!(
            plan_title("#   "),
            Some(" ".to_owned()),
            "as the regex reads it"
        );
        assert_eq!(plan_title("# "), None);
        assert_eq!(plan_title("#  \r"), Some(" ".to_owned()));
        assert_eq!(plan_title("# \r\r"), None);
        assert_eq!(plan_title("# \u{a0}Wide\u{3000}"), Some("Wide".to_owned()));
    }
}
