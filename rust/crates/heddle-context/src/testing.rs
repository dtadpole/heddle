//! An in-memory [`ContextStore`], for this crate's tests and a dependent crate's.
//!
//! It keeps one log per session in memory and folds the surface by the rules of
//! `src/session/store.ts` — one node per `message` or `context/note`, one node per streamed
//! assistant run, a replacement splicing the positions it names — and it refuses the replacements
//! that store refuses (a range that is not a span; a rewritten system head; a tool result rewritten
//! by anything but a tool result for the same call). It is a double, not the store: no files, no
//! metadata, no zstd. Enabled by the `testing` feature.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::store::{
    AppendOptions, ContextStore, LogEvent, SeqRange, StoreError, SurfaceOp, SurfaceState,
};
use crate::types::{ContentPart, Message, Role};

/// Names one session of a [`MemoryStore`].
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MemorySession(pub String);

/// An in-memory session store.
#[derive(Debug, Default)]
pub struct MemoryStore {
    logs: Mutex<HashMap<String, Vec<LogEvent>>>,
}

/// A refusal the store's own rules raise, boxed into [`StoreError`].
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct MemoryStoreError(String);

impl MemoryStore {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Open (or create) a session by id.
    pub fn open(&self, id: &str) -> MemorySession {
        let mut logs = self
            .logs
            .lock()
            .expect("the memory store lock is not poisoned");
        logs.entry(id.to_string()).or_default();
        MemorySession(id.to_string())
    }

    /// Record a `message` event, as `SessionStore.message` does; returns its seq.
    pub fn message(&self, session: &MemorySession, message: Message) -> u64 {
        self.append_value(
            session,
            serde_json::json!({ "type": "message", "message": message }),
            AppendOptions::default(),
        )
        .expect("a message event needs no surface operation")
    }

    /// Record one `assistant/chunk` event carrying `chunk` (`{"type":"text-delta",…}`, `…"done"…`).
    pub fn assistant_chunk(&self, session: &MemorySession, chunk: Value) -> u64 {
        self.append_value(
            session,
            serde_json::json!({ "type": "assistant/chunk", "chunk": chunk }),
            AppendOptions::default(),
        )
        .expect("a chunk event needs no surface operation")
    }

    /// Put one event in the log, validating a replacement the way the real store does.
    fn append_value(
        &self,
        session: &MemorySession,
        event: Value,
        options: AppendOptions,
    ) -> Result<u64, StoreError> {
        let Some(object) = event.as_object() else {
            return Err(refusal("the event is not a JSON object"));
        };
        let Some(kind) = object.get("type").and_then(Value::as_str) else {
            return Err(refusal("the event carries no type"));
        };
        if let Some(SurfaceOp::Replace(range)) = options.surface_op {
            self.validate_replacement(session, object, range)?;
        }

        let mut logs = self
            .logs
            .lock()
            .expect("the memory store lock is not poisoned");
        let log = logs.entry(session.0.clone()).or_default();
        let seq = log.len() as u64;
        let mut fields = Map::new();
        for (key, value) in object {
            if key != "type" {
                fields.insert(key.clone(), value.clone());
            }
        }
        if let Some(op) = options.surface_op {
            fields.insert("surfaceOp".to_string(), op.to_json());
        }
        if let Some(source) = options.source_event_seqs {
            fields.insert(
                "sourceEventSeqs".to_string(),
                Value::Array(source.into_iter().map(Value::from).collect()),
            );
        }
        log.push(LogEvent {
            seq,
            kind: kind.to_string(),
            fields,
        });
        Ok(seq)
    }

