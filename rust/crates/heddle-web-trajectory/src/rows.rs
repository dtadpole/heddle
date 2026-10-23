//! The Trajectory table's rows, and the lanes of its timeline.
//!
//! Ported from `projectRows`, `previewOf` and `laneOf` in `src/server/ledger.ts`. DSH's table is one row per event
//! with the turn and step boundaries carried **on the rows**, not as nested containers — which is what lets it be
//! virtualised, searched and collapsed by turn — so the flattening is done here, where a test can judge it.

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
    /// True for a record that belongs to no turn.
    pub loose: bool,
    /// The one line the table shows for the row.
    pub preview: String,
}

/// Which lane a kind belongs to: `user`, `context`, `system` are input; `tool` is tools; the rest are model.
pub fn lane_of(kind: LedgerKind) -> LedgerLane {
    let _ = kind;
    todo!("lane_of")
}

/// The one line a row shows: its text's first line; else `(tool call only)` for an assistant, the tool's name
/// for a tool, the label otherwise.
pub fn preview_of(record: &LedgerRecord) -> String {
    let _ = record;
    todo!("preview_of")
}

/// Flatten the ledger into table rows: every step's records in order, then the loose records last, marked loose
/// and given turn `0` rather than an invented turn.
pub fn project_rows(ledger: &Ledger) -> Vec<LedgerRow> {
    let _ = ledger;
    todo!("project_rows")
}
