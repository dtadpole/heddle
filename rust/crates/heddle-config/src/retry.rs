//! Provider request retry: DSH's provider-owned `retryPolicy` (`dsh-llm`'s retry policy) and the decision its
//! retry executor (`dsh-llm-retry`) takes for one failed model request. `src/config/retry.ts` is the
//! TypeScript twin; both answer the same policy, codes, delays and decisions.
//!
//! **The policy.** An endpoint's `retryPolicy` is `normal` (the default: at most `maxRetries` retries, 5, for
//! the codes in `retryableCodes`, by default `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT` and
//! `TRANSPORT`) or `always` (every failure, without a limit). Both share a bounded exponential `backoff`:
//! `initialDelayMs` 500, `maxDelayMs` 10000, `jitterRatio` 0.1. [`resolve_retry_policy`] validates and
//! defaults it with DSH's sentences.
//!
//! **The decision.** [`RetryPolicy::plan`] takes a failure (its code, from [`retry_failure_code`], and the
//! provider's `Retry-After`, from [`parse_retry_after`]) and how many retries this step already took, and
//! answers the next retry and its delay, or `None` when the failure goes to the caller as it is. A positive
//! `Retry-After` within `maxDelayMs` replaces the local delay; one beyond it ends a `normal` policy and is
//! replaced by the local delay in an `always` policy, so a provider cannot stop it. The local delay is
//! `min(initialDelayMs × 2^(retry−1), maxDelayMs)`, jittered symmetrically by `jitterRatio` and capped again.
//! The count is per step: the caller resets it when a new step or turn begins.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::error::ConfigError;

/// Retries a `normal` policy allows when it names none.
pub const DEFAULT_MAX_RETRIES: u64 = 5;
/// The first local delay, in milliseconds.
pub const DEFAULT_INITIAL_DELAY_MS: f64 = 500.0;
/// The largest local delay, and the largest provider delay a policy accepts, in milliseconds.
pub const DEFAULT_MAX_DELAY_MS: f64 = 10_000.0;
/// The symmetric jitter around each local delay.
pub const DEFAULT_JITTER_RATIO: f64 = 0.1;
/// The longest delay a timer can hold, in milliseconds.
pub const MAX_TIMER_DELAY_MS: f64 = 2_147_483_647.0;
/// The failure codes a `normal` policy retries when it names none.
pub const DEFAULT_RETRYABLE_CODES: [&str; 5] = [
    "EMPTY_RESPONSE",
    "RATE_LIMIT",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
];
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Which failures a policy retries, and how often.
#[derive(Clone, Debug, PartialEq)]
pub enum RetryMode {
    /// At most `max_retries` retries per step, for the listed codes only.
    Normal {
        /// Retries after the first request.
        max_retries: u64,
        /// The failure codes eligible for a retry.
        retryable_codes: Vec<String>,
    },
    /// Every failure, until success or cancellation.
    Always,
}

/// One endpoint's resolved retry policy.
#[derive(Clone, Debug, PartialEq)]
pub struct RetryPolicy {
    /// Which failures, how often.
    pub mode: RetryMode,
    /// The first local delay, in milliseconds.
    pub initial_delay_ms: f64,
    /// The largest local delay and the largest accepted provider delay, in milliseconds.
    pub max_delay_ms: f64,
    /// The symmetric jitter around each local delay, between 0 and 1.
    pub jitter_ratio: f64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            mode: RetryMode::Normal {
                max_retries: DEFAULT_MAX_RETRIES,
                retryable_codes: DEFAULT_RETRYABLE_CODES
                    .iter()
                    .map(|code| (*code).to_owned())
                    .collect(),
            },
            initial_delay_ms: DEFAULT_INITIAL_DELAY_MS,
            max_delay_ms: DEFAULT_MAX_DELAY_MS,
            jitter_ratio: DEFAULT_JITTER_RATIO,
        }
    }
}

/// One failed model request, as a retry policy judges it.
#[derive(Clone, Debug, PartialEq)]
pub struct RetryFailure {
    /// The failure's code ([`retry_failure_code`]).
    pub code: String,
    /// The provider's `Retry-After`, in milliseconds, when it sent one.
    pub retry_after_ms: Option<f64>,
}

