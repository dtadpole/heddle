//! The Trajectory table's rows, and the lanes of its timeline.
//!
//! Ported from `projectRows`, `previewOf` and `laneOf` in `src/server/ledger.ts`. DSH's table is one row per event
//! with the turn and step boundaries carried **on the rows**, not as nested containers — which is what lets it be
//! virtualised, searched and collapsed by turn — so the flattening is done here, where a test can judge it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ledger::{Ledger, LedgerKind, LedgerRecord};

/// The three lanes of DSH's timeline overview: what was put in, what the model produced, what ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LedgerLane {
    Input,
    Model,
    Tools,
}

/// One row of the Trajectory table: a record, plus where it sits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRow {
    /// The turn's index; `0` for a loose record.
    pub turn: u32,
    /// The step's index; absent for a loose record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<u32>,
    pub kind: LedgerKind,
    pub record: LedgerRecord,
    /// True on a turn's first row.
    pub turn_start: bool,
    /// True on a step's first row.
    pub step_start: bool,
    /// True for a record that belongs to no turn: logged before the first prompt or between two turns.
    pub loose: bool,
    /// The one line the table shows for the row.
    pub preview: String,
}

/// Which lane a kind belongs to: `user`, `context`, `system` are input; `tool` is tools; the rest are model.
pub fn lane_of(kind: LedgerKind) -> LedgerLane {
    match kind {
        LedgerKind::User | LedgerKind::Context | LedgerKind::System => LedgerLane::Input,
        LedgerKind::Tool => LedgerLane::Tools,
        LedgerKind::Assistant | LedgerKind::Reasoning | LedgerKind::Compaction => LedgerLane::Model,
    }
}

/// The one line a row shows: its text's first line; else `(tool call only)` for an assistant, the tool's name
/// for a tool, the label otherwise.
pub fn preview_of(record: &LedgerRecord) -> String {
    let text = record.text.split('\n').next().unwrap_or("");
    if !text.is_empty() {
        return text.to_owned();
    }
    match record.kind {
        LedgerKind::Assistant => "(tool call only)".to_owned(),
        LedgerKind::Tool => record.name.clone().unwrap_or_else(|| record.label.clone()),
        _ => record.label.clone(),
    }
}

