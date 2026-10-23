//! The body of `GET /api/sessions/{id}?view=ledger`: one read of the events, every projection made from it.
//!
//! The ledger, its rows, its timeline and the tool catalog travel together, so the axis cannot disagree with the
//! rows beneath it, and a tool row travels with its inspector content already rendered.

use heddle_web_composer::ToolSchema;
use serde::Serialize;
use serde_json::Value;

use crate::inspector::{JsonHighlighter, ToolCall, ToolInspection, inspect_tool};
use crate::ledger::{Ledger, LedgerKind, ToolState, project_ledger};
use crate::rows::{LedgerRow, project_rows};
use crate::timeline::{Timeline, project_timeline};

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
    let ledger = project_ledger(events);
    // A tool row travels with its inspector content already rendered: the payload and the schema parameters are
    // highlighted JSON, and every byte of them is escaped by the renderer the unit suite judges.
    let rows = project_rows(&ledger)
        .into_iter()
        .map(|row| {
            let inspection = if row.kind == LedgerKind::Tool {
                Some(inspect_tool(
                    ToolCall {
                        payload: &row.record.text,
                        result: row.record.result.as_deref().unwrap_or(""),
                        name: row.record.name.as_deref(),
                        error: row.record.state == Some(ToolState::Error),
                    },
                    &catalog,
                    highlighter,
                ))
            } else {
                None
            };
            LedgerViewRow { row, inspection }
        })
        .collect();
    let timeline = project_timeline(&ledger);
    LedgerView {
        id: id.to_owned(),
        ledger,
        rows,
        timeline,
        tools: catalog,
    }
}

#[cfg(test)]
mod tests {
    use heddle_web_composer::catalog::catalog_of;
    use serde_json::json;

    use super::*;
    use crate::test_support::Host;

    const SESSION: &str = "session-00000000-0000-4000-8000-000000000000";

    fn events() -> Vec<Value> {
        vec![
            json!({"seq": 1, "at": "2026-10-17T10:00:00.000Z", "type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "list it"}]}}),
            json!({"seq": 2, "at": "2026-10-17T10:00:00.100Z", "type": "model/request", "messages": 1, "estimatedTokens": 20}),
            json!({"seq": 3, "at": "2026-10-17T10:00:00.200Z", "type": "assistant/chunk", "chunk": {"type": "tool-call", "id": "c1", "name": "list_dir", "arguments": "{\"path\":\"/tmp\"}"}}),
            json!({"seq": 4, "at": "2026-10-17T10:00:00.300Z", "type": "message", "message": {"role": "tool", "toolCallId": "c1", "content": [{"type": "text", "text": "a.txt"}]}}),
            json!({"seq": 5, "at": "2026-10-17T10:00:00.400Z", "type": "turn/completed", "rounds": 1}),
        ]
    }

    #[test]
    fn the_view_carries_the_ledger_its_rows_its_timeline_and_the_catalog() {
        let host = Host::default();
        let catalog = catalog_of(&[heddle_web_composer::ToolSpec {
            name: "list_dir".to_owned(),
            description: "list a folder".to_owned(),
            parameters: Some(json!({"type": "object"})),
        }]);
        let view = ledger_view(SESSION, &events(), catalog, &host);
        assert_eq!(view.id, SESSION);
        assert_eq!(view.ledger.turns.len(), 1);
        assert_eq!(view.timeline.spans.len(), 1);
        assert_eq!(view.tools.len(), 1);
        let tool_row = view
            .rows
            .iter()
            .find(|row| row.row.kind == LedgerKind::Tool)
            .expect("the tool row");
        let inspection = tool_row
            .inspection
            .as_ref()
            .expect("a tool row carries its inspection");
        assert!(inspection.payload_is_json);
        assert!(inspection.result.contains("a.txt"));
        assert_eq!(
            inspection
                .schema
                .as_ref()
                .map(|schema| schema.name.as_str()),
            Some("list_dir")
        );
        let user_row = view
            .rows
            .iter()
            .find(|row| row.row.kind == LedgerKind::User)
            .expect("the prompt row");
        assert!(user_row.inspection.is_none(), "only a tool row carries one");
    }

    #[test]
    fn the_serialised_view_flattens_the_row_and_skips_an_absent_inspection() {
        let host = Host::default();
        let view = ledger_view(SESSION, &events(), Vec::new(), &host);
        let body = serde_json::to_value(&view).expect("the view serialises");
        assert_eq!(body["id"], SESSION);
        assert_eq!(
            body["rows"][0]["turn"], 1,
            "the row's fields are on the row, not nested"
        );
        assert_eq!(body["rows"][0]["turnStart"], true);
        assert!(
            body["rows"][0].get("inspection").is_none(),
            "a user row has no inspection key"
        );
        let tool_row = body["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["kind"] == "tool")
            .expect("the tool row");
        assert!(tool_row["inspection"]["payload"].is_string());
        assert_eq!(body["ledger"]["turns"][0]["index"], 1);
        assert!(body["timeline"]["durationMs"].as_u64().unwrap() > 0);
    }
}
