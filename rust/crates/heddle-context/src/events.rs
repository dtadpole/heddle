//! The session events this crate writes, typed, in the TypeScript build's field order.
//!
//! Every model-visible thing the harness composes — the system prompt, the instruction baseline, a
//! compaction checkpoint, a runtime-context snapshot — is a **`context/note`**, never a `message`:
//! a view of the conversation renders `message` and chunk events, so a note cannot appear in one as
//! something a person said. Everything else here is log-only.
//!
//! The enum is public so a reader of the log (the trajectory view, the context panel) can parse
//! these events with the same types that wrote them. Field order follows the TypeScript literals;
//! it reaches the log unchanged once `serde_json` preserves insertion order.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::Message;

/// The `origin` values of a `context/note`.
pub mod origin {
    /// The system prompt, the surface's first node.
    pub const SYSTEM_PROMPT: &str = "system-prompt";
    /// The instruction baseline.
    pub const INSTRUCTIONS: &str = "instructions";
    /// A compaction checkpoint.
    pub const COMPACTION: &str = "compaction";
    /// A runtime-context snapshot.
    pub const RUNTIME_CONTEXT: &str = crate::runtime::RUNTIME_CONTEXT_ORIGIN;
    /// The note the replacing mechanism wrote before snapshots existed; the first snapshot replaces it.
    pub const LEGACY_SANDBOX_POLICY: &str = "sandbox-policy";
}

/// A one-node span as `compaction/prune` writes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShadowedRange {
    /// The first seq.
    pub start: u64,
    /// The last seq.
    pub end: u64,
}

/// One event this crate appends, tagged by its `type`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ContextEvent {
    /// A model-visible message the harness wrote.
    #[serde(rename = "context/note")]
    Note {
        /// The message the node derives to.
        message: Message,
        /// Which mechanism wrote it; see [`origin`].
        origin: String,
        /// What it was rendered from: a baseline's digest, or a snapshot's text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        identity: Option<String>,
        /// The instruction files a baseline carries.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        files: Option<Vec<PathBuf>>,
    },
    /// The shadow price of one pruned tool result, written just before its replacement.
    #[serde(rename = "compaction/prune")]
    Prune {
        /// The node pruned.
        shadowed_range: ShadowedRange,
        /// The same node, as a list.
        shadowed_seqs: Vec<u64>,
        /// The estimate of the original.
        shadowed_token_count: u64,
    },
    /// A compaction opened.
    #[serde(rename = "compaction/start")]
    Start {
        /// The span's first seq.
        from_seq: u64,
        /// The span's last seq.
        through_seq: u64,
        /// The span.
        shadowed_seqs: Vec<u64>,
        /// The span's price.
        shadowed_token_count: u64,
        /// The measurement the decision was taken on.
        estimated_tokens: u64,
        /// The trigger.
        threshold_tokens: u64,
    },
    /// The accepted summary, log-only: the model reads it once, through the replacement.
    #[serde(rename = "compaction/summary")]
    Summary {
        /// The span's first seq.
        from_seq: u64,
        /// The span's last seq.
        through_seq: u64,
        /// The framed checkpoint text.
        summary: String,
        /// The span.
        shadowed_seqs: Vec<u64>,
        /// The span's price.
        shadowed_token_count: u64,
        /// The checkpoint's price.
        estimated_tokens: u64,
    },
    /// A compaction closed.
    #[serde(rename = "compaction/end")]
    End {
        /// The span's first seq.
        from_seq: u64,
        /// The span's last seq.
        through_seq: u64,
        /// The `compaction/summary` event.
        summary_seq: u64,
        /// The replacement note.
        replacement_seq: u64,
    },
    /// The measurement before and after a landed compaction.
    #[serde(rename = "compaction/measured")]
    Measured {
        /// Before.
        before: u64,
        /// After.
        after: u64,
    },
    /// A refused compaction; the surface is unchanged.
    #[serde(rename = "compaction/failed")]
    Failed {
        /// The span's first seq.
        from_seq: u64,
        /// The span's last seq.
        through_seq: u64,
        /// Always `true`: the refusal was a decision, not a crash.
        refused: bool,
        /// Why.
        reason: String,
    },
    /// The decision taken on a refused model call: retry after a landed reduction, or not.
    #[serde(rename = "compaction/recovery")]
    Recovery {
        /// The failure's code.
        code: String,
        /// `replaceGeneration` before the forced reduction.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        generation_before: Option<u64>,
        /// `replaceGeneration` after it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        generation_after: Option<u64>,
        /// Whether the loop is granted its one retry.
        retry: bool,
        /// Why not, for a failure that is not a window overflow.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

impl ContextEvent {
    /// The event as the JSON object [`crate::ContextStore::append`] takes.
    pub fn to_value(&self) -> Value {
        todo!("ContextEvent::to_value")
    }

    /// The event's `type`.
    pub fn kind(&self) -> &'static str {
        todo!("ContextEvent::kind")
    }
}