/// Flatten the ledger into table rows: every step's records in order, and the loose records where they happened.
///
/// A record that belongs to no turn sits in a section of its own (DSH's `Between turns`): before the first turn, or
/// after the turn its `after_turn` names. It is marked loose and given turn `0` rather than an invented turn, and the
/// first row of each section is a `turn_start`. A record without `after_turn` (a ledger built by hand) follows the last
/// turn, and a run whose turn is missing still comes last, so no record is dropped.
pub fn project_rows(ledger: &Ledger) -> Vec<LedgerRow> {
    let last_turn = ledger.turns.last().map_or(0, |turn| turn.index);
    let mut between: BTreeMap<u32, Vec<&LedgerRecord>> = BTreeMap::new();
    for record in &ledger.loose {
        between
            .entry(record.after_turn.unwrap_or(last_turn))
            .or_default()
            .push(record);
    }
    let mut rows = Vec::new();
    let section = |rows: &mut Vec<LedgerRow>, records: Vec<&LedgerRecord>| {
        for (index, record) in records.into_iter().enumerate() {
            rows.push(LedgerRow {
                turn: 0,
                step: None,
                kind: record.kind,
                record: record.clone(),
                turn_start: index == 0,
                step_start: false,
                loose: true,
                preview: preview_of(record),
            });
        }
    };
    section(&mut rows, between.remove(&0).unwrap_or_default());
    for turn in &ledger.turns {
        for step in &turn.steps {
            for (index, record) in step.records.iter().enumerate() {
                let turn_start = rows
                    .last()
                    .is_none_or(|row: &LedgerRow| row.turn != turn.index);
                rows.push(LedgerRow {
                    turn: turn.index,
                    step: Some(step.index),
                    kind: record.kind,
                    record: record.clone(),
                    turn_start,
                    step_start: index == 0,
                    loose: false,
                    preview: preview_of(record),
                });
            }
        }
        section(&mut rows, between.remove(&turn.index).unwrap_or_default());
    }
    for (_, records) in std::mem::take(&mut between) {
        section(&mut rows, records);
    }
    rows
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::ledger::{LedgerRecord, project_ledger};

    fn message(seq: u64, at: &str, role: &str, text: &str) -> serde_json::Value {
        json!({"seq": seq, "at": at, "type": "message", "message": {"role": role, "content": [{"type": "text", "text": text}]}})
    }

    fn request(seq: u64, at: &str) -> serde_json::Value {
        json!({"seq": seq, "at": at, "type": "model/request", "messages": 1})
    }

    #[test]
    fn rows_carry_where_they_sit_so_a_table_can_draw_boundaries_without_a_tree() {
        let ledger = project_ledger(&[
            message(1, "2026-10-17T10:00:00.000Z", "user", "one"),
            request(2, "2026-10-17T10:00:00.100Z"),
            json!({"seq": 3, "at": "2026-10-17T10:00:00.200Z", "type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "a"}}),
            json!({"seq": 4, "at": "2026-10-17T10:00:00.300Z", "type": "assistant/completed", "text": "a", "finishReason": "stop", "rounds": 1}),
            json!({"seq": 5, "at": "2026-10-17T10:00:00.400Z", "type": "turn/completed", "rounds": 1}),
            message(6, "2026-10-17T10:00:01.000Z", "user", "two"),
            request(7, "2026-10-17T10:00:01.100Z"),
            json!({"seq": 8, "at": "2026-10-17T10:00:01.200Z", "type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "b"}}),
            json!({"seq": 9, "at": "2026-10-17T10:00:01.300Z", "type": "assistant/completed", "text": "b", "finishReason": "stop", "rounds": 1}),
            json!({"seq": 10, "at": "2026-10-17T10:00:01.400Z", "type": "turn/completed", "rounds": 1}),
        ]);
        let rows = project_rows(&ledger);
        assert_eq!(
            rows.iter()
                .map(|row| (row.turn, row.step, row.turn_start, row.step_start))
                .collect::<Vec<_>>(),
            vec![
                (1, Some(1), true, true),
                (1, Some(1), false, false),
                (1, Some(1), false, false),
                (2, Some(1), true, true),
                (2, Some(1), false, false),
                (2, Some(1), false, false),
            ],
            "the first row of each turn is marked, and so is the first row of each step"
        );
        assert_eq!(
            rows.iter().filter(|row| row.turn_start).count(),
            2,
            "one boundary per turn"
        );
    }

    #[test]
    fn a_row_carries_its_own_one_line_preview() {
        assert_eq!(
            preview_of(&LedgerRecord::new(LedgerKind::User, "user", "two\nlines")),
            "two",
            "the first line is the preview"
        );
        let mut tool = LedgerRecord::new(LedgerKind::Tool, "→ list_dir", "{\"path\":\"/tmp\"}");
        tool.name = Some("list_dir".to_owned());
        assert_eq!(preview_of(&tool), "{\"path\":\"/tmp\"}");
        assert_eq!(
            preview_of(&LedgerRecord::new(LedgerKind::Assistant, "assistant", "")),
            "(tool call only)",
            "an answer that only called tools says so"
        );
        let mut result_only = LedgerRecord::new(LedgerKind::Tool, "tool result", "");
        result_only.result = Some("a.txt".to_owned());
        assert_eq!(
            preview_of(&result_only),
            "tool result",
            "a result with no call still names itself"
        );
        assert_eq!(
            preview_of(&LedgerRecord::new(LedgerKind::System, "request", "")),
            "request"
        );

        let ledger = project_ledger(&[
            message(1, "2026-10-17T10:00:00.000Z", "user", "ask"),
            request(2, "2026-10-17T10:00:00.100Z"),
            json!({"seq": 3, "at": "2026-10-17T10:00:00.200Z", "type": "turn/completed", "rounds": 1}),
        ]);
        assert_eq!(
            project_rows(&ledger)[0].preview,
            "ask",
            "and the projection puts it on the row"
        );
    }

    #[test]
    fn a_loose_record_sits_where_it_happened_with_turn_zero_and_no_step() {
        let ledger = project_ledger(&[
            json!({"seq": 1, "at": "2026-10-17T10:00:00.000Z", "type": "something/new", "detail": 1}),
            message(2, "2026-10-17T10:00:00.100Z", "user", "ask"),
            request(3, "2026-10-17T10:00:00.200Z"),
            json!({"seq": 4, "at": "2026-10-17T10:00:00.300Z", "type": "turn/completed", "rounds": 1}),
        ]);
        let rows = project_rows(&ledger);
        let loose = rows.first().expect("the loose row");
        assert!(loose.loose);
        assert_eq!(
            loose.record.after_turn,
            Some(0),
            "it came before the first turn"
        );
        assert_eq!(loose.turn, 0, "a loose record does not invent a turn");
        assert_eq!(loose.step, None);
        assert!(loose.turn_start, "it heads its own Between turns section");
        assert!(!loose.step_start);
        assert!(
            rows[1].turn == 1 && rows[1].turn_start,
            "and the turn after it still starts its own section"
        );
    }

    #[test]
    fn a_hand_built_loose_record_without_its_turn_follows_the_last_turn() {
        let mut ledger = project_ledger(&[
            message(1, "2026-10-17T10:00:00.100Z", "user", "ask"),
            request(2, "2026-10-17T10:00:00.200Z"),
            json!({"seq": 3, "at": "2026-10-17T10:00:00.300Z", "type": "turn/completed", "rounds": 1}),
        ]);
        ledger
            .loose
            .push(LedgerRecord::new(LedgerKind::System, "note", "kept"));
        let rows = project_rows(&ledger);
        let last = rows.last().expect("a row");
        assert!(
            last.loose && last.turn_start,
            "it is not dropped, and it heads a section after the last turn"
        );
    }

    #[test]
    fn every_kind_belongs_to_one_of_the_three_overview_lanes() {
        assert_eq!(lane_of(LedgerKind::User), LedgerLane::Input);
        assert_eq!(lane_of(LedgerKind::Context), LedgerLane::Input);
        assert_eq!(lane_of(LedgerKind::System), LedgerLane::Input);
        assert_eq!(lane_of(LedgerKind::Assistant), LedgerLane::Model);
        assert_eq!(lane_of(LedgerKind::Reasoning), LedgerLane::Model);
        assert_eq!(lane_of(LedgerKind::Compaction), LedgerLane::Model);
        assert_eq!(lane_of(LedgerKind::Tool), LedgerLane::Tools);
    }
}
