//! The message shapes the log records — **`heddle-llm`'s**, re-exported.
//!
//! These types belong to `heddle-llm` (`src/llm/types.ts`: `Message`, `ContentPart`, `Chunk`) and this
//! module no longer keeps a copy: a second declaration would drift from the wire vocabulary the adapters
//! use, and a caller crossing between the two crates would have to serialize a node to convert it. What
//! this crate needs from them — and so what `heddle-llm`'s declaration must keep for the log to stay
//! readable by both builds — is pinned by the tests below and by the byte-oracle tests: a content part
//! and a chunk are objects tagged by `"type"` first, with kebab-case variants (`text`, `reasoning`,
//! `tool-call`, `image`, `file`; `text-delta`, `reasoning-delta`, `tool-call-delta`, `tool-call`, `done`)
//! and camelCase fields (`toolCallId`, `mimeType`, `argumentsDelta`, `finishReason`); a message
//! serializes `role`, then `toolCallId` when present, then `content`, then `source` when the harness
//! wrote it; an optional field that is absent is **omitted**, never `null`.
//!
//! [`RecordedMessage`] is the same `Message`: the log's recorded message carries `source` inline, exactly
//! as `src/llm/types.ts` does, so there is no wrapper to convert.

pub use heddle_llm::{
    Chunk, ContentPart, FilePart, ImageMediaType, ImagePart, Message, Role, TokenUsage, ToolCall,
};

/// A message as the store records it: the [`Message`] itself, whose `source` names who wrote it when that
/// was not a person (an automatic goal round, a runtime-context snapshot).
pub type RecordedMessage = Message;

/// The text parts of a message's content, joined with nothing — `textOf` in `src/llm/types.ts`.
///
/// `heddle-llm` owns this rule but does not re-export the function yet, so the session crate keeps the
/// five-line fold here rather than reach into a private module; it becomes a re-export with the rest when
/// `heddle-llm` publishes it.
pub fn text_of(parts: &[ContentPart]) -> String {
    parts
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(role: Role, content: Vec<ContentPart>) -> Message {
        Message {
            role,
            tool_call_id: None,
            content,
            source: None,
        }
    }

    #[test]
    fn text_of_joins_only_the_text_parts() {
        let parts = vec![
            ContentPart::Text {
                text: "remember ".to_string(),
            },
            ContentPart::Image(ImagePart {
                name: "a.png".to_string(),
                mime_type: ImageMediaType::Png,
                path: "/tmp/a.png".to_string(),
                bytes: 3,
                sha256: "abc".to_string(),
                data: None,
            }),
            ContentPart::Text {
                text: "the word loom".to_string(),
            },
        ];
        assert_eq!(text_of(&parts), "remember the word loom");
        assert_eq!(text_of(&[]), "");
    }

    #[test]
    fn a_message_writes_role_then_tool_call_id_then_content() {
        let tool = Message {
            role: Role::Tool,
            tool_call_id: Some("call-1".to_string()),
            content: vec![ContentPart::Text {
                text: "ok".to_string(),
            }],
            source: None,
        };
        assert_eq!(
            serde_json::to_string(&tool).unwrap(),
            r#"{"role":"tool","toolCallId":"call-1","content":[{"type":"text","text":"ok"}]}"#
        );
        // An absent option is omitted, never `null`.
        let plain = message(Role::User, vec![]);
        assert_eq!(
            serde_json::to_string(&plain).unwrap(),
            r#"{"role":"user","content":[]}"#
        );
    }

    #[test]
    fn the_content_parts_are_tagged_first_and_kebab_cased() {
        let tool_call = ContentPart::ToolCall(ToolCall {
            id: "call-1".to_string(),
            name: "read_file".to_string(),
            arguments: "{}".to_string(),
        });
        assert_eq!(
            serde_json::to_string(&tool_call).unwrap(),
            r#"{"type":"tool-call","id":"call-1","name":"read_file","arguments":"{}"}"#
        );
        let reasoning = ContentPart::Reasoning {
            text: "hmm".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&reasoning).unwrap(),
            r#"{"type":"reasoning","text":"hmm"}"#
        );
    }

    #[test]
    fn a_recorded_message_carries_its_source_inline() {
        let recorded = RecordedMessage {
            role: Role::User,
            tool_call_id: None,
            content: vec![ContentPart::Text {
                text: "hi".to_string(),
            }],
            source: Some(json!({"kind": "goal", "goalId": "g", "revision": 1, "round": 2})),
        };
        assert_eq!(
            serde_json::to_string(&recorded).unwrap(),
            r#"{"role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"goal","goalId":"g","revision":1,"round":2}}"#
        );
    }

    #[test]
    fn a_chunk_is_tagged_and_its_fields_are_camel_cased() {
        let delta = Chunk::ToolCallDelta {
            index: 0,
            id: None,
            name: None,
            arguments_delta: "{\"pa".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&delta).unwrap(),
            r#"{"type":"tool-call-delta","index":0,"argumentsDelta":"{\"pa"}"#
        );
        let done = Chunk::Done {
            finish_reason: "stop".to_string(),
            usage: None,
        };
        assert_eq!(
            serde_json::to_string(&done).unwrap(),
            r#"{"type":"done","finishReason":"stop"}"#
        );
    }

    #[test]
    fn a_chunk_parses_back_from_the_logs_bytes() {
        let line = r#"{"type":"text-delta","text":"loom"}"#;
        assert_eq!(
            serde_json::from_str::<Chunk>(line).unwrap(),
            Chunk::TextDelta {
                text: "loom".to_string()
            }
        );
    }
}
