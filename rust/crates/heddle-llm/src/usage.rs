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

/// A non-negative token count, or `None` when the frame did not carry one.
fn count(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number >= 0.0)
        .map(|number| number as u64)
}

/// The cached-token count out of a nested details object, if the provider sent one.
fn cached_in(details: Option<&Value>) -> Option<u64> {
    count(details.and_then(|details| details.get("cached_tokens")))
}

/// Build a usage value from a prompt total that **includes** its cached subset, as OpenAI reports it.
fn assemble(
    prompt_total: Option<u64>,
    cached_read: Option<u64>,
    cache_write: Option<u64>,
    output_tokens: Option<u64>,
) -> Option<TokenUsage> {
    let usage = TokenUsage {
        input_tokens: prompt_total.map(|prompt| prompt.saturating_sub(cached_read.unwrap_or(0))),
        output_tokens,
        cache_read_tokens: cached_read,
        cache_write_tokens: cache_write,
    };
    if usage.is_empty() { None } else { Some(usage) }
}

/// Chat Completions usage (`openaiChatUsage`): `prompt_tokens` minus `prompt_tokens_details.cached_tokens` is the
/// uncached input; `completion_tokens` the output. `None` when the frame is not an object or reports nothing.
pub fn openai_chat_usage(frame: &Value) -> Option<TokenUsage> {
    if !frame.is_object() {
        return None;
    }
    assemble(
        count(frame.get("prompt_tokens")),
        cached_in(frame.get("prompt_tokens_details")),
        None,
        count(frame.get("completion_tokens")),
    )
}

/// Responses usage (`openaiResponsesUsage`): the same subset rule on `input_tokens` / `input_tokens_details`.
pub fn openai_responses_usage(frame: &Value) -> Option<TokenUsage> {
    if !frame.is_object() {
        return None;
    }
    assemble(
        count(frame.get("input_tokens")),
        cached_in(frame.get("input_tokens_details")),
        None,
        count(frame.get("output_tokens")),
    )
}

/// Anthropic usage (`anthropicUsage`): `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`
/// are already disjoint.
pub fn anthropic_usage(frame: &Value) -> Option<TokenUsage> {
    if !frame.is_object() {
        return None;
    }
    let usage = TokenUsage {
        input_tokens: count(frame.get("input_tokens")),
        output_tokens: count(frame.get("output_tokens")),
        cache_read_tokens: count(frame.get("cache_read_input_tokens")),
        cache_write_tokens: count(frame.get("cache_creation_input_tokens")),
    };
    if usage.is_empty() { None } else { Some(usage) }
}

/// Add one frame's usage to a running total, bucket by bucket (`mergeTokenUsage`). A bucket absent on both sides
/// stays absent.
pub fn merge_token_usage(
    previous: Option<TokenUsage>,
    next: Option<TokenUsage>,
) -> Option<TokenUsage> {
    let (previous, next) = match (previous, next) {
        (_, None) => return previous,
        (None, Some(next)) => return Some(next),
        (Some(previous), Some(next)) => (previous, next),
    };
    let add = |left: Option<u64>, right: Option<u64>| match (left, right) {
        (None, None) => None,
        (left, right) => Some(left.unwrap_or(0) + right.unwrap_or(0)),
    };
    Some(TokenUsage {
        input_tokens: add(previous.input_tokens, next.input_tokens),
        output_tokens: add(previous.output_tokens, next.output_tokens),
        cache_read_tokens: add(previous.cache_read_tokens, next.cache_read_tokens),
        cache_write_tokens: add(previous.cache_write_tokens, next.cache_write_tokens),
    })
}

