//! Closers for a turn its writer never finished: DSH's `openTurnClosers` (`@deepseek-ai/dsh-session`
//! lib/types/repair.js:35-78) read against heddle's log. Ported from `src/session/repair.ts`, to the same bytes.
//!
//! A turn cut by a restart, a crash or a killed command line leaves a log that ends inside the turn: the call
//! the model asked for has no result and the turn has no end, so a view draws the call as running for good
//! (issue #5). DSH balances such a log in two places, and so does heddle:
//!
//! - **When the session is next opened for writing**, before anything else is appended (`dsh-agent-loop`
//!   lib/index.js:1992-1993). Here that is the first time a process takes the session's writer lock
//!   ([`crate::SessionStore::claim`]), which is DSH's write-open; a turn running in this process already holds
//!   the lock, so it is never closed from under itself.
//! - **When a session no writer holds is read** (`readColdSessionLog`, dsh-session-query lib/index.js:26-52):
//!   the same closers are appended to what the reader gets and nothing is written
//!   ([`crate::SessionService::events`]). The two agree byte for byte, so a view does not change when the
//!   session is later written.
//!
//! The closers are heddle's vocabulary for DSH's `tool/result`, `step/end` and `turn/end`: one tool `message`
//! per call the turn left unanswered, in call order; `assistant/completed` with the text and reasoning the turn
//! streamed and an `ended` reason; and `turn/completed` carrying DSH's cause as `reason: { kind }`. Sequences
//! continue the log and every closer reuses the last real event's time, as DSH's do.
//!
//! The result's words are heddle's request-time repair's (`heddle-context` `pairing.rs`,
//! `src/context/pairing.ts`), not DSH's `ToolCallRecovery` text: the model has already been answered in those
//! words, the views draw a result as an error only when it begins with `error`, and heddle records no call
//! start for DSH's started / not-started distinction to rest on. The code, `INTERRUPTED`, is DSH's.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::event::SessionEvent;

/// Why a turn is being closed, which picks the words. DSH also has `forked` (a fork seed cut inside a turn,
/// `buildForkSeed`, dsh-session lib/types/fork.js:26); a fork seed adds its variant here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloserCause {
    /// A crashed or killed writer's turn: DSH's `interruptedTurnClosers` cause.
    Interrupted,
}

impl CloserCause {
    /// The cause's name as DSH writes it in `reason.kind`.
    pub fn kind(self) -> &'static str {
        match self {
            CloserCause::Interrupted => "interrupted",
        }
    }

    /// The answer an open call is given.
    pub fn result_text(self) -> &'static str {
        match self {
            CloserCause::Interrupted => INTERRUPTED_RESULT,
        }
    }

    /// The reason the turn's answer record gives.
    pub fn ended_text(self) -> &'static str {
        match self {
            CloserCause::Interrupted => {
                "the process exited before this turn finished, so the turn was closed; unfinished tool calls have unknown outcomes"
            }
        }
    }
}

/// The answer an interrupted call is given: the request-time repair's words (`heddle-context` `pairing.rs`).
pub const INTERRUPTED_RESULT: &str =
    "error (INTERRUPTED): the turn ended before this call answered";

/// The plain text of a message's parts.
fn text_of(message: &Value) -> String {
    message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect()
}

