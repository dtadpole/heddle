//! The plan review over the user-question service: DSH's one `plan-review` question, with the plan as its detail.
//!
//! Ported from `questionsReviewChannel` in `src/plan/service.ts` (agreed with developer-eleven on 2026-10-29: the
//! question service stays free of plan semantics and this side asks its public `ask`). Approve approves; Keep
//! planning, or anything typed, keeps planning with the typed words as the feedback; a skip is a dismissal (plan mode
//! stays on). The wait never runs out (`timeout: -1`), so a `pending` answer cannot happen; if it did, it is read as a
//! dismissal — the safe outcome, because it leaves plan mode on. A failed ask (a stop) is passed on as it came.
//!
//! The review is asked not continuable (#228): only the turn that asked it can take the answer. A review left open by a
//! crash reads as cancelled after the restart and an Approve is refused, so no approval reaches the model as a late
//! message while plan mode stays on — DSH's "after a service reload while the review is pending, the call fails
//! closed". `/plan off` remains the manual escape, and the model may present the plan again.
//!
//! Asked as DSH asks it (#231): the question is the short "Approve this plan and leave plan mode?", the plan is the
//! question's `detail`, and its `intent` is `plan-review` with Approve as the approving option and the presenting
//! call's id ([`review_presentation`]). A client draws the plan as rendered Markdown from those.
//!
//! The binary builds this channel over its question service when the `questions` row is loaded and hands it to
//! [`crate::PlanService::provide_review_channel`]; without that row `exit_plan_mode` refuses with DSH's sentence.

use std::sync::Arc;

use futures::future::BoxFuture;
use heddle_session::SessionHandle;
use heddle_tools::CancellationToken;
use serde_json::{Value, json};

use crate::text;
use crate::tool::{PLAN_REVIEW, PlanForReview, PlanReviewAnswer, PlanReviewChannel};

/// How long the review waits for the person: `-1`, never running out.
pub const REVIEW_TIMEOUT: i64 = -1;

/// One answer the question service reports: the question's id, the options chosen, and any typed words.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct QuestionAnswer {
    /// The question it answers.
    pub id: String,
    /// The labels of the options chosen.
    pub selected: Vec<String>,
    /// What the person typed instead of (or as well as) choosing.
    pub custom: Option<String>,
}

/// What an ask came back with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuestionOutcome {
    /// `answered`: the person answered.
    Answered {
        /// One per question asked.
        answers: Vec<QuestionAnswer>,
    },
    /// `pending`: the wait ran out and the question stays open under this call.
    Pending {
        /// The call the answer will arrive under.
        call_id: String,
    },
}

/// The ask's options: `{timeout, signal, continuable, presentation}`.
#[derive(Debug, Clone, Default)]
pub struct AskOptions {
    /// How long to wait; `-1` never runs out.
    pub timeout: Option<i64>,
    /// The call's Stop.
    pub cancel: Option<CancellationToken>,
    /// Whether the request may stay answerable after its turn is gone; the review's is `false` (#228).
    pub continuable: bool,
    /// `detail` and `intent` by question id, `{ <id>: { detail?, intent? } }`, the TypeScript `presentation` (#231).
    pub presentation: Option<Value>,
}

/// The part of the question service the review uses: `ask(handle, questions, {timeout, signal, continuable,
/// presentation})`.
///
/// `questions` is the TypeScript build's array of `{id, header, question, options: [{label, description}]}`; an
/// `Err` is the ask failing (a stop), which the review passes on.
pub trait QuestionAsker: Send + Sync {
    /// Ask the person `questions` in `session`.
    fn ask(
        &self,
        session: &SessionHandle,
        questions: Value,
        options: AskOptions,
    ) -> BoxFuture<'static, Result<QuestionOutcome, String>>;
}

