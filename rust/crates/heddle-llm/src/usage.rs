//! Token usage in the shape the harness keeps it, and each provider's normalisation into it.
//!
//! Ported from `src/llm/usage.ts`. Two rules carry over:
//!
//! - **A bucket stays absent until a frame reports it.** An absent cache bucket is not a zero: a provider that
//!   never mentions caching must not make the page print `Cache hit 0%`.
//! - **`input_tokens` is the uncached part**, never the whole prompt. OpenAI's `prompt_tokens` includes the cached
//!   subset, so the cache read is subtracted; Anthropic's `input_tokens` already excludes it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One call's, or one turn's, reported usage. JSON: `{"inputTokens"?,"outputTokens"?,"cacheReadTokens"?,"cacheWriteTokens"?}`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Whether no bucket was reported.
    pub fn is_empty(&self) -> bool {
        self.input_tokens.is_none()
            && self.output_tokens.is_none()
            && self.cache_read_tokens.is_none()
            && self.cache_write_tokens.is_none()
    }
}

/// Chat Completions usage (`openaiChatUsage`): `prompt_tokens` minus `prompt_tokens_details.cached_tokens` is the
/// uncached input; `completion_tokens` the output. `None` when the frame is not an object or reports nothing.
pub fn openai_chat_usage(frame: &Value) -> Option<TokenUsage> {
    let _ = frame;
    todo!("port openaiChatUsage")
}

/// Responses usage (`openaiResponsesUsage`): the same subset rule on `input_tokens` / `input_tokens_details`.
pub fn openai_responses_usage(frame: &Value) -> Option<TokenUsage> {
    let _ = frame;
    todo!("port openaiResponsesUsage")
}

/// Anthropic usage (`anthropicUsage`): `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`
/// are already disjoint.
pub fn anthropic_usage(frame: &Value) -> Option<TokenUsage> {
    let _ = frame;
    todo!("port anthropicUsage")
}

/// Add one frame's usage to a running total, bucket by bucket (`mergeTokenUsage`). A bucket absent on both sides
/// stays absent.
pub fn merge_token_usage(
    previous: Option<TokenUsage>,
    next: Option<TokenUsage>,
) -> Option<TokenUsage> {
    let _ = (previous, next);
    todo!("port mergeTokenUsage")
}

/// The billed prompt-side total, the denominator of `Cache hit` (`billedInputTokens`). `None` when no prompt-side
/// bucket was reported at all.
pub fn billed_input_tokens(usage: Option<&TokenUsage>) -> Option<u64> {
    let _ = usage;
    todo!("port billedInputTokens")
}