    /// The refusals `SessionStore.assertReplacement` makes, in the same order.
    fn validate_replacement(
        &self,
        session: &MemorySession,
        event: &Map<String, Value>,
        range: SeqRange,
    ) -> Result<(), StoreError> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(kind, "message" | "context/note" | "assistant/chunk") {
            return Err(refusal(format!(
                "\"{kind}\" is not surface-eligible and cannot replace a range"
            )));
        }
        let state = self.surface(session)?;
        let start = state.nodes.iter().position(|seq| *seq == range.start_seq);
        let end = state.nodes.iter().position(|seq| *seq == range.end_seq);
        let shadowed = match (start, end) {
            (Some(start), Some(end)) if end >= start => state.nodes[start..=end].to_vec(),
            _ => {
                return Err(refusal(format!(
                    "replacement range {}..{} is not a span of the surface",
                    range.start_seq, range.end_seq
                )));
            }
        };

        let replacement: Option<Message> = event
            .get("message")
            .and_then(|value| serde_json::from_value(value.clone()).ok());
        // The surface head holds the system prompt, and only a system message over exactly
        // that node may rewrite it.
        if start == Some(0) {
            if let Some(head) = self.derive_node(session, shadowed[0])? {
                if head.role == Role::System
                    && (replacement.as_ref().map(|message| message.role) != Some(Role::System)
                        || shadowed.len() != 1)
                {
                    return Err(refusal(
                        "the surface head holds the system prompt and may be rewritten only by a system message over exactly that node",
                    ));
                }
            }
        }
        // A tool result answers one call, and a tool result may rewrite only that one.
        for seq in &shadowed {
            let Some(original) = self.derive_node(session, *seq)? else {
                continue;
            };
            if original.role != Role::Tool {
                continue;
            }
            if let Some(replacement) = replacement
                .as_ref()
                .filter(|message| message.role == Role::Tool)
            {
                if shadowed.len() != 1 || replacement.tool_call_id != original.tool_call_id {
                    return Err(refusal(
                        "a tool result may be rewritten only by a tool result for the same call",
                    ));
                }
            }
        }
        Ok(())
    }

    /// The surface of one session, folded from its log by the store's rules.
    fn fold(&self, session: &MemorySession) -> Result<SurfaceState, StoreError> {
        let logs = self
            .logs
            .lock()
            .expect("the memory store lock is not poisoned");
        let log = logs.get(&session.0).map(Vec::as_slice).unwrap_or_default();
        let mut nodes: Vec<u64> = Vec::new();
        let mut content_generation = 0;
        let mut replace_generation = 0;
        let mut open_chunk: Option<u64> = None;

        for event in log {
            if let Some(SurfaceOp::Replace(range)) = event.surface_op() {
                let start = nodes.iter().position(|seq| *seq == range.start_seq);
                let end = nodes.iter().position(|seq| *seq == range.end_seq);
                let (Some(start), Some(end)) = (start, end) else {
                    return Err(refusal(format!(
                        "session event {}: a replacement names a range that is not on the surface ({}..{})",
                        event.seq, range.start_seq, range.end_seq
                    )));
                };
                if end < start {
                    return Err(refusal(format!(
                        "session event {}: a replacement names a range that is not on the surface ({}..{})",
                        event.seq, range.start_seq, range.end_seq
                    )));
                }
                nodes.splice(start..=end, std::iter::once(event.seq));
                content_generation += 1;
                replace_generation += 1;
                open_chunk = None;
                continue;
            }
            if event.kind == "message" || event.kind == "context/note" {
                // A message a person or the model produced, or a note the harness wrote: both
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
                if event
                    .field("chunk")
                    .and_then(|chunk| chunk.get("type"))
                    .and_then(Value::as_str)
                    == Some("done")
                {
                    open_chunk = None;
                }
            }
        }

        Ok(SurfaceState {
            nodes,
            content_generation,
            replace_generation,
        })
    }
}

impl ContextStore for MemoryStore {
    type Handle = MemorySession;

    fn count(&self, session: &MemorySession) -> Result<u64, StoreError> {
        let logs = self
            .logs
            .lock()
            .expect("the memory store lock is not poisoned");
        Ok(logs.get(&session.0).map_or(0, |log| log.len() as u64))
    }

    fn read(&self, session: &MemorySession) -> Result<Vec<LogEvent>, StoreError> {
        let logs = self
            .logs
            .lock()
            .expect("the memory store lock is not poisoned");
        Ok(logs.get(&session.0).cloned().unwrap_or_default())
    }

