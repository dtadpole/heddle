//! Provisional mirrors of types other crates own.
//!
//! The loop needs the model vocabulary of `heddle-llm`, the session records of `heddle-session` and the
//! context report of `heddle-context`, none of which exists yet. Each item copies the TypeScript shape
//! field for field, with the same JSON spelling, and names its owner; when the owner's API lands, the item
//! becomes a `pub use` of the owner's type, and a caller importing it from `heddle_agent` does not change.
//! The tool, sandbox and session-handle mirrors are `heddle-tools`'s, re-exported here.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub use heddle_tools::{SandboxMode, SessionHandle, ToolSpec};

/// Who wrote a message. Mirror of `heddle_llm::Role` (TypeScript `Message['role']`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// The harness's instructions.
    System,
    /// A person, or an automatic round speaking for one.
    User,
    /// The model.
    Assistant,
    /// A tool's answer to one call.
    Tool,
}

/// One part of a message's content. Mirror of `heddle_llm::ContentPart` (TypeScript `ContentPart`,
/// `src/llm/types.ts`), tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ContentPart {
    /// Text.
    Text {
        /// The text.
        text: String,
    },
    /// Reasoning the model showed.
    Reasoning {
        /// The text.
        text: String,
    },
    /// A complete tool call, as the assistant asked for it.
    ToolCall {
        /// The provider's call id, which the tool message answers.
        id: String,
        /// The tool's name.
        name: String,
        /// The arguments as the model wrote them: a JSON string, possibly malformed.
        arguments: String,
    },
    /// An uploaded image, by its durable path.
    Image {
        /// The file name a person gave it.
        name: String,
        /// `image/png`, `image/jpeg`, `image/webp` or `image/gif`.
        mime_type: String,
        /// Where the harness stored it.
        path: PathBuf,
        /// Its size.
        bytes: u64,
        /// Its digest.
        sha256: String,
        /// Base64 bytes, only on the adapter-facing copy.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<String>,
    },
    /// An uploaded non-image file, by its durable path.
    File {
        /// The file name a person gave it.
        name: String,
        /// Where the harness stored it.
        path: PathBuf,
        /// Its size.
        bytes: u64,
        /// Its digest.
        sha256: String,
    },
}

impl ContentPart {
    /// A text part.
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }
}

/// One message in a request, and as the session records it. Mirror of `heddle_llm::Message`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// Who wrote it.
    pub role: Role,
    /// What it says.
    pub content: Vec<ContentPart>,
    /// On a `tool` message: which call it answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Token usage as the harness keeps it; a bucket is absent until a frame reports it.
/// Mirror of `heddle_llm::TokenUsage` (TypeScript `TokenUsage`, `src/llm/usage.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// Prompt-side tokens billed without a cache hit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    /// Completion tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// Prompt-side tokens served from the cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    /// Prompt-side tokens written to the cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
}

/// Add one call's usage to a running total. Mirror of `heddle_llm::merge_token_usage` (TypeScript
/// `mergeTokenUsage`): a bucket stays absent until either side reports it, and reported buckets add.
pub fn merge_token_usage(
    previous: Option<TokenUsage>,
    next: Option<TokenUsage>,
) -> Option<TokenUsage> {
    let (previous, next) = match (previous, next) {
        (previous, None) => return previous,
        (None, next) => return next,
        (Some(previous), Some(next)) => (previous, next),
    };
    let add = |a: Option<u64>, b: Option<u64>| match (a, b) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    };
    Some(TokenUsage {
        input_tokens: add(previous.input_tokens, next.input_tokens),
        output_tokens: add(previous.output_tokens, next.output_tokens),
        cache_read_tokens: add(previous.cache_read_tokens, next.cache_read_tokens),
        cache_write_tokens: add(previous.cache_write_tokens, next.cache_write_tokens),
    })
}

