//! A tool result pruned under context pressure keeps one row holding the original, judged on the shared fixture (#186).
//!
//! `fixtures/pruned-result.jsonl` holds a call whose result is later cut down under context pressure: the original
//! result, a `compaction/prune`, then the cut copy as a second `message` for the same call with
//! `surfaceOp: {"op": "replace"}`. DSH keeps a replacement copy model-only, and its trajectory keeps the call's first
//! result. `test/ledger.test.ts` and `test/web.test.ts` read the same file, and so does `transcript.rs`'s fold test.

use heddle_web_trajectory::{LedgerKind, project_ledger, project_rows};
use serde_json::Value;

const LOG: &str = include_str!("fixtures/pruned-result.jsonl");

#[test]
fn a_pruned_tool_result_keeps_one_row_with_the_original() {
    let events: Vec<Value> = LOG
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("each fixture line is one JSON event"))
        .collect();
    let original = events
        .iter()
        .find(|event| event.get("seq").and_then(Value::as_u64) == Some(5))
        .and_then(|event| event.pointer("/message/content/0/text"))
        .and_then(Value::as_str)
        .expect("the fixture holds the original result at seq 5")
        .to_owned();
    let rows = project_rows(&project_ledger(&events));
    let tools: Vec<(String, Option<String>)> = rows
        .iter()
        .filter(|row| row.kind == LedgerKind::Tool)
        .map(|row| (row.record.label.clone(), row.record.result.clone()))
        .collect();
    assert_eq!(
        tools,
        vec![("→ read_file".to_owned(), Some(original))],
        "one row for the call, holding what the tool returned"
    );
    assert!(
        !rows.iter().any(|row| {
            row.record.text.contains("[pruned,")
                || row
                    .record
                    .result
                    .as_deref()
                    .is_some_and(|result| result.contains("[pruned,"))
        }),
        "and the cut copy is drawn nowhere"
    );
}