/// The closers an open tail turn needs, in order; empty when the log's last turn has ended or never began.
///
/// heddle writes no turn-start event, so a turn is known to have begun at its first `model/request` or
/// streamed `assistant/chunk` after the last turn end (`turn/completed` or `turn/failed`) — the markers the
/// goal driver reads a turn in flight from. A prompt with no model call after it is not closed. A call is open
/// from its `tool-call` chunk until a tool message names it; a turn end forgets the calls it leaves, as DSH's
/// recovery does at its boundaries, so an old turn is never reopened.
pub fn open_turn_closers(events: &[Arc<SessionEvent>], cause: CloserCause) -> Vec<SessionEvent> {
    let mut open = false;
    // Unanswered call ids in the order the model asked for them, with a JavaScript `Map`'s semantics: a call
    // asked for again keeps its place, and an answered one is removed.
    let mut pending: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut finish_reason: Option<String> = None;
    let mut requests: u64 = 0;
    let mut retries: u64 = 0;
    let mut errors: u64 = 0;
    for event in events {
        match event.kind.as_str() {
            "turn/completed" | "turn/failed" => {
                open = false;
                pending.clear();
                text.clear();
                reasoning.clear();
                finish_reason = None;
                requests = 0;
                retries = 0;
                errors = 0;
            }
            "model/request" => {
                open = true;
                requests += 1;
            }
            "turn/retry" => retries += 1,
            "assistant/chunk" => {
                if event.is_transient() {
                    continue;
                }
                open = true;
                let Some(chunk) = event.get("chunk") else {
                    continue;
                };
                match chunk["type"].as_str() {
                    Some("text-delta") => text.push_str(chunk["text"].as_str().unwrap_or("")),
                    Some("reasoning-delta") => {
                        reasoning.push_str(chunk["text"].as_str().unwrap_or(""));
                    }
                    Some("tool-call") => {
                        if let Some(id) = chunk["id"].as_str()
                            && !pending.iter().any(|call| call == id)
                        {
                            pending.push(id.to_string());
                        }
                    }
                    Some("done") => {
                        if let Some(reason) = chunk["finishReason"].as_str() {
                            finish_reason = Some(reason.to_string());
                        }
                    }
                    _ => {}
                }
            }
            "message" => {
                let Some(message) = event.get("message") else {
                    continue;
                };
                if message["role"] != "tool" {
                    continue;
                }
                if let Some(id) = message["toolCallId"].as_str() {
                    pending.retain(|call| call != id);
                }
                if text_of(message).starts_with("error (") {
                    errors += 1;
                }
            }
            _ => {}
        }
    }
    let Some(last) = events.last() else {
        return Vec::new();
    };
    if !open {
        return Vec::new();
    }

    let at = last.at.clone();
    let mut seq = events.len() as u64;
    let rounds = requests.saturating_sub(retries);
    let mut closers = Vec::with_capacity(pending.len() + 2);
    let mut push = |kind: &str, fields: Value| {
        let Value::Object(fields) = fields else {
            unreachable!("a closer's fields are an object");
        };
        closers.push(SessionEvent {
            seq,
            at: at.clone(),
            kind: kind.to_string(),
            fields,
        });
        seq += 1;
    };
    for call in &pending {
        push(
            "message",
            json!({"message": {
                "role": "tool",
                "toolCallId": call,
                "content": [{"type": "text", "text": cause.result_text()}],
            }}),
        );
    }
    let mut completed = Map::new();
    completed.insert("text".to_string(), Value::String(text));
    completed.insert("reasoning".to_string(), Value::String(reasoning));
    if let Some(reason) = finish_reason {
        completed.insert("finishReason".to_string(), Value::String(reason));
    }
    completed.insert("rounds".to_string(), Value::from(rounds));
    completed.insert(
        "denials".to_string(),
        Value::from(errors + pending.len() as u64),
    );
    completed.insert("ended".to_string(), json!([cause.ended_text()]));
    push("assistant/completed", Value::Object(completed));
    push(
        "turn/completed",
        json!({"rounds": rounds, "reason": {"kind": cause.kind()}}),
    );
    closers
}

