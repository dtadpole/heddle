//! The context budget: how large the window is, when to compact, and how much to keep.
//!
//! A port of `src/context/budget.ts`. Its two rules are DSH's:
//!
//! - **The endpoint's own window beats the configured one** — an adapter that declares a window
//!   knows its model; a number in a configuration file is one guess covering every endpoint.
//! - **Retention must sit strictly below the trigger** — a retained tail at least as large as the
//!   threshold could never bring the surface back under it, so such a policy is refused.

use serde::{Deserialize, Serialize};

/// Compact when the estimate reaches this fraction of the window. DSH's default.
pub const THRESHOLD_RATIO: f64 = 0.8;
/// Keep this fraction of the window as recent history, uncompacted. DSH's default.
pub const RETAIN_RATIO: f64 = 0.16;

/// What a caller branches on when a budget cannot be resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BudgetErrorCode {
    /// `NO_CAPACITY`: neither the endpoint nor the configuration gives a window — a configuration
    /// gap a caller may fall back from.
    NoCapacity,
    /// `RETAIN_NOT_BELOW_THRESHOLD`: a policy bug that must not be silently repaired.
    RetainNotBelowThreshold,
}

impl BudgetErrorCode {
    /// The code as the TypeScript build spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            BudgetErrorCode::NoCapacity => "NO_CAPACITY",
            BudgetErrorCode::RetainNotBelowThreshold => "RETAIN_NOT_BELOW_THRESHOLD",
        }
    }
}

/// A budget that cannot be resolved, with its code and the TypeScript build's message.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct BudgetError {
    /// What a caller branches on.
    pub code: BudgetErrorCode,
    /// Names the endpoint, or the two numbers that conflict.
    pub message: String,
}

/// The ratios and absolute numbers a caller may override, per plugin or per endpoint.
///
/// An absolute number wins over its ratio when both are set.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BudgetPolicy {
    /// Compact at this fraction of the window.
    pub threshold_ratio: Option<f64>,
    /// Retain this fraction of the window.
    pub retain_ratio: Option<f64>,
    /// An absolute trigger.
    pub threshold_tokens: Option<u64>,
    /// An absolute retained tail.
    pub retain_tokens: Option<u64>,
}

/// A per-endpoint override, matched by endpoint name; it names only what it changes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EndpointPolicy {
    /// The endpoint it applies to.
    pub endpoint: String,
    /// What it changes.
    #[serde(flatten)]
    pub policy: BudgetPolicy,
}

/// Where a budget's window came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetSource {
    /// The routed endpoint (or its model) declared it.
    Endpoint,
    /// The context configuration's `contextWindow`.
    Config,
}

/// The resolved budget for one request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// The window, in tokens.
    pub context_window: u64,
    /// Compact when the measurement reaches this.
    pub threshold_tokens: u64,
    /// Keep a tail priced at least this, verbatim.
    pub retain_tokens: u64,
    /// Where the window came from.
    pub source: BudgetSource,
}

/// What a budget is resolved from.
#[derive(Clone, Copy, Debug, Default)]
pub struct BudgetInput<'a> {
    /// The routed endpoint's name, matched against `policies`.
    pub endpoint: Option<&'a str>,
    /// The endpoint's own window, when its adapter declares one.
    pub endpoint_window: Option<u64>,
    /// The configured window, used when the endpoint declares none.
    pub config_window: Option<u64>,
    /// The configured policy.
    pub config_policy: BudgetPolicy,
    /// Per-endpoint overrides; the first match wins, field by field over `config_policy`.
    pub policies: &'a [EndpointPolicy],
}

