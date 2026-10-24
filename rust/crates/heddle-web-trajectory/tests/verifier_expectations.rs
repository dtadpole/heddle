//! The Trajectory verifiers' API expectations, judged on logs the TypeScript build recorded for their own scenarios.
//!
//! `85-trajectory-view` and `80-web-ui` (check-trajectory-view, check-runtime-context) run a browser and a binary;
//! this pins the part they read from `?view=ledger`, so a change to the projection fails here rather than in a
//! verifier run hours later. Each assertion names the check line it stands in for. The inputs are in
//! [`fixtures/`](fixtures/INDEX.md): what the harness actually records for those scenarios, byte for byte.

use heddle_web_composer::catalog::catalog_of;
use heddle_web_composer::{ToolSpec, js};
use heddle_web_trajectory::usage::billed_input_tokens;
use heddle_web_trajectory::{
    JsonHighlighter, LedgerKind, ToolState, ledger_view, project_ledger, session_stats_view,
};
use serde_json::{Value, json};

const RUN_PWD: &str = include_str!("fixtures/85-run-pwd-and-answer.jsonl");
const LIST_DIR_TWO_TURNS: &str = include_str!("fixtures/80-list-dir-two-turns.jsonl");
const COMPOSER_STATS: &str = include_str!("fixtures/80-composer-stats-two-turns.jsonl");

fn events(log: &str) -> Vec<Value> {
    log.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("each fixture line is one JSON event"))
        .collect()
}

/// An escaping stand-in for heddle-web-files' renderer that, like it, marks what it highlighted.
struct Highlighter;

impl JsonHighlighter for Highlighter {
    fn render_json(&self, source: &str) -> String {
        format!(
            "<code class=\"code\"><span class=\"hljs-json\">{}</span></code>",
            js::escape_html(source)
        )
    }
}

/// The profile's tools as the binary will describe them, enough for the Schema tab.
fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "list_dir".to_owned(),
            description: "List a directory".to_owned(),
            parameters: Some(json!({"type": "object", "properties": {"path": {"type": "string"}}})),
        },
        ToolSpec {
            name: "bash".to_owned(),
            description: "Run a shell command".to_owned(),
            parameters: Some(
                json!({"type": "object", "properties": {"command": {"type": "string"}}}),
            ),
        },
    ]
}

/// The `?view=ledger` body, serialised as the page receives it.
fn view_body(id: &str, log: &str) -> Value {
    let view = ledger_view(id, &events(log), catalog_of(&specs()), &Highlighter);
    serde_json::to_value(&view).expect("the view serialises")
}

#[test]
fn the_85_ledger_is_a_projection_in_fields_rather_than_prose() {
    let id = "session-recorded-85";
    let body = view_body(id, RUN_PWD);

    // check.mjs: body.ledger, body.id === id, body.ledger.turns non-empty
    assert_eq!(body["id"], id, "for the session asked for");
    let turns = body["ledger"]["turns"]
        .as_array()
        .expect("the response carries a ledger with turns");
    assert!(!turns.is_empty(), "with turns");

    // each turn has steps; a turn is numbered; a step is numbered
    let turn = &turns[0];
    let steps = turn["steps"].as_array().expect("each turn has steps");
    assert!(!steps.is_empty(), "each turn has steps");
    assert!(turn["index"].is_u64(), "a turn is numbered");
    assert!(steps[0]["index"].is_u64(), "and a step is numbered");

    let records: Vec<&Value> = steps
        .iter()
        .flat_map(|step| step["records"].as_array().expect("records").iter())
        .collect();
    let kinds: Vec<&str> = records
        .iter()
        .map(|record| record["kind"].as_str().unwrap_or(""))
        .collect();
    assert!(kinds.contains(&"user"), "the prompt is a record");
    assert!(
        kinds.contains(&"tool") || kinds.contains(&"assistant"),
        "and so is what the harness did about it"
    );
    for record in &records {
        assert!(
            record["kind"].is_string(),
            "every record names its kind as a field"
        );
        assert!(record["label"].is_string(), "and has a label");
        assert!(record["text"].is_string(), "and its text");
    }

    // the two rules a reader would believe if they were wrong
    let running: Vec<&&Value> = records
        .iter()
        .filter(|record| record["inFlight"] == json!(true))
        .collect();
    assert!(
        running
            .iter()
            .all(|record| record.get("durationMs").is_none()),
        "an in-flight record carries no duration"
    );
    let with_usage: Vec<&&Value> = records
        .iter()
        .filter(|record| record.get("usage").is_some())
        .collect();
    assert!(
        !with_usage.is_empty(),
        "at least the request carries a token count"
    );
    assert!(
        with_usage
            .iter()
            .all(|record| record["usageSource"] == "provider"
                || record["usageSource"] == "estimated"),
        "and every count says where it came from"
    );
    assert_eq!(
        body["ledger"]["inFlight"],
        json!(running.len()),
        "the ledger counts its in-flight records"
    );

    // the scripted turn as the TypeScript build recorded it: the call and its result are one row
    let tools: Vec<&&Value> = records
        .iter()
        .filter(|record| record["kind"] == "tool")
        .collect();
    assert_eq!(tools.len(), 1, "one call, one record");
    assert_eq!(tools[0]["name"], "bash");
    assert_eq!(tools[0]["state"], "ok");
    assert!(
        tools[0]["result"]
            .as_str()
            .is_some_and(|text| text.ends_with("/work\n")),
        "the pwd result is on the call's row"
    );
    assert!(
        records
            .iter()
            .any(|record| record["kind"] == "assistant" && record["text"] == "the answer")
    );
}