/// One piece of a streamed answer. Mirror of `heddle_llm::Chunk` (TypeScript `Chunk`), tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Chunk {
    /// Answer text.
    TextDelta {
        /// The fragment.
        text: String,
    },
    /// Reasoning text.
    ReasoningDelta {
        /// The fragment.
        text: String,
    },
    /// A fragment of a tool call while it is being written; live only, never the record.
    ToolCallDelta {
        /// The provider's slot for the call.
        index: u32,
        /// The call id, when this fragment carries it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// The tool name, when this fragment carries it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        /// The argument text added.
        arguments_delta: String,
    },
    /// A complete tool call; what the loop runs.
    ToolCall {
        /// The call id.
        id: String,
        /// The tool name.
        name: String,
        /// The arguments, a JSON string.
        arguments: String,
    },
    /// The round finished.
    Done {
        /// The canonical finish reason: `stop`, `tool_calls`, or what the provider said.
        finish_reason: String,
        /// What the provider said the call used.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<TokenUsage>,
    },
}

/// What to ask one endpoint for. Mirror of `heddle_llm::GenerateRequest` (TypeScript `GenerateRequest`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    /// The endpoint's configured name.
    pub endpoint: String,
    /// The model id; the endpoint's default when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The conversation.
    pub messages: Vec<Message>,
    /// The tools the model may ask for; absent when there are none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolSpec>>,
    /// Cap on generated tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// Sampling temperature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// The reasoning level, as an id the model declares.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Ask the transport to stream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    /// The session, for logging and for the scripted endpoint's per-session steps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Which round of the turn this is; the scripted endpoint hands out one step per round.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round: Option<u32>,
    /// What the call is for when it is not an ordinary turn (`team`, `compaction`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
}

/// One entry in a session log. Mirror of `heddle_session::SessionEvent`: `seq`, `at`, `type`, and the
/// type's own fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionEvent {
    /// Monotonic within a session.
    pub seq: u64,
    /// ISO-8601 time it was written.
    pub at: String,
    /// The event type, e.g. `message`, `assistant/chunk`, `model/request`, `assistant/completed`.
    #[serde(rename = "type")]
    pub kind: String,
    /// Every other field.
    #[serde(flatten)]
    pub fields: serde_json::Map<String, serde_json::Value>,
}

/// The parts of a session's metadata the loop and delegation read. Mirror of a subset of
/// `heddle_session::SessionMeta`; fields this crate does not read are kept in `rest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    /// The session id.
    pub id: String,
    /// The folder the session works in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    /// The endpoint it was created with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// The model it was created with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The reasoning level it was created with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// The parent session of a child agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session: Option<String>,
    /// How it came to exist: `subagent` for a delegated child.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// How deep in a delegation chain it is; a root is 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_depth: Option<u32>,
    /// Every other field, kept as read.
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

/// What a new session is created with. Mirror of the options of `heddle_session`'s `create`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSession {
    /// Its folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    /// Its endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// Its model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Its reasoning level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Its title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Its parent, for a child agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session: Option<String>,
    /// `subagent` for a delegated child.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// Its delegation depth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_depth: Option<u32>,
    /// The team it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// An id chosen by the caller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// What the loop reads of a session's surface. Mirror of the parts of `heddle_session::SurfaceState` it uses.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SurfaceView {
    /// The positions on the surface, in order.
    pub nodes: Vec<u64>,
    /// Bumped whenever the surface's content changes; recorded on `model/request`.
    pub content_generation: u64,
    /// Bumped whenever a replacement (a compaction) lands; how a retry tells that something durable changed.
    pub replace_generation: u64,
}

/// One dynamic contribution to the runtime context. Mirror of `heddle_context::RuntimeContextSection`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeContextSection {
    /// Its stable name, e.g. `sandbox:policy`.
    pub name: String,
    /// Its text.
    pub text: String,
}

/// What a round's context is prepared for. Mirror of the options of `heddle_context`'s `prepare`/`assemble`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PrepareOptions {
    /// The conversation's folder, where instruction files are found.
    pub cwd: PathBuf,
    /// The endpoint, whose window prices the request.
    pub endpoint: String,
    /// The model, whose window may differ from the endpoint's.
    pub model: Option<String>,
    /// The tools the request will carry, which count against the window.
    pub tools: Vec<ToolSpec>,
    /// A system prompt for a session that has none.
    pub system: Option<String>,
}

