//! The body of `GET /api/sessions/{id}?view=ledger`: one read of the events, every projection made from it.
//!
//! The ledger, its rows, its timeline and the tool catalog travel together, so the axis cannot disagree with the
//! rows beneath it, and a tool row travels with its inspector content already rendered.

use heddle_web_composer::ToolSchema;
use serde::Serialize;
use serde_json::Value;

use crate::inspector::{JsonHighlighter, ToolInspection};
use crate::ledger::Ledger;
use crate::rows::LedgerRow;
use crate::timeline::Timeline;

/// `{ id, ledger, rows, timeline, tools }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LedgerView {
    pub id: String,
    pub ledger: Ledger,
    pub rows: Vec<LedgerViewRow>,
    pub timeline: Timeline,
    pub tools: Vec<ToolSchema>,
}

/// A table row; a `tool` row also carries its `inspection`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LedgerViewRow {
    #[serde(flatten)]
    pub row: LedgerRow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inspection: Option<ToolInspection>,
}

/// The view of one session's events.
pub fn ledger_view(
    id: &str,
    events: &[Value],
    catalog: Vec<ToolSchema>,
    highlighter: &(impl JsonHighlighter + ?Sized),
) -> LedgerView {
    let _ = (id, events, catalog, highlighter);
    todo!("ledger_view")
}
