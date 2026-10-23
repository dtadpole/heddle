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
        self.input_tokens.is_none()
            && self.output_tokens.is_none()
            && self.cache_read_tokens.is_none()
            && self.cache_write_tokens.is_none()
    }
}

/// Add one frame's usage to a running total, bucket by bucket (`mergeTokenUsage`). A bucket stays absent until a
/// frame reports it.
pub fn merge_token_usage(
    previous: Option<TokenUsage>,
    next: Option<TokenUsage>,
) -> Option<TokenUsage> {
    match (previous, next) {
        (previous, None) => previous,
        (None, Some(next)) => Some(next),
        (Some(previous), Some(next)) => Some(TokenUsage {
            input_tokens: add_bucket(previous.input_tokens, next.input_tokens),
            output_tokens: add_bucket(previous.output_tokens, next.output_tokens),
            cache_read_tokens: add_bucket(previous.cache_read_tokens, next.cache_read_tokens),
            cache_write_tokens: add_bucket(previous.cache_write_tokens, next.cache_write_tokens),
        }),
    }
}

/// One bucket's sum: a bucket stays absent when neither side reported it.
fn add_bucket(previous: Option<u64>, next: Option<u64>) -> Option<u64> {
    match (previous, next) {
        (None, None) => None,
        (previous, next) => Some(previous.unwrap_or(0) + next.unwrap_or(0)),
    }
}

/// The billed prompt-side total — uncached input plus cache reads plus cache writes (`billedInputTokens`);
/// `None` when no prompt-side bucket was reported.
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

    #[test]
    fn merging_adds_every_bucket_and_keeps_an_unreported_one_absent() {
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
                }),
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
    fn the_billed_prompt_total_sums_three_buckets_or_says_nothing() {
        let full = TokenUsage {
            input_tokens: Some(10),
            output_tokens: Some(99),
            cache_read_tokens: Some(30),
            cache_write_tokens: Some(5),
        };
        assert_eq!(
            billed_input_tokens(Some(&full)),
            Some(45),
            "output is not prompt-side"
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

    #[test]
    fn a_usage_with_no_bucket_is_empty_and_serialises_as_an_empty_object() {
        assert!(TokenUsage::default().is_empty());
        assert!(
            !TokenUsage {
                output_tokens: Some(0),
                ..TokenUsage::default()
            }
            .is_empty()
        );
        assert_eq!(serde_json::to_string(&TokenUsage::default()).unwrap(), "{}");
        assert_eq!(
            serde_json::to_string(&TokenUsage {
                input_tokens: Some(1),
                ..TokenUsage::default()
            })
            .unwrap(),
            "{\"inputTokens\":1}"
        );
    }
}