#[test]
fn the_80_session_draws_one_row_per_call_with_its_result_and_a_turn_boundary_per_prompt() {
    let body = view_body("session-recorded-80", LIST_DIR_TWO_TURNS);
    let rows = body["rows"]
        .as_array()
        .expect("the projection travels with the ledger");
    assert!(!rows.is_empty(), "the projection travels with the ledger");

    // check-trajectory-view.mjs: toolRows.length === 2, each names list_dir and carries a.txt, two turnStarts
    let tool_rows: Vec<&Value> = rows.iter().filter(|row| row["kind"] == "tool").collect();
    assert_eq!(tool_rows.len(), 2, "two calls, two rows, not four");
    assert!(
        tool_rows
            .iter()
            .all(|row| row["record"]["name"] == "list_dir"),
        "each row names its tool"
    );
    assert!(
        tool_rows.iter().all(|row| row["record"]["result"]
            .as_str()
            .is_some_and(|text| text.contains("a.txt"))),
        "and each carries its result"
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row["turnStart"] == json!(true))
            .count(),
        2,
        "two prompts, two turn boundaries"
    );
    let kinds: Vec<&str> = rows
        .iter()
        .map(|row| row["kind"].as_str().unwrap_or(""))
        .collect();
    assert!(
        kinds.contains(&"user") && kinds.contains(&"assistant"),
        "user and assistant rows are drawn"
    );

    // the details pane: Payload is highlighted JSON, Schema names the tool with its parameters
    for row in &tool_rows {
        let inspection = &row["inspection"];
        assert_eq!(
            inspection["payloadIsJson"], true,
            "the arguments render as JSON"
        );
        assert!(
            inspection["payload"]
                .as_str()
                .is_some_and(|html| html.contains("hljs-")),
            "highlighted, not a text dump"
        );
        assert!(
            inspection["result"]
                .as_str()
                .is_some_and(|html| html.contains("a.txt")),
            "the Result tab shows the answer"
        );
        assert_eq!(
            inspection["schema"]["name"], "list_dir",
            "the Schema tab names the tool"
        );
        assert!(
            inspection["schema"]["parameters"]
                .as_str()
                .is_some_and(|html| html.contains("&quot;type&quot;")),
            "with the schema itself as JSON"
        );
    }
    assert_eq!(
        body["tools"].as_array().map(Vec::len),
        Some(2),
        "the catalog travels with the view"
    );
    assert!(
        body["timeline"]["spans"]
            .as_array()
            .is_some_and(|spans| spans.len() == 2),
        "a tick per turn"
    );
}

#[test]
fn a_runtime_context_snapshot_is_an_attributed_context_row_not_a_chat_turn() {
    // check-runtime-context.mjs reads the ledger for rows naming the runtime context and opens each to the policy.
    let ledger = project_ledger(&events(RUN_PWD));
    let notes: Vec<_> = ledger
        .turns
        .iter()
        .flat_map(|turn| turn.steps.iter().flat_map(|step| step.records.iter()))
        .filter(|record| record.origin.as_deref() == Some("runtime-context"))
        .collect();
    assert_eq!(notes.len(), 1, "one row per snapshot");
    assert_eq!(
        notes[0].kind,
        LedgerKind::Context,
        "a CONTEXT row, attributed to the harness"
    );
    assert_eq!(
        notes[0].label, "runtime-context",
        "named by its origin, not as a person"
    );
    assert!(
        notes[0].text.starts_with("Current runtime context"),
        "the table row names the snapshot"
    );
    assert!(
        notes[0]
            .text
            .contains("Current heddle file policy: workspace-write"),
        "the details carry the policy"
    );
}

