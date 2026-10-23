//! Token usage in the shape the harness keeps it, as much as the projections need.
//!
//! The type and the two helpers are `heddle-llm`'s (`src/llm/usage.ts`). They are declared here until that crate
//! publishes them, and will then become re-exports with the same fields and serialised shape: four prompt- and
//! output-side buckets, **each absent until a frame reports it** — an absent cache bucket is not a zero.

use serde::{Deserialize, Serialize};

/// One call's, or one turn's, reported usage. Every field is absent when no frame reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// Prompt-side tokens billed without a cache hit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    /// Completion tokens the provider billed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// Prompt-side tokens served from the provider's cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    /// Prompt-side tokens written into the provider's cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
}

impl TokenUsage {
    /// Whether no bucket was reported at all.
    pub fn is_empty(&self) -> bool {
        todo!("TokenUsage::is_empty")
    }
}

/// Add one frame's usage to a running total, bucket by bucket (`mergeTokenUsage`). A bucket stays absent until a
/// frame reports it.
pub fn merge_token_usage(
    previous: Option<TokenUsage>,
    next: Option<TokenUsage>,
) -> Option<TokenUsage> {
    let _ = (previous, next);
    todo!("merge_token_usage")
}

/// The billed prompt-side total — uncached input plus cache reads plus cache writes (`billedInputTokens`);
/// `None` when no prompt-side bucket was reported.
pub fn billed_input_tokens(usage: Option<&TokenUsage>) -> Option<u64> {
    let _ = usage;
    todo!("billed_input_tokens")
}