/// The retry a policy grants: its number within the step and how long to wait first.
#[derive(Clone, Debug, PartialEq)]
pub struct RetryPlan {
    /// 1 for the first retry of the step.
    pub retry: u64,
    /// The wait before the retry, in milliseconds.
    pub delay_ms: f64,
}

impl RetryPolicy {
    /// The policy's identity for counting: two policies with the same key count retries together. Every field
    /// that changes behaviour is in it, and the codes are sorted because eligibility is set membership.
    pub fn key(&self) -> String {
        // Whole numbers are written as JavaScript writes them (`500`, not `500.0`), so both builds key alike.
        let number = |value: f64| {
            if value.fract() == 0.0 && value.abs() < 1e15 {
                serde_json::json!(value as i64)
            } else {
                serde_json::json!(value)
            }
        };
        let key = match &self.mode {
            RetryMode::Normal {
                max_retries,
                retryable_codes,
            } => {
                let mut codes = retryable_codes.clone();
                codes.sort();
                serde_json::json!([
                    "normal",
                    max_retries,
                    codes,
                    number(self.initial_delay_ms),
                    number(self.max_delay_ms),
                    number(self.jitter_ratio)
                ])
            }
            RetryMode::Always => serde_json::json!([
                "always",
                number(self.initial_delay_ms),
                number(self.max_delay_ms),
                number(self.jitter_ratio)
            ]),
        };
        key.to_string()
    }

    /// The local delay before retry number `retry` (1-based), given `random` in `[0, 1)`.
    pub fn local_delay_ms(&self, retry: u64, random: f64) -> f64 {
        let exponent = retry.saturating_sub(1).min(1024) as i32;
        let exponential = (self.initial_delay_ms * 2f64.powi(exponent)).min(self.max_delay_ms);
        let jitter = 1.0 - self.jitter_ratio + 2.0 * self.jitter_ratio * random;
        (exponential * jitter).min(self.max_delay_ms)
    }

    /// The next retry for `failure` after `previous_retry` retries in this step, or `None` when the failure goes
    /// to the caller as it is: a code the policy does not retry, a spent budget, or a provider delay past
    /// `maxDelayMs` under a `normal` policy.
    pub fn plan(
        &self,
        failure: &RetryFailure,
        previous_retry: u64,
        random: f64,
    ) -> Option<RetryPlan> {
        if let RetryMode::Normal {
            max_retries,
            retryable_codes,
        } = &self.mode
            && (!retryable_codes.contains(&failure.code) || previous_retry >= *max_retries)
        {
            return None;
        }
        let retry = previous_retry + 1;
        let provider = failure
            .retry_after_ms
            .filter(|delay| delay.is_finite() && *delay > 0.0);
        let delay_ms = match provider {
            Some(delay) if delay > self.max_delay_ms => match self.mode {
                RetryMode::Normal { .. } => return None,
                RetryMode::Always => self.local_delay_ms(retry, random),
            },
            Some(delay) => delay,
            None => self.local_delay_ms(retry, random),
        };
        Some(RetryPlan { retry, delay_ms })
    }
}

/// Validate and default one endpoint's `retryPolicy` as written; `path` names it in every problem. An absent
/// policy is the `normal` default.
///
/// # Errors
///
/// The sentences DSH's `resolveRetryPolicy` gives: an unknown mode or key, a `maxRetries` that is not a
/// non-negative safe integer, empty or duplicated codes, and a backoff out of range.
pub fn resolve_retry_policy(
    config: Option<&Value>,
    path: &str,
) -> Result<RetryPolicy, ConfigError> {
    let fail = |problem: String| ConfigError::new(vec![problem]);
    let Some(config) = config else {
        return Ok(RetryPolicy::default());
    };
    let mode_problem = || fail(format!("{path}.mode must be \"normal\" or \"always\""));
    let Value::Object(map) = config else {
        return Err(mode_problem());
    };
    for key in map.keys() {
        if !["mode", "maxRetries", "retryableCodes", "backoff"].contains(&key.as_str()) {
            return Err(fail(format!("{path}: unknown key \"{key}\"")));
        }
    }
    let (initial_delay_ms, max_delay_ms, jitter_ratio) =
        resolve_backoff(map.get("backoff"), &format!("{path}.backoff"))?;
    let mode = match map.get("mode").and_then(Value::as_str) {
        Some("normal") => {
            let max_retries = match map.get("maxRetries") {
                None => DEFAULT_MAX_RETRIES,
                Some(value) => value
                    .as_u64()
                    .filter(|retries| *retries <= MAX_SAFE_INTEGER)
                    .ok_or_else(|| {
                        fail(format!(
                            "{path}.maxRetries must be a non-negative safe integer"
                        ))
                    })?,
            };
            let retryable_codes = match map.get("retryableCodes") {
                None => DEFAULT_RETRYABLE_CODES
                    .iter()
                    .map(|code| (*code).to_owned())
                    .collect(),
                Some(value) => resolve_codes(value, path)?,
            };
            RetryMode::Normal {
                max_retries,
                retryable_codes,
            }
        }
        Some("always") => RetryMode::Always,
        _ => return Err(mode_problem()),
    };
    Ok(RetryPolicy {
        mode,
        initial_delay_ms,
        max_delay_ms,
        jitter_ratio,
    })
}

