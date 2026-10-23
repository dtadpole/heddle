//! A streaming view on standard error — the harness's own proof that streaming works without a browser.
//!
//! Ported from `src/stream/printer.ts`. `heddle --stream` feeds every `session/event` of its session to a
//! [`StreamPrinter`], which writes it as it is appended: reasoning deltas dimmed and prefixed `[reasoning] `, text
//! deltas verbatim, tool calls as `\n[tool] name args\n`, a newline at `assistant/completed`, and user / tool-result
//! messages as `\n[user] …\n` / `[tool result] …\n`. Deliberately on **stderr** while the final answer goes to stdout.
//!
//! The printer takes session events as JSON (`{"type": "assistant/chunk", "chunk": {…}}`, …), so it depends on no
//! session crate; whoever subscribes to the session's events (the CLI) forwards each one. [`StreamSummary`] is what
//! `--json` reports as `stream`.

use std::time::Instant;

use serde::Serialize;
use serde_json::Value;

/// The prefix a reasoning delta is printed with, inside the dim escape (`\u{1b}[2m[reasoning] …\u{1b}[0m`).
pub const REASONING_PREFIX: &str = "[reasoning] ";

/// What to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamPrinterOptions {
    /// The session to show; other sessions' events are ignored.
    pub session: String,
    /// Include reasoning deltas (default on).
    pub reasoning: bool,
    /// Include tool-call lines (default on).
    pub tools: bool,
}

impl StreamPrinterOptions {
    /// Everything shown, for one session.
    pub fn new(session: impl Into<String>) -> Self {
        Self {
            session: session.into(),
            reasoning: true,
            tools: true,
        }
    }
}

/// What the printer saw. JSON: `{"textDeltas","reasoningDeltas","toolCalls","spanMs","completed"}`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSummary {
    pub text_deltas: u64,
    pub reasoning_deltas: u64,
    pub tool_calls: u64,
    /// Milliseconds from the first printed delta to the last, which is what "live" means.
    pub span_ms: u64,
    pub completed: bool,
}

