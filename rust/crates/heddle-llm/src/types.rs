//! The model service's vocabulary: messages, content parts, tool specs, requests and streamed chunks.
//!
//! Ported from `src/llm/types.ts`. Two decisions carry over unchanged:
//!
//! - **Tool calls are content, not a typed channel.** A [`ContentPart::ToolCall`] carries a name and the raw
//!   argument string; the loop decides what to do with it.
//! - **Every call is a stream.** A non-streaming transport still produces [`Chunk`]s, so a consumer has one shape.
//!
//! # JSON shapes
//!
//! These types are written into the session log, so their JSON is the TypeScript build's **byte for byte**: the
//! `type` tag first, then the fields in the order the TypeScript code constructs them, optional fields omitted
//! when absent. Field order in these declarations is therefore part of the contract — do not reorder.

use serde::{Deserialize, Serialize};

use crate::usage::TokenUsage;

/// The raster formats an attached image may have, matching what the providers accept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ImageMediaType {
    #[serde(rename = "image/png")]
    Png,
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/webp")]
    Webp,
    #[serde(rename = "image/gif")]
    Gif,
}

impl ImageMediaType {
    /// The media type as the wire spells it, e.g. `image/png`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Gif => "image/gif",
        }
    }
}

/// One uploaded image, referenced by the durable path the harness stored it at.
///
/// The session log keeps the reference; `data` (base64 bytes) is filled only on the adapter-facing copy that
/// [`crate::attachments::project_attachments`] builds, so a large image never enters the log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    pub name: String,
    pub mime_type: ImageMediaType,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    /// Base64 bytes, present only on the adapter-facing copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

/// One uploaded non-image file, referenced by its durable path. Never sent natively: it is projected to a handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilePart {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

/// One complete tool call: the provider's id, the tool's name, and the arguments as the JSON text the model wrote.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// One part of a message's content. JSON: `{"type":"text","text":…}`, `{"type":"tool-call","id":…,"name":…,"arguments":…}`, …
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "reasoning")]
    Reasoning { text: String },
    #[serde(rename = "tool-call")]
    ToolCall(ToolCall),
    #[serde(rename = "image")]
    Image(ImagePart),
    #[serde(rename = "file")]
    File(FilePart),
}

impl ContentPart {
    /// A text part.
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    /// A reasoning part.
    pub fn reasoning(text: impl Into<String>) -> Self {
        Self::Reasoning { text: text.into() }
    }
}

/// Who speaks a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// One message, as a request carries it and as the session log records it.
///
/// JSON field order is `role`, `toolCallId` (only on a `tool` message), `content`, `source` (only on a message the
/// harness wrote on someone's behalf) — the orders the agent loop writes a tool result in and the session service
/// writes a user message in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: Role,
    /// Present on a `tool` message: which call this is the answer to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub content: Vec<ContentPart>,
    /// Who wrote it when it was not a person — a goal round, a runtime-context snapshot. Recorded and carried,
    /// never sent: no adapter reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<serde_json::Value>,
}

impl Message {
    /// A message with no tool-call id.
    pub fn new(role: Role, content: Vec<ContentPart>) -> Self {
        Self {
            role,
            tool_call_id: None,
            content,
            source: None,
        }
    }
}

/// One tool the model may ask for, in the provider-neutral shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments (an object), passed to the provider as written.
    pub parameters: serde_json::Value,
}

/// What to ask one endpoint for.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    /// The endpoint's name, as the configuration declares it.
    pub endpoint: String,
    /// The model id to use; falls back to the endpoint's configured default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub messages: Vec<Message>,
    /// Tools the model may call. Empty means none, which every adapter treats as "send no `tools` field".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolSpec>,
    /// Upper bound on generated tokens, which is also what keeps a probe cheap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// The reasoning level to ask for, as an **id** the model declares; the adapter sends that level's wire value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Ask the transport to stream; adapters that must stream ignore `false`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    /// Opaque identity carried through the `model/request` hook for logging and selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Which round of a turn this is. Transports ignore it; the scripted adapter hands out one step per round.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round: Option<u32>,
    /// What the call is for when it is not a turn, e.g. `compaction`. Scripted steps are separable by it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
}

