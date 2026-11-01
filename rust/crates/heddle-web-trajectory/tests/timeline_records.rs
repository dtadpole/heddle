//! The overview's per-record timeline and the answer timing it rests on, judged on the shared fixture.
//!
//! `fixtures/timeline-records.jsonl` is a timed two-turn log: a request, its first token 300 ms later and its completion
//! 1200 ms after the request, a tool call, and a second turn still running. `fixtures/timeline-records.expected.json` is
//! the `records` both builds must produce from it; `test/ledger.test.ts` reads the same two files, so the TypeScript and
//! Rust projections cannot drift apart (developer-ten's condition 4 for S151).

use heddle_web_trajectory::timeline::project_timeline;
use heddle_web_trajectory::{LedgerKind, project_ledger};
use serde_json::Value;

const LOG: &str = include_str!("fixtures/timeline-records.jsonl");
const EXPECTED: &str = include_str!("fixtures/timeline-records.expected.json");

fn events() -> Vec<Value> {
    LOG.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("each fixture line is one JSON event"))
        .collect()
}

#[test]
fn an_answer_is_measured_from_its_step_request_so_its_ttft_is_the_wait_for_the_first_token() {
    // #124: both ledgers opened the answer at its first chunk and measured TTFT from that same chunk, so it read 0 ms.
    let ledger = project_ledger(&events());
    let answers: Vec<_> = ledger
        .turns
        .iter()
        .flat_map(|turn| turn.steps.iter().flat_map(|step| step.records.iter()))
        .filter(|record| record.kind == LedgerKind::Assistant)
        .collect();
    let settled = answers
        .iter()
        .find(|record| !record.in_flight)
        .expect("a settled answer");
    assert_eq!(
        (
            settled.started_at.as_deref(),
            settled.ttft_ms,
            settled.duration_ms
        ),
        (Some("2026-10-31T09:00:01.000Z"), Some(300), Some(1200)),
        "the answer starts at its request; TTFT is the 300 ms before its first token, and it lasts until it completed"
    );
    let running = answers
        .iter()
        .find(|record| record.in_flight)
        .expect("a running answer");
    assert_eq!(
        (
            running.started_at.as_deref(),
            running.ttft_ms,
            running.duration_ms
        ),
        (Some("2026-10-31T09:00:03.400Z"), Some(300), None),
        "a running answer keeps its first chunk as its start, so the axis reaches the stream, and knows its TTFT already"
    );
}

#[test]
fn the_timeline_carries_one_record_per_timed_record_the_same_as_the_typescript_projection() {
    let timeline = project_timeline(&project_ledger(&events()));
    let produced = serde_json::to_value(&timeline.records).expect("the records serialise");
    let expected: Value = serde_json::from_str(EXPECTED).expect("the expected records parse");
    assert_eq!(as_floats(produced), as_floats(expected));
}

/// Every number as an `f64`: the TypeScript answer writes `0` and `1` as integers where Rust writes `0.0` and `1.0`, and
/// the claim is about the values both builds compute, not about how JSON spells them.
fn as_floats(value: Value) -> Value {
    match value {
        Value::Number(number) => Value::from(number.as_f64().expect("a finite number")),
        Value::Array(items) => Value::Array(items.into_iter().map(as_floats).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, field)| (key, as_floats(field)))
                .collect(),
        ),
        other => other,
    }
}