    fn surface(&self, session: &MemorySession) -> Result<SurfaceState, StoreError> {
        self.fold(session)
    }

    fn derive_node(
        &self,
        session: &MemorySession,
        seq: u64,
    ) -> Result<Option<Message>, StoreError> {
        let events = self.read(session)?;
        let Some(position) = events.iter().position(|event| event.seq == seq) else {
            return Ok(None);
        };
        let event = &events[position];
        if event.kind == "message" || event.kind == "context/note" {
            return Ok(event
                .message()
                .filter(|message| !message.content.is_empty()));
        }
        if event.kind != "assistant/chunk" {
            return Ok(None);
        }

        let mut content: Vec<ContentPart> = Vec::new();
        for next in &events[position..] {
            if next.kind != "assistant/chunk" {
                break;
            }
            let Some(chunk) = next.field("chunk") else {
                continue;
            };
            match chunk.get("type").and_then(Value::as_str) {
                Some("text-delta") => content.push(ContentPart::Text {
                    text: string_field(chunk, "text"),
                }),
                Some("reasoning-delta") => content.push(ContentPart::Reasoning {
                    text: string_field(chunk, "text"),
                }),
                Some("tool-call") => content.push(ContentPart::ToolCall {
                    id: string_field(chunk, "id"),
                    name: string_field(chunk, "name"),
                    arguments: string_field(chunk, "arguments"),
                }),
                Some("done") => break,
                _ => {}
            }
        }
        if content.is_empty() {
            return Ok(None);
        }
        Ok(Some(Message {
            role: Role::Assistant,
            content,
            tool_call_id: None,
            source: None,
        }))
    }

    fn append(
        &self,
        session: &MemorySession,
        event: Value,
        options: AppendOptions,
    ) -> Result<u64, StoreError> {
        self.append_value(session, event, options)
    }
}

/// One string field of a chunk, or the empty string when it is absent.
fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn refusal(message: impl Into<String>) -> StoreError {
    StoreError(Box::new(MemoryStoreError(message.into())))
}

#[cfg(test)]
mod tests {
    use super::MemoryStore;
    use crate::store::{AppendOptions, ContextStore, SeqRange, SurfaceOp};
    use crate::types::{ContentPart, Message, Role};
    use serde_json::{Value, json};

    fn user(text: &str) -> Message {
        Message::text(Role::User, text)
    }

    fn texts(store: &MemoryStore, session: &super::MemorySession) -> Vec<String> {
        store
            .derive_messages(session)
            .expect("the messages derive")
            .into_iter()
            .map(|message| match message.content.first() {
                Some(ContentPart::Text { text }) => text.clone(),
                _ => String::new(),
            })
            .collect()
    }

    #[test]
    fn an_append_takes_the_next_position_and_the_messages_derive_in_order() {
        let store = MemoryStore::new();
        let session = store.open("s");
        store.message(&session, Message::text(Role::System, "be brief"));
        store.message(&session, user("first"));
        store.message(&session, user("second"));

        let surface = store.surface(&session).expect("the surface folds");
        assert_eq!(surface.nodes.len(), 3, "every message took a position");
        assert_eq!(surface.content_generation, 3);
        assert_eq!(surface.replace_generation, 0);
        assert_eq!(texts(&store, &session), vec!["be brief", "first", "second"]);
    }

