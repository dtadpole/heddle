//! The **surface**: the positional view of a log, which a model request is derived from.
//!
//! Ported from the pure functions of `src/session/store.ts`. An append-only log cannot by itself let
//! something be *replaced* without being *erased*; the surface can. Three rules hold it up:
//!
//! - **Only message-producing events take a position**: `message`, `context/note`, and one node per
//!   streamed run of `assistant/chunk` events (the seq of its first chunk). Everything else is log-only.
//! - **What the harness wrote is not what a person said**: a system prompt or a compaction checkpoint is
//!   a `context/note`, never a `message`, so a transcript view cannot mistake it for a turn.
//! - **A replacement names positions, not a new history**: it is written later, so its seq is higher than
//!   what it shadows; it splices the span between its two endpoints and records which seqs it found.
//!
//! Every function here is generic over `E: Borrow<SessionEvent>` so it reads a store snapshot
//! (`&[Arc<SessionEvent>]`) and a test's `&[SessionEvent]` alike.

use std::borrow::Borrow;
use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use crate::error::SessionError;
use crate::event::{SessionEvent, SurfaceOp};
use crate::message::{Chunk, ContentPart, Message, Role};

/// The event types that can take a position on the surface.
pub const SURFACE_EVENT_TYPES: [&str; 3] = ["message", "context/note", "assistant/chunk"];

/// One landed replacement, kept so a reader can see what a node shadowed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceReplacement {
    pub seq: u64,
    pub start_seq: u64,
    pub end_seq: u64,
    pub shadowed_seqs: Vec<u64>,
}

/// The positional view of a log: the nodes the model can see, in order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceState {
    /// The seq of every node, in surface order — which is not seq order after a replacement.
    pub nodes: Vec<u64>,
    /// Bumped by an append and by a replacement: the derivation cache key.
    pub content_generation: u64,
    /// Bumped only by a replacement: "a rewrite has landed", which is what a retry waits for.
    pub replace_generation: u64,
    pub replacements: Vec<SurfaceReplacement>,
}

/// Whether an event type can take a position on the surface.
pub fn is_surface_eligible(kind: &str) -> bool {
    SURFACE_EVENT_TYPES.contains(&kind)
}

/// Fold a log into its surface.
///
/// A `message` or `context/note` takes a position and closes any open chunk run; the first
/// `assistant/chunk` of a run takes one and a `done` chunk closes the run; a replacement splices the
/// positions between its endpoints (both must be on the surface, end not before start) and closes the
/// run. A replacement the fold cannot place is [`SessionError::UnfoldableReplacement`] — a log that
/// carries one is a log nothing should silently half-read.
pub fn fold_surface<E: Borrow<SessionEvent>>(events: &[E]) -> Result<SurfaceState, SessionError> {
    let mut nodes: Vec<u64> = Vec::new();
    let mut replacements: Vec<SurfaceReplacement> = Vec::new();
    let mut content_generation: u64 = 0;
    let mut replace_generation: u64 = 0;
    let mut open_chunk: Option<u64> = None;

    for event in events {
        let event = event.borrow();
        if let Some(SurfaceOp::Replace { start_seq, end_seq }) = event.surface_op() {
            let start_idx = nodes.iter().position(|seq| *seq == start_seq);
            let end_idx = nodes.iter().position(|seq| *seq == end_seq);
            let (Some(start_idx), Some(end_idx)) = (start_idx, end_idx) else {
                return Err(SessionError::UnfoldableReplacement {
                    seq: event.seq,
                    start_seq,
                    end_seq,
                });
            };
            if end_idx < start_idx {
                return Err(SessionError::UnfoldableReplacement {
                    seq: event.seq,
                    start_seq,
                    end_seq,
                });
            }
            let shadowed_seqs = nodes[start_idx..=end_idx].to_vec();
            nodes.splice(start_idx..=end_idx, std::iter::once(event.seq));
            replacements.push(SurfaceReplacement {
                seq: event.seq,
                start_seq,
                end_seq,
                shadowed_seqs,
            });
            content_generation += 1;
            replace_generation += 1;
            open_chunk = None;
            continue;
        }
        if is_surface_eligible(&event.kind) && event.kind != "assistant/chunk" {
            // A `message` the person or the model produced, or a `context/note` the harness wrote: both
            // take a position, and neither is a chunk run.
            nodes.push(event.seq);
            content_generation += 1;
            open_chunk = None;
            continue;
        }
        if event.kind == "assistant/chunk" {
            if open_chunk.is_none() {
                nodes.push(event.seq);
                content_generation += 1;
                open_chunk = Some(event.seq);
            }
            let done = event
                .get("chunk")
                .and_then(|chunk| chunk.get("type"))
                .and_then(Value::as_str)
                == Some("done");
            if done {
                open_chunk = None;
            }
        }
    }

    Ok(SurfaceState {
        nodes,
        content_generation,
        replace_generation,
        replacements,
    })
}