fn resolve_codes(value: &Value, path: &str) -> Result<Vec<String>, ConfigError> {
    let fail = |problem: &str| ConfigError::new(vec![format!("{path}.retryableCodes {problem}")]);
    let Value::Array(items) = value else {
        return Err(fail("must contain only non-empty strings"));
    };
    if items.is_empty() {
        return Err(fail("must not be empty"));
    }
    let mut codes = Vec::new();
    for item in items {
        match item.as_str() {
            Some(code) if !code.is_empty() => codes.push(code.to_owned()),
            _ => return Err(fail("must contain only non-empty strings")),
        }
    }
    let mut unique = codes.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != codes.len() {
        return Err(fail("must not contain duplicates"));
    }
    Ok(codes)
}

fn resolve_backoff(value: Option<&Value>, path: &str) -> Result<(f64, f64, f64), ConfigError> {
    let fail = |problem: String| ConfigError::new(vec![problem]);
    let empty = Map::new();
    let map = match value {
        None => &empty,
        Some(Value::Object(map)) => map,
        Some(_) => return Err(fail(format!("{path} must be a mapping"))),
    };
    for key in map.keys() {
        if !["initialDelayMs", "maxDelayMs", "jitterRatio"].contains(&key.as_str()) {
            return Err(fail(format!("{path}: unknown key \"{key}\"")));
        }
    }
    let number = |key: &str, default: f64| match map.get(key) {
        None => Some(default),
        Some(value) => value.as_f64(),
    };
    let delay_problem = |key: &str| {
        fail(format!(
            "{path}.{key} must be a positive finite number no greater than {}",
            MAX_TIMER_DELAY_MS as u64
        ))
    };
    let in_range = |delay: f64| delay.is_finite() && delay > 0.0 && delay <= MAX_TIMER_DELAY_MS;
    let initial = number("initialDelayMs", DEFAULT_INITIAL_DELAY_MS)
        .filter(|delay| in_range(*delay))
        .ok_or_else(|| delay_problem("initialDelayMs"))?;
    let max = number("maxDelayMs", DEFAULT_MAX_DELAY_MS)
        .filter(|delay| in_range(*delay))
        .ok_or_else(|| delay_problem("maxDelayMs"))?;
    if initial > max {
        return Err(fail(format!(
            "{path}.initialDelayMs must be less than or equal to maxDelayMs"
        )));
    }
    let jitter = number("jitterRatio", DEFAULT_JITTER_RATIO)
        .filter(|ratio| ratio.is_finite() && (0.0..=1.0).contains(ratio))
        .ok_or_else(|| fail(format!("{path}.jitterRatio must be between 0 and 1")))?;
    Ok((initial, max, jitter))
}

/// The code a retry policy judges a failure by, given heddle's model-error code and the HTTP status: an `HTTP`
/// failure is named by its status as DSH's provider adapters name it (401 and 403 `AUTH`, 402 `QUOTA`, 429
/// `RATE_LIMIT`, 400 and 413 `INVALID_REQUEST`, 5xx `SERVER`, otherwise `HTTP_<status>`); a failure with no
/// status is `SERVER`. Every other code (`TIMEOUT`, `TRANSPORT`, `CONTEXT_WINDOW_EXCEEDED`, …) is kept.
pub fn retry_failure_code(code: &str, status: Option<u16>) -> String {
    if code != "HTTP" {
        return code.to_owned();
    }
    match status {
        Some(401 | 403) => "AUTH".to_owned(),
        Some(402) => "QUOTA".to_owned(),
        Some(429) => "RATE_LIMIT".to_owned(),
        Some(400 | 413) => "INVALID_REQUEST".to_owned(),
        Some(status) if status >= 500 => "SERVER".to_owned(),
        Some(status) => format!("HTTP_{status}"),
        None => "SERVER".to_owned(),
    }
}