    #[test]
    fn a_streamed_run_is_one_node_folded_from_the_chunks_that_follow_it() {
        let store = MemoryStore::new();
        let session = store.open("s");
        store.assistant_chunk(
            &session,
            json!({"type": "reasoning-delta", "text": "thinking"}),
        );
        store.assistant_chunk(&session, json!({"type": "text-delta", "text": "the "}));
        store.assistant_chunk(&session, json!({"type": "text-delta", "text": "answer"}));
        store.assistant_chunk(
            &session,
            json!({"type": "tool-call", "id": "call-1", "name": "list_dir", "arguments": "{}"}),
        );
        store.assistant_chunk(
            &session,
            json!({"type": "done", "finishReason": "tool_calls"}),
        );

        let surface = store.surface(&session).expect("the surface folds");
        assert_eq!(surface.nodes.len(), 1, "one run is one position, not five");
        let message = store
            .derive_node(&session, surface.nodes[0])
            .expect("the node derives")
            .expect("the run has content");
        assert_eq!(message.role, Role::Assistant);
        assert_eq!(
            message.content,
            vec![
                ContentPart::Reasoning {
                    text: "thinking".to_string()
                },
                ContentPart::Text {
                    text: "the ".to_string()
                },
                ContentPart::Text {
                    text: "answer".to_string()
                },
                ContentPart::ToolCall {
                    id: "call-1".to_string(),
                    name: "list_dir".to_string(),
                    arguments: "{}".to_string(),
                },
            ],
            "arrival order is kept, and reasoning stays its own block"
        );
    }

    #[test]
    fn a_replacement_shadows_positions_while_the_log_keeps_everything() {
        let store = MemoryStore::new();
        let session = store.open("s");
        let first = store.message(&session, user("one"));
        let second = store.message(&session, Message::text(Role::Assistant, "two"));
        store.message(&session, user("three"));

        let replacement = store
            .append(
                &session,
                json!({"type": "message", "message": user("<compacted-summary>two of them</compacted-summary>")}),
                AppendOptions::replace(SeqRange { start_seq: first, end_seq: second }, vec![first, second]),
            )
            .expect("a span of two nodes accepts a replacement");

        let surface = store.surface(&session).expect("the surface folds");
        assert_eq!(
            surface.nodes,
            vec![replacement, 2],
            "the span is one node now"
        );
        assert_eq!(surface.replace_generation, 1);
        assert_eq!(surface.content_generation, 4);
        assert_eq!(
            texts(&store, &session),
            vec![
                "<compacted-summary>two of them</compacted-summary>",
                "three"
            ]
        );
        assert_eq!(
            store.read(&session).expect("the log reads").len(),
            4,
            "the log still holds every original event"
        );
    }

    #[test]
    fn an_append_after_a_replacement_lands_at_the_end_of_the_surface() {
        let store = MemoryStore::new();
        let session = store.open("s");
        let first = store.message(&session, user("one"));
        let replacement = store
            .append(
                &session,
                json!({"type": "message", "message": user("summary")}),
                AppendOptions::replace(
                    SeqRange {
                        start_seq: first,
                        end_seq: first,
                    },
                    vec![first],
                ),
            )
            .expect("a one-node span accepts a replacement");
        let last = store.message(&session, user("after"));
        assert_eq!(
            store.surface(&session).expect("the surface folds").nodes,
            vec![replacement, last]
        );
    }

    #[test]
    fn the_surface_refuses_a_rewrite_it_could_not_fold_or_must_not_allow() {
        let store = MemoryStore::new();
        let session = store.open("s");
        let system = store.message(&session, Message::text(Role::System, "be brief"));
        let user_seq = store.message(&session, user("hello"));
        let tool = store.message(
            &session,
            Message {
                role: Role::Tool,
                content: vec![ContentPart::Text {
                    text: "result".to_string(),
                }],
                tool_call_id: Some("call-1".to_string()),
                source: None,
            },
        );

        let log_only = store.append(
            &session,
            json!({"type": "compaction/summary", "summary": "x"}),
            AppendOptions::replace(
                SeqRange {
                    start_seq: user_seq,
                    end_seq: user_seq,
                },
                vec![user_seq],
            ),
        );
        assert!(
            log_only.is_err(),
            "a log-only event cannot take a model-visible position"
        );

        let outside = store.append(
            &session,
            json!({"type": "message", "message": user("x")}),
            AppendOptions::replace(
                SeqRange {
                    start_seq: user_seq,
                    end_seq: user_seq + 1000,
                },
                vec![user_seq],
            ),
        );
        assert!(
            outside.is_err(),
            "a range whose end is not on the surface is refused"
        );

        let head = store.append(
            &session,
            json!({"type": "message", "message": user("x")}),
            AppendOptions::replace(
                SeqRange {
                    start_seq: system,
                    end_seq: system,
                },
                vec![system],
            ),
        );
        assert!(
            head.is_err(),
            "the system head may be rewritten only by a system message"
        );

        let wrong_call = store.append(
            &session,
            json!({"type": "message", "message": {
                "role": "tool",
                "toolCallId": "other",
                "content": [{"type": "text", "text": "x"}],
            }}),
            AppendOptions::replace(
                SeqRange {
                    start_seq: tool,
                    end_seq: tool,
                },
                vec![tool],
            ),
        );
        assert!(
            wrong_call.is_err(),
            "a tool result answers one call, and its rewrite must answer the same one"
        );
        assert_eq!(
            store
                .surface(&session)
                .expect("the surface folds")
                .nodes
                .len(),
            3,
            "no refusal changed the surface"
        );
    }