/// Resolve the budget for one endpoint.
///
/// The window is the endpoint's, else the configuration's, else [`BudgetErrorCode::NoCapacity`].
/// The first matching per-endpoint entry overrides the configured policy **field by field**; a
/// threshold is `threshold_tokens` or `floor(window × ratio)`, and the same for the tail; a tail at
/// or above the threshold is [`BudgetErrorCode::RetainNotBelowThreshold`].
pub fn resolve_budget(input: &BudgetInput<'_>) -> Result<Budget, BudgetError> {
    let window = input.endpoint_window.or(input.config_window);
    let Some(window) = window else {
        return Err(BudgetError {
            code: BudgetErrorCode::NoCapacity,
            message: match input.endpoint {
                None => "no context window: the endpoint declares none and none is configured"
                    .to_string(),
                Some(endpoint) => format!(
                    "no context window for endpoint '{endpoint}': the endpoint declares none and none is configured"
                ),
            },
        });
    };

    // The first matching entry wins, and it names only what it changes: a field it leaves alone
    // keeps the configured value, even when the entry carries nothing for it.
    let overridden = input
        .policies
        .iter()
        .find(|entry| input.endpoint == Some(entry.endpoint.as_str()))
        .map(|entry| &entry.policy);
    let configured = input.config_policy;
    let policy = BudgetPolicy {
        threshold_ratio: overridden
            .and_then(|policy| policy.threshold_ratio)
            .or(configured.threshold_ratio),
        retain_ratio: overridden
            .and_then(|policy| policy.retain_ratio)
            .or(configured.retain_ratio),
        threshold_tokens: overridden
            .and_then(|policy| policy.threshold_tokens)
            .or(configured.threshold_tokens),
        retain_tokens: overridden
            .and_then(|policy| policy.retain_tokens)
            .or(configured.retain_tokens),
    };

    let threshold_tokens = policy
        .threshold_tokens
        .unwrap_or_else(|| floor_ratio(window, policy.threshold_ratio.unwrap_or(THRESHOLD_RATIO)));
    let retain_tokens = policy
        .retain_tokens
        .unwrap_or_else(|| floor_ratio(window, policy.retain_ratio.unwrap_or(RETAIN_RATIO)));
    if retain_tokens >= threshold_tokens {
        return Err(BudgetError {
            code: BudgetErrorCode::RetainNotBelowThreshold,
            message: format!(
                "retainTokens ({retain_tokens}) is not below thresholdTokens ({threshold_tokens}): the retained tail is at least the trigger, so compaction could never make progress"
            ),
        });
    }

    Ok(Budget {
        context_window: window,
        threshold_tokens,
        retain_tokens,
        source: if input.endpoint_window.is_some() {
            BudgetSource::Endpoint
        } else {
            BudgetSource::Config
        },
    })
}

/// `Math.floor(window * ratio)`: a window and a ratio chosen so the result is not negative.
fn floor_ratio(window: u64, ratio: f64) -> u64 {
    (window as f64 * ratio).floor() as u64
}

#[cfg(test)]
mod tests {
    use super::{
        Budget, BudgetErrorCode, BudgetInput, BudgetPolicy, BudgetSource, EndpointPolicy,
        resolve_budget,
    };

    fn resolve(input: BudgetInput<'_>) -> Budget {
        resolve_budget(&input).expect("the budget resolves")
    }

    #[test]
    fn a_code_is_spelled_as_the_typescript_build_spells_it() {
        assert_eq!(BudgetErrorCode::NoCapacity.as_str(), "NO_CAPACITY");
        assert_eq!(
            BudgetErrorCode::RetainNotBelowThreshold.as_str(),
            "RETAIN_NOT_BELOW_THRESHOLD"
        );
    }

    #[test]
    fn the_endpoint_window_beats_the_configured_window_and_is_the_reported_source() {
        assert_eq!(
            resolve(BudgetInput {
                endpoint: Some("local"),
                endpoint_window: Some(1000),
                config_window: Some(500),
                ..BudgetInput::default()
            }),
            Budget {
                context_window: 1000,
                threshold_tokens: 800,
                retain_tokens: 160,
                source: BudgetSource::Endpoint,
            }
        );
        assert_eq!(
            resolve(BudgetInput {
                endpoint: Some("local"),
                endpoint_window: None,
                config_window: Some(500),
                ..BudgetInput::default()
            }),
            Budget {
                context_window: 500,
                threshold_tokens: 400,
                retain_tokens: 80,
                source: BudgetSource::Config,
            }
        );
    }