/// The crash-recovery entry point: [`open_turn_closers`] with the `interrupted` cause, DSH's
/// `interruptedTurnClosers`.
pub fn interrupted_turn_closers(events: &[Arc<SessionEvent>]) -> Vec<SessionEvent> {
    open_turn_closers(events, CloserCause::Interrupted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minute: u32) -> String {
        format!("2026-10-30T10:{minute:02}:00.000Z")
    }

    /// A log built the way the TypeScript test builds its own: each event's seq is its position.
    struct Log(Vec<Arc<SessionEvent>>);

    impl Log {
        fn new() -> Self {
            Log(Vec::new())
        }

        fn push(&mut self, kind: &str, fields: Value, minute: u32) -> &mut Self {
            let Value::Object(fields) = fields else {
                panic!("fields are an object");
            };
            self.0.push(Arc::new(SessionEvent {
                seq: self.0.len() as u64,
                at: at(minute),
                kind: kind.to_string(),
                fields,
            }));
            self
        }

        fn event(&mut self, kind: &str) -> &mut Self {
            self.push(kind, json!({}), 0)
        }

        fn user(&mut self, text: &str) -> &mut Self {
            self.push(
                "message",
                json!({"message": {"role": "user", "content": [{"type": "text", "text": text}]}}),
                0,
            )
        }

        fn chunk(&mut self, chunk: Value, minute: u32) -> &mut Self {
            self.push("assistant/chunk", json!({ "chunk": chunk }), minute)
        }

        fn result(&mut self, id: &str, text: &str) -> &mut Self {
            self.push(
                "message",
                json!({"message": {"role": "tool", "toolCallId": id, "content": [{"type": "text", "text": text}]}}),
                0,
            )
        }

        fn balanced() -> Self {
            let mut log = Log::new();
            log.event("session/created")
                .user("hi")
                .event("model/request")
                .chunk(json!({"type": "text-delta", "text": "hello"}), 0)
                .chunk(json!({"type": "done", "finishReason": "stop"}), 0)
                .push("assistant/completed", json!({"text": "hello"}), 0)
                .push("turn/completed", json!({"rounds": 1}), 0);
            log
        }
    }

    fn lines(closers: &[SessionEvent]) -> Vec<String> {
        closers.iter().map(SessionEvent::to_line).collect()
    }

    #[test]
    fn a_cut_turn_is_closed_in_the_bytes_the_typescript_build_writes() {
        // The fixture and the three lines `test/session-turn-closers.test.ts` pins for the TypeScript build.
        let mut log = Log::new();
        log.event("session/created")
            .user("go")
            .event("model/request")
            .chunk(json!({"type": "reasoning-delta", "text": "r"}), 0)
            .chunk(json!({"type": "text-delta", "text": "a"}), 0)
            .chunk(
                json!({"type": "tool-call", "id": "call-1", "name": "bash", "arguments": "{}"}),
                0,
            )
            .chunk(json!({"type": "done", "finishReason": "tool_calls"}), 6);
        assert_eq!(
            lines(&interrupted_turn_closers(&log.0)),
            vec![
                r#"{"seq":7,"at":"2026-10-30T10:06:00.000Z","type":"message","message":{"role":"tool","toolCallId":"call-1","content":[{"type":"text","text":"error (INTERRUPTED): the turn ended before this call answered"}]}}"#,
                r#"{"seq":8,"at":"2026-10-30T10:06:00.000Z","type":"assistant/completed","text":"a","reasoning":"r","finishReason":"tool_calls","rounds":1,"denials":1,"ended":["the process exited before this turn finished, so the turn was closed; unfinished tool calls have unknown outcomes"]}"#,
                r#"{"seq":9,"at":"2026-10-30T10:06:00.000Z","type":"turn/completed","rounds":1,"reason":{"kind":"interrupted"}}"#,
            ]
        );
    }

    #[test]
    fn a_balanced_log_an_empty_one_and_a_prompt_nobody_answered_need_nothing() {
        assert!(interrupted_turn_closers(&Log::balanced().0).is_empty());
        assert!(interrupted_turn_closers(&[]).is_empty());
        // heddle writes no turn start: a prompt with no model call after it is not a turn the loop began.
        let mut log = Log::balanced();
        log.user("a prompt nobody answered");
        assert!(interrupted_turn_closers(&log.0).is_empty());
    }

    #[test]
    fn each_unanswered_call_gets_one_result_in_call_order_before_the_turn_closes() {
        let mut log = Log::balanced();
        log.user("two calls")
            .event("model/request")
            .chunk(
                json!({"type": "tool-call", "id": "call-a", "name": "bash", "arguments": "{}"}),
                0,
            )
            .chunk(
                json!({"type": "tool-call", "id": "call-b", "name": "read_file", "arguments": "{}"}),
                0,
            )
            .chunk(json!({"type": "done", "finishReason": "tool_calls"}), 0)
            .result("call-a", "error (DENIED): not allowed")
            .event("turn/retry")
            .event("model/request")
            .event("model/request")
            .chunk(
                json!({"type": "tool-call", "id": "call-c", "name": "bash", "arguments": "{}"}),
                7,
            );
        let closers = interrupted_turn_closers(&log.0);
        let shape: Vec<(String, Option<String>)> = closers
            .iter()
            .map(|event| {
                (
                    event.kind.clone(),
                    event
                        .get("message")
                        .and_then(|message| message["toolCallId"].as_str())
                        .map(str::to_string),
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                ("message".to_string(), Some("call-b".to_string())),
                ("message".to_string(), Some("call-c".to_string())),
                ("assistant/completed".to_string(), None),
                ("turn/completed".to_string(), None),
            ]
        );
        let n = log.0.len() as u64;
        assert_eq!(
            closers.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![n, n + 1, n + 2, n + 3]
        );
        assert!(closers.iter().all(|event| event.at == at(7)));
        assert_eq!(
            closers[2].get("rounds"),
            Some(&json!(2)),
            "a retry is the same round"
        );
        assert_eq!(closers[2].get("denials"), Some(&json!(3)));
        assert_eq!(closers[2].get("finishReason"), Some(&json!("tool_calls")));
        assert_eq!(
            closers[3].to_line(),
            format!(
                r#"{{"seq":{},"at":"{}","type":"turn/completed","rounds":2,"reason":{{"kind":"interrupted"}}}}"#,
                n + 3,
                at(7)
            )
        );
    }

    #[test]
    fn a_turn_cut_while_it_streamed_text_is_closed_without_inventing_a_result() {
        let mut log = Log::balanced();
        log.user("no call")
            .event("model/request")
            .chunk(json!({"type": "text-delta", "text": "half an ans"}), 0);
        let kinds: Vec<String> = interrupted_turn_closers(&log.0)
            .into_iter()
            .map(|event| event.kind)
            .collect();
        assert_eq!(kinds, vec!["assistant/completed", "turn/completed"]);
    }

    #[test]
    fn a_call_left_in_a_turn_that_already_ended_is_not_reopened() {
        let mut log = Log::new();
        log.event("session/created")
            .user("old")
            .event("model/request")
            .chunk(
                json!({"type": "tool-call", "id": "call-old", "name": "bash", "arguments": "{}"}),
                0,
            )
            .chunk(json!({"type": "done", "finishReason": "tool_calls"}), 0)
            .push("turn/failed", json!({"reason": "boom"}), 0);
        assert!(interrupted_turn_closers(&log.0).is_empty());
    }
}