/// A `Retry-After` header as milliseconds from `now`: decimal seconds, or an HTTP date (IMF-fixdate,
/// `Sun, 06 Nov 1994 08:49:37 GMT`). `None` unless the delay is positive and finite, as DSH reads it.
pub fn parse_retry_after(value: &str, now: SystemTime) -> Option<f64> {
    let value = value.trim();
    let delay = if !value.is_empty()
        && value.chars().all(|c| c.is_ascii_digit() || c == '.')
        && value.matches('.').count() <= 1
        && !value.starts_with('.')
        && !value.ends_with('.')
    {
        value.parse::<f64>().ok()? * 1000.0
    } else {
        let at = imf_fixdate_ms(value)?;
        let now = now.duration_since(UNIX_EPOCH).ok()?.as_millis() as f64;
        at - now
    };
    (delay.is_finite() && delay > 0.0).then_some(delay)
}

/// Milliseconds since the epoch for an IMF-fixdate, `Day, DD Mon YYYY HH:MM:SS GMT`.
fn imf_fixdate_ms(value: &str) -> Option<f64> {
    let (_, rest) = value.split_once(", ")?;
    let parts: Vec<&str> = rest.split(' ').collect();
    let [day, month, year, time, "GMT"] = parts.as_slice() else {
        return None;
    };
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|name| name == month)? as i64
        + 1;
    let day: i64 = day.parse().ok()?;
    let year: i64 = year.parse().ok()?;
    let clock: Vec<i64> = time
        .split(':')
        .map(|part| part.parse().ok())
        .collect::<Option<_>>()?;
    let [hours, minutes, seconds] = clock.as_slice() else {
        return None;
    };
    if !(1..=31).contains(&day) || *hours > 23 || *minutes > 59 || *seconds > 60 {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm), then seconds.
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let year_of_era = shifted - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 86_400 + hours * 3_600 + minutes * 60 + seconds) * 1000) as f64)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;

    fn failure(code: &str, retry_after_ms: Option<f64>) -> RetryFailure {
        RetryFailure {
            code: code.to_owned(),
            retry_after_ms,
        }
    }

    #[test]
    fn an_absent_policy_is_dsh_normal_default() {
        let policy = resolve_retry_policy(None, "endpoints.a.retryPolicy").unwrap();
        assert_eq!(policy, RetryPolicy::default());
        assert_eq!(
            policy.mode,
            RetryMode::Normal {
                max_retries: 5,
                retryable_codes: vec![
                    "EMPTY_RESPONSE".into(),
                    "RATE_LIMIT".into(),
                    "SERVER".into(),
                    "TIMEOUT".into(),
                    "TRANSPORT".into()
                ]
            }
        );
        assert_eq!(
            (
                policy.initial_delay_ms,
                policy.max_delay_ms,
                policy.jitter_ratio
            ),
            (500.0, 10_000.0, 0.1)
        );
    }

    #[test]
    fn a_written_policy_is_validated_with_dsh_sentences() {
        let path = "endpoints.a.retryPolicy";
        let problem = |value: Value| {
            resolve_retry_policy(Some(&value), path)
                .unwrap_err()
                .problems()
                .join("; ")
        };
        assert_eq!(
            problem(json!({ "mode": "sometimes" })),
            format!("{path}.mode must be \"normal\" or \"always\"")
        );
        assert_eq!(
            problem(json!({ "mode": "normal", "tries": 3 })),
            format!("{path}: unknown key \"tries\"")
        );
        assert_eq!(
            problem(json!({ "mode": "normal", "maxRetries": -1 })),
            format!("{path}.maxRetries must be a non-negative safe integer")
        );
        assert_eq!(
            problem(json!({ "mode": "normal", "maxRetries": 1.5 })),
            format!("{path}.maxRetries must be a non-negative safe integer")
        );
        assert_eq!(
            problem(json!({ "mode": "normal", "retryableCodes": [] })),
            format!("{path}.retryableCodes must not be empty")
        );
        assert_eq!(
            problem(json!({ "mode": "normal", "retryableCodes": ["A", "A"] })),
            format!("{path}.retryableCodes must not contain duplicates")
        );
        assert_eq!(
            problem(json!({ "mode": "normal", "retryableCodes": [""] })),
            format!("{path}.retryableCodes must contain only non-empty strings")
        );
        assert_eq!(
            problem(json!({ "mode": "always", "backoff": { "initialDelayMs": 0 } })),
            format!(
                "{path}.backoff.initialDelayMs must be a positive finite number no greater than 2147483647"
            )
        );
        assert_eq!(
            problem(
                json!({ "mode": "always", "backoff": { "initialDelayMs": 2000, "maxDelayMs": 1000 } })
            ),
            format!("{path}.backoff.initialDelayMs must be less than or equal to maxDelayMs")
        );
        assert_eq!(
            problem(json!({ "mode": "always", "backoff": { "jitterRatio": 2 } })),
            format!("{path}.backoff.jitterRatio must be between 0 and 1")
        );
        assert_eq!(
            problem(json!({ "mode": "always", "backoff": { "delay": 1 } })),
            format!("{path}.backoff: unknown key \"delay\"")
        );

        let written = resolve_retry_policy(
            Some(&json!({ "mode": "normal", "maxRetries": 2, "retryableCodes": ["RATE_LIMIT"], "backoff": { "initialDelayMs": 100, "maxDelayMs": 400, "jitterRatio": 0 } })),
            path,
        )
        .unwrap();
        assert_eq!(
            written.mode,
            RetryMode::Normal {
                max_retries: 2,
                retryable_codes: vec!["RATE_LIMIT".into()]
            }
        );
        assert_eq!(
            (
                written.initial_delay_ms,
                written.max_delay_ms,
                written.jitter_ratio
            ),
            (100.0, 400.0, 0.0)
        );
        let always =
            resolve_retry_policy(Some(&json!({ "mode": "always", "maxRetries": 3 })), path)
                .unwrap();
        assert_eq!(
            always.mode,
            RetryMode::Always,
            "always accepts and ignores the normal fields, as DSH does"
        );
    }

    #[test]
    fn the_local_delay_doubles_from_the_initial_delay_up_to_the_cap_with_symmetric_jitter() {
        let policy = RetryPolicy::default();
        let midpoint: Vec<f64> = (1..=7)
            .map(|retry| policy.local_delay_ms(retry, 0.5))
            .collect();
        assert_eq!(
            midpoint,
            vec![500.0, 1000.0, 2000.0, 4000.0, 8000.0, 10_000.0, 10_000.0]
        );
        assert!(
            (policy.local_delay_ms(1, 0.0) - 450.0).abs() < 1e-9,
            "jitter reaches 1 − ratio"
        );
        assert!(
            (policy.local_delay_ms(1, 1.0) - 550.0).abs() < 1e-9,
            "and 1 + ratio"
        );
        assert_eq!(policy.local_delay_ms(5, 1.0), 8800.0);
        assert_eq!(
            policy.local_delay_ms(6, 1.0),
            10_000.0,
            "never past the cap"
        );
        assert_eq!(
            policy.local_delay_ms(2_000, 0.5),
            10_000.0,
            "a huge retry number saturates"
        );
    }

    #[test]
    fn a_normal_policy_retries_its_codes_within_its_budget() {
        let policy = RetryPolicy::default();
        assert_eq!(
            policy.plan(&failure("RATE_LIMIT", None), 0, 0.5),
            Some(RetryPlan {
                retry: 1,
                delay_ms: 500.0
            })
        );
        assert_eq!(
            policy.plan(&failure("SERVER", None), 4, 0.5),
            Some(RetryPlan {
                retry: 5,
                delay_ms: 8000.0
            })
        );
        assert_eq!(
            policy.plan(&failure("SERVER", None), 5, 0.5),
            None,
            "the sixth retry is past the budget"
        );
        assert_eq!(
            policy.plan(&failure("AUTH", None), 0, 0.5),
            None,
            "a permanent failure is not retried"
        );
        assert_eq!(
            policy.plan(&failure("CONTEXT_WINDOW_EXCEEDED", None), 0, 0.5),
            None,
            "compaction owns that one"
        );
    }

    #[test]
    fn a_provider_delay_within_the_cap_replaces_the_local_delay() {
        let normal = RetryPolicy::default();
        assert_eq!(
            normal.plan(&failure("RATE_LIMIT", Some(3000.0)), 0, 0.5),
            Some(RetryPlan {
                retry: 1,
                delay_ms: 3000.0
            })
        );
        assert_eq!(
            normal
                .plan(&failure("RATE_LIMIT", Some(0.0)), 0, 0.5)
                .unwrap()
                .delay_ms,
            500.0,
            "a zero delay is no delay"
        );
        assert_eq!(
            normal.plan(&failure("RATE_LIMIT", Some(20_000.0)), 0, 0.5),
            None,
            "past the cap ends a normal policy"
        );
        let always = RetryPolicy {
            mode: RetryMode::Always,
            ..RetryPolicy::default()
        };
        assert_eq!(
            always.plan(&failure("RATE_LIMIT", Some(20_000.0)), 0, 0.5),
            Some(RetryPlan {
                retry: 1,
                delay_ms: 500.0
            }),
            "an always policy uses its own delay instead"
        );
        assert_eq!(
            always
                .plan(&failure("AUTH", None), 99, 0.5)
                .map(|plan| plan.retry),
            Some(100),
            "and retries everything"
        );
    }

    #[test]
    fn http_failures_are_named_by_status_as_dsh_adapters_name_them() {
        let named = |status| retry_failure_code("HTTP", status);
        assert_eq!(named(Some(429)), "RATE_LIMIT");
        assert_eq!(named(Some(500)), "SERVER");
        assert_eq!(named(Some(503)), "SERVER");
        assert_eq!(named(Some(401)), "AUTH");
        assert_eq!(named(Some(403)), "AUTH");
        assert_eq!(named(Some(402)), "QUOTA");
        assert_eq!(named(Some(400)), "INVALID_REQUEST");
        assert_eq!(named(Some(404)), "HTTP_404");
        assert_eq!(named(None), "SERVER");
        assert_eq!(retry_failure_code("TIMEOUT", None), "TIMEOUT");
        assert_eq!(retry_failure_code("TRANSPORT", None), "TRANSPORT");
        assert_eq!(
            retry_failure_code("CONTEXT_WINDOW_EXCEEDED", Some(400)),
            "CONTEXT_WINDOW_EXCEEDED"
        );
    }

    #[test]
    fn retry_after_reads_seconds_and_http_dates() {
        let now = UNIX_EPOCH + Duration::from_secs(784_111_777); // Sun, 06 Nov 1994 08:49:37 GMT
        assert_eq!(parse_retry_after("2", now), Some(2000.0));
        assert_eq!(parse_retry_after("1.5", now), Some(1500.0));
        assert_eq!(parse_retry_after("0", now), None, "zero is no delay");
        assert_eq!(
            parse_retry_after("Sun, 06 Nov 1994 08:49:40 GMT", now),
            Some(3000.0)
        );
        assert_eq!(
            parse_retry_after("Sun, 06 Nov 1994 08:49:30 GMT", now),
            None,
            "a date in the past is no delay"
        );
        assert_eq!(parse_retry_after("soon", now), None);
        assert_eq!(parse_retry_after("-3", now), None);
    }

    #[test]
    fn the_key_counts_equal_policies_together() {
        let one = RetryPolicy {
            mode: RetryMode::Normal {
                max_retries: 5,
                retryable_codes: vec!["SERVER".into(), "RATE_LIMIT".into()],
            },
            ..RetryPolicy::default()
        };
        let two = RetryPolicy {
            mode: RetryMode::Normal {
                max_retries: 5,
                retryable_codes: vec!["RATE_LIMIT".into(), "SERVER".into()],
            },
            ..RetryPolicy::default()
        };
        assert_eq!(one.key(), two.key(), "code order does not matter");
        assert_eq!(
            one.key(),
            r#"["normal",5,["RATE_LIMIT","SERVER"],500,10000,0.1]"#
        );
        assert_ne!(
            one.key(),
            RetryPolicy {
                mode: RetryMode::Always,
                ..RetryPolicy::default()
            }
            .key()
        );
    }
}