#[test]
fn every_call_in_the_recorded_logs_is_settled() {
    // A recorded log whose calls all answered leaves nothing running: the ledger must not invent work in flight.
    for log in [RUN_PWD, LIST_DIR_TWO_TURNS] {
        let ledger = project_ledger(&events(log));
        assert_eq!(ledger.in_flight, 0);
        for record in ledger
            .turns
            .iter()
            .flat_map(|turn| turn.steps.iter().flat_map(|step| step.records.iter()))
        {
            if record.kind == LedgerKind::Tool {
                assert_ne!(
                    record.state,
                    Some(ToolState::Running),
                    "a settled call is not left running"
                );
            }
        }
    }
}

/// check-composer's stats test declares `contextWindow: 2000` on its endpoint; the dock divides by it.
const COMPOSER_CONTEXT_WINDOW: f64 = 2000.0;

/// The chat route's `stats` after the first `n` events, as the page reads it.
fn stats_after(events: &[Value], n: usize) -> Value {
    serde_json::to_value(session_stats_view(&events[..n], || None)).expect("the stats serialise")
}

#[test]
fn the_composer_dock_figures_are_what_check_composer_asserts() {
    // check-composer.mjs, 'the session-statistics dock prints DSH's figures': a provider reporting
    // prompt_tokens 1000 (800 cached) and completion_tokens 50 per round, two turns, a 2000-token window.
    let events = events(COMPOSER_STATS);
    let first_turn_end = events
        .iter()
        .position(|event| event["type"] == "turn/completed")
        .expect("the first turn completed")
        + 1;

    let first = stats_after(&events, first_turn_end);
    assert_eq!(
        first["turns"], 1,
        "'1 turns' — the reference's label is always plural"
    );
    assert_eq!(
        first["steps"], 1,
        "'1 steps' — one model round is one agent step"
    );
    let usage: heddle_web_trajectory::TokenUsage =
        serde_json::from_value(first["usage"].clone()).unwrap();
    let billed = billed_input_tokens(Some(&usage)).expect("a prompt side was reported");
    assert_eq!(
        billed + usage.output_tokens.unwrap(),
        1050,
        "'1.1K tok' — uncached + cache read + output"
    );
    assert_eq!(
        usage.cache_read_tokens.unwrap() as f64 / billed as f64,
        0.8,
        "'Cache hit 80%'"
    );
    assert_eq!(
        first["lastPromptTokens"].as_f64().unwrap() / COMPOSER_CONTEXT_WINDOW,
        0.5,
        "'50%' context share"
    );
    assert!(
        first["generationMs"].as_u64().is_some_and(|ms| ms > 0),
        "the rate has a measured denominator"
    );
    assert_eq!(
        first["decodeTokens"], 50,
        "and the reported output as its numerator"
    );

    let second = stats_after(&events, events.len());
    assert_eq!(second["turns"], 2, "the backend fold counts two turns");
    assert_eq!(second["steps"], 2, "'2 steps'");
    let usage: heddle_web_trajectory::TokenUsage =
        serde_json::from_value(second["usage"].clone()).unwrap();
    let billed = billed_input_tokens(Some(&usage)).unwrap();
    assert_eq!(
        billed + usage.output_tokens.unwrap(),
        2100,
        "'2.1K tok' — the total is cumulative over the session"
    );
    assert_eq!(
        usage.cache_read_tokens.unwrap() as f64 / billed as f64,
        0.8,
        "'Cache hit 80%' still"
    );
    assert_eq!(
        second["lastPromptTokens"].as_f64().unwrap() / COMPOSER_CONTEXT_WINDOW,
        0.5,
        "the context share survives"
    );
    // the reloaded dock prints decodeTokens / (generationMs / 1000) and requires both to be positive
    assert!(second["generationMs"].as_u64().is_some_and(|ms| ms > 0));
    assert_eq!(second["decodeTokens"], 100);
    assert_eq!(
        second["contextBreakdownSource"], "request",
        "the panel's sections are the last request's"
    );
}

#[test]
fn a_provider_that_reports_no_usage_leaves_the_dock_figures_absent() {
    // check-composer.mjs's 'stats-bare' half: no usage frame, so no token figure, rate or context share.
    let events: Vec<Value> = events(COMPOSER_STATS)
        .into_iter()
        .map(|mut event| {
            if let Some(chunk) = event.get_mut("chunk").and_then(Value::as_object_mut) {
                chunk.remove("usage");
            }
            event
        })
        .collect();
    let stats = stats_after(&events, events.len());
    assert_eq!(stats["turns"], 2, "the turns are still counted");
    for absent in ["usage", "lastPromptTokens", "generationMs", "decodeTokens"] {
        assert!(stats.get(absent).is_none(), "{absent} is absent, not zero");
    }
}
