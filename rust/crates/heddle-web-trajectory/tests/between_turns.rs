//! Records outside every turn sit where they happened, in DSH's `Between turns` sections, judged on the shared fixture.
//!
//! `fixtures/between-turns.jsonl` is a two-turn log shaped like the TypeScript build's own (S151): `/permission` before
//! the first prompt, `/compact` with its `compaction/start` and `compaction/failed` between the turns, and `/export`
//! after the last. `fixtures/between-turns.expected.json` is the row placement both builds must produce from it;
//! `test/ledger.test.ts` reads the same two files, so the TypeScript and Rust projections cannot drift apart.

use heddle_web_trajectory::{project_ledger, project_rows};
use serde_json::{Value, json};

const LOG: &str = include_str!("fixtures/between-turns.jsonl");
const EXPECTED: &str = include_str!("fixtures/between-turns.expected.json");

fn events() -> Vec<Value> {
    LOG.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("each fixture line is one JSON event"))
        .collect()
}

#[test]
fn a_record_between_turns_sits_where_it_happened_in_its_own_section() {
    // DSH: "A standalone compaction request appears chronologically in its own `Between turns` section." Both builds
    // listed every loose record after the last turn, with no section head.
    let rows = project_rows(&project_ledger(&events()));
    let placed: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut entry = json!({
                "turn": row.turn,
                "loose": row.loose,
                "turnStart": row.turn_start,
                "stepStart": row.step_start,
                "label": row.record.label,
            });
            if let Some(step) = row.step {
                entry["step"] = json!(step);
            }
            if let Some(after) = row.record.after_turn {
                entry["afterTurn"] = json!(after);
            }
            entry
        })
        .collect();
    let expected: Value = serde_json::from_str(EXPECTED).expect("the expected rows are JSON");
    assert_eq!(Value::Array(placed), expected);
}

#[test]
fn only_a_loose_record_names_the_turn_it_follows() {
    let ledger = project_ledger(&events());
    assert!(
        ledger
            .turns
            .iter()
            .flat_map(|turn| turn.steps.iter().flat_map(|step| step.records.iter()))
            .all(|record| record.after_turn.is_none()),
        "a record inside a turn needs no placement"
    );
    let serialized = serde_json::to_value(&ledger).expect("the ledger serializes");
    assert_eq!(
        serialized["loose"][2]["afterTurn"],
        json!(1),
        "the field travels as afterTurn"
    );
    assert!(
        serialized["turns"][0]["steps"][0]["records"][0]
            .get("afterTurn")
            .is_none(),
        "and is absent inside a turn"
    );
}
