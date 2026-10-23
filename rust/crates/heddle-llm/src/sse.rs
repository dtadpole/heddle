//! The `text/event-stream` parser every streaming adapter reads its body through.
//!
//! Ported from `readSse` and `parseBlock` in `src/llm/adapters.ts`. Written against measured behaviour: the Codex
//! route answers `200` with **no content type at all** and ends on a `response.completed` event rather than
//! `[DONE]`, so parsing is driven by `data:` lines and never by a header.
//!
//! The parser is a plain state machine fed bytes, so it is judged without a socket; [`read_sse`] drives it over a
//! [`ByteStream`].

use std::collections::VecDeque;
use std::pin::Pin;

use futures::{Stream, StreamExt};

use crate::error::ModelError;
use crate::http::ByteStream;

/// One event parsed out of an event-stream body: the optional `event:` name and the joined `data:` lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Decode one read, holding back a trailing incomplete UTF-8 sequence until the next read completes it.
fn decode(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    let mut all = std::mem::take(pending);
    all.extend_from_slice(bytes);
    match std::str::from_utf8(&all) {
        Ok(text) => text.to_string(),
        // A sequence split across two reads: decode what is complete, hold the rest.
        Err(error) if error.error_len().is_none() => {
            let complete = error.valid_up_to();
            let text = String::from_utf8_lossy(&all[..complete]).into_owned();
            *pending = all[complete..].to_vec();
            text
        }
        // Bytes that cannot start a sequence: replace them, as a streaming text decoder does.
        Err(_) => String::from_utf8_lossy(&all).into_owned(),
    }
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
        self.buffer.push_str(&decode(&mut self.pending, bytes));
        let mut events = Vec::new();
        while let Some(at) = self.buffer.find("\n\n") {
            let block: String = self.buffer[..at].to_string();
            self.buffer.drain(..at + 2);
            if let Some(event) = parse_block(&block) {
                events.push(event);
            }
        }
        events
    }

    /// The body ended: the trailing block, if it carries data.
    pub fn finish(mut self) -> Option<SseEvent> {
        if !self.pending.is_empty() {
            let tail = std::mem::take(&mut self.pending);
            self.buffer.push_str(&String::from_utf8_lossy(&tail));
        }
        parse_block(&self.buffer)
    }
}

/// One block's event (`parseBlock`): `event:` is trimmed, each `data:` loses its leading whitespace, data lines join
/// with `\n`; a block with no `data:` line is `None`.
pub fn parse_block(block: &str) -> Option<SseEvent> {
    let mut event = None;
    let mut data: Vec<&str> = Vec::new();
    for line in block.split('\n') {
        if let Some(name) = line.strip_prefix("event:") {
            event = Some(name.trim().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start());
        }
    }
    if data.is_empty() {
        return None;
    }
    Some(SseEvent {
        event,
        data: data.join("\n"),
    })
}

/// A stream of parsed events.
pub type SseStream = Pin<Box<dyn Stream<Item = Result<SseEvent, ModelError>> + Send + 'static>>;

