//! A session's log folded into the turns the chat view draws — `transcriptTurns` and `attachmentsOf` of
//! `src/server/web.ts`.
//!
//! The fold is pure and is where the subtle rules live, so it is judged directly:
//!
//! - **Deltas, not the completion**: one turn records `assistant/chunk` deltas *and* `assistant/completed`;
//!   reading both prints every answer twice. Consecutive deltas of one kind merge into one turn; a run ends
//!   at anything that is not its own delta.
//! - **Reasoning keeps its own kind**, as it does live.
//! - **A tool call and its result are one turn**: a `tool` message fills in the call its `toolCallId`
//!   names, or the newest open call when the provider sends no ids; an unmatched result is still shown.
//! - **A blank-line-only delta between two ordinary characters is a stream artifact** and is dropped from an
//!   assistant run (a real paragraph break follows sentence punctuation or whitespace).
//! - **A stopped turn says why**: `assistant/completed` with `ended` attaches it to the answer it stopped,
//!   or to a row that exists only to carry it.
//! - **Edited files**: `write_file` calls since the last user message are attached, as `{path, added}`, to
//!   that exchange's last answer once the whole log is folded.
//!
//! Events are read as JSON values, because the fold's job is to ignore what it does not draw rather than to
//! demand a shape: a real log holds `session/created`, `model/request` and many more.

use serde::Serialize;
use serde_json::Value;

/// The kind of a drawn turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnKind {
    User,
    Assistant,
    Reasoning,
    Tool,
}

/// A tool turn's phase: running until its result says otherwise; a result starting with `error`
/// (case-insensitive) is an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolState {
    Running,
    Ok,
    Error,
}

/// One file attached to a person's message, as the transcript draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAttachment {
    /// `image` or `file`.
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub bytes: u64,
    /// `/api/uploads/<encoded leaf>` — the same-origin read-only address of the stored bytes.
    pub url: String,
}

/// One file an exchange wrote: its path and the lines its content carried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EditedFile {
    pub path: String,
    pub added: u64,
}

/// One thing the chat shows, after the fold. Serialized with the TypeScript field names, absent fields
/// omitted.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub kind: TurnKind,
    /// The user message's own `at`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<EditedFile>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<TurnAttachment>>,
    /// What the model said, a tool call's arguments, or the reasoning text.
    pub text: String,
    /// A tool call's one-liner, `→ <name>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ToolState>,
    /// An assistant turn's markdown rendered as a document; set by the session route, never by the fold.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
}

impl ChatTurn {
    /// A turn of `kind` with `text` and nothing else.
    pub fn new(kind: TurnKind, text: impl Into<String>) -> Self {
        todo!()
    }
}

/// The files one message carries, as transcript cards: `image` and `file` parts with a path; the card's
/// name defaults to the path's leaf, the type to `application/octet-stream`, the size to 0.
pub fn attachments_of(content: &[Value]) -> Vec<TurnAttachment> {
    todo!()
}

/// Fold a session's recorded events into the turns the page renders.
pub fn transcript_turns(events: &[Value]) -> Vec<ChatTurn> {
    todo!()
}