/// The one question a review asks, as the question service takes it; the plan rides [`review_presentation`].
pub fn review_questions() -> Value {
    json!([{
        "id": PLAN_REVIEW.id,
        "header": PLAN_REVIEW.header,
        "question": PLAN_REVIEW.question,
        "options": [
            { "label": PLAN_REVIEW.approve.label, "description": PLAN_REVIEW.approve.description },
            { "label": PLAN_REVIEW.keep_planning.label, "description": PLAN_REVIEW.keep_planning.description },
        ],
    }])
}

/// The review question's presentation: the plan as its `detail`, and the `plan-review` intent with Approve as the
/// approving option and the presenting call's id when known.
pub fn review_presentation(plan: &PlanForReview) -> Value {
    let mut intent = json!({ "kind": "plan-review", "approve": PLAN_REVIEW.approve.label });
    if let Some(call_id) = &plan.call_id {
        intent["callId"] = Value::String(call_id.clone());
    }
    json!({ (PLAN_REVIEW.id): { "detail": plan.markdown, "intent": intent } })
}

/// What an ask's outcome means for the plan.
pub fn read_review(outcome: &QuestionOutcome) -> PlanReviewAnswer {
    let QuestionOutcome::Answered { answers } = outcome else {
        return PlanReviewAnswer::Dismissed;
    };
    let answer = answers
        .iter()
        .find(|entry| entry.id == PLAN_REVIEW.id)
        .or_else(|| answers.first());
    let custom = answer
        .and_then(|answer| answer.custom.as_deref())
        .map(text::trim)
        .unwrap_or("");
    let chose = |label: &str| {
        answer.is_some_and(|answer| answer.selected.iter().any(|chosen| chosen == label))
    };
    if custom.is_empty() && chose(PLAN_REVIEW.approve.label) {
        return PlanReviewAnswer::Approve;
    }
    if !custom.is_empty() || chose(PLAN_REVIEW.keep_planning.label) {
        return PlanReviewAnswer::KeepPlanning {
            feedback: custom.to_owned(),
        };
    }
    PlanReviewAnswer::Dismissed
}

/// The review channel over a question service.
pub fn questions_review_channel(questions: Arc<dyn QuestionAsker>) -> Arc<dyn PlanReviewChannel> {
    Arc::new(QuestionsReview { questions })
}

struct QuestionsReview {
    questions: Arc<dyn QuestionAsker>,
}

impl PlanReviewChannel for QuestionsReview {
    fn review(
        &self,
        session: &SessionHandle,
        plan: PlanForReview,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'static, Result<PlanReviewAnswer, String>> {
        let asked = self.questions.ask(
            session,
            review_questions(),
            AskOptions {
                timeout: Some(REVIEW_TIMEOUT),
                cancel,
                continuable: false,
                presentation: Some(review_presentation(&plan)),
            },
        );
        Box::pin(async move { Ok(read_review(&asked.await?)) })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::test_support::Fixture;

    /// What one ask carried: the questions, the timeout, `continuable` and the presentation.
    type Asked = (Value, Option<i64>, bool, Option<Value>);

    /// A question service that answers what it is told and records what it was asked.
    struct Asker {
        answer: Result<QuestionOutcome, String>,
        asked: Mutex<Vec<Asked>>,
    }

    impl QuestionAsker for Asker {
        fn ask(
            &self,
            _session: &SessionHandle,
            questions: Value,
            options: AskOptions,
        ) -> BoxFuture<'static, Result<QuestionOutcome, String>> {
            self.asked.lock().unwrap().push((
                questions,
                options.timeout,
                options.continuable,
                options.presentation,
            ));
            let answer = self.answer.clone();
            Box::pin(async move { answer })
        }
    }

    fn answered(selected: &[&str], custom: Option<&str>) -> QuestionOutcome {
        QuestionOutcome::Answered {
            answers: vec![QuestionAnswer {
                id: "plan-review".to_owned(),
                selected: selected.iter().map(|label| (*label).to_owned()).collect(),
                custom: custom.map(str::to_owned),
            }],
        }
    }

    fn plan() -> PlanForReview {
        PlanForReview {
            title: "Ship it".to_owned(),
            markdown: "# Ship it\n\n1. Go".to_owned(),
            call_id: Some("call_plan_1".to_owned()),
        }
    }

