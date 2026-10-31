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
//! - **Edited files**: `write_file` calls since the last user message whose result succeeded are attached, as
//!   `{path, added}`, to that exchange's last answer once the whole log is folded; a refused or failed write, or
//!   one still waiting for its result, changed nothing and is not listed.
//! - **A slash command is a row of its own**, outside the conversation: `command/run` opens a `command` turn
//!   (`{kind, text: "", commandId, name, args?, state: "running"}`) and closes any open run; `command/done`
//!   settles it in place with the host's words (`state` `done`, or `error` for a done of kind `error`).
//!   Neither is a message, so the model never saw either (`src/commands/`, developer-three).
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
    /// A slash command's row: `command/run` and its `command/done`.
    Command,
}

/// A tool turn's phase: running until its result says otherwise; a result starting with `error`
/// (case-insensitive) is an error. A command turn is running until its `command/done`, then done or error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolState {
    Running,
    Ok,
    Error,
    /// A command that finished with kind `success`.
    Done,
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
    /// What the model said, a tool call's arguments, the reasoning text, or a command's answer.
    pub text: String,
    /// A slash command's run id, which pairs its `command/run` and `command/done`. Declared here so a command
    /// turn serializes as the TypeScript object is written: `kind, text, commandId, name, args, state`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    /// A tool call's one-liner, `→ <name>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// What followed a command's name, when the log kept it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ToolState>,
    /// On the answer that closes a completed turn: the seq of its `turn/completed`, which the page's Branch
    /// action sends as the fork's `atSeq` (DSH's turn footer forks at the turn's end seq).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_seq: Option<u64>,
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
            command_id: None,
            label: None,
            name: None,
            args: None,
            tool_call_id: None,
            result: None,
            state: None,
            fork_seq: None,
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

/// A `write_file` call, noted when it is made and **counted only once its result says it succeeded**.
///
/// A call's arguments say what the model asked for, not what happened: a write the sandbox refused, or one that
/// failed for any other reason, changed nothing on disk. Measured 2026-10-29 (DSH parity R-developer-twelve-11):
/// with every write refused, the panel still named three files with their added lines. So a write is held against
/// its call until the paired result arrives, and only an `ok` result makes it an edited file.
#[derive(Debug, Clone)]
struct NotedWrite {
    path: String,
    added: u64,
    ok: bool,
}

/// The write one `write_file` call would make, or `None` for any other tool or unreadable arguments.
fn noted_write(name: &str, arguments: &str) -> Option<NotedWrite> {
    if name != "write_file" {
        return None;
    }
    let arguments = serde_json::from_str::<Value>(arguments).ok()?;
    let path = arguments.get("path").and_then(Value::as_str)?;
    let content = arguments.get("content").and_then(Value::as_str)?;
    Some(NotedWrite {
        path: path.to_owned(),
        added: line_count(content),
        ok: false,
    })
}

/// The edited files of one exchange: its successful writes, first position per path, the latest lines.
fn edited_files(writes: &[NotedWrite]) -> Vec<EditedFile> {
    let mut files: Vec<EditedFile> = Vec::new();
    for write in writes.iter().filter(|write| write.ok) {
        match files.iter_mut().find(|file| file.path == write.path) {
            Some(existing) => existing.added = write.added,
            None => files.push(EditedFile {
                path: write.path.clone(),
                added: write.added,
            }),
        }
    }
    files
}