    #[test]
    fn a_second_replacement_may_shadow_a_span_whose_seqs_are_not_in_order() {
        let store = MemoryStore::new();
        let session = store.open("s");
        let one = store.message(&session, user("one"));
        let two = store.message(&session, Message::text(Role::Assistant, "two"));
        let three = store.message(&session, user("three"));
        let first = store
            .append(
                &session,
                json!({"type": "context/note", "message": user("first summary"), "origin": "compaction"}),
                AppendOptions::replace(SeqRange { start_seq: one, end_seq: two }, vec![one, two]),
            )
            .expect("the first span accepts a replacement");
        assert_eq!(
            store.surface(&session).expect("the surface folds").nodes,
            vec![first, three]
        );

        // `first` is newer than `three`, so the span is 3..=1 in numeric terms and a positional
        // reading is the only one that can fold it.
        let second = store
            .append(
                &session,
                json!({"type": "context/note", "message": user("second summary"), "origin": "compaction"}),
                AppendOptions::replace(SeqRange { start_seq: first, end_seq: three }, vec![first, three]),
            )
            .expect("a span holding an out-of-order seq accepts a replacement");
        assert_eq!(
            store.surface(&session).expect("the surface folds").nodes,
            vec![second]
        );
        assert_eq!(texts(&store, &session), vec!["second summary"]);
    }

    #[test]
    fn a_note_the_harness_wrote_is_a_surface_node_without_being_a_message_event() {
        let store = MemoryStore::new();
        let session = store.open("s");
        store.message(&session, user("what the person said"));
        let note = store
            .append(
                &session,
                json!({
                    "type": "context/note",
                    "message": user("<system-reminder>the project rules</system-reminder>"),
                    "origin": "instructions",
                }),
                AppendOptions::default(),
            )
            .expect("a note appends");
        assert_eq!(
            texts(&store, &session),
            vec![
                "what the person said",
                "<system-reminder>the project rules</system-reminder>"
            ]
        );
        assert_eq!(
            store
                .read(&session)
                .expect("the log reads")
                .iter()
                .filter(|event| event.kind == "message")
                .count(),
            1,
            "a view of the conversation still sees only what the person said"
        );
        assert_eq!(
            store.surface(&session).expect("the surface folds").nodes,
            vec![0, note]
        );
    }

    #[test]
    fn the_append_marker_is_written_only_when_a_caller_asks_for_it() {
        let store = MemoryStore::new();
        let session = store.open("s");
        store.message(&session, user("plain"));
        store
            .append(
                &session,
                json!({"type": "message", "message": user("marked")}),
                AppendOptions::append(),
            )
            .expect("a marked append lands");
        let events = store.read(&session).expect("the log reads");
        assert!(
            events[0].surface_op().is_none(),
            "a bare event carries no marker"
        );
        assert_eq!(events[1].surface_op(), Some(SurfaceOp::Append));
        assert_eq!(
            events[1].field("surfaceOp"),
            Some(&Value::String("append".to_string()))
        );
    }
}
