//! The message shapes the log records — **a stand-in until `heddle-llm` declares them**.
//!
//! These types belong to `heddle-llm` (`src/llm/types.ts`: `Message`, `ContentPart`, `Chunk`), and this
//! module becomes `pub use heddle_llm::{…}` the day that crate publishes them; import them from
//! `heddle_llm` once it does. They are declared here only so the session API compiles now. What the
//! session crate needs from them — and so what the `heddle-llm` declaration must keep for the log to stay
//! readable by both builds — is the **serde shape**, which is pinned here:
//!
//! - a content part and a chunk are objects tagged by `"type"`, written first, with kebab-case variant
//!   names (`text`, `reasoning`, `tool-call`, `image`, `file`; `text-delta`, `reasoning-delta`,
//!   `tool-call-delta`, `tool-call`, `done`) and camelCase fields (`toolCallId`, `mimeType`,
//!   `argumentsDelta`, `finishReason`);
//! - a message serializes `role`, then `toolCallId` when present, then `content` — the order every
//!   TypeScript writer uses (`{ role: 'tool', toolCallId, content }`), so a Rust-written log is
//!   byte-identical, not merely equivalent;
//! - an optional field that is absent is **omitted**, never `null`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Who a message is from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// One uploaded image, referenced by the durable path the harness stored it at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    pub name: String,
    pub mime_type: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    /// Base64 bytes, present only on the adapter-facing copy; never in the log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

/// One uploaded non-image file, referenced by its durable path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilePart {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

/// One part of a message's content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: String,
    },
    Image(ImagePart),
    File(FilePart),
}

/// One message in a request, and in the log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    /// Present on a `tool` message: which call this answers.
    #[serde(
        rename = "toolCallId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_call_id: Option<String>,
    pub content: Vec<ContentPart>,
}

/// A message as the store records it: the message, and who wrote it when that was not a person.
///
/// An automatic goal round is a user message whose `source` is
/// `{ "kind": "goal", "goalId", "revision", "round" }`; the goal fold counts admitted rounds from it.
/// Serialized flat: `{"role":…,"content":…,"source":…}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordedMessage {
    #[serde(flatten)]
    pub message: Message,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

impl From<Message> for RecordedMessage {
    fn from(message: Message) -> Self {
        RecordedMessage {
            message,
            source: None,
        }
    }
}

/// Token usage a provider reported, carried opaquely by the session crate.
pub type TokenUsage = Value;

/// One streamed chunk of a model's answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Chunk {
    TextDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    /// A fragment of a tool call while it is being written: published live, **never recorded**.
    #[serde(rename_all = "camelCase")]
    ToolCallDelta {
        index: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        arguments_delta: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: String,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        finish_reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<TokenUsage>,
    },
}

/// The text parts of a message's content, joined with nothing — `textOf` in `src/llm/types.ts`.
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

    #[test]
    fn text_of_joins_only_the_text_parts() {
        let parts = vec![
            ContentPart::Text {
                text: "remember ".to_string(),
            },
            ContentPart::Image(ImagePart {
                name: "a.png".to_string(),
                mime_type: "image/png".to_string(),
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
        let message = Message {
            role: Role::Tool,
            tool_call_id: Some("call-1".to_string()),
            content: vec![ContentPart::Text {
                text: "ok".to_string(),
            }],
        };
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"role":"tool","toolCallId":"call-1","content":[{"type":"text","text":"ok"}]}"#
        );
        // An absent option is omitted, never `null`.
        let plain = Message {
            role: Role::User,
            tool_call_id: None,
            content: vec![],
        };
        assert_eq!(
            serde_json::to_string(&plain).unwrap(),
            r#"{"role":"user","content":[]}"#
        );
    }

    #[test]
    fn the_content_parts_are_tagged_first_and_kebab_cased() {
        let tool_call = ContentPart::ToolCall {
            id: "call-1".to_string(),
            name: "read_file".to_string(),
            arguments: "{}".to_string(),
        };
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
    fn a_recorded_message_is_flat() {
        let recorded = RecordedMessage {
            message: Message {
                role: Role::User,
                tool_call_id: None,
                content: vec![ContentPart::Text {
                    text: "hi".to_string(),
                }],
            },
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
