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

use std::collections::HashMap;

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
        ChatTurn {
            kind,
            time: None,
            files: None,
            ended: None,
            attachments: None,
            text: text.into(),
            label: None,
            name: None,
            tool_call_id: None,
            result: None,
            state: None,
            html: None,
        }
    }
}

/// `encodeURIComponent`, for the leaf of an upload's route: the unreserved marks it keeps are
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )`, and everything else is its UTF-8 bytes as `%XX`.
fn encode_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The leaf of a path, as `basename` reads it.
fn leaf(path: &str) -> Option<&str> {
    let trimmed = path.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    (!name.is_empty()).then_some(name)
}

/// The files one message carries, as transcript cards: `image` and `file` parts with a path; the card's
/// name defaults to the path's leaf, the type to `application/octet-stream`, the size to 0.
pub fn attachments_of(content: &[Value]) -> Vec<TurnAttachment> {
    let mut attachments = Vec::new();
    for part in content {
        let Some(kind) = part.get("type").and_then(Value::as_str) else {
            continue;
        };
        if kind != "image" && kind != "file" {
            continue;
        }
        let Some(path) = part.get("path").and_then(Value::as_str) else {
            continue;
        };
        let Some(leaf) = leaf(path) else {
            continue;
        };
        let name = part
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or(leaf);
        let mime_type = part
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream");
        let bytes = part
            .get("bytes")
            .and_then(Value::as_f64)
            .filter(|bytes| bytes.is_finite())
            .map(|bytes| bytes as u64)
            .unwrap_or(0);
        attachments.push(TurnAttachment {
            kind: kind.to_owned(),
            name: name.to_owned(),
            mime_type: mime_type.to_owned(),
            bytes,
            url: format!("/api/uploads/{}", encode_component(leaf)),
        });
    }
    attachments
}

/// The first character of a string, as `text.slice(-1)` reads it (a code point, not a byte).
fn last_char(text: &str) -> Option<char> {
    text.chars().next_back()
}

/// A run of two or more newlines wedged between two ordinary characters is a stream artifact.
fn is_stream_artifact(text: &str, open: &ChatTurn) -> bool {
    if text.len() < 2 || !text.bytes().all(|byte| byte == b'\n') {
        return false;
    }
    match last_char(&open.text) {
        None => false,
        Some(previous) => {
            !previous.is_whitespace()
                && !matches!(
                    previous,
                    '。' | '．'
                        | '.'
                        | '!'
                        | '?'
                        | '！'
                        | '？'
                        | '：'
                        | ':'
                        | '；'
                        | ';'
                        | '，'
                        | ','
                        | '、'
                        | '）'
                        | ')'
                        | '」'
                        | '』'
                        | '】'
                )
        }
    }
}

/// The number of lines `content` has, as the Edited files panel counts them: a trailing newline closes the
/// last line rather than starting one.
fn line_count(content: &str) -> u64 {
    if content.is_empty() {
        return 0;
    }
    let lines = content.split('\n').count();
    (lines - usize::from(content.ends_with('\n'))) as u64
}

/// Note one `write_file` call, keeping the lines of its content per path.
fn note_write(name: &str, arguments: &str, written: &mut Vec<EditedFile>) {
    if name != "write_file" {
        return;
    }
    let Ok(arguments) = serde_json::from_str::<Value>(arguments) else {
        return;
    };
    let (Some(path), Some(content)) = (
        arguments.get("path").and_then(Value::as_str),
        arguments.get("content").and_then(Value::as_str),
    ) else {
        return;
    };
    let added = line_count(content);
    match written.iter_mut().find(|file| file.path == path) {
        Some(existing) => existing.added = added,
        None => written.push(EditedFile {
            path: path.to_owned(),
            added,
        }),
    }
}

/// Fold a session's recorded events into the turns the page renders.
pub fn transcript_turns(events: &[Value]) -> Vec<ChatTurn> {
    let mut turns: Vec<ChatTurn> = Vec::new();
    // Where each open call sits, by the id its result will carry.
    let mut open: HashMap<String, usize> = HashMap::new();
    // The newest call without a result, for a provider that sends no ids at all.
    let mut last_open: Option<usize> = None;
    let mut open_assistant: Option<usize> = None;
    let mut open_reasoning: Option<usize> = None;
    // Writes kept per exchange, keyed by the index of the user turn that opened it.
    let mut sections: HashMap<usize, Vec<EditedFile>> = HashMap::new();
    let mut section_start: Option<usize> = None;

    let close_runs = |open_assistant: &mut Option<usize>, open_reasoning: &mut Option<usize>| {
        *open_assistant = None;
        *open_reasoning = None;
    };

    for event in events {
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        if event_type == "message" {
            close_runs(&mut open_assistant, &mut open_reasoning);
            let Some(message) = event.get("message") else {
                continue;
            };
            if !message.is_object() {
                continue;
            }
            let content = message
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let text: String = content
                .iter()
                .map(|part| part.get("text").and_then(Value::as_str).unwrap_or(""))
                .collect();
            match message.get("role").and_then(Value::as_str).unwrap_or("") {
                "user" => {
                    section_start = Some(turns.len());
                    let attachments = attachments_of(&content);
                    let mut turn = ChatTurn::new(TurnKind::User, text);
                    if !attachments.is_empty() {
                        turn.attachments = Some(attachments);
                    }
                    if let Some(at) = event.get("at").and_then(Value::as_str) {
                        turn.time = Some(at.to_owned());
                    }
                    turns.push(turn);
                }
                "assistant" => turns.push(ChatTurn::new(TurnKind::Assistant, text)),
                "tool" => {
                    let tool_call_id = message
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let index = tool_call_id
                        .as_ref()
                        .and_then(|id| open.get(id.as_str()).copied())
                        .or(last_open);
                    if let Some(index) = index {
                        let open_call = turns.get(index).is_some_and(|turn| {
                            turn.kind == TurnKind::Tool && turn.result.is_none()
                        });
                        if open_call {
                            if let Some(turn) = turns.get_mut(index) {
                                turn.result = Some(text.clone());
                                turn.state = Some(if starts_with_error(&text) {
                                    ToolState::Error
                                } else {
                                    ToolState::Ok
                                });
                            }
                            if let Some(id) = tool_call_id.as_ref() {
                                open.remove(id.as_str());
                            }
                            last_open = None;
                            continue;
                        }
                    }
                    let mut turn = ChatTurn::new(TurnKind::Tool, "");
                    turn.result = Some(text.clone());
                    turn.state = Some(if starts_with_error(&text) {
                        ToolState::Error
                    } else {
                        ToolState::Ok
                    });
                    turn.tool_call_id = tool_call_id;
                    turns.push(turn);
                }
                _ => {}
            }
            continue;
        }

        if event_type != "assistant/chunk" {
            if event_type == "assistant/completed"
                && let Some(ended) = event.get("ended").and_then(Value::as_array)
            {
                let ended: Vec<String> = ended
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
                if !ended.is_empty() {
                    match turns.last_mut() {
                        Some(last) if last.kind == TurnKind::Assistant => {
                            last.ended = Some(ended);
                        }
                        _ => {
                            let text = event
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                            let mut turn = ChatTurn::new(TurnKind::Assistant, text);
                            turn.ended = Some(ended);
                            turns.push(turn);
                        }
                    }
                }
            }
            // A completion or any other record ends the run of deltas before it. An inbox splice does not: a
            // steer can be queued while the answer streams, and it is not part of the conversation until claimed.
            if event_type != heddle_session::inbox::INBOX_SPLICED {
                close_runs(&mut open_assistant, &mut open_reasoning);
            }
            continue;
        }

        let Some(chunk) = event.get("chunk") else {
            continue;
        };
        let chunk_type = chunk.get("type").and_then(Value::as_str).unwrap_or("");
        match chunk_type {
            "text-delta" => {
                if let Some(text) = chunk.get("text").and_then(Value::as_str) {
                    open_assistant = Some(append(
                        &mut turns,
                        TurnKind::Assistant,
                        text,
                        open_assistant,
                    ));
                    open_reasoning = None;
                }
            }
            "reasoning-delta" => {
                if let Some(text) = chunk.get("text").and_then(Value::as_str) {
                    open_reasoning = Some(append(
                        &mut turns,
                        TurnKind::Reasoning,
                        text,
                        open_reasoning,
                    ));
                    open_assistant = None;
                }
            }
            "tool-call" => {
                if let Some(name) = chunk.get("name").and_then(Value::as_str) {
                    let arguments = chunk
                        .get("arguments")
                        .and_then(Value::as_str)
                        .unwrap_or("{}");
                    if let Some(start) = section_start {
                        note_write(name, arguments, sections.entry(start).or_default());
                    }
                    let mut turn = ChatTurn::new(TurnKind::Tool, arguments);
                    turn.name = Some(name.to_owned());
                    turn.label = Some(format!("→ {name}"));
                    turn.state = Some(ToolState::Running);
                    let id = chunk.get("id").and_then(Value::as_str).map(str::to_owned);
                    turn.tool_call_id = id.clone();
                    turns.push(turn);
                    let index = turns.len() - 1;
                    last_open = Some(index);
                    if let Some(id) = id {
                        open.insert(id, index);
                    }
                    close_runs(&mut open_assistant, &mut open_reasoning);
                }
            }
            _ => {}
        }
    }

    // The Edited files panel belongs to the message that closes an exchange: the writes are attached to
    // that exchange's last answer once the whole log is folded.
    let mut sections: Vec<(usize, Vec<EditedFile>)> = sections.into_iter().collect();
    sections.sort_by_key(|(start, _)| *start);
    for (start, files) in sections {
        if files.is_empty() {
            continue;
        }
        let mut last_answer = None;
        for (index, turn) in turns.iter().enumerate().skip(start + 1) {
            if turn.kind == TurnKind::User {
                break;
            }
            if turn.kind == TurnKind::Assistant {
                last_answer = Some(index);
            }
        }
        if let Some(index) = last_answer {
            turns[index].files = Some(files);
        }
    }
    turns
}

/// Whether a tool result begins with `error`, case-insensitively.
fn starts_with_error(text: &str) -> bool {
    text.to_ascii_lowercase().starts_with("error")
}

/// Append `text` to the open run at `index`, or start a new turn. Answers the index of the run.
fn append(turns: &mut Vec<ChatTurn>, kind: TurnKind, text: &str, index: Option<usize>) -> usize {
    if let Some(index) = index
        && let Some(turn) = turns.get(index)
    {
        // A blank-line-only delta pinned between two ordinary characters is a stream artifact.
        if kind == TurnKind::Assistant && is_stream_artifact(text, turn) {
            return index;
        }
        let mut updated = turn.clone();
        updated.text.push_str(text);
        turns[index] = updated;
        return index;
    }
    let mut turn = ChatTurn::new(kind, text);
    if kind == TurnKind::Tool {
        turn.state = Some(ToolState::Running);
    }
    turns.push(turn);
    turns.len() - 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kinds(turns: &[ChatTurn]) -> Vec<TurnKind> {
        turns.iter().map(|turn| turn.kind).collect()
    }

    #[test]
    fn an_exchange_is_user_then_one_answer_from_its_deltas() {
        let events = vec![
            json!({"type": "session/created"}),
            json!({"type": "message", "at": "2026-10-22T00:00:00.000Z", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "hel"}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "lo"}}),
            // The completion carries the same text; the fold must not print it twice.
            json!({"type": "assistant/completed", "text": "hello"}),
        ];
        let turns = transcript_turns(&events);
        assert_eq!(kinds(&turns), vec![TurnKind::User, TurnKind::Assistant]);
        assert_eq!(turns[0].text, "hi");
        assert_eq!(turns[0].time.as_deref(), Some("2026-10-22T00:00:00.000Z"));
        assert_eq!(turns[1].text, "hello");
    }

    #[test]
    fn reasoning_keeps_its_own_kind_and_ends_the_answer_run() {
        let events = vec![
            json!({"type": "assistant/chunk", "chunk": {"type": "reasoning-delta", "text": "think"}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "reasoning-delta", "text": "ing"}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "answer"}}),
        ];
        let turns = transcript_turns(&events);
        assert_eq!(
            kinds(&turns),
            vec![TurnKind::Reasoning, TurnKind::Assistant]
        );
        assert_eq!(turns[0].text, "thinking");
        assert_eq!(turns[1].text, "answer");
    }

    #[test]
    fn a_tool_call_and_its_result_are_one_turn() {
        let events = vec![
            json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "id": "call-1", "name": "read_file", "arguments": "{\"path\":\"a\"}"}}),
            json!({"type": "message", "message": {"role": "tool", "toolCallId": "call-1", "content": [{"type": "text", "text": "contents"}]}}),
        ];
        let turns = transcript_turns(&events);
        assert_eq!(kinds(&turns), vec![TurnKind::Tool]);
        assert_eq!(turns[0].name.as_deref(), Some("read_file"));
        assert_eq!(turns[0].label.as_deref(), Some("→ read_file"));
        assert_eq!(turns[0].result.as_deref(), Some("contents"));
        assert_eq!(turns[0].state, Some(ToolState::Ok));
        assert_eq!(turns[0].tool_call_id.as_deref(), Some("call-1"));
    }

    #[test]
    fn a_result_pairs_with_the_newest_open_call_when_the_provider_sends_no_ids() {
        let events = vec![
            json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "name": "read_file", "arguments": "{}"}}),
            json!({"type": "message", "message": {"role": "tool", "content": [{"type": "text", "text": "error: nope"}]}}),
        ];
        let turns = transcript_turns(&events);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].state, Some(ToolState::Error));
        assert_eq!(turns[0].result.as_deref(), Some("error: nope"));
    }

    #[test]
    fn an_unmatched_result_is_still_shown() {
        let events = vec![
            json!({"type": "message", "message": {"role": "tool", "toolCallId": "gone", "content": [{"type": "text", "text": "orphan"}]}}),
        ];
        let turns = transcript_turns(&events);
        assert_eq!(kinds(&turns), vec![TurnKind::Tool]);
        assert_eq!(turns[0].result.as_deref(), Some("orphan"));
    }

    #[test]
    fn a_blank_line_only_delta_between_ordinary_characters_is_dropped() {
        let clean = transcript_turns(&[
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "检测"}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "器"}}),
        ]);
        assert_eq!(clean[0].text, "检测器");

        let artifact = transcript_turns(&[
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "检测"}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "\n\n\n"}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "器"}}),
        ]);
        assert_eq!(artifact.len(), 1);
        assert_eq!(artifact[0].text, "检测器");

        // A paragraph break after sentence punctuation is real prose, not an artifact.
        let prose = transcript_turns(&[
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "Done."}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "\n\n"}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "Next"}}),
        ]);
        assert_eq!(prose[0].text, "Done.\n\nNext");
    }

    #[test]
    fn a_stopped_answer_carries_its_reason() {
        let events = vec![
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "half"}}),
            json!({"type": "assistant/completed", "ended": ["max-rounds"]}),
        ];
        let turns = transcript_turns(&events);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].text, "half");
        assert_eq!(turns[0].ended, Some(vec!["max-rounds".to_owned()]));

        // With no answer text at all, a row exists only to carry the notice.
        let empty =
            transcript_turns(&[json!({"type": "assistant/completed", "ended": ["stopped"]})]);
        assert_eq!(empty.len(), 1);
        assert_eq!(empty[0].kind, TurnKind::Assistant);
        assert_eq!(empty[0].text, "");
        assert_eq!(empty[0].ended, Some(vec!["stopped".to_owned()]));
    }

    #[test]
    fn edited_files_attach_to_the_exchange_last_answer() {
        let events = vec![
            json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "write"}]}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "name": "write_file", "arguments": "{\"path\":\"/w/a.txt\",\"content\":\"one\\ntwo\\n\"}"}}),
            json!({"type": "message", "message": {"role": "tool", "content": [{"type": "text", "text": "ok"}]}}),
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "done"}}),
        ];
        let turns = transcript_turns(&events);
        let answer = turns
            .iter()
            .find(|turn| turn.kind == TurnKind::Assistant)
            .expect("an answer");
        assert_eq!(
            answer.files,
            Some(vec![EditedFile {
                path: "/w/a.txt".into(),
                added: 2
            }])
        );
    }

    #[test]
    fn attachments_become_cards_with_the_upload_route() {
        let attachments = attachments_of(&[
            json!({"type": "image", "path": "/u/pic one.png", "mimeType": "image/png", "bytes": 12}),
            json!({"type": "file", "path": "/u/notes.txt"}),
            json!({"type": "text", "text": "ignored"}),
        ]);
        assert_eq!(attachments.len(), 2);
        assert_eq!(attachments[0].kind, "image");
        assert_eq!(attachments[0].name, "pic one.png");
        assert_eq!(attachments[0].mime_type, "image/png");
        assert_eq!(attachments[0].bytes, 12);
        assert_eq!(attachments[0].url, "/api/uploads/pic%20one.png");
        assert_eq!(attachments[1].name, "notes.txt");
        assert_eq!(attachments[1].mime_type, "application/octet-stream");
        assert_eq!(attachments[1].bytes, 0);
    }

    #[test]
    fn a_user_message_carries_its_attachment_cards() {
        let turns = transcript_turns(&[json!({
            "type": "message",
            "message": {"role": "user", "content": [
                {"type": "text", "text": "look"},
                {"type": "image", "path": "/u/a.png"}
            ]}
        })]);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].attachments.as_ref().unwrap().len(), 1);
        assert_eq!(turns[0].text, "look");
    }
}