/// One piece of a streamed answer.
///
/// JSON: `{"type":"text-delta","text":…}`, `{"type":"reasoning-delta","text":…}`,
/// `{"type":"tool-call-delta","index":…,"id"?:…,"name"?:…,"argumentsDelta":…}`,
/// `{"type":"tool-call","id":…,"name":…,"arguments":…}`, `{"type":"done","finishReason":…,"usage"?:…}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Chunk {
    #[serde(rename = "text-delta")]
    TextDelta { text: String },
    #[serde(rename = "reasoning-delta")]
    ReasoningDelta { text: String },
    /// A fragment of a tool call while the model is still writing it — live only, never the record. The complete
    /// call still arrives as one [`Chunk::ToolCall`]; a consumer that ignores this variant loses nothing but the
    /// wait. `index` is the provider's slot for the call, the only stable key before the id is known.
    #[serde(rename = "tool-call-delta", rename_all = "camelCase")]
    ToolCallDelta {
        index: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        arguments_delta: String,
    },
    #[serde(rename = "tool-call")]
    ToolCall(ToolCall),
    /// The end of one call: the loop's finish reason (see [`canonical_finish_reason`]) and the usage, if reported.
    #[serde(rename = "done", rename_all = "camelCase")]
    Done {
        finish_reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<TokenUsage>,
    },
}

/// The two words the agent loop treats as a healthy end: `stop` (an answer that finished) and `tool_calls` (a round
/// that asked for tools and expects another). Every other finish reason is reported on the answer.
pub const HEALTHY_FINISH_REASONS: [&str; 2] = ["stop", "tool_calls"];

/// Whether a finish reason is one of [`HEALTHY_FINISH_REASONS`].
pub fn is_healthy_finish(reason: &str) -> bool {
    HEALTHY_FINISH_REASONS.contains(&reason)
}

/// The loop's word for a provider's finish reason (`canonicalFinishReason`).
///
/// 1. A known provider spelling becomes the canonical one (`end_turn`, `completed` → `stop`; `tool_use`,
///    `function_call` → `tool_calls`; `length`, `max_tokens` → `max_output_tokens`).
/// 2. An unknown spelling passes through unchanged; absent or empty is `stop`.
/// 3. A round that produced tool calls ended in `tool_calls`, whatever the provider called it.
pub fn canonical_finish_reason(raw: Option<&str>, tool_calls: usize) -> String {
    let _ = (raw, tool_calls);
    todo!("port canonicalFinishReason")
}

/// Plain text of a message's text parts, concatenated (`textOf`).
pub fn text_of(parts: &[ContentPart]) -> String {
    let _ = parts;
    todo!("port textOf")
}

/// A plain-text rendering for a summary a person reads (`describeContent`): tool calls as `→ name args`, text and
/// reasoning as themselves, attachments as `[image name]` / `[file name]`.
pub fn describe_content(parts: &[ContentPart]) -> String {
    let _ = parts;
    todo!("port describeContent")
}

/// A one-message user request, which is what a turn and a probe both are (`userMessage`).
pub fn user_message(text: impl Into<String>) -> Message {
    Message::new(Role::User, vec![ContentPart::text(text)])
}