/// Parse a streamed body into events (`readSse`). A transport error on the body ends the stream with that error.
pub fn read_sse(body: ByteStream) -> SseStream {
    let state = (body, SseParser::new(), VecDeque::new(), false);
    Box::pin(futures::stream::unfold(
        state,
        |(mut body, mut parser, mut queue, mut ended)| async move {
            loop {
                if let Some(event) = queue.pop_front() {
                    return Some((Ok(event), (body, parser, queue, ended)));
                }
                if ended {
                    return None;
                }
                match body.next().await {
                    Some(Ok(bytes)) => queue.extend(parser.push(&bytes)),
                    Some(Err(error)) => return Some((Err(error), (body, parser, queue, true))),
                    None => {
                        ended = true;
                        // The trailing block, if the body ended without its blank line.
                        let mut spent = SseParser::new();
                        std::mem::swap(&mut spent, &mut parser);
                        if let Some(event) = spent.finish() {
                            queue.push_back(event);
                        }
                    }
                }
            }
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    fn event(event: Option<&str>, data: &str) -> SseEvent {
        SseEvent {
            event: event.map(ToString::to_string),
            data: data.to_string(),
        }
    }

    #[test]
    fn a_block_carries_its_event_name_and_its_joined_data_lines() {
        assert_eq!(
            parse_block("event: message_start\ndata: {\"a\":1}"),
            Some(event(Some("message_start"), "{\"a\":1}"))
        );
        assert_eq!(
            parse_block("data: one\ndata: two"),
            Some(event(None, "one\ntwo"))
        );
        // An event name is trimmed; a data line loses only its leading whitespace.
        assert_eq!(
            parse_block("event:  done \ndata:   spaced "),
            Some(event(Some("done"), "spaced "))
        );
        // A block with no data (a comment, an id-only block) is no event.
        assert_eq!(parse_block(": comment"), None);
        assert_eq!(parse_block(""), None);
        assert_eq!(parse_block("id: 7"), None);
    }

    #[test]
    fn the_parser_hands_on_each_completed_block_and_keeps_the_partial_one() {
        let mut parser = SseParser::new();
        assert_eq!(parser.push(b"data: one\n\n"), vec![event(None, "one")]);
        assert_eq!(parser.push(b"data: tw"), Vec::new());
        assert_eq!(
            parser.push(b"o\n\ndata: three\n\n"),
            vec![event(None, "two"), event(None, "three")]
        );
        // Two blocks in one read, and an event name carried separately.
        assert_eq!(
            parser.push(b"event: a\ndata: 1\n\nevent: b\ndata: 2\n\n"),
            vec![event(Some("a"), "1"), event(Some("b"), "2")]
        );
    }

    #[test]
    fn a_character_split_across_two_reads_is_not_corrupted() {
        let mut parser = SseParser::new();
        let text = "data: héllo\n\n".as_bytes();
        let split = text
            .iter()
            .position(|byte| *byte == 0xc3)
            .expect("two-byte start");
        // The first read ends between the two bytes of `é`.
        assert_eq!(parser.push(&text[..split + 1]), Vec::new());
        assert_eq!(parser.push(&text[split + 1..]), vec![event(None, "héllo")]);
    }

    #[test]
    fn the_body_end_returns_the_trailing_block() {
        let mut parser = SseParser::new();
        assert_eq!(parser.push(b"data: last"), Vec::new());
        assert_eq!(parser.finish(), Some(event(None, "last")));
        // A body that ended on its blank line has no trailing block left.
        let mut parser = SseParser::new();
        assert_eq!(parser.push(b"data: one\n\n"), vec![event(None, "one")]);
        assert_eq!(parser.finish(), None);
    }

    #[test]
    fn a_streamed_body_becomes_events_across_read_boundaries() {
        let body: ByteStream = Box::pin(futures::stream::iter(vec![
            Ok(Bytes::from_static(b"event: message_start\ndata: {\"a\":")),
            Ok(Bytes::from_static(b"1}\n\ndata: [DONE]\n\n")),
        ]));
        let events: Vec<Result<(Option<String>, String), String>> =
            futures::executor::block_on(read_sse(body).collect::<Vec<_>>())
                .into_iter()
                .map(|item| {
                    item.map(|event| (event.event, event.data))
                        .map_err(|error| error.to_string())
                })
                .collect();
        assert_eq!(
            events,
            vec![
                Ok((Some("message_start".into()), "{\"a\":1}".into())),
                Ok((None, "[DONE]".into())),
            ]
        );
    }

    #[test]
    fn a_transport_error_ends_the_event_stream_with_that_error() {
        let body: ByteStream = Box::pin(futures::stream::iter(vec![
            Ok(Bytes::from_static(b"data: one\n\n")),
            Err(ModelError::new(
                "connection reset",
                "chat",
                crate::error::code::TRANSPORT,
            )),
        ]));
        let events = futures::executor::block_on(read_sse(body).collect::<Vec<_>>());
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0]
                .as_ref()
                .ok()
                .map(|event| (event.event.clone(), event.data.clone())),
            Some((None, "one".to_string()))
        );
        assert_eq!(
            events[1].as_ref().map_err(|error| error.code.as_str()),
            Err("TRANSPORT")
        );
        assert_eq!(
            events[1].as_ref().err().map(ToString::to_string).as_deref(),
            Some("connection reset")
        );
    }
}