/// The transcript's attachment addresses for one session (`web.ts`'s `scopeAttachmentUrls`): each card's `url` names
/// the session it is read for, because the upload route serves a file only to a session whose log references it
/// (DSH's `session/attachment`).
pub fn scope_attachment_urls(turns: &mut [ChatTurn], session: &str) {
    let query = format!("session={}", encode_component(session));
    for turn in turns.iter_mut() {
        if let Some(attachments) = turn.attachments.as_mut() {
            for card in attachments.iter_mut() {
                let joint = if card.url.contains('?') { '&' } else { '?' };
                card.url = format!("{}{joint}{query}", card.url);
            }
        }
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
    // Writes kept per exchange in call order, keyed by the index of the user turn that opened it.
    let mut sections: HashMap<usize, Vec<NotedWrite>> = HashMap::new();
    // The write each call would make, by the index of its turn: (the exchange's start, its position there).
    let mut write_of_call: HashMap<usize, (usize, usize)> = HashMap::new();
    let mut section_start: Option<usize> = None;

    let close_runs = |open_assistant: &mut Option<usize>, open_reasoning: &mut Option<usize>| {
        *open_assistant = None;
        *open_reasoning = None;
    };
    // Where each slash command's row sits, by its run id.
    let mut command_at: HashMap<String, usize> = HashMap::new();

    for event in events {
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        // A slash command is a row of its own, outside the conversation: `command/run` opens it and
        // `command/done` settles it with the host's words. An event without a string `commandId` is not one.
        let command_id = event.get("commandId").and_then(Value::as_str);
        if event_type == "command/run"
            && let Some(command_id) = command_id
        {
            close_runs(&mut open_assistant, &mut open_reasoning);
            command_at.insert(command_id.to_owned(), turns.len());
            let mut turn = ChatTurn::new(TurnKind::Command, "");
            turn.command_id = Some(command_id.to_owned());
            turn.name = Some(
                event
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            );
            turn.args = event.get("args").and_then(Value::as_str).map(str::to_owned);
            turn.state = Some(ToolState::Running);
            turns.push(turn);
            continue;
        }
        if event_type == "command/done"
            && let Some(command_id) = command_id
        {
            if let Some(turn) = command_at
                .get(command_id)
                .and_then(|index| turns.get_mut(*index))
            {
                turn.state = Some(
                    if event.get("kind").and_then(Value::as_str) == Some("error") {
                        ToolState::Error
                    } else {
                        ToolState::Done
                    },
                );
                turn.text = event
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
            }
            continue;
        }
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
                            let succeeded = !starts_with_error(&text);
                            if let Some(turn) = turns.get_mut(index) {
                                turn.result = Some(text.clone());
                                turn.state = Some(if succeeded {
                                    ToolState::Ok
                                } else {
                                    ToolState::Error
                                });
                            }
                            // Only a write whose call succeeded is an edited file.
                            if succeeded
                                && let Some(&(start, position)) = write_of_call.get(&index)
                                && let Some(write) = sections
                                    .get_mut(&start)
                                    .and_then(|writes| writes.get_mut(position))
                            {
                                write.ok = true;
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
            // A completed turn can be branched from its closing answer: DSH's turn footer offers "Branch into a
            // new conversation" and forks with `atSeq` at the turn's end, and refuses when the last row is not an
            // answer with text (dsh-client-ui-chat/lib/client.js:6963-7001, 11094-11115, 13266-13285).
            if event_type == "turn/completed"
                && let Some(seq) = event.get("seq").and_then(Value::as_u64)
                && let Some(last) = turns.last_mut()
                && last.kind == TurnKind::Assistant
                && !last.text.trim().is_empty()
            {
                last.fork_seq = Some(seq);
            }
            // A failed turn (`turn/failed`, written by the turn route) is the answer's stop reason, on the
            // notice row a stopped turn uses — web.ts's transcriptTurns does the same. A turn the archived-session
            // gate blocked (`reason: {"kind": "blocked"}`) is no failure and adds nothing: DSH's chat shows no
            // failure for a `blocked` end (`endFailure`, dsh-client-ui-chat lib/client.js:10475-10487) (#139).
            let blocked = event
                .get("reason")
                .and_then(|reason| reason.get("kind"))
                .and_then(Value::as_str)
                == Some("blocked");
            if event_type == "turn/failed" && !blocked {
                let message = event
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|message| !message.is_empty())
                    .unwrap_or("unknown error");
                let reason = format!("the turn failed: {message}");
                match turns.last_mut() {
                    Some(last) if last.kind == TurnKind::Assistant => {
                        last.ended.get_or_insert_with(Vec::new).push(reason);
                    }
                    _ => {
                        let mut turn = ChatTurn::new(TurnKind::Assistant, String::new());
                        turn.ended = Some(vec![reason]);
                        turns.push(turn);
                    }
                }
            }
            close_runs(&mut open_assistant, &mut open_reasoning);
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
                    let mut turn = ChatTurn::new(TurnKind::Tool, arguments);
                    turn.name = Some(name.to_owned());
                    turn.label = Some(format!("→ {name}"));
                    turn.state = Some(ToolState::Running);
                    let id = chunk.get("id").and_then(Value::as_str).map(str::to_owned);
                    turn.tool_call_id = id.clone();
                    turns.push(turn);
                    let index = turns.len() - 1;
                    if let Some(start) = section_start
                        && let Some(write) = noted_write(name, arguments)
                    {
                        let writes = sections.entry(start).or_default();
                        writes.push(write);
                        write_of_call.insert(index, (start, writes.len() - 1));
                    }
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
    let mut sections: Vec<(usize, Vec<NotedWrite>)> = sections.into_iter().collect();
    sections.sort_by_key(|(start, _)| *start);
    for (start, writes) in sections {
        let files = edited_files(&writes);
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

    #[test]
    fn a_failed_turn_is_the_answers_stop_reason_as_in_typescript() {
        let events = vec![
            serde_json::json!({"seq": 0, "type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "go"}]}}),
            serde_json::json!({"seq": 1, "type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "partial"}}),
            serde_json::json!({"seq": 2, "type": "turn/failed", "message": "upstream answered 502"}),
        ];
        let turns = transcript_turns(&events);
        let last = turns.last().expect("an answer row");
        assert_eq!(last.kind, TurnKind::Assistant);
        assert_eq!(
            last.ended.as_deref(),
            Some(&["the turn failed: upstream answered 502".to_owned()][..])
        );

        let alone = transcript_turns(&[
            serde_json::json!({"seq": 0, "type": "turn/failed", "message": ""}),
        ]);
        assert_eq!(
            alone.len(),
            1,
            "a failure with no answer gets a row of its own"
        );
        assert_eq!(
            alone[0].ended.as_deref(),
            Some(&["the turn failed: unknown error".to_owned()][..])
        );
    }

    /// #139: a turn the archived-session gate blocked ends `turn/failed {"reason": {"kind": "blocked"}}` with no
    /// message. It read as "the turn failed: unknown error" on the previous, finished answer; DSH's chat shows no
    /// failure for a `blocked` end (`endFailure`, dsh-client-ui-chat lib/client.js:10475-10487).
    #[test]
    fn a_blocked_turn_adds_no_failure_to_the_previous_answer() {
        let answered = vec![
            serde_json::json!({"seq": 0, "type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "code word?"}]}}),
            serde_json::json!({"seq": 1, "type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "HERON-58"}}),
            serde_json::json!({"seq": 2, "type": "assistant/completed", "text": "HERON-58", "finishReason": "stop", "rounds": 1}),
            serde_json::json!({"seq": 3, "type": "turn/completed"}),
        ];
        let mut blocked = answered.clone();
        blocked.push(
            serde_json::json!({"seq": 4, "type": "turn/failed", "reason": {"kind": "blocked"}}),
        );
        let turns = transcript_turns(&blocked);
        assert_eq!(
            turns.len(),
            transcript_turns(&answered).len(),
            "no row of its own"
        );
        let last = turns.last().expect("the answer row");
        assert_eq!(last.text, "HERON-58");
        assert_eq!(last.ended, None, "and nothing on the previous answer");
        let alone = transcript_turns(&[
            serde_json::json!({"seq": 0, "type": "turn/failed", "reason": {"kind": "blocked"}}),
        ]);
        assert!(alone.is_empty(), "a blocked turn alone draws nothing");
    }
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
    fn the_answer_closing_a_completed_turn_carries_the_seq_a_branch_forks_at() {
        // DSH's turn footer branches with `atSeq` at the turn's end, and only from an answer with text.
        let events = vec![
            json!({"seq": 1, "type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "one"}]}}),
            json!({"seq": 2, "type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "first answer"}}),
            json!({"seq": 3, "type": "assistant/completed", "text": "first answer"}),
            json!({"seq": 4, "type": "turn/completed"}),
            json!({"seq": 5, "type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "two"}]}}),
            json!({"seq": 6, "type": "assistant/chunk", "chunk": {"type": "tool-call", "id": "c1", "name": "list_dir", "arguments": "{}"}}),
            json!({"seq": 7, "type": "turn/completed"}),
        ];
        let turns = transcript_turns(&events);
        let marked: Vec<(TurnKind, &str, u64)> = turns
            .iter()
            .filter_map(|turn| {
                turn.fork_seq
                    .map(|seq| (turn.kind, turn.text.as_str(), seq))
            })
            .collect();
        assert_eq!(marked, vec![(TurnKind::Assistant, "first answer", 4)]);
        assert_eq!(
            serde_json::to_value(&turns[1]).unwrap()["forkSeq"],
            json!(4),
            "serialized with the TypeScript name"
        );
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

    fn answer_files(events: &[Value]) -> Option<Vec<EditedFile>> {
        transcript_turns(events)
            .into_iter()
            .find(|turn| turn.kind == TurnKind::Assistant)
            .and_then(|answer| answer.files)
    }

    fn user(text: &str) -> Value {
        json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
    }

    fn call(id: Option<&str>, name: &str, arguments: Value) -> Value {
        let mut chunk =
            json!({"type": "tool-call", "name": name, "arguments": arguments.to_string()});
        if let Some(id) = id {
            chunk["id"] = json!(id);
        }
        json!({"type": "assistant/chunk", "chunk": chunk})
    }

    fn result(id: Option<&str>, text: &str) -> Value {
        let mut message = json!({"role": "tool", "content": [{"type": "text", "text": text}]});
        if let Some(id) = id {
            message["toolCallId"] = json!(id);
        }
        json!({"type": "message", "message": message})
    }

    fn answer(text: &str) -> Value {
        json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": text}})
    }

    #[test]
    fn a_failed_write_is_not_an_edited_file_and_a_successful_one_is() {
        // DSH parity R-developer-twelve-11, measured 2026-10-29: with every write refused by the sandbox the panel
        // still named the files with their added lines, though the disk was unchanged.
        let events = vec![
            user("edit three files"),
            call(
                Some("c1"),
                "write_file",
                json!({"path": "/w/refused.txt", "content": "one\ntwo\n"}),
            ),
            result(
                Some("c1"),
                "error (SANDBOX): '/w/refused.txt' is outside the sandbox root /elsewhere",
            ),
            call(
                Some("c2"),
                "bash",
                json!({"command": "sed -i '' 's/a/b/' /w/shell.txt"}),
            ),
            result(
                Some("c2"),
                "error (SANDBOX): [sandbox: file access denied under workspace-write mode]",
            ),
            call(
                Some("c3"),
                "write_file",
                json!({"path": "/w/kept.txt", "content": "x\n"}),
            ),
            result(Some("c3"), "wrote 2 bytes to /w/kept.txt"),
            answer("one of three"),
        ];
        assert_eq!(
            answer_files(&events),
            Some(vec![EditedFile {
                path: "/w/kept.txt".into(),
                added: 1
            }]),
            "only the write that succeeded is listed"
        );
        let turns = transcript_turns(&events);
        let refused = turns
            .iter()
            .find(|turn| turn.name.as_deref() == Some("write_file"))
            .expect("the refused call");
        assert_eq!(
            refused.state,
            Some(ToolState::Error),
            "the refused call still reads as an error"
        );
    }

    #[test]
    fn an_exchange_whose_every_write_failed_carries_no_panel() {
        let events = vec![
            user("edit"),
            call(
                Some("c1"),
                "write_file",
                json!({"path": "/w/a.txt", "content": "x"}),
            ),
            result(Some("c1"), "error: permission denied"),
            answer("could not write"),
        ];
        assert_eq!(
            answer_files(&events),
            None,
            "nothing changed, so no Edited files panel"
        );
    }

    #[test]
    fn a_write_still_waiting_for_its_result_is_not_yet_an_edited_file() {
        let events = vec![
            user("edit"),
            answer("writing now"),
            call(
                Some("c1"),
                "write_file",
                json!({"path": "/w/a.txt", "content": "x"}),
            ),
        ];
        assert_eq!(
            answer_files(&events),
            None,
            "a running call has changed nothing yet"
        );
    }

    #[test]
    fn a_path_written_twice_keeps_the_lines_of_its_last_successful_write() {
        // Results without ids pair with the newest open call, as a provider that sends no ids requires.
        let events = vec![
            user("edit"),
            call(
                None,
                "write_file",
                json!({"path": "/w/a.txt", "content": "one\ntwo\nthree\n"}),
            ),
            result(None, "wrote 14 bytes to /w/a.txt"),
            call(
                None,
                "write_file",
                json!({"path": "/w/a.txt", "content": "one\n"}),
            ),
            result(None, "Error: disk full"),
            answer("the second write failed"),
        ];
        assert_eq!(
            answer_files(&events),
            Some(vec![EditedFile {
                path: "/w/a.txt".into(),
                added: 3
            }]),
            "the failed second write does not overwrite the first"
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
    fn a_transcript_names_its_session_in_every_attachment_address() {
        let session = "session-00000000-0000-4000-8000-000000000001";
        let mut turns = transcript_turns(&[json!({
            "type": "message",
            "message": {"role": "user", "content": [
                {"type": "text", "text": "look"},
                {"type": "image", "path": "/h/uploads/a b.png", "name": "a b.png", "bytes": 3}
            ]}
        })]);
        scope_attachment_urls(&mut turns, session);
        let cards = turns[0]
            .attachments
            .as_ref()
            .expect("the user turn's cards");
        assert_eq!(
            cards[0].url,
            format!("/api/uploads/a%20b.png?session={session}")
        );
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

    /// `test/commands.test.ts`: "a session's history shows each command as its own row, settled by its done
    /// event, outside the conversation".
    #[test]
    fn a_sessions_history_shows_each_command_as_its_own_row_settled_by_its_done_event() {
        // A `/goal` create answers with DSH's goal card (developer-nine's `/goal`, D-059).
        let created = "Goal created\nStatus: active\nObjective: ship it\nRounds: 0/256\nActivation: armed\n\nCommands: /goal edit <objective>, /goal pause, /goal clear";
        let turns = transcript_turns(&[
            json!({"type": "message", "seq": 0, "message": {"role": "user", "content": [{"type": "text", "text": "hello"}]}}),
            json!({"type": "command/run", "seq": 1, "commandId": "cmd-0000abcd-1", "name": "goal", "args": "ship it", "source": {"kind": "user"}}),
            json!({"type": "goal/change", "seq": 2}),
            json!({"type": "command/done", "seq": 3, "commandId": "cmd-0000abcd-1", "kind": "success", "text": created}),
            json!({"type": "command/run", "seq": 4, "commandId": "cmd-0000abcd-2", "name": "export"}),
            json!({"type": "command/done", "seq": 5, "commandId": "cmd-0000abcd-2", "kind": "error", "text": "The Web /export command does not accept a path."}),
            json!({"type": "command/run", "seq": 6, "commandId": "cmd-0000abcd-3", "name": "compact"}),
        ]);
        let commands: Vec<&ChatTurn> = turns
            .iter()
            .filter(|turn| turn.kind == TurnKind::Command)
            .collect();
        assert_eq!(
            serde_json::to_value(&commands).unwrap(),
            json!([
                {"kind": "command", "text": created, "commandId": "cmd-0000abcd-1", "name": "goal", "args": "ship it", "state": "done"},
                {"kind": "command", "text": "The Web /export command does not accept a path.", "commandId": "cmd-0000abcd-2", "name": "export", "state": "error"},
                {"kind": "command", "text": "", "commandId": "cmd-0000abcd-3", "name": "compact", "state": "running"},
            ])
        );
        // The bytes keep the TypeScript object's key order.
        assert_eq!(
            serde_json::to_string(commands[0]).unwrap(),
            format!(
                r#"{{"kind":"command","text":{},"commandId":"cmd-0000abcd-1","name":"goal","args":"ship it","state":"done"}}"#,
                serde_json::to_string(created).unwrap()
            )
        );
        assert_eq!(
            turns[0].kind,
            TurnKind::User,
            "the conversation keeps its place"
        );
        assert_eq!(turns.len(), 4);
    }

    #[test]
    fn a_command_run_ends_an_open_answer_and_a_malformed_one_is_not_a_row() {
        let turns = transcript_turns(&[
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "one"}}),
            json!({"type": "command/run", "commandId": "cmd-0000abcd-1", "name": "compact"}),
            json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "two"}}),
            json!({"type": "command/run", "commandId": 7, "name": "compact"}),
            json!({"type": "command/done", "commandId": "cmd-unknown-9", "kind": "success", "text": "x"}),
        ]);
        assert_eq!(
            kinds(&turns),
            vec![TurnKind::Assistant, TurnKind::Command, TurnKind::Assistant],
            "the answer run ends at the command; a run without a string id draws nothing"
        );
        assert_eq!(turns[0].text, "one");
        assert_eq!(turns[2].text, "two");
        assert_eq!(
            turns[1].state,
            Some(ToolState::Running),
            "a done for another id settles nothing"
        );
        assert_eq!(turns[1].text, "");
    }
}
