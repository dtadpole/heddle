//! The message shapes this crate reads and writes — **provisional stand-ins** for `heddle-llm`'s.
//!
//! They mirror `src/llm/types.ts` field for field, including the JSON the session log stores, and
//! they exist only so this crate builds before `heddle-llm` publishes its API. When it does, this
//! module becomes `pub use heddle_llm::{...}` under the same names, so a caller that names
//! `heddle_context::Message` keeps compiling; a difference in shape is settled with that crate's
//! owner, not worked around here.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The code a provider's refusal is normalised to when the request did not fit the window.
///
/// It is the one model failure the harness recovers from: the loop offers it to
/// [`crate::ContextService::recover_overflow`], which answers with one forced reduction.
pub const CONTEXT_WINDOW_EXCEEDED: &str = "CONTEXT_WINDOW_EXCEEDED";

/// Who a message is from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// The system prompt, which the surface keeps as its first node.
    System,
    /// A person, or a note the harness wrote in the user role.
    User,
    /// The model.
    Assistant,
    /// A tool's answer to one call, named by `tool_call_id`.
    Tool,
}

/// One part of a message's content, tagged by `type` as the log stores it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ContentPart {
    /// Plain text.
    Text {
        /// The text.
        text: String,
    },
    /// A reasoning block; priced like text, never replayed to a provider.
    Reasoning {
        /// The reasoning text.
        text: String,
    },
    /// A complete tool call (`type: "tool-call"`).
    ToolCall {
        /// The call id its answer names.
        id: String,
        /// The tool's name.
        name: String,
        /// The arguments, as the JSON text the model wrote.
        arguments: String,
    },
    /// An uploaded image, by the durable path the harness stored it at.
    Image(ImagePart),
    /// An uploaded non-image file, by its durable path.
    File(FilePart),
}

/// An uploaded image (`ImagePart`); this crate prices it by its JSON and never looks inside.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    /// The name it was uploaded under.
    pub name: String,
    /// `image/png`, `image/jpeg`, `image/webp` or `image/gif`.
    pub mime_type: String,
    /// Where the harness stored it.
    pub path: String,
    /// Its size.
    pub bytes: u64,
    /// Its digest.
    pub sha256: String,
    /// Base64 bytes, present only on the adapter-facing copy a request projection builds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

/// An uploaded non-image file (`FilePart`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilePart {
    /// The name it was uploaded under.
    pub name: String,
    /// Where the harness stored it.
    pub path: String,
    /// Its size.
    pub bytes: u64,
    /// Its digest.
    pub sha256: String,
}

/// One message, as a request carries it and as the log records it (`RecordedMessage`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// Who it is from.
    pub role: Role,
    /// Its parts, in order.
    pub content: Vec<ContentPart>,
    /// On a `tool` message: which call this answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Who wrote it when it was not a person — a goal round, a runtime-context snapshot. Never priced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

impl Message {
    /// A message of one text part.
    pub fn text(role: Role, text: impl Into<String>) -> Self {
        let _ = (role, text.into());
        todo!("Message::text")
    }
}

/// One tool the model may ask for, in the provider's shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    /// The tool's name.
    pub name: String,
    /// What it does, for the model.
    pub description: String,
    /// JSON Schema for the arguments.
    pub parameters: Value,
}

/// A provider's reported usage for one call (`src/llm/usage.ts`).
///
/// The meter's anchor adds input and output tokens only; the cache buckets are carried so a log
/// round-trips, not priced — the TypeScript build does not price them either.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// Prompt-side tokens billed without a cache hit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    /// Completion tokens billed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// Prompt-side tokens served from the provider's cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    /// Prompt-side tokens written into the provider's cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
}

/// A plain-text rendering of content for a person (`describeContent`): what `heddle context`
/// prints as each message's `text`.
///
/// A tool call reads `→ name arguments`; an attachment contributes a bracketed name rather than
/// disappearing.
pub fn describe_content(parts: &[ContentPart]) -> String {
    let _ = parts;
    todo!("describe_content")
}
