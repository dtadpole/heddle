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
        serde_json::to_value(self).expect("a context event serialises as JSON")
    }

    /// The event's `type`.
    pub fn kind(&self) -> &'static str {
        match self {
            ContextEvent::Note { .. } => "context/note",
            ContextEvent::Prune { .. } => "compaction/prune",
            ContextEvent::Start { .. } => "compaction/start",
            ContextEvent::Summary { .. } => "compaction/summary",
            ContextEvent::End { .. } => "compaction/end",
            ContextEvent::Measured { .. } => "compaction/measured",
            ContextEvent::Failed { .. } => "compaction/failed",
            ContextEvent::Recovery { .. } => "compaction/recovery",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ContextEvent, ShadowedRange, origin};
    use crate::types::{Role, text_message};
    use serde_json::json;

    #[test]
    fn a_note_serialises_with_its_type_first_and_no_absent_optional_fields() {
        let note = ContextEvent::Note {
            message: text_message(Role::User, "the rules"),
            origin: origin::INSTRUCTIONS.to_string(),
            identity: None,
            files: None,
        };
        let value = note.to_value();
        assert_eq!(value["type"], json!("context/note"));
        assert_eq!(value["origin"], json!("instructions"));
        assert_eq!(
            value["message"],
            json!({"role": "user", "content": [{"type": "text", "text": "the rules"}]})
        );
        assert!(value.get("identity").is_none());
        assert!(value.get("files").is_none());
        assert_eq!(note.kind(), "context/note");
    }

    #[test]
    fn a_prune_names_its_span_and_shadow_price_in_camel_case() {
        let prune = ContextEvent::Prune {
            shadowed_range: ShadowedRange { start: 2, end: 2 },
            shadowed_seqs: vec![2],
            shadowed_token_count: 9000,
        };
        let value = prune.to_value();
        assert_eq!(
            value,
            json!({
                "type": "compaction/prune",
                "shadowedRange": { "start": 2, "end": 2 },
                "shadowedSeqs": [2],
                "shadowedTokenCount": 9000,
            })
        );
        assert_eq!(prune.kind(), "compaction/prune");
    }

    #[test]
    fn every_variant_names_the_type_the_typescript_build_writes() {
        let measured = ContextEvent::Measured {
            before: 100,
            after: 40,
        };
        assert_eq!(
            measured.to_value(),
            json!({"type": "compaction/measured", "before": 100, "after": 40})
        );
        assert_eq!(measured.kind(), "compaction/measured");
        let failed = ContextEvent::Failed {
            from_seq: 1,
            through_seq: 2,
            refused: true,
            reason: "no".to_string(),
        };
        assert_eq!(failed.kind(), "compaction/failed");
        assert_eq!(failed.to_value()["refused"], json!(true));
    }
}
