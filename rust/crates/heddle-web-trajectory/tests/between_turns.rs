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
fn model_selection_is_metadata_not_a_leading_trajectory_section() {
    let activity = vec![
        json!({"seq":1,"at":"2026-10-31T09:00:01.000Z","type":"message","message":{"role":"user","content":[{"type":"text","text":"one"}]}}),
        json!({"seq":2,"at":"2026-10-31T09:00:01.100Z","type":"model/request","estimatedTokens":10}),
        json!({"seq":3,"at":"2026-10-31T09:00:01.200Z","type":"assistant/completed","text":"first"}),
        json!({"seq":4,"at":"2026-10-31T09:00:01.200Z","type":"turn/completed","rounds":1}),
        json!({"seq":5,"at":"2026-10-31T09:00:02.000Z","type":"message","message":{"role":"user","content":[{"type":"text","text":"two"}]}}),
        json!({"seq":6,"at":"2026-10-31T09:00:02.100Z","type":"model/request","estimatedTokens":10}),
        json!({"seq":7,"at":"2026-10-31T09:00:02.200Z","type":"assistant/completed","text":"second"}),
        json!({"seq":8,"at":"2026-10-31T09:00:02.200Z","type":"turn/completed","rounds":1}),
    ];
    let mut decorated = vec![json!({"seq":0,"at":"2026-10-31T09:00:00.000Z","type":"model/selection","endpoint":"scripted","reasoningEffort":"high"})];
    decorated.extend(activity.iter().cloned());
    let baseline = project_ledger(&activity);
    let ledger = project_ledger(&decorated);
    let rows = project_rows(&ledger);
    assert_eq!(rows.iter().filter(|row| row.turn_start).count(), 2);
    assert_eq!(rows[0].record.label, "user", "turn one starts at row zero");
    assert_eq!(ledger, baseline, "metadata changes no activity counters or records");
    assert_eq!(rows, project_rows(&baseline));
    assert_eq!(heddle_web_trajectory::timeline::project_timeline(&ledger), heddle_web_trajectory::timeline::project_timeline(&baseline));
    assert_eq!(heddle_web_trajectory::stats::project_session_stats(&decorated), heddle_web_trajectory::stats::project_session_stats(&activity));
}

#[test]
fn model_selection_exclusion_keeps_real_commands_and_unknown_events() {
    let mut activity = events();
    activity.push(json!({"seq":17,"at":"2026-10-31T09:00:04.100Z","type":"custom/event","detail":"kept"}));
    let decorated: Vec<Value> = activity.iter().enumerate().flat_map(|(index, event)| {
        [json!({"seq":index*2,"at":"2026-10-31T09:00:00.000Z","type":"model/selection","endpoint":"scripted"}), event.clone()]
    }).collect();
    let baseline = project_ledger(&activity);
    let ledger = project_ledger(&decorated);
    assert_eq!(ledger, baseline, "metadata before, within, between and after turns changes no activity");
    let rows = project_rows(&ledger);
    assert_eq!(rows[0].record.label, "command/run", "a legitimate leading command stays");
    assert_eq!(rows.iter().filter(|row| row.loose && row.record.after_turn == Some(1)).map(|row| row.record.label.as_str()).collect::<Vec<_>>(), vec!["command/run", "compaction/start", "compaction/failed", "command/done"]);
    assert!(rows.iter().any(|row| row.record.label == "custom/event" && row.record.text.contains("kept")));
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
