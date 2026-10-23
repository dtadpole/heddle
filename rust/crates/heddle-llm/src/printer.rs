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
        let _ = options;
        todo!("port printStream's stderr writer")
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
        let _ = (
            session,
            event,
            now,
            &self.options,
            &mut self.write,
            &mut self.first,
            &mut self.last,
        );
        todo!("port printStream's onEvent")
    }

    /// What was printed so far.
    pub fn summary(&self) -> StreamSummary {
        self.summary
    }
}