/// The messages a provider may actually be sent (`requestMessages`): an assistant message with neither text nor
/// a tool call (a reasoning-only turn) is dropped, because reasoning is not replayed and a provider refuses an
/// assistant message with no content. The log keeps the turn; only the request loses it.
pub fn request_messages(messages: &[Message]) -> Vec<Message> {
    let _ = messages;
    todo!("port requestMessages")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).expect("serializes")
    }

    #[test]
    fn content_parts_serialize_as_the_typescript_store_writes_them() {
        assert_eq!(
            json(&ContentPart::text("hi")),
            r#"{"type":"text","text":"hi"}"#
        );
        assert_eq!(
            json(&ContentPart::reasoning("hm")),
            r#"{"type":"reasoning","text":"hm"}"#
        );
        let call = ContentPart::ToolCall(ToolCall {
            id: "call-1".into(),
            name: "read_file".into(),
            arguments: r#"{"path":"a"}"#.into(),
        });
        assert_eq!(
            json(&call),
            r#"{"type":"tool-call","id":"call-1","name":"read_file","arguments":"{\"path\":\"a\"}"}"#
        );
        let image = ContentPart::Image(ImagePart {
            name: "a.png".into(),
            mime_type: ImageMediaType::Png,
            path: "/u/a.png".into(),
            bytes: 3,
            sha256: "ab".into(),
            data: None,
        });
        assert_eq!(
            json(&image),
            r#"{"type":"image","name":"a.png","mimeType":"image/png","path":"/u/a.png","bytes":3,"sha256":"ab"}"#
        );
        let file = ContentPart::File(FilePart {
            name: "a.txt".into(),
            path: "/u/a.txt".into(),
            bytes: 1,
            sha256: "cd".into(),
        });
        assert_eq!(
            json(&file),
            r#"{"type":"file","name":"a.txt","path":"/u/a.txt","bytes":1,"sha256":"cd"}"#
        );
    }

    #[test]
    fn a_message_writes_its_fields_in_the_order_the_log_holds_them() {
        let message = Message {
            role: Role::Tool,
            tool_call_id: Some("call-1".into()),
            content: vec![ContentPart::text("ok")],
            source: None,
        };
        assert_eq!(
            json(&message),
            r#"{"role":"tool","toolCallId":"call-1","content":[{"type":"text","text":"ok"}]}"#
        );
        assert_eq!(
            json(&user_message("hello")),
            r#"{"role":"user","content":[{"type":"text","text":"hello"}]}"#
        );
        let mut sourced = user_message("goal round");
        sourced.source = Some(serde_json::json!({"kind": "goal"}));
        assert_eq!(
            json(&sourced),
            r#"{"role":"user","content":[{"type":"text","text":"goal round"}],"source":{"kind":"goal"}}"#
        );
    }

    #[test]
    fn chunks_serialize_with_their_tag_first_and_optional_fields_omitted() {
        assert_eq!(
            json(&Chunk::TextDelta { text: "a".into() }),
            r#"{"type":"text-delta","text":"a"}"#
        );
        assert_eq!(
            json(&Chunk::ReasoningDelta { text: "b".into() }),
            r#"{"type":"reasoning-delta","text":"b"}"#
        );
        assert_eq!(
            json(&Chunk::ToolCallDelta {
                index: 0,
                id: Some("c".into()),
                name: None,
                arguments_delta: "{".into()
            }),
            r#"{"type":"tool-call-delta","index":0,"id":"c","argumentsDelta":"{"}"#
        );
        assert_eq!(
            json(&Chunk::Done {
                finish_reason: "stop".into(),
                usage: None
            }),
            r#"{"type":"done","finishReason":"stop"}"#
        );
        let usage = TokenUsage {
            input_tokens: Some(3),
            output_tokens: Some(2),
            ..TokenUsage::default()
        };
        assert_eq!(
            json(&Chunk::Done {
                finish_reason: "tool_calls".into(),
                usage: Some(usage)
            }),
            r#"{"type":"done","finishReason":"tool_calls","usage":{"inputTokens":3,"outputTokens":2}}"#
        );
    }

    #[test]
    fn a_recorded_chunk_reads_back_as_the_same_chunk() {
        let line = r#"{"type":"tool-call","id":"x","name":"y","arguments":"{}"}"#;
        let chunk: Chunk = serde_json::from_str(line).expect("parses");
        assert_eq!(
            chunk,
            Chunk::ToolCall(ToolCall {
                id: "x".into(),
                name: "y".into(),
                arguments: "{}".into()
            })
        );
        assert_eq!(json(&chunk), line);
    }

    #[test]
    fn a_request_omits_what_it_does_not_set() {
        let request = GenerateRequest {
            endpoint: "chat".into(),
            messages: vec![user_message("q")],
            round: Some(1),
            ..GenerateRequest::default()
        };
        assert_eq!(
            json(&request),
            r#"{"endpoint":"chat","messages":[{"role":"user","content":[{"type":"text","text":"q"}]}],"round":1}"#
        );
    }
}