/// A request's estimated size, split the way the context panel shows it. Mirror of `heddle_context`'s.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ContextBreakdown {
    /// System prompts.
    pub system: u64,
    /// Tool schemas.
    pub tools: u64,
    /// Every other message.
    pub messages: u64,
}

/// What a context preparation answered. Mirror of `heddle_context::ContextReport` (TypeScript `ContextReport`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ContextReport {
    /// What to send.
    pub messages: Vec<Message>,
    /// Its estimated size.
    pub estimated_tokens: u64,
    /// The window it is priced against.
    pub context_window: u64,
    /// The size that triggers a reduction.
    pub threshold_tokens: u64,
    /// How many oversized tool results this call rewrote.
    pub pruned: u64,
    /// Whether a summary replaced part of the conversation.
    pub compacted: bool,
    /// The instruction files the baseline carried.
    pub instructions: Vec<String>,
    /// The size split.
    pub breakdown: ContextBreakdown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_buckets_stay_absent_until_reported_and_add_once_they_are() {
        let first = TokenUsage {
            input_tokens: Some(10),
            output_tokens: Some(2),
            ..TokenUsage::default()
        };
        let second = TokenUsage {
            input_tokens: Some(5),
            cache_read_tokens: Some(7),
            ..TokenUsage::default()
        };
        let merged = merge_token_usage(Some(first), Some(second)).unwrap();
        assert_eq!(merged.input_tokens, Some(15));
        assert_eq!(merged.output_tokens, Some(2));
        assert_eq!(merged.cache_read_tokens, Some(7));
        assert_eq!(merged.cache_write_tokens, None);
        assert_eq!(merge_token_usage(None, None), None);
        assert_eq!(merge_token_usage(Some(first), None), Some(first));
        assert_eq!(merge_token_usage(None, Some(second)), Some(second));
    }

    #[test]
    fn chunks_read_the_typescript_wire_shape() {
        let call: Chunk = serde_json::from_str(
            r#"{"type":"tool-call","id":"c1","name":"read_file","arguments":"{}"}"#,
        )
        .unwrap();
        assert_eq!(
            call,
            Chunk::ToolCall {
                id: "c1".into(),
                name: "read_file".into(),
                arguments: "{}".into()
            }
        );
        let done: Chunk = serde_json::from_str(
            r#"{"type":"done","finishReason":"stop","usage":{"outputTokens":3}}"#,
        )
        .unwrap();
        assert!(
            matches!(done, Chunk::Done { ref finish_reason, usage: Some(TokenUsage { output_tokens: Some(3), .. }) } if finish_reason == "stop")
        );
        let delta = Chunk::ToolCallDelta {
            index: 0,
            id: None,
            name: None,
            arguments_delta: "{".into(),
        };
        assert_eq!(
            serde_json::to_string(&delta).unwrap(),
            r#"{"type":"tool-call-delta","index":0,"argumentsDelta":"{"}"#
        );
    }

    #[test]
    fn a_tool_message_keeps_its_call_id_in_camel_case() {
        let message = Message {
            role: Role::Tool,
            content: vec![ContentPart::text("ok")],
            tool_call_id: Some("c1".into()),
        };
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"role":"tool","content":[{"type":"text","text":"ok"}],"toolCallId":"c1"}"#
        );
    }

    #[test]
    fn a_session_event_keeps_its_own_fields_beside_the_envelope() {
        let event: SessionEvent = serde_json::from_str(
            r#"{"seq":3,"at":"t","type":"assistant/completed","text":"hi","rounds":1}"#,
        )
        .unwrap();
        assert_eq!(event.kind, "assistant/completed");
        assert_eq!(event.fields["text"], "hi");
    }

    #[test]
    fn session_meta_reads_delegation_fields_and_keeps_the_rest() {
        let meta: SessionMeta = serde_json::from_str(
            r#"{"id":"c","parentSession":"p","origin":"subagent","delegationDepth":1,"turns":2}"#,
        )
        .unwrap();
        assert_eq!(meta.parent_session.as_deref(), Some("p"));
        assert_eq!(meta.delegation_depth, Some(1));
        assert_eq!(meta.rest["turns"], 2);
    }
}