    #[test]
    fn a_per_endpoint_policy_overrides_the_configured_policy_field_by_field() {
        let policies = [EndpointPolicy {
            endpoint: "a".to_string(),
            policy: BudgetPolicy {
                threshold_ratio: Some(0.5),
                ..BudgetPolicy::default()
            },
        }];
        let budget = resolve(BudgetInput {
            endpoint: Some("a"),
            endpoint_window: Some(1000),
            config_policy: BudgetPolicy {
                threshold_ratio: Some(0.9),
                retain_ratio: Some(0.05),
                ..BudgetPolicy::default()
            },
            policies: &policies,
            ..BudgetInput::default()
        });
        // The ratio it names is overridden; the one it leaves alone survives.
        assert_eq!(budget.threshold_tokens, 500);
        assert_eq!(budget.retain_tokens, 50);

        let other = resolve(BudgetInput {
            endpoint: Some("a"),
            endpoint_window: Some(1000),
            config_policy: BudgetPolicy {
                threshold_ratio: Some(0.9),
                ..BudgetPolicy::default()
            },
            policies: &[EndpointPolicy {
                endpoint: "b".to_string(),
                policy: BudgetPolicy {
                    threshold_ratio: Some(0.5),
                    ..BudgetPolicy::default()
                },
            }],
            ..BudgetInput::default()
        });
        assert_eq!(other.threshold_tokens, 900);
    }

    #[test]
    fn the_first_matching_per_endpoint_policy_wins() {
        let policies = [
            EndpointPolicy {
                endpoint: "a".to_string(),
                policy: BudgetPolicy {
                    threshold_ratio: Some(0.5),
                    ..BudgetPolicy::default()
                },
            },
            EndpointPolicy {
                endpoint: "a".to_string(),
                policy: BudgetPolicy {
                    threshold_ratio: Some(0.25),
                    retain_ratio: Some(0.1),
                    ..BudgetPolicy::default()
                },
            },
        ];
        let budget = resolve(BudgetInput {
            endpoint: Some("a"),
            endpoint_window: Some(1000),
            policies: &policies,
            ..BudgetInput::default()
        });
        assert_eq!(budget.threshold_tokens, 500);
        assert_eq!(budget.retain_tokens, 160);
    }

    #[test]
    fn absolute_numbers_in_the_policy_beat_the_ratios() {
        let budget = resolve(BudgetInput {
            endpoint_window: Some(1000),
            config_policy: BudgetPolicy {
                threshold_tokens: Some(640),
                retain_tokens: Some(96),
                threshold_ratio: Some(0.1),
                retain_ratio: Some(0.01),
            },
            ..BudgetInput::default()
        });
        assert_eq!(budget.threshold_tokens, 640);
        assert_eq!(budget.retain_tokens, 96);
    }

    #[test]
    fn a_window_that_comes_from_nowhere_is_refused_with_no_capacity_naming_the_endpoint() {
        let error = resolve_budget(&BudgetInput {
            endpoint: Some("local"),
            ..BudgetInput::default()
        })
        .expect_err("no window is a refusal");
        assert_eq!(error.code, BudgetErrorCode::NoCapacity);
        assert_eq!(error.code.as_str(), "NO_CAPACITY");
        assert!(error.message.contains("local"), "{}", error.message);

        let unnamed = resolve_budget(&BudgetInput::default()).expect_err("no window is a refusal");
        assert_eq!(unnamed.code, BudgetErrorCode::NoCapacity);
        assert!(!unnamed.message.contains("''"), "{}", unnamed.message);
    }

    #[test]
    fn a_retained_tail_at_or_above_the_trigger_is_refused() {
        let error = resolve_budget(&BudgetInput {
            endpoint_window: Some(100),
            config_policy: BudgetPolicy {
                threshold_ratio: Some(0.1),
                retain_ratio: Some(0.2),
                ..BudgetPolicy::default()
            },
            ..BudgetInput::default()
        })
        .expect_err("a retained tail above the trigger cannot make progress");
        assert_eq!(error.code, BudgetErrorCode::RetainNotBelowThreshold);
        assert!(error.message.contains("20"), "{}", error.message);
        assert!(error.message.contains("10"), "{}", error.message);

        let equal = resolve_budget(&BudgetInput {
            endpoint_window: Some(100),
            config_policy: BudgetPolicy {
                threshold_ratio: Some(0.2),
                retain_ratio: Some(0.2),
                ..BudgetPolicy::default()
            },
            ..BudgetInput::default()
        })
        .expect_err("a retained tail at the trigger cannot make progress");
        assert_eq!(equal.code, BudgetErrorCode::RetainNotBelowThreshold);
    }
}
