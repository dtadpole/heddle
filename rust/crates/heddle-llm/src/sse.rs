//! The `text/event-stream` parser every streaming adapter reads its body through.
//!
//! Ported from `readSse` and `parseBlock` in `src/llm/adapters.ts`. Written against measured behaviour: the Codex
//! route answers `200` with **no content type at all** and ends on a `response.completed` event rather than
//! `[DONE]`, so parsing is driven by `data:` lines and never by a header.
//!
//! The parser is a plain state machine fed bytes, so it is judged without a socket; [`read_sse`] drives it over a
//! [`ByteStream`].

use std::pin::Pin;

use futures::Stream;

use crate::error::ModelError;
use crate::http::ByteStream;

/// One event parsed out of an event-stream body: the optional `event:` name and the joined `data:` lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// An incremental parser. Blocks are separated by a blank line (`\n\n`); a UTF-8 sequence split across two reads
/// is held until it completes.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: String,
    pending: Vec<u8>,
}

impl SseParser {
    /// An empty parser.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one read of the body; returns every event it completed, in order.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        let _ = (bytes, &mut self.buffer, &mut self.pending);
        todo!("port the readSse loop")
    }

    /// The body ended: the trailing block, if it carries data.
    pub fn finish(self) -> Option<SseEvent> {
        todo!("port the readSse tail")
    }
}

/// One block's event (`parseBlock`): `event:` is trimmed, each `data:` loses its leading whitespace, data lines join
/// with `\n`; a block with no `data:` line is `None`.
pub fn parse_block(block: &str) -> Option<SseEvent> {
    let _ = block;
    todo!("port parseBlock")
}

/// A stream of parsed events.
pub type SseStream = Pin<Box<dyn Stream<Item = Result<SseEvent, ModelError>> + Send + 'static>>;

/// Parse a streamed body into events (`readSse`). A transport error on the body ends the stream with that error.
pub fn read_sse(body: ByteStream) -> SseStream {
    let _ = body;
    todo!("port readSse over a ByteStream")
}
