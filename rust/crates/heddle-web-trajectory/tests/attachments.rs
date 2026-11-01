//! A user record carries its images and files in content order, judged on the shared fixture (S151).
//!
//! `fixtures/attachments.jsonl` holds a message with text, an image, a zero-byte file, an unnamed image, a repeat and a
//! part with no stored path, then an attachment-only message. `fixtures/attachments.expected.json` is what both builds'
//! user rows must carry; `test/ledger.test.ts` reads the same two files.

use heddle_web_trajectory::{LedgerKind, project_ledger, project_rows};
use serde_json::{Value, json};

const LOG: &str = include_str!("fixtures/attachments.jsonl");
const EXPECTED: &str = include_str!("fixtures/attachments.expected.json");

#[test]
fn a_user_record_carries_its_images_and_files_in_content_order() {
    let events: Vec<Value> = LOG
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("each fixture line is one JSON event"))
        .collect();
    let users: Vec<Value> = project_rows(&project_ledger(&events))
        .into_iter()
        .filter(|row| row.kind == LedgerKind::User)
        .map(|row| json!({"text": row.record.text, "attachments": row.record.attachments}))
        .collect();
    let expected: Value = serde_json::from_str(EXPECTED).expect("the expected rows are JSON");
    assert_eq!(Value::Array(users), expected);
}

#[test]
fn a_message_without_attachments_serialises_no_key() {
    let ledger = project_ledger(&[
        json!({"seq": 1, "type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}}),
    ]);
    let record = serde_json::to_value(&ledger.turns[0].steps[0].records[0]).unwrap();
    assert!(record.get("attachments").is_none(), "{record}");
}
