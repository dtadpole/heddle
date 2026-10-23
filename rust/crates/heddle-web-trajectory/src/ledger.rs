//! The Trajectory ledger: one session's recorded events, projected as a turn-aware ledger.
//!
//! Ported from `projectLedger` in `src/server/ledger.ts`. The Chat view answers *what was said*; this answers
//! *what the harness did* — which step, in which turn, how long it took, and what it cost.
//!
//! The projection, event by event (`type` field):
//!
//! | Event | Becomes |
//! |---|---|
//! | `message` role `user` | closes the open turn, opens turn *n+1* with a `user` record as its prologue |
//! | `message` role `tool` | fills the open call it answers (by `toolCallId`, else the newest open one); an unmatched result is its own `tool` row; text starting `error` marks `state: error` |
//! | `message` role `assistant` | an `assistant` record |
//! | `session/created` | nothing |
//! | `model/request` | closes the open step and opens the next (the prologue folds into it); a `system`/`request` record carrying the estimate |
//! | `assistant/chunk` | assembles one streamed answer: text and reasoning deltas, provider usage, TTFT; a `tool-call` chunk is a `tool` record in state `running`; `done` settles it |
//! | `assistant/completed` | settles the stream; writes the answer only if the step does not already hold the same words; a `completed` note with finish reason and rounds |
//! | `turn/retry` | a `system`/`retry` record |
//! | `turn/completed` | closes the turn, with its rounds |
//! | `context/note` | a `system` record for `origin: system-prompt`, else a `context` record labelled by origin |
//! | anything else | a `system` record labelled by its type, its other fields as pretty JSON (at most 2000 UTF-16 units) |
//!
//! A stream still open when the events end is left **in flight**: no duration, `inFlight: true`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::usage::TokenUsage;

/// What produced a record. The vocabulary is DSH's, so a reader of either tool sees the same words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LedgerKind {
    User,
    Assistant,
    Tool,
    Reasoning,
    System,
    Context,
    Compaction,
}

/// Where a record's token counts came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageSource {
    /// Reported by the provider.
    Provider,
    /// The harness's own estimate.
    Estimated,
}

/// A tool call's state: running until its result says otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolState {
    Running,
    Ok,
    Error,
}

/// One row of the ledger. Every optional field is skipped when `None`, so "not reported" never reads as zero.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRecord {
    pub kind: LedgerKind,
    /// A one-line identity: the tool's name with its arrow, the model, or the record's kind.
    pub label: String,
    /// The full text — the tool's arguments, the reasoning, or the message.
    pub text: String,
    /// When it started, from its own event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// How long it took, in milliseconds; absent while running and when the events cannot measure it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Whether the record had not finished when the events ended. Serialised only when true.
    #[serde(default, skip_serializing_if = "is_false")]
    pub in_flight: bool,
    /// Time to first token, when a stream recorded one and a step start is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    /// Token counts; absent when the record carries none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// Present exactly when `usage` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_source: Option<UsageSource>,
    /// Finish reason, refusal, and the like.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// A tool call's name, without the arrow its label carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The call a result answers — the field that pairs the two halves into one row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// What the tool answered, held on the call's own record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<ToolState>,
    /// Which note wrote a context row: `system-prompt`, `instructions`, `runtime-context`, ….
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl LedgerRecord {
    /// A record with only its kind, label and text set.
    pub fn new(kind: LedgerKind, label: impl Into<String>, text: impl Into<String>) -> Self {
        let _ = (kind, label.into(), text.into());
        todo!("LedgerRecord::new")
    }
}

/// A step: one model request and everything it produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerStep {
    /// 1-based within its turn.
    pub index: u32,
    pub records: Vec<LedgerRecord>,
    /// The model this step asked, when the request named one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// A turn: what one prompt caused, in steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerTurn {
    /// 1-based within the session.
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rounds: Option<u64>,
    pub steps: Vec<LedgerStep>,
}

/// The session-wide token totals a header shows; each absent until something reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerTokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
    /// The sum of every request's own estimate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated: Option<u64>,
}

/// The whole ledger, plus the totals a header shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub turns: Vec<LedgerTurn>,
    /// Records that belong to no turn — events recorded before the first prompt.
    pub loose: Vec<LedgerRecord>,
    pub tokens: LedgerTokens,
    /// How many records the ledger holds, loose ones included.
    pub records: usize,
    /// How many of them are in flight.
    pub in_flight: usize,
}

/// Project events into the ledger. Pure: the same events always give the same ledger.
pub fn project_ledger(events: &[Value]) -> Ledger {
    let _ = events;
    todo!("project_ledger")
}
