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

    /// The answer a command left running is given (#206).
    pub fn command_text(self) -> &'static str {
        match self {
            CloserCause::Interrupted => "The process exited before this command finished.",
        }
    }

    /// The reason a compaction a command left open is closed with (#206).
    pub fn compaction_text(self) -> &'static str {
        match self {
            CloserCause::Interrupted => "the process exited before the compaction finished",
        }
    }
}

/// What a command whose compaction was cut answers: DSH's words for a cancelled `/compact`
/// (dsh-command-compact `cancelled`), the same `COMPACT_CANCELLED` the Stop route answers with
/// (`heddle-commands` `builtins.rs`). The session crate does not depend on the commands crate, so the words
/// are restated here and a test there holds the two equal.
pub const COMPACTION_CANCELLED: &str = "Compaction cancelled.";

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
/// goal driver reads a turn in flight from. A prompt with no model call after it is not closed, with one exception:
/// a turn's automatic compaction, its pre-step. A `compaction/start` after a prompt that has had no turn end opens
/// the turn too (#154): a process killed while that summary ran left the prompt unanswered with nothing saying why,
/// and DSH, which appends `turn/start` before the pre-step, closes such a turn as interrupted. A `/compact` on its
/// own has no prompt after the last turn end and opens no turn (its command is closed below). The span needs no
/// closer as a turn's: a compaction is log-only until its replacement note, so a `compaction/start` with no end
/// leaves the surface unchanged. A call is open from its `tool-call` chunk until a tool message names it; a turn
/// end forgets the calls it leaves, as DSH's recovery does at its boundaries, so an old turn is never reopened.
///
/// **A command left running is closed too** (#206): a `command/run` with no `command/done` is a row the page
/// draws as Running… for good. Each such command gets a `command/done` of kind `error`, after the turn's closers
/// when there are any, in the order the commands ran. A command that left its compaction open (a
/// `compaction/start` after its `command/run`, with no `compaction/end` or `compaction/failed` since) is a
/// `/compact` cut mid-summary: its span is closed first with a `compaction/failed` marked `stopped`, the record a
/// Stop writes, and the command answers "Compaction cancelled.", as DSH settles a cancelled `/compact`. Any other
/// command answers the generic words. Such a compaction is the command's, not a turn's pre-step, so it does not
/// open a turn. A command a closer has answered is no longer open, so a second restart writes nothing more.
pub fn open_turn_closers(events: &[Arc<SessionEvent>], cause: CloserCause) -> Vec<SessionEvent> {
    // Commands run with no `command/done` yet, in run order, each with the compaction span it left open, if any:
    // `(fromSeq, throughSeq)` as the log holds them.
    let mut commands: Vec<(String, Option<(Option<Value>, Option<Value>)>)> = Vec::new();
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
    // A prompt was recorded since the last turn end, so a compaction now is that turn's pre-step (#154).
    let mut prompted = false;
    for event in events {
        match event.kind.as_str() {
            "turn/completed" | "turn/failed" => {
                open = false;
                prompted = false;
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
            "command/run" => {
                // A JavaScript `Map`'s `set`: a run named again keeps its place and starts afresh.
                if let Some(id) = event.get("commandId").and_then(Value::as_str) {
                    match commands.iter_mut().find(|(command, _)| command == id) {
                        Some((_, span)) => *span = None,
                        None => commands.push((id.to_string(), None)),
                    }
                }
            }
            "command/done" => {
                if let Some(id) = event.get("commandId").and_then(Value::as_str) {
                    commands.retain(|(command, _)| command != id);
                }
            }
            "compaction/start" => {
                if let Some((_, span)) = commands.last_mut() {
                    *span = Some((
                        event.get("fromSeq").cloned(),
                        event.get("throughSeq").cloned(),
                    ));
                } else if prompted {
                    open = true;
                }
            }
            "compaction/end" | "compaction/failed" => {
                for (_, span) in &mut commands {
                    *span = None;
                }
            }
            "message" => {
                let Some(message) = event.get("message") else {
                    continue;
                };
                if message["role"] == "user" {
                    prompted = true;
                }
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
    if !open && commands.is_empty() {
        return Vec::new();
    }

    let at = last.at.clone();
    let mut seq = events.len() as u64;
    let rounds = requests.saturating_sub(retries);
    let mut closers = Vec::with_capacity(pending.len() + 2 + 2 * commands.len());
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
    if open {
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
    }
    for (command, span) in commands {
        let text = match span {
            Some((from_seq, through_seq)) => {
                let mut failed = Map::new();
                if let Some(from_seq) = from_seq {
                    failed.insert("fromSeq".to_string(), from_seq);
                }
                if let Some(through_seq) = through_seq {
                    failed.insert("throughSeq".to_string(), through_seq);
                }
                failed.insert("stopped".to_string(), Value::Bool(true));
                failed.insert(
                    "reason".to_string(),
                    Value::String(cause.compaction_text().to_string()),
                );
                push("compaction/failed", Value::Object(failed));
                COMPACTION_CANCELLED
            }
            None => cause.command_text(),
        };
        push(
            "command/done",
            json!({"commandId": command, "kind": "error", "text": text}),
        );
    }
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

    /// #154: a server killed while a turn's automatic summary ran left the log at `compaction/start`, and nothing
    /// closed it at the next open. The two lines are the ones `test/session-turn-closers.test.ts` pins for the
    /// TypeScript build.
    #[test]
    fn a_turn_cut_while_its_automatic_compaction_ran_is_closed_and_a_compact_alone_is_not() {
        let balanced = || {
            let mut log = Log::new();
            log.event("session/created")
                .user("hi")
                .event("model/request")
                .chunk(json!({"type": "text-delta", "text": "hello"}), 0)
                .push("assistant/completed", json!({"text": "hello"}), 0)
                .push("turn/completed", json!({"rounds": 1}), 0);
            log
        };

        let mut cut = balanced();
        cut.user("go").push(
            "compaction/start",
            json!({"fromSeq": 1, "throughSeq": 4}),
            3,
        );
        assert_eq!(
            lines(&interrupted_turn_closers(&cut.0)),
            vec![
                r#"{"seq":8,"at":"2026-10-30T10:03:00.000Z","type":"assistant/completed","text":"","reasoning":"","rounds":0,"denials":0,"ended":["the process exited before this turn finished, so the turn was closed; unfinished tool calls have unknown outcomes"]}"#,
                r#"{"seq":9,"at":"2026-10-30T10:03:00.000Z","type":"turn/completed","rounds":0,"reason":{"kind":"interrupted"}}"#,
            ]
        );

        let kinds = |log: &Log| -> Vec<String> {
            interrupted_turn_closers(&log.0)
                .into_iter()
                .map(|event| event.kind)
                .collect()
        };
        // A compaction that landed before the kill still leaves the prompt unanswered.
        let mut landed = balanced();
        landed
            .user("go")
            .event("compaction/start")
            .event("compaction/summary")
            .push("context/note", json!({"origin": "compaction"}), 0)
            .event("compaction/end")
            .event("compaction/measured");
        assert_eq!(
            kinds(&landed),
            vec!["assistant/completed", "turn/completed"]
        );

        // A model request after the compaction opens the same turn, closed once.
        let mut requested = balanced();
        requested
            .user("go")
            .event("compaction/start")
            .event("compaction/end")
            .event("model/request")
            .chunk(json!({"type": "text-delta", "text": "half"}), 0);
        let once = interrupted_turn_closers(&requested.0);
        assert_eq!(
            once.iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["assistant/completed", "turn/completed"]
        );
        assert_eq!(once[0].get("rounds"), Some(&json!(1)));
        assert_eq!(once[0].get("text"), Some(&json!("half")));

        // A /compact after a turn end, with no prompt since, is no turn, finished or not.
        let mut compact = balanced();
        compact.event("compaction/start");
        assert!(interrupted_turn_closers(&compact.0).is_empty());
        compact.event("compaction/end");
        assert!(interrupted_turn_closers(&compact.0).is_empty());
        assert!(interrupted_turn_closers(&balanced().0).is_empty());
    }

    /// #206: a server killed while `/compact` waited on its summary left `command/run` and `compaction/start`
    /// with no closer and no `command/done`, so the page drew the row as Running… for good. The lines are the
    /// ones `test/session-turn-closers.test.ts` pins for the TypeScript build.
    #[test]
    fn a_command_left_running_is_answered_and_a_cut_compact_closes_its_span_as_cancelled() {
        let balanced = || {
            let mut log = Log::new();
            log.event("session/created")
                .user("hi")
                .event("model/request")
                .chunk(json!({"type": "text-delta", "text": "hello"}), 0)
                .push("assistant/completed", json!({"text": "hello"}), 0)
                .push("turn/completed", json!({"rounds": 1}), 0);
            log
        };
        let run = |log: &mut Log, id: &str, name: &str| {
            log.push(
                "command/run",
                json!({"commandId": id, "name": name, "source": {"kind": "user"}}),
                0,
            );
        };
        let shape = |log: &Log| -> Vec<(String, Option<String>)> {
            interrupted_turn_closers(&log.0)
                .into_iter()
                .map(|event| {
                    let id = event
                        .get("commandId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    (event.kind, id)
                })
                .collect()
        };

        let mut cut = balanced();
        run(&mut cut, "cmd-1", "compact");
        cut.push(
            "compaction/start",
            json!({"fromSeq": 1, "throughSeq": 4, "shadowedSeqs": [1, 2, 3, 4]}),
            5,
        );
        let closers = interrupted_turn_closers(&cut.0);
        assert_eq!(
            lines(&closers),
            vec![
                r#"{"seq":8,"at":"2026-10-30T10:05:00.000Z","type":"compaction/failed","fromSeq":1,"throughSeq":4,"stopped":true,"reason":"the process exited before the compaction finished"}"#,
                r#"{"seq":9,"at":"2026-10-30T10:05:00.000Z","type":"command/done","commandId":"cmd-1","kind":"error","text":"Compaction cancelled."}"#,
            ]
        );
        // A log already closed is not closed again, so a second restart writes nothing.
        let mut closed = cut.0.clone();
        closed.extend(closers.into_iter().map(Arc::new));
        assert!(interrupted_turn_closers(&closed).is_empty());

        // Any other command left running answers the generic words.
        let mut goal = balanced();
        run(&mut goal, "cmd-1", "goal");
        assert_eq!(
            lines(&interrupted_turn_closers(&goal.0)),
            vec![
                r#"{"seq":7,"at":"2026-10-30T10:00:00.000Z","type":"command/done","commandId":"cmd-1","kind":"error","text":"The process exited before this command finished."}"#,
            ]
        );

        // A /compact killed after its compaction landed is answered, and its span is not closed twice; nor is a
        // span a refusal already closed.
        let mut landed = balanced();
        run(&mut landed, "cmd-1", "compact");
        landed
            .event("compaction/start")
            .event("compaction/summary")
            .push("context/note", json!({"origin": "compaction"}), 0)
            .event("compaction/end")
            .event("compaction/measured");
        let answered = interrupted_turn_closers(&landed.0);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].kind, "command/done");
        assert_eq!(
            answered[0].get("text"),
            Some(&json!("The process exited before this command finished."))
        );
        let mut refused = balanced();
        run(&mut refused, "cmd-1", "compact");
        refused.event("compaction/start").push(
            "compaction/failed",
            json!({"refused": true, "reason": "no"}),
            0,
        );
        assert_eq!(
            shape(&refused),
            vec![("command/done".to_string(), Some("cmd-1".to_string()))]
        );

        // A command that settled needs nothing.
        let mut finished = balanced();
        run(&mut finished, "cmd-1", "compact");
        finished
            .event("compaction/start")
            .event("compaction/end")
            .push(
                "command/done",
                json!({"commandId": "cmd-1", "kind": "success", "text": "Compacted 2 history items (~10 tokens)."}),
                0,
            );
        assert!(interrupted_turn_closers(&finished.0).is_empty());

        // Each open command is answered in the order it ran, and the open span is the latest command's.
        let mut two = balanced();
        run(&mut two, "cmd-1", "goal");
        run(&mut two, "cmd-2", "compact");
        two.push(
            "compaction/start",
            json!({"fromSeq": 1, "throughSeq": 4}),
            0,
        );
        assert_eq!(
            shape(&two),
            vec![
                ("command/done".to_string(), Some("cmd-1".to_string())),
                ("compaction/failed".to_string(), None),
                ("command/done".to_string(), Some("cmd-2".to_string())),
            ]
        );

        // A compaction inside a command is the command's, not a turn's pre-step (#154), even after a prompt
        // nobody answered: no turn is closed for it.
        let mut after_prompt = balanced();
        after_prompt.user("a prompt nobody answered");
        run(&mut after_prompt, "cmd-1", "compact");
        after_prompt.push(
            "compaction/start",
            json!({"fromSeq": 1, "throughSeq": 4}),
            0,
        );
        assert_eq!(
            shape(&after_prompt)
                .into_iter()
                .map(|(kind, _)| kind)
                .collect::<Vec<_>>(),
            vec!["compaction/failed", "command/done"]
        );

        // A turn and a command both left open: the turn is closed first, then the command, with seqs
        // continuing the log and every closer at the last real event's time.
        let mut both = balanced();
        run(&mut both, "cmd-1", "goal");
        both.user("go")
            .event("model/request")
            .chunk(json!({"type": "text-delta", "text": "half"}), 9);
        let closers = interrupted_turn_closers(&both.0);
        assert_eq!(
            closers
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["assistant/completed", "turn/completed", "command/done"]
        );
        let n = both.0.len() as u64;
        assert_eq!(
            closers.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![n, n + 1, n + 2]
        );
        assert!(closers.iter().all(|event| event.at == at(9)));
    }
}