/// The live view of one session's stream.
pub struct StreamPrinter {
    options: StreamPrinterOptions,
    write: Box<dyn FnMut(&str) + Send>,
    summary: StreamSummary,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl StreamPrinter {
    /// A printer that writes to standard error.
    pub fn new(options: StreamPrinterOptions) -> Self {
        Self::with_writer(options, |text| eprint!("{text}"))
    }

    /// A printer that writes through `write` — a test's buffer, or a terminal the caller owns.
    pub fn with_writer(
        options: StreamPrinterOptions,
        write: impl FnMut(&str) + Send + 'static,
    ) -> Self {
        Self {
            options,
            write: Box::new(write),
            summary: StreamSummary::default(),
            first: None,
            last: None,
        }
    }

    /// One `session/event`, now.
    pub fn observe(&mut self, session: &str, event: &Value) {
        self.observe_at(session, event, Instant::now());
    }

    /// One `session/event`, at a given instant (so a test controls the span).
    pub fn observe_at(&mut self, session: &str, event: &Value, now: Instant) {
        if session != self.options.session {
            return;
        }
        match event.get("type").and_then(Value::as_str) {
            Some("assistant/chunk") => {
                let Some(chunk) = event.get("chunk") else {
                    return;
                };
                match chunk.get("type").and_then(Value::as_str) {
                    Some("reasoning-delta") => {
                        if !self.options.reasoning {
                            return;
                        }
                        self.summary.reasoning_deltas += 1;
                        self.touch(now);
                        let text = chunk
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        (self.write)(&format!("\u{1b}[2m{REASONING_PREFIX}{text}\u{1b}[0m"));
                    }
                    Some("text-delta") => {
                        self.summary.text_deltas += 1;
                        self.touch(now);
                        let text = chunk
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        (self.write)(text);
                    }
                    Some("tool-call") => {
                        if !self.options.tools {
                            return;
                        }
                        self.summary.tool_calls += 1;
                        self.touch(now);
                        let name = chunk
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let arguments = chunk
                            .get("arguments")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        (self.write)(&format!("\n[tool] {name} {arguments}\n"));
                    }
                    _ => {}
                }
            }
            Some("assistant/completed") => {
                self.summary.completed = true;
                (self.write)("\n");
            }
            Some("message") => {
                let Some(message) = event.get("message") else {
                    return;
                };
                let text = message
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                    .map(|part| part.get("text").and_then(Value::as_str).unwrap_or_default())
                    .collect::<String>();
                if text.is_empty() {
                    return;
                }
                match message.get("role").and_then(Value::as_str) {
                    Some("user") => (self.write)(&format!("\n[user] {text}\n")),
                    Some("tool") => (self.write)(&format!("[tool result] {text}\n")),
                    _ => {}
                }
            }
            _ => {}
        }
    }

    /// Mark one printed delta, and keep the span from the first to the last.
    fn touch(&mut self, now: Instant) {
        if self.first.is_none() {
            self.first = Some(now);
        }
        self.last = Some(now);
        self.summary.span_ms = match (self.first, self.last) {
            (Some(first), Some(last)) => last.duration_since(first).as_millis() as u64,
            _ => 0,
        };
    }

    /// What was printed so far.
    pub fn summary(&self) -> StreamSummary {
        self.summary
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::*;

    fn printer(options: StreamPrinterOptions) -> (StreamPrinter, Arc<Mutex<String>>) {
        let buffer = Arc::new(Mutex::new(String::new()));
        let sink = buffer.clone();
        let printer = StreamPrinter::with_writer(options, move |text| {
            sink.lock().expect("buffer").push_str(text);
        });
        (printer, buffer)
    }

    fn chunk(value: serde_json::Value) -> Value {
        serde_json::json!({ "type": "assistant/chunk", "chunk": value })
    }

    fn printed(buffer: &Arc<Mutex<String>>) -> String {
        buffer.lock().expect("buffer").clone()
    }

    #[test]
    fn reasoning_is_dimmed_and_prefixed_and_text_is_verbatim() {
        let (mut printer, buffer) = printer(StreamPrinterOptions::new("s"));
        let start = Instant::now();
        printer.observe_at(
            "s",
            &chunk(serde_json::json!({ "type": "reasoning-delta", "text": "hm" })),
            start,
        );
        printer.observe_at(
            "s",
            &chunk(serde_json::json!({ "type": "text-delta", "text": "hi" })),
            start + Duration::from_millis(250),
        );
        assert_eq!(
            printed(&buffer),
            "\u{1b}[2m[reasoning] hm\u{1b}[0mhi",
            "reasoning is dimmed and prefixed, the answer is written as it comes"
        );
        let summary = printer.summary();
        assert_eq!(summary.reasoning_deltas, 1);
        assert_eq!(summary.text_deltas, 1);
        assert_eq!(summary.span_ms, 250, "span is the first-to-last delta");
        assert!(!summary.completed);
    }

    #[test]
    fn a_tool_call_is_its_own_line_and_the_completed_answer_ends_with_a_newline() {
        let (mut printer, buffer) = printer(StreamPrinterOptions::new("s"));
        let now = Instant::now();
        printer.observe_at(
            "s",
            &chunk(serde_json::json!({ "type": "tool-call", "id": "c", "name": "bash", "arguments": "{}" })),
            now,
        );
        printer.observe_at(
            "s",
            &serde_json::json!({ "type": "assistant/completed" }),
            now + Duration::from_millis(5),
        );
        assert_eq!(printed(&buffer), "\n[tool] bash {}\n\n");
        assert_eq!(printer.summary().tool_calls, 1);
        assert!(printer.summary().completed);
    }

    #[test]
    fn a_user_message_and_a_tool_result_are_labelled_but_do_not_move_the_span() {
        let (mut printer, buffer) = printer(StreamPrinterOptions::new("s"));
        let now = Instant::now();
        printer.observe_at(
            "s",
            &serde_json::json!({
                "type": "message",
                "message": { "role": "user", "content": [{ "type": "text", "text": "hello" }] }
            }),
            now,
        );
        printer.observe_at(
            "s",
            &serde_json::json!({
                "type": "message",
                "message": { "role": "tool", "content": [{ "type": "text", "text": "hi" }] }
            }),
            now,
        );
        assert_eq!(printed(&buffer), "\n[user] hello\n[tool result] hi\n");
        assert_eq!(printer.summary().span_ms, 0);
    }

    #[test]
    fn another_sessions_events_and_events_it_does_not_show_are_ignored() {
        let (mut printer, buffer) = printer(StreamPrinterOptions::new("s"));
        printer.observe_at(
            "other",
            &chunk(serde_json::json!({ "type": "text-delta", "text": "not mine" })),
            Instant::now(),
        );
        printer.observe_at(
            "s",
            &serde_json::json!({ "type": "session/started" }),
            Instant::now(),
        );
        printer.observe_at(
            "s",
            &serde_json::json!({ "type": "assistant/chunk" }),
            Instant::now(),
        );
        assert_eq!(printed(&buffer), "");
        assert_eq!(printer.summary(), StreamSummary::default());
    }

    #[test]
    fn the_options_can_silence_reasoning_or_tools() {
        let (mut quiet, buffer) = printer(StreamPrinterOptions {
            session: "s".into(),
            reasoning: false,
            tools: false,
        });
        let now = Instant::now();
        quiet.observe_at(
            "s",
            &chunk(serde_json::json!({ "type": "reasoning-delta", "text": "hm" })),
            now,
        );
        quiet.observe_at(
            "s",
            &chunk(serde_json::json!({ "type": "tool-call", "id": "c", "name": "bash", "arguments": "{}" })),
            now,
        );
        quiet.observe_at(
            "s",
            &chunk(serde_json::json!({ "type": "text-delta", "text": "answer" })),
            now,
        );
        assert_eq!(printed(&buffer), "answer", "only the answer is left");
        assert_eq!(quiet.summary().reasoning_deltas, 0);
        assert_eq!(quiet.summary().tool_calls, 0);
        assert_eq!(quiet.summary().text_deltas, 1);
    }

    #[test]
    fn the_summary_is_the_json_the_command_reports() {
        let summary = StreamSummary {
            text_deltas: 3,
            reasoning_deltas: 2,
            tool_calls: 1,
            span_ms: 1200,
            completed: true,
        };
        assert_eq!(
            serde_json::to_string(&summary).expect("serializes"),
            r#"{"textDeltas":3,"reasoningDeltas":2,"toolCalls":1,"spanMs":1200,"completed":true}"#
        );
    }
}