/// Index a log by seq, which every derivation over it wants.
pub fn index_by_seq<E: Borrow<SessionEvent>>(events: &[E]) -> HashMap<u64, &SessionEvent> {
    let mut by_seq = HashMap::with_capacity(events.len());
    for event in events {
        let event = event.borrow();
        by_seq.insert(event.seq, event);
    }
    by_seq
}

/// The message one node derives to, or `None` when it produces none.
///
/// A `message` or `context/note` node is its `message` field, when that parses and has content. A chunk
/// node is the run that starts at it, in order, until a `done` chunk or the first non-chunk seq:
/// `text-delta` → a `text` part, `reasoning-delta` → `reasoning`, `tool-call` → `tool-call`; the
/// result is an `assistant` message, or `None` when the run produced no part.
///
/// A `message` field that does not parse as a [`Message`] derives to `None` (the TypeScript build passed
/// such an object through unchecked; no writer produces one).
pub fn derive_message(by_seq: &HashMap<u64, &SessionEvent>, seq: u64) -> Option<Message> {
    let event = by_seq.get(&seq)?;
    if event.kind == "message" || event.kind == "context/note" {
        let message = serde_json::from_value::<Message>(event.get("message")?.clone()).ok()?;
        if message.content.is_empty() {
            return None;
        }
        return Some(message);
    }
    if event.kind != "assistant/chunk" {
        return None;
    }
    let mut content: Vec<ContentPart> = Vec::new();
    let mut index = seq;
    while let Some(next) = by_seq.get(&index) {
        if next.kind != "assistant/chunk" {
            break;
        }
        let chunk = next
            .get("chunk")
            .and_then(|value| serde_json::from_value::<Chunk>(value.clone()).ok());
        match chunk {
            Some(Chunk::TextDelta { text }) => content.push(ContentPart::Text { text }),
            Some(Chunk::ReasoningDelta { text }) => content.push(ContentPart::Reasoning { text }),
            Some(Chunk::ToolCall(call)) => content.push(ContentPart::ToolCall(call)),
            Some(Chunk::Done { .. }) => break,
            Some(Chunk::ToolCallDelta { .. }) => {}
            // A chunk that does not parse is a chunk this build does not know; the run continues past it,
            // as the TypeScript build does when its `if` chain matches no branch.
            None => {}
        }
        index += 1;
    }
    if content.is_empty() {
        None
    } else {
        Some(Message {
            role: Role::Assistant,
            tool_call_id: None,
            content,
            source: None,
        })
    }
}

/// The message one node derives to, indexing the log first.
pub fn derive_node_message<E: Borrow<SessionEvent>>(events: &[E], seq: u64) -> Option<Message> {
    derive_message(&index_by_seq(events), seq)
}

/// The events a fork inherits: everything up to and including the **last** `turn/completed`.
///
/// A log with no `turn/completed` comes back whole; whether that is forkable is the caller's call.
pub fn completed_prefix<E: Borrow<SessionEvent> + Clone>(events: &[E]) -> Vec<E> {
    let mut boundary: Option<u64> = None;
    for event in events {
        let event = E::borrow(event);
        if event.kind == "turn/completed" {
            boundary = Some(event.seq);
        }
    }
    match boundary {
        None => events.to_vec(),
        Some(last) => events
            .iter()
            .filter(|event| E::borrow(*event).seq <= last)
            .cloned()
            .collect(),
    }
}