/// The billed prompt-side total, the denominator of `Cache hit` (`billedInputTokens`). `None` when no prompt-side
/// bucket was reported at all.
pub fn billed_input_tokens(usage: Option<&TokenUsage>) -> Option<u64> {
    let usage = usage?;
    if usage.input_tokens.is_none()
        && usage.cache_read_tokens.is_none()
        && usage.cache_write_tokens.is_none()
    {
        return None;
    }
    Some(
        usage.input_tokens.unwrap_or(0)
            + usage.cache_read_tokens.unwrap_or(0)
            + usage.cache_write_tokens.unwrap_or(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_chat_usage_subtracts_the_cached_subset_of_prompt_tokens() {
        assert_eq!(
            openai_chat_usage(&json!({
                "prompt_tokens": 1000,
                "completion_tokens": 50,
                "prompt_tokens_details": { "cached_tokens": 800 }
            })),
            Some(TokenUsage {
                input_tokens: Some(200),
                output_tokens: Some(50),
                cache_read_tokens: Some(800),
                cache_write_tokens: None,
            }),
            "the uncached part is what is billed as input"
        );
        assert_eq!(
            openai_chat_usage(&json!({ "prompt_tokens": 10, "completion_tokens": 4 })),
            Some(TokenUsage {
                input_tokens: Some(10),
                output_tokens: Some(4),
                ..TokenUsage::default()
            }),
            "without a cache detail the whole prompt is uncached"
        );
        assert_eq!(
            openai_chat_usage(&Value::Null),
            None,
            "nothing reported, nothing claimed"
        );
        assert_eq!(openai_chat_usage(&json!({})), None);
    }

    #[test]
    fn a_provider_cannot_make_the_billed_input_negative() {
        assert_eq!(
            openai_chat_usage(&json!({
                "prompt_tokens": 100,
                "prompt_tokens_details": { "cached_tokens": 250 }
            })),
            Some(TokenUsage {
                input_tokens: Some(0),
                output_tokens: None,
                cache_read_tokens: Some(250),
                cache_write_tokens: None,
            })
        );
    }

    #[test]
    fn openai_responses_usage_applies_the_same_subset_rule_to_input_tokens() {
        assert_eq!(
            openai_responses_usage(&json!({
                "input_tokens": 500,
                "output_tokens": 20,
                "input_tokens_details": { "cached_tokens": 400 }
            })),
            Some(TokenUsage {
                input_tokens: Some(100),
                output_tokens: Some(20),
                cache_read_tokens: Some(400),
                cache_write_tokens: None,
            })
        );
        assert_eq!(
            openai_responses_usage(&json!({ "input_tokens": 500 })),
            Some(TokenUsage {
                input_tokens: Some(500),
                ..TokenUsage::default()
            })
        );
        assert_eq!(openai_responses_usage(&Value::Null), None);
    }

    #[test]
    fn anthropic_usage_keeps_the_three_prompt_side_buckets_disjoint() {
        assert_eq!(
            anthropic_usage(&json!({
                "input_tokens": 12,
                "output_tokens": 7,
                "cache_read_input_tokens": 30,
                "cache_creation_input_tokens": 5
            })),
            Some(TokenUsage {
                input_tokens: Some(12),
                output_tokens: Some(7),
                cache_read_tokens: Some(30),
                cache_write_tokens: Some(5),
            })
        );
        assert_eq!(
            anthropic_usage(&json!({ "input_tokens": 12 })),
            Some(TokenUsage {
                input_tokens: Some(12),
                ..TokenUsage::default()
            })
        );
        assert_eq!(anthropic_usage(&Value::Null), None);
    }

    #[test]
    fn a_token_count_that_is_absent_negative_or_not_a_number_is_not_reported() {
        assert_eq!(
            openai_chat_usage(&json!({ "prompt_tokens": -5, "completion_tokens": "3" })),
            None
        );
        assert_eq!(
            openai_chat_usage(&json!({ "prompt_tokens": 4 })),
            Some(TokenUsage {
                input_tokens: Some(4),
                ..TokenUsage::default()
            })
        );
    }

    #[test]
    fn merge_adds_every_bucket_and_a_bucket_no_round_reported_stays_absent() {
        assert_eq!(merge_token_usage(None, None), None);
        assert_eq!(
            merge_token_usage(
                None,
                Some(TokenUsage {
                    input_tokens: Some(10),
                    cache_read_tokens: Some(30),
                    ..TokenUsage::default()
                })
            ),
            Some(TokenUsage {
                input_tokens: Some(10),
                cache_read_tokens: Some(30),
                ..TokenUsage::default()
            })
        );
        assert_eq!(
            merge_token_usage(
                Some(TokenUsage {
                    input_tokens: Some(10),
                    output_tokens: Some(4),
                    cache_read_tokens: Some(30),
                    cache_write_tokens: Some(5),
                }),
                Some(TokenUsage {
                    input_tokens: Some(2),
                    output_tokens: Some(6),
                    cache_read_tokens: Some(70),
                    cache_write_tokens: None,
                })
            ),
            Some(TokenUsage {
                input_tokens: Some(12),
                output_tokens: Some(10),
                cache_read_tokens: Some(100),
                cache_write_tokens: Some(5),
            }),
            "rounds add up per bucket"
        );
        assert_eq!(
            merge_token_usage(
                Some(TokenUsage {
                    input_tokens: Some(10),
                    ..TokenUsage::default()
                }),
                Some(TokenUsage {
                    output_tokens: Some(6),
                    ..TokenUsage::default()
                })
            ),
            Some(TokenUsage {
                input_tokens: Some(10),
                output_tokens: Some(6),
                ..TokenUsage::default()
            }),
            "a field only one round reported is kept without inventing the other"
        );
    }

    #[test]
    fn billed_input_sums_the_prompt_side_buckets_or_says_nothing() {
        assert_eq!(
            billed_input_tokens(Some(&TokenUsage {
                input_tokens: Some(10),
                cache_read_tokens: Some(30),
                cache_write_tokens: Some(5),
                output_tokens: None,
            })),
            Some(45)
        );
        assert_eq!(
            billed_input_tokens(Some(&TokenUsage {
                input_tokens: Some(10),
                ..TokenUsage::default()
            })),
            Some(10)
        );
        assert_eq!(
            billed_input_tokens(Some(&TokenUsage {
                cache_read_tokens: Some(30),
                ..TokenUsage::default()
            })),
            Some(30)
        );
        assert_eq!(
            billed_input_tokens(None),
            None,
            "no usage means no denominator"
        );
        assert_eq!(
            billed_input_tokens(Some(&TokenUsage::default())),
            None,
            "an empty usage is not a zero-token billing"
        );
    }
}
