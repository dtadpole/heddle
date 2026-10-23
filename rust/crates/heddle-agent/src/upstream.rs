//! The owners' types where they have landed, and provisional mirrors where they have not.
//!
//! The model vocabulary (`Message`, `ContentPart`, `Role`, `Chunk`, `TokenUsage`, `GenerateRequest`) is
//! `heddle-llm`'s own, re-exported. The session records of `heddle-session` and the context report of
//! `heddle-context` are still mirrors: each copies the TypeScript shape field for field, with the same JSON
//! spelling, and names its owner; when the owner's API lands it becomes a `pub use`, and a caller importing it
//! from `heddle_agent` does not change. The tool, sandbox and session-handle types are `heddle-tools`'s,
//! re-exported here (the sandbox ones are already `heddle-sandbox`'s own).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub use heddle_tools::{SandboxMode, SessionHandle, ToolSpec};

// `heddle-llm` has landed, so the model vocabulary is the owner's own: the loop records and sends the same
// `Message`, streams the same `Chunk`, and sums the same `TokenUsage` the model service produces, with no
// conversion at the port. The JSON shapes are the TypeScript build's, pinned by heddle-llm's own tests.
pub use heddle_llm::usage::merge_token_usage;
pub use heddle_llm::{
    Chunk, ContentPart, FilePart, GenerateRequest, ImageMediaType, ImagePart, Message, Role,
    TokenUsage, ToolCall,
};

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
    fn usage_adds_across_rounds_and_a_bucket_stays_absent_until_reported() {
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
    }

    #[test]
    fn the_tool_message_the_loop_writes_keeps_the_typescript_field_order() {
        let mut message = Message::new(Role::Tool, vec![ContentPart::text("ok")]);
        message.tool_call_id = Some("c1".into());
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"role":"tool","toolCallId":"c1","content":[{"type":"text","text":"ok"}]}"#
        );
    }

    #[test]
    fn a_streamed_tool_call_reads_the_typescript_wire_shape() {
        let call: Chunk = serde_json::from_str(
            r#"{"type":"tool-call","id":"c1","name":"read_file","arguments":"{}"}"#,
        )
        .unwrap();
        assert_eq!(
            call,
            Chunk::ToolCall(ToolCall {
                id: "c1".into(),
                name: "read_file".into(),
                arguments: "{}".into()
            })
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