/// Whether the conversation a fork would inherit contains an assistant answer.
///
/// True when a surface node of the completed prefix derives to an `assistant` message (a fork's own log
/// holds copied messages and no chunks), or when the prefix holds an `assistant/completed` event.
pub fn inherits_answer<E: Borrow<SessionEvent> + Clone>(
    events: &[E],
) -> Result<bool, SessionError> {
    let inherited = completed_prefix(events);
    let by_seq = index_by_seq(&inherited);
    for seq in fold_surface(&inherited)?.nodes {
        if derive_message(&by_seq, seq)
            .map(|message| message.role == Role::Assistant)
            .unwrap_or(false)
        {
            return Ok(true);
        }
    }
    Ok(inherited
        .iter()
        .any(|event| E::borrow(event).kind == "assistant/completed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::ToolCall;
    use serde_json::{Map, json};

    fn event(seq: u64, kind: &str, fields: &[(&str, Value)]) -> SessionEvent {
        let mut map = Map::new();
        for (key, value) in fields {
            map.insert((*key).to_string(), value.clone());
        }
        SessionEvent {
            seq,
            at: "2026-10-22T18:17:41.123Z".to_string(),
            kind: kind.to_string(),
            fields: map,
        }
    }

    fn message(seq: u64, role: &str) -> SessionEvent {
        event(
            seq,
            "message",
            &[(
                "message",
                json!({"role": role, "content": [{"type": "text", "text": "x"}]}),
            )],
        )
    }

    fn chunk(seq: u64, value: Value) -> SessionEvent {
        event(seq, "assistant/chunk", &[("chunk", value)])
    }

    fn replacement(seq: u64, start: u64, end: u64) -> SessionEvent {
        event(
            seq,
            "message",
            &[
                (
                    "message",
                    json!({"role": "user", "content": [{"type": "text", "text": "summary"}]}),
                ),
                (
                    "surfaceOp",
                    json!({"op": "replace", "startSeq": start, "endSeq": end}),
                ),
            ],
        )
    }

    #[test]
    fn only_message_producing_events_take_a_position() {
        let events = vec![
            event(0, "session/created", &[("cwd", json!("/x"))]),
            message(1, "user"),
            event(2, "model/request", &[("messages", json!(1))]),
            event(
                3,
                "context/note",
                &[(
                    "message",
                    json!({"role": "system", "content": [{"type": "text", "text": "prompt"}]}),
                )],
            ),
            event(4, "turn/completed", &[]),
        ];
        let surface = fold_surface(&events).unwrap();
        assert_eq!(surface.nodes, vec![1, 3]);
        assert_eq!(surface.content_generation, 2);
        assert_eq!(surface.replace_generation, 0);
        assert!(surface.replacements.is_empty());
    }

    #[test]
    fn one_node_per_chunk_run_and_done_closes_it() {
        let events = vec![
            chunk(0, json!({"type": "text-delta", "text": "a"})),
            chunk(1, json!({"type": "text-delta", "text": "b"})),
            chunk(2, json!({"type": "done", "finishReason": "stop"})),
            chunk(3, json!({"type": "text-delta", "text": "c"})),
        ];
        let surface = fold_surface(&events).unwrap();
        assert_eq!(
            surface.nodes,
            vec![0, 3],
            "the second run starts a second node"
        );
    }

    #[test]
    fn a_message_closes_an_open_run() {
        let events = vec![
            chunk(0, json!({"type": "text-delta", "text": "a"})),
            message(1, "user"),
            chunk(2, json!({"type": "text-delta", "text": "b"})),
        ];
        assert_eq!(fold_surface(&events).unwrap().nodes, vec![0, 1, 2]);
    }

    #[test]
    fn a_replacement_splices_the_span_and_records_what_it_shadowed() {
        let events = vec![
            message(0, "user"),
            message(1, "assistant"),
            message(2, "user"),
            replacement(3, 1, 2),
        ];
        let surface = fold_surface(&events).unwrap();
        assert_eq!(surface.nodes, vec![0, 3]);
        assert_eq!(surface.replace_generation, 1);
        assert_eq!(
            surface.replacements,
            vec![SurfaceReplacement {
                seq: 3,
                start_seq: 1,
                end_seq: 2,
                shadowed_seqs: vec![1, 2],
            }]
        );
    }

    #[test]
    fn a_later_span_may_name_a_high_seq_before_a_low_one() {
        // After one replacement the surface holds `[0, 3, 2]`, where the middle node's seq is above the
        // last one's. A span from 3 to 2 covers positions 1..2 and is ordinary; a fold that required the
        // seqs to be numerically ordered would refuse every second compaction.
        let events = vec![
            message(0, "user"),
            message(1, "assistant"),
            message(2, "user"),
            replacement(3, 1, 1),
            replacement(4, 3, 2),
        ];
        let surface = fold_surface(&events).unwrap();
        assert_eq!(surface.nodes, vec![0, 4]);
        assert_eq!(surface.replacements[1].shadowed_seqs, vec![3, 2]);
        assert_eq!(surface.replace_generation, 2);
    }

    #[test]
    fn a_replacement_that_names_nothing_on_the_surface_is_an_error() {
        let events = vec![message(0, "user"), replacement(1, 0, 7)];
        let error = fold_surface(&events).unwrap_err();
        assert!(
            matches!(
                error,
                SessionError::UnfoldableReplacement {
                    seq: 1,
                    start_seq: 0,
                    end_seq: 7
                }
            ),
            "got {error:?}"
        );
        assert_eq!(
            error.to_string(),
            "session event 1: a replacement names a range that is not on the surface (0..7)"
        );
    }

    #[test]
    fn a_replacement_whose_end_sits_before_its_start_is_an_error() {
        let events = vec![message(0, "user"), message(1, "user"), replacement(2, 1, 0)];
        assert!(matches!(
            fold_surface(&events).unwrap_err(),
            SessionError::UnfoldableReplacement { .. }
        ));
    }

    #[test]
    fn a_message_node_derives_to_its_message() {
        let events = vec![message(0, "user")];
        let by_seq = index_by_seq(&events);
        let derived = derive_message(&by_seq, 0).unwrap();
        assert_eq!(derived.role, Role::User);
        assert_eq!(derived.content.len(), 1);
        assert_eq!(derive_message(&by_seq, 9), None);
    }

    #[test]
    fn an_empty_message_and_an_unparseable_one_derive_to_nothing() {
        let events = vec![
            event(
                0,
                "message",
                &[("message", json!({"role": "user", "content": []}))],
            ),
            event(
                1,
                "message",
                &[("message", json!({"role": "nobody", "content": []}))],
            ),
            event(2, "message", &[]),
        ];
        let by_seq = index_by_seq(&events);
        assert_eq!(derive_message(&by_seq, 0), None);
        assert_eq!(derive_message(&by_seq, 1), None);
        assert_eq!(derive_message(&by_seq, 2), None);
    }

    #[test]
    fn a_chunk_run_derives_one_assistant_message_until_done() {
        let events = vec![
            chunk(0, json!({"type": "reasoning-delta", "text": "think"})),
            chunk(1, json!({"type": "text-delta", "text": "loom"})),
            chunk(
                2,
                json!({"type": "tool-call", "id": "c", "name": "read", "arguments": "{}"}),
            ),
            chunk(3, json!({"type": "done", "finishReason": "stop"})),
            chunk(4, json!({"type": "text-delta", "text": "ignored"})),
        ];
        let by_seq = index_by_seq(&events);
        let derived = derive_message(&by_seq, 0).unwrap();
        assert_eq!(derived.role, Role::Assistant);
        assert_eq!(
            derived.content,
            vec![
                ContentPart::Reasoning {
                    text: "think".to_string()
                },
                ContentPart::Text {
                    text: "loom".to_string()
                },
                ContentPart::ToolCall(ToolCall {
                    id: "c".to_string(),
                    name: "read".to_string(),
                    arguments: "{}".to_string()
                }),
            ]
        );
    }

    #[test]
    fn a_chunk_run_with_no_part_derives_to_nothing() {
        let events = vec![
            chunk(0, json!({"type": "done", "finishReason": "stop"})),
            chunk(
                1,
                json!({"type": "tool-call-delta", "index": 0, "argumentsDelta": "{"}),
            ),
        ];
        let by_seq = index_by_seq(&events);
        assert_eq!(derive_message(&by_seq, 0), None);
        assert_eq!(derive_message(&by_seq, 1), None);
    }

    #[test]
    fn the_completed_prefix_cuts_at_the_last_turn_boundary() {
        let events = vec![
            message(0, "user"),
            message(1, "assistant"),
            event(2, "turn/completed", &[]),
            message(3, "user"),
        ];
        let prefix = completed_prefix(&events);
        assert_eq!(
            prefix.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        // No boundary at all: the log comes back whole, and the caller decides.
        let unfinished = vec![message(0, "user")];
        assert_eq!(completed_prefix(&unfinished).len(), 1);
    }

    #[test]
    fn a_fork_inherits_an_answer_from_a_message_or_a_completed_event() {
        let copied = vec![message(0, "user"), message(1, "assistant")];
        assert!(inherits_answer(&copied).unwrap());

        let streamed = vec![
            message(0, "user"),
            chunk(1, json!({"type": "text-delta", "text": "a"})),
            event(2, "assistant/completed", &[("text", json!("a"))]),
        ];
        assert!(inherits_answer(&streamed).unwrap());

        let unanswered = vec![message(0, "user")];
        assert!(!inherits_answer(&unanswered).unwrap());
    }

    #[test]
    fn a_dangling_half_turn_is_not_inherited() {
        let events = vec![
            message(0, "user"),
            message(1, "assistant"),
            event(2, "turn/completed", &[]),
            message(3, "user"),
        ];
        assert!(inherits_answer(&events).unwrap());
        // The dangling prompt at seq 3 is cut, so a fork continues from the finished turn.
        assert_eq!(completed_prefix(&events).len(), 3);
    }
}
