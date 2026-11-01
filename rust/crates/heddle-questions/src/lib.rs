//! Heddle in Rust: `ask_user_question`, the questions a model asks a person, and their answers.
//!
//! Ported from `src/questions/` (DSH's `dsh-tool-ask-user` over the user-questions seam): [`model`] holds the
//! vocabulary and its checks, [`service`] the event-sourced requests and the process-local waits, [`tool`] the
//! model-facing tool, [`http`] the three routes' exact answers, and [`log`] the session-log seam the boot fills with
//! `heddle-session`'s store.

pub mod http;
pub mod log;
pub mod model;
pub mod service;
pub mod tool;

pub use http::{HttpAnswer, get_questions, is_question_id, post_question};
pub use log::{LogError, QuestionLog};
pub use model::{
    Answer, Presentation, Question, QuestionError, QuestionIntent, QuestionOption,
    apply_presentation, codes, presentation_from_value, validate_answers, validate_questions,
};
pub use service::{
    AnswerOutcome, AskOutcome, INTERRUPTED_REASON, Mode, QuestionConfig, QuestionService,
    fold_questions, late_answer_message,
};
pub use tool::{ASK_USER_TOOL, AskUserTool, ask_user_parameters};

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use heddle_config::Env;
    use heddle_session::{CreateOptions, SessionStore};
    use heddle_tools::{CancellationToken, SandboxMode, Tool, ToolContext, ToolRunContext};
    use serde_json::{Value, json};

    use super::*;

    struct Fixture {
        root: PathBuf,
        store: Arc<SessionStore>,
        session: String,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn fixture(label: &str) -> Fixture {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "heddle-questions-{label}-{}-{nanos}",
            std::process::id()
        ));
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let store = Arc::new(SessionStore::new(
            &root.join("sessions").display().to_string(),
            &Env::default(),
        ));
        let handle = store
            .create(CreateOptions {
                cwd: Some(work.display().to_string()),
                ..CreateOptions::default()
            })
            .unwrap();
        Fixture {
            root,
            store,
            session: handle.id,
        }
    }

    fn service(fixture: &Fixture, mode: Mode, timeout: i64) -> Arc<QuestionService> {
        Arc::new(QuestionService::new(
            fixture.store.clone(),
            QuestionConfig { mode, timeout },
        ))
    }

    fn one() -> Value {
        json!([{ "id": "q", "question": "Ready?", "options": [{ "label": "Go" }] }])
    }

    async fn first_open(service: &QuestionService, session: &str) -> Value {
        for _ in 0..100 {
            if let Some(view) = service.list(session, true).unwrap().into_iter().next() {
                return Value::Object(view);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no open question")
    }

    fn question_events(fixture: &Fixture) -> Vec<String> {
        let handle = fixture.store.open(&fixture.session).unwrap();
        fixture
            .store
            .read(&handle)
            .unwrap()
            .iter()
            .map(|event| {
                event.to_value()["type"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            })
            .filter(|kind| kind.starts_with("question/"))
            .collect()
    }

    #[tokio::test]
    async fn a_blocking_ask_waits_for_the_answer_and_the_log_records_both_halves() {
        let fixture = fixture("blocking");
        let questions = service(&fixture, Mode::Legacy, 120);
        let asking = tokio::spawn({
            let questions = Arc::clone(&questions);
            let session = fixture.session.clone();
            async move { questions.ask(&session, &one(), None, None).await }
        });
        let open = first_open(&questions, &fixture.session).await;
        assert_eq!(open["state"], "waiting");
        assert_eq!(open["timed"], false);
        assert_eq!(open["deadline"], Value::Null);
        let id = open["id"].as_str().unwrap().to_owned();
        let outcome = questions
            .answer(
                &fixture.session,
                &id,
                &json!([{ "id": "q", "selected": ["Go"] }]),
            )
            .unwrap();
        assert!(!outcome.late);
        assert_eq!(
            asking.await.unwrap().unwrap(),
            AskOutcome::Answered(vec![Answer {
                id: "q".into(),
                selected: vec!["Go".into()],
                custom: None
            }])
        );
        assert_eq!(
            question_events(&fixture),
            ["question/asked", "question/answered"]
        );
        assert_eq!(
            questions
                .answer(&fixture.session, &id, &json!([]))
                .unwrap_err()
                .code,
            codes::SETTLED
        );
    }

    #[tokio::test]
    async fn a_timed_ask_resolves_pending_and_a_late_answer_is_dshs_user_message() {
        let fixture = fixture("timed");
        let questions = service(&fixture, Mode::Timed, 30);
        let outcome = questions
            .ask(
                &fixture.session,
                &json!([{ "id": "q", "question": "Ready?" }]),
                Some(&json!(1)),
                None,
            )
            .await
            .unwrap();
        let AskOutcome::Pending { call_id } = outcome else {
            panic!("expected pending")
        };
        assert_eq!(
            questions.get(&fixture.session, &call_id).unwrap().unwrap()["state"],
            "pending"
        );
        let late = questions
            .answer(
                &fixture.session,
                &call_id,
                &json!([{ "id": "q", "selected": [], "custom": "yes" }]),
            )
            .unwrap();
        assert!(late.late);
        assert_eq!(
            late.message.unwrap(),
            format!(
                r#"{{"kind":"answer_to_pending_question","tool":"ask_user_question","callId":"{call_id}","questions":[{{"id":"q","question":"Ready?"}}],"answers":[{{"id":"q","selected":[],"custom":"yes"}}]}}"#
            )
        );
        assert_eq!(
            questions.get(&fixture.session, &call_id).unwrap().unwrap()["late"],
            true
        );
    }

    #[tokio::test]
    async fn take_time_holds_a_timed_wait_past_its_deadline() {
        let fixture = fixture("hold");
        let questions = service(&fixture, Mode::Timed, 120);
        let asking = tokio::spawn({
            let questions = Arc::clone(&questions);
            let session = fixture.session.clone();
            async move { questions.ask(&session, &one(), Some(&json!(1)), None).await }
        });
        let open = first_open(&questions, &fixture.session).await;
        assert!(
            open["deadline"].is_string(),
            "a timed wait shows its deadline"
        );
        let id = open["id"].as_str().unwrap().to_owned();
        let held = questions.hold(&fixture.session, &id).unwrap();
        assert_eq!(held["held"], true);
        assert_eq!(held["deadline"], Value::Null);
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert_eq!(
            questions.get(&fixture.session, &id).unwrap().unwrap()["state"],
            "waiting"
        );
        questions
            .answer(
                &fixture.session,
                &id,
                &json!([{ "id": "q", "selected": [] }]),
            )
            .unwrap();
        assert!(matches!(
            asking.await.unwrap().unwrap(),
            AskOutcome::Answered(_)
        ));
    }

    #[tokio::test]
    async fn stop_cancels_a_waiting_question_and_the_log_says_so() {
        let fixture = fixture("stop");
        let questions = service(&fixture, Mode::Legacy, 120);
        let stop = CancellationToken::new();
        let asking = tokio::spawn({
            let questions = Arc::clone(&questions);
            let session = fixture.session.clone();
            let stop = stop.clone();
            async move { questions.ask(&session, &one(), None, Some(stop)).await }
        });
        first_open(&questions, &fixture.session).await;
        stop.cancel();
        assert_eq!(asking.await.unwrap().unwrap_err().code, codes::CANCELLED);
        let all = questions.list(&fixture.session, false).unwrap();
        assert_eq!(all[0]["state"], "cancelled");
        assert_eq!(all[0]["reason"], "stopped");
        assert!(questions.list(&fixture.session, true).unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_question_asked_before_a_restart_is_answerable_after_it() {
        let fixture = fixture("restart");
        let before = service(&fixture, Mode::Legacy, 120);
        let asking = tokio::spawn({
            let before = Arc::clone(&before);
            let session = fixture.session.clone();
            async move { before.ask(&session, &one(), None, None).await }
        });
        first_open(&before, &fixture.session).await;
        let after = service(&fixture, Mode::Legacy, 120);
        let open = Value::Object(after.list(&fixture.session, true).unwrap().remove(0));
        assert_eq!(
            open["state"], "continued",
            "a new process sees the request with no turn waiting"
        );
        let outcome = after
            .answer(
                &fixture.session,
                open["id"].as_str().unwrap(),
                &json!([{ "id": "q", "selected": [] }]),
            )
            .unwrap();
        assert!(outcome.late);
        assert!(
            outcome
                .message
                .unwrap()
                .starts_with(r#"{"kind":"answer_to_pending_question""#)
        );
        asking.abort();
    }

    #[tokio::test]
    async fn a_question_only_its_own_turn_can_take_reads_as_cancelled_after_a_restart() {
        // #228: the plan review is asked `continuable: false`; after a crash it fails closed, as DSH's does.
        let fixture = fixture("not-continuable");
        let before = service(&fixture, Mode::Legacy, 120);
        let asking = tokio::spawn({
            let before = Arc::clone(&before);
            let session = fixture.session.clone();
            async move {
                before
                    .ask_with(&session, &one(), None, None, false, None)
                    .await
            }
        });
        let waiting = first_open(&before, &fixture.session).await;
        assert_eq!(
            waiting["state"], "waiting",
            "while its turn waits it is answerable"
        );
        let id = waiting["id"].as_str().unwrap().to_owned();
        let ordinary = tokio::spawn({
            let before = Arc::clone(&before);
            let session = fixture.session.clone();
            async move {
                before
                    .ask(
                        &session,
                        &json!([{ "id": "other", "question": "Ready?" }]),
                        None,
                        None,
                    )
                    .await
            }
        });
        for _ in 0..100 {
            if before.list(&fixture.session, true).unwrap().len() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let handle = fixture.store.open(&fixture.session).unwrap();
        let asked: Vec<Value> = fixture
            .store
            .read(&handle)
            .unwrap()
            .iter()
            .map(|event| event.to_value())
            .filter(|event| event["type"] == "question/asked")
            .collect();
        assert_eq!(asked.len(), 2);
        assert_eq!(asked[0]["continuable"], json!(false));
        assert!(
            asked[1].get("continuable").is_none(),
            "an ordinary request is written as before"
        );

        let after = service(&fixture, Mode::Legacy, 120);
        let all = after.list(&fixture.session, false).unwrap();
        assert_eq!(
            all[0]["state"], "cancelled",
            "a new process sees it closed, not continued"
        );
        assert_eq!(all[0]["reason"], INTERRUPTED_REASON);
        assert_eq!(all[0]["deadline"], Value::Null);
        assert_eq!(
            all[1]["state"], "continued",
            "an ordinary request is still continued"
        );
        let open = after.list(&fixture.session, true).unwrap();
        assert_eq!(open.len(), 1, "only the ordinary one is open");
        assert_eq!(open[0]["id"], all[1]["id"]);
        let refused = after
            .answer(
                &fixture.session,
                &id,
                &json!([{ "id": "q", "selected": ["Go"] }]),
            )
            .unwrap_err();
        assert_eq!(refused.code, codes::SETTLED);
        assert_eq!(
            refused.message,
            format!("question request '{id}' is already cancelled")
        );
        assert!(
            fold_questions(
                &fixture
                    .store
                    .read(&handle)
                    .unwrap()
                    .iter()
                    .map(|event| event.to_value())
                    .collect::<Vec<_>>()
            )[0]
            .settled
            .is_none(),
            "the refusal wrote nothing"
        );

        // In the process that asked it, an answer still reaches the waiting turn.
        before
            .answer(
                &fixture.session,
                &id,
                &json!([{ "id": "q", "selected": ["Go"] }]),
            )
            .unwrap();
        assert_eq!(
            asking.await.unwrap().unwrap(),
            AskOutcome::Answered(vec![Answer {
                id: "q".to_owned(),
                selected: vec!["Go".to_owned()],
                custom: None,
            }])
        );
        ordinary.abort();
    }

    #[tokio::test]
    async fn the_tool_answers_compact_json_and_refuses_a_delegated_agent() {
        let fixture = fixture("tool");
        let questions = service(&fixture, Mode::Legacy, 120);
        let tool = AskUserTool::new(Arc::clone(&questions));
        assert_eq!(tool.spec().name, ASK_USER_TOOL);
        assert!(
            tool.spec().parameters["properties"]
                .get("timeout")
                .is_none()
        );
        assert!(
            AskUserTool::new(service(&fixture, Mode::Timed, 120))
                .spec()
                .parameters["properties"]
                .get("timeout")
                .is_some()
        );

        let handle = fixture.store.open(&fixture.session).unwrap();
        let context = |session| {
            ToolRunContext::new(
                ToolContext::new(fixture.root.clone()).with_session(session),
                SandboxMode::WorkspaceWrite,
            )
        };
        let args = |value: Value| value.as_object().unwrap().clone();
        let running = tokio::spawn({
            let tool = AskUserTool::new(Arc::clone(&questions));
            let context = context(handle.clone());
            async move { tool.run(args(json!({ "questions": one() })), context).await }
        });
        let open = first_open(&questions, &fixture.session).await;
        questions
            .answer(
                &fixture.session,
                open["id"].as_str().unwrap(),
                &json!([{ "id": "q", "selected": ["Go"] }]),
            )
            .unwrap();
        assert_eq!(
            running.await.unwrap().unwrap().output,
            r#"{"answers":[{"id":"q","selected":["Go"]}]}"#
        );

        let child = fixture
            .store
            .create(CreateOptions {
                cwd: Some(fixture.root.display().to_string()),
                parent_session: Some(fixture.session.clone()),
                ..CreateOptions::default()
            })
            .unwrap();
        let refused = tool
            .run(args(json!({ "questions": one() })), context(child))
            .await
            .unwrap();
        assert_eq!(refused.error.unwrap().code, "DELEGATED_CALLER");
        let invalid = tool
            .run(args(json!({ "questions": [] })), context(handle))
            .await
            .unwrap();
        assert_eq!(invalid.error.unwrap().code, codes::INVALID_QUESTIONS);
    }

    #[tokio::test]
    async fn the_routes_answer_the_typescript_servers_statuses_and_bodies() {
        let fixture = fixture("http");
        let questions = service(&fixture, Mode::Legacy, 120);
        assert_eq!(
            get_questions(None, Some(&fixture.session), false).status,
            503
        );
        assert_eq!(
            get_questions(Some(&questions), Some("nope"), false).body,
            "{\"error\":\"a session id is required\"}\n"
        );
        let empty = get_questions(Some(&questions), Some(&fixture.session), false);
        assert_eq!(
            empty.body,
            format!(
                "{{\n  \"session\": \"{}\",\n  \"requests\": []\n}}\n",
                fixture.session
            )
        );
        let asking = tokio::spawn({
            let questions = Arc::clone(&questions);
            let session = fixture.session.clone();
            async move { questions.ask(&session, &one(), None, None).await }
        });
        let id = first_open(&questions, &fixture.session).await["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let body = |answers: Value| json!({ "session": fixture.session, "answers": answers });
        let bad = post_question(
            Some(&questions),
            &id,
            false,
            &body(json!([{ "id": "q", "selected": ["No"] }])),
        );
        assert_eq!(
            (bad.status, bad.body.as_str()),
            (
                400,
                "{\"error\":\"'No' is not an option of question 'q'\",\"code\":\"INVALID_ANSWERS\"}\n"
            )
        );
        let ok = post_question(
            Some(&questions),
            &id,
            false,
            &body(json!([{ "id": "q", "selected": ["Go"] }])),
        );
        assert_eq!(ok.status, 200);
        assert!(
            ok.body
                .starts_with("{\n  \"answered\": true,\n  \"late\": false,\n  \"request\": {")
        );
        asking.await.unwrap().unwrap();
        let again = post_question(Some(&questions), &id, false, &body(json!([])));
        assert_eq!(again.status, 409);

        let after = service(&fixture, Mode::Timed, 1);
        let pending = after
            .ask(&fixture.session, &one(), None, None)
            .await
            .unwrap();
        let AskOutcome::Pending { call_id } = pending else {
            panic!("expected pending")
        };
        let late = post_question(
            Some(&after),
            &call_id,
            false,
            &body(json!([{ "id": "q", "selected": [] }])),
        );
        assert!(
            late.body.contains("\"delivered\": \"none\""),
            "a late answer is handed back, never steered in"
        );
        assert!(
            late.body
                .contains("\"message\": \"{\\\"kind\\\":\\\"answer_to_pending_question\\\"")
        );
    }

    fn review() -> Value {
        json!([{ "id": "plan-review", "header": "Plan review", "question": "Approve this plan and leave plan mode?", "options": [{ "label": "Approve" }, { "label": "Keep planning" }] }])
    }

    fn review_intent() -> Value {
        json!({ "kind": "plan-review", "approve": "Approve", "callId": "call_plan_1" })
    }

    fn presented(presentation: Value) -> Result<Vec<Question>, QuestionError> {
        apply_presentation(
            validate_questions(&review())?,
            &presentation_from_value(&presentation)?,
        )
    }

    #[tokio::test]
    async fn detail_and_intent_come_only_from_a_service_caller_not_the_models_ask_user_question() {
        let mut dressed = review();
        dressed[0]["detail"] = json!("# Fake plan");
        dressed[0]["intent"] = review_intent();
        assert_eq!(
            serde_json::to_value(validate_questions(&dressed).unwrap()).unwrap(),
            review(),
            "the batch check keeps neither field, so the model's arguments drop them"
        );
        let fixture = fixture("dressed");
        let questions = service(&fixture, Mode::Legacy, 120);
        let tool = AskUserTool::new(Arc::clone(&questions));
        let schema = tool.spec().parameters.to_string();
        assert!(!schema.contains("detail") && !schema.contains("intent"));
        let handle = fixture.store.open(&fixture.session).unwrap();
        let context = ToolRunContext::new(
            ToolContext::new(fixture.root.clone()).with_session(handle.clone()),
            SandboxMode::WorkspaceWrite,
        );
        let running = tokio::spawn({
            let args = json!({ "questions": dressed }).as_object().unwrap().clone();
            async move { tool.run(args, context).await }
        });
        let open = first_open(&questions, &fixture.session).await;
        assert_eq!(open["questions"], review());
        let log = fixture.store.read(&handle).unwrap();
        assert!(
            log.iter()
                .all(|event| !event.to_value().to_string().contains("Fake plan")),
            "and the log never holds them"
        );
        questions
            .answer(
                &fixture.session,
                open["id"].as_str().unwrap(),
                &json!([{ "id": "plan-review", "selected": ["Approve"] }]),
            )
            .unwrap();
        running.await.unwrap().unwrap();
    }

    #[test]
    fn a_service_callers_presentation_is_checked_as_dsh_checks_an_intent() {
        let bad = |presentation: Value, why: &str| {
            assert_eq!(
                presented(presentation).unwrap_err().code,
                codes::BAD_INTENT,
                "{why}"
            );
        };
        bad(
            json!({ "plan-review": { "intent": review_intent() } }),
            "an intent needs a detail",
        );
        let mut other = review_intent();
        other["approve"] = json!("Ship it");
        bad(
            json!({ "plan-review": { "detail": "# P", "intent": other } }),
            "approve names an option",
        );
        let mut other = review_intent();
        other["kind"] = json!("other");
        bad(
            json!({ "plan-review": { "detail": "# P", "intent": other } }),
            "plan-review is the one kind",
        );
        bad(
            json!({ "plan-review": { "detail": "   " } }),
            "a detail is non-empty text",
        );
        bad(
            json!({ "plan-review": { "detail": 7 } }),
            "a detail is text",
        );
        let mut other = review_intent();
        other["callId"] = json!("");
        bad(
            json!({ "plan-review": { "detail": "# P", "intent": other } }),
            "a callId is text",
        );
        bad(
            json!({ "plan-review": { "detail": "# P", "intent": { "kind": "plan-review" } } }),
            "an intent names its approving option",
        );
        bad(
            json!({ "elsewhere": { "detail": "# P" } }),
            "the presentation names questions in the batch",
        );
        bad(json!([]), "a presentation is an object");
        let plain = validate_questions(&review()).unwrap();
        assert_eq!(presented(json!({})).unwrap(), plain);
        assert_eq!(
            serde_json::to_value(presented(json!({ "plan-review": { "detail": "# P" } })).unwrap())
                .unwrap()[0]["detail"],
            "# P",
            "a detail may come alone"
        );
        assert_eq!(
            serde_json::to_value(
                presented(json!({ "plan-review": { "detail": "# P", "intent": { "kind": "plan-review", "approve": "Approve" } } }))
                    .unwrap()
            )
            .unwrap()[0]["intent"],
            json!({ "kind": "plan-review", "approve": "Approve" }),
            "callId is optional"
        );
    }

    #[tokio::test]
    async fn a_presented_question_keeps_its_detail_and_intent_through_the_log_the_fold_and_every_view()
     {
        let fixture = fixture("presented");
        let questions = service(&fixture, Mode::Legacy, 120);
        let presentation =
            json!({ "plan-review": { "detail": "# Ship it\n\n1. Go", "intent": review_intent() } });
        let refused = questions
            .ask_with(
                &fixture.session,
                &review(),
                None,
                None,
                true,
                Some(&json!({ "plan-review": { "intent": review_intent() } })),
            )
            .await
            .unwrap_err();
        assert_eq!(refused.code, codes::BAD_INTENT);
        assert!(
            question_events(&fixture).is_empty(),
            "a refused presentation writes nothing"
        );
        let mut batch = review();
        batch
            .as_array_mut()
            .unwrap()
            .push(json!({ "id": "q", "question": "Ready?", "options": [{ "label": "Go" }] }));
        let asking = tokio::spawn({
            let questions = Arc::clone(&questions);
            let session = fixture.session.clone();
            async move {
                questions
                    .ask_with(&session, &batch, None, None, true, Some(&presentation))
                    .await
            }
        });
        let open = first_open(&questions, &fixture.session).await;
        let mut expected = review()[0].clone();
        expected["detail"] = json!("# Ship it\n\n1. Go");
        expected["intent"] = review_intent();
        assert_eq!(open["questions"][0], expected);
        assert_eq!(
            open["questions"][0].to_string(),
            r##"{"id":"plan-review","question":"Approve this plan and leave plan mode?","header":"Plan review","options":[{"label":"Approve"},{"label":"Keep planning"}],"detail":"# Ship it\n\n1. Go","intent":{"kind":"plan-review","approve":"Approve","callId":"call_plan_1"}}"##,
            "the TypeScript build's key order"
        );
        assert_eq!(
            open["questions"][1],
            one()[0],
            "the other question is byte-identical"
        );
        let handle = fixture.store.open(&fixture.session).unwrap();
        let events: Vec<Value> = fixture
            .store
            .read(&handle)
            .unwrap()
            .iter()
            .map(|event| event.to_value())
            .collect();
        assert_eq!(
            serde_json::to_value(&fold_questions(&events)[0].questions).unwrap()[0],
            expected
        );
        let later = service(&fixture, Mode::Legacy, 120);
        let id = open["id"].as_str().unwrap().to_owned();
        assert_eq!(
            Value::Object(later.get(&fixture.session, &id).unwrap().unwrap())["questions"][0],
            expected,
            "a restart reads the same"
        );
        questions
            .answer(
                &fixture.session,
                &id,
                &json!([{ "id": "plan-review", "selected": ["Approve"] }, { "id": "q", "selected": [] }]),
            )
            .unwrap();
        asking.await.unwrap().unwrap();
    }
}