    async fn review(
        fixture: &Fixture,
        answer: Result<QuestionOutcome, String>,
    ) -> (Result<PlanReviewAnswer, String>, Arc<Asker>) {
        let asker = Arc::new(Asker {
            answer,
            asked: Mutex::new(Vec::new()),
        });
        let channel = questions_review_channel(asker.clone());
        (channel.review(&fixture.handle, plan(), None).await, asker)
    }

    #[tokio::test]
    async fn the_review_over_the_question_service_asks_dshs_plan_review_question_and_reads_each_answer_as_dsh_does()
     {
        let fixture = Fixture::new("review");
        let (approved, asker) = review(&fixture, Ok(answered(&["Approve"], None))).await;
        assert_eq!(approved, Ok(PlanReviewAnswer::Approve));
        assert_eq!(
            asker.asked.lock().unwrap()[0],
            (
                json!([{
                    "id": "plan-review",
                    "header": "Plan review",
                    "question": "Approve this plan and leave plan mode?",
                    "options": [
                        { "label": "Approve", "description": "Leave plan mode; the plan is carried out from the next step." },
                        { "label": "Keep planning", "description": "Stay in plan mode; feedback goes back to the model." },
                    ],
                }]),
                Some(-1),
                false,
                Some(json!({ "plan-review": {
                    "detail": "# Ship it\n\n1. Go",
                    "intent": { "kind": "plan-review", "approve": "Approve", "callId": "call_plan_1" },
                } })),
            ),
            "only the turn that asked the review can take its answer (#228); the plan is the question's detail (#231)"
        );
        assert_eq!(
            review_presentation(&PlanForReview {
                call_id: None,
                ..plan()
            }),
            json!({ "plan-review": { "detail": "# Ship it\n\n1. Go", "intent": { "kind": "plan-review", "approve": "Approve" } } }),
            "with no call found, the review is asked without the link"
        );
        let keep = |feedback: &str| {
            Ok(PlanReviewAnswer::KeepPlanning {
                feedback: feedback.to_owned(),
            })
        };
        assert_eq!(
            review(&fixture, Ok(answered(&["Keep planning"], None)))
                .await
                .0,
            keep("")
        );
        assert_eq!(
            review(&fixture, Ok(answered(&[], Some(" split it "))))
                .await
                .0,
            keep("split it")
        );
        assert_eq!(
            review(&fixture, Ok(answered(&["Approve"], Some("but rename it"))))
                .await
                .0,
            keep("but rename it"),
            "typed words are feedback, never approval"
        );
        assert_eq!(
            review(&fixture, Ok(answered(&[], None))).await.0,
            Ok(PlanReviewAnswer::Dismissed),
            "a skip dismisses"
        );
        assert_eq!(
            review(
                &fixture,
                Ok(QuestionOutcome::Pending {
                    call_id: "call-1".to_owned()
                })
            )
            .await
            .0,
            Ok(PlanReviewAnswer::Dismissed),
            "pending cannot happen with no time limit, and reads as the safe outcome"
        );
        // An answer to another id is read when the review's own is missing, as `?? answers[0]` reads it.
        let other = QuestionOutcome::Answered {
            answers: vec![QuestionAnswer {
                id: "elsewhere".to_owned(),
                selected: vec!["Approve".to_owned()],
                custom: None,
            }],
        };
        assert_eq!(read_review(&other), PlanReviewAnswer::Approve);
        assert_eq!(
            read_review(&QuestionOutcome::Answered {
                answers: Vec::new()
            }),
            PlanReviewAnswer::Dismissed
        );
    }

    #[tokio::test]
    async fn a_stop_during_the_review_reaches_the_turn_as_the_stop_it_is() {
        let fixture = Fixture::new("review-stop");
        let (stopped, _) = review(&fixture, Err("the question was cancelled".to_owned())).await;
        assert_eq!(stopped, Err("the question was cancelled".to_owned()));
    }
}
