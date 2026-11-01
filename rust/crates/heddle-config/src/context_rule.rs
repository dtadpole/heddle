//! The context row's budget rule, judged where a value is written (issue #212).
//!
//! heddle-context's `resolve_budget` refuses a budget whose retained tail is not below its trigger, but it
//! runs when a turn starts, so a settings write could save a value that failed every later turn on that
//! server. This is the same rule over the written configuration, run by [`crate::Schema::check`] for a
//! schema that names it ([`CONTEXT_BUDGET_RULE`], which [`crate::context_schema`] does), so a Save and
//! `config --validate` refuse it first. `src/config/context-rule.ts` is its twin, word for word.
//!
//! The words are DSH's compaction-basic where it has a rule of the same shape (`assertRatio`,
//! `validateRatioRetention`): a ratio is a number in (0, 1], and a retained ratio must be less than the
//! resolved threshold ratio, whatever the window. Where only the window decides (a tail in tokens against
//! a trigger by ratio, or a window too small for the ratios), the sentence names each side by what was
//! written and the configured `contextWindow` it was judged at; an endpoint that declares its own window
//! is budgeted against that window when a turn runs.
//!
//! Each scope is judged as `resolve_budget` merges it: the row's own fields, then each `policies[i]` that
//! names any budget field, field by field over the row's. Every problem is about one field path.

use serde_json::Value;

use crate::schema::SchemaProblem;

/// The rule name a schema gives in `x-heddle-rule` to have the context budget judged.
pub const CONTEXT_BUDGET_RULE: &str = "context-budget";

/// The window the context row budgets against when it names none (`src/context/service.ts` `Config`).
pub const DEFAULT_CONTEXT_WINDOW: f64 = 1_048_576.0;
/// heddle-context's `THRESHOLD_RATIO` (src/context/budget.ts), which this crate cannot depend on.
const THRESHOLD_RATIO: f64 = 0.8;
/// heddle-context's `RETAIN_RATIO`.
const RETAIN_RATIO: f64 = 0.16;

const FIELDS: [&str; 4] = [
    "thresholdRatio",
    "retainRatio",
    "thresholdTokens",
    "retainTokens",
];

/// A number as JavaScript prints it: `1`, `0.16`, `1048576`.
fn shown(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e15 {
        format!("{}", number as i64)
    } else {
        number.to_string()
    }
}

fn field(scope: &Value, name: &str) -> Option<f64> {
    scope
        .get(name)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
}

/// One problem, split as [`SchemaProblem`] displays it: the field path, then the rest of the sentence.
fn problem(path: String, message: String) -> SchemaProblem {
    SchemaProblem { path, message }
}

/// Every way the context row's budget fields would fail a turn; empty when they would not.
pub fn context_budget_problems(config: &Value) -> Vec<SchemaProblem> {
    let window = field(config, "contextWindow").unwrap_or(DEFAULT_CONTEXT_WINDOW);
    let mut problems = scope_problems("", config, &|name| field(config, name), window);
    if let Some(policies) = config.get("policies").and_then(Value::as_array) {
        for (index, entry) in policies.iter().enumerate() {
            if !entry.is_object() || !FIELDS.iter().any(|name| entry.get(*name).is_some()) {
                continue;
            }
            let merged = |name: &str| field(entry, name).or_else(|| field(config, name));
            problems.extend(scope_problems(
                &format!("policies[{index}]."),
                entry,
                &merged,
                window,
            ));
        }
    }
    problems
}

/// One scope: its own ratios in range, then the merged budget's tail below its trigger.
fn scope_problems(
    prefix: &str,
    own: &Value,
    merged: &dyn Fn(&str) -> Option<f64>,
    window: f64,
) -> Vec<SchemaProblem> {
    let mut problems = Vec::new();
    for name in ["thresholdRatio", "retainRatio"] {
        if let Some(value) = field(own, name)
            && (value <= 0.0 || value > 1.0)
        {
            problems.push(problem(
                format!("{prefix}{name}"),
                format!("({}) must be a number in (0, 1]", shown(value)),
            ));
        }
    }
    if !problems.is_empty() {
        return problems;
    }

    let threshold_tokens = merged("thresholdTokens");
    let retain_tokens = merged("retainTokens");
    let threshold_ratio = merged("thresholdRatio").unwrap_or(THRESHOLD_RATIO);
    let retain_ratio = merged("retainRatio").unwrap_or(RETAIN_RATIO);
    match (threshold_tokens, retain_tokens) {
        (None, None) if retain_ratio >= threshold_ratio => {
            return vec![problem(
                format!("{prefix}retainRatio"),
                format!(
                    "({}) must be less than the resolved thresholdRatio ({})",
                    shown(retain_ratio),
                    shown(threshold_ratio)
                ),
            )];
        }
        (Some(threshold), Some(retain)) => {
            if retain >= threshold {
                return vec![problem(
                    format!("{prefix}retainTokens"),
                    format!(
                        "({}) must be less than thresholdTokens ({})",
                        shown(retain),
                        shown(threshold)
                    ),
                )];
            }
            return Vec::new();
        }
        _ => {}
    }
    let threshold = threshold_tokens.unwrap_or_else(|| (window * threshold_ratio).floor());
    let retain = retain_tokens.unwrap_or_else(|| (window * retain_ratio).floor());
    if retain < threshold {
        return Vec::new();
    }
    let (path, tail) = match retain_tokens {
        Some(tokens) => (
            format!("{prefix}retainTokens"),
            format!("({})", shown(tokens)),
        ),
        None => (
            format!("{prefix}retainRatio"),
            format!(
                "({}) of contextWindow {} is {} tokens, which",
                shown(retain_ratio),
                shown(window),
                shown(retain)
            ),
        ),
    };
    let trigger = match threshold_tokens {
        Some(tokens) => format!("thresholdTokens ({})", shown(tokens)),
        None => format!(
            "the threshold tokens ({} = thresholdRatio {} of contextWindow {})",
            shown(threshold),
            shown(threshold_ratio),
            shown(window)
        ),
    };
    vec![problem(path, format!("{tail} must be less than {trigger}"))]
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn said(config: Value) -> Vec<String> {
        context_budget_problems(&config)
            .iter()
            .map(ToString::to_string)
            .collect()
    }

    #[test]
    fn the_shipped_and_default_budgets_pass() {
        assert!(said(json!({})).is_empty());
        assert!(said(json!({ "contextWindow": 1_048_576 })).is_empty());
        assert!(said(json!({ "thresholdRatio": 0.7, "retainRatio": 0.2 })).is_empty());
        assert!(said(json!({ "thresholdTokens": 1000, "retainTokens": 200 })).is_empty());
    }

    #[test]
    fn each_refusal_is_dsh_shaped_and_names_what_was_written() {
        assert_eq!(
            said(json!({ "retainRatio": 0.99, "thresholdRatio": 0.5 })),
            vec!["retainRatio (0.99) must be less than the resolved thresholdRatio (0.5)"]
        );
        assert_eq!(
            said(json!({ "thresholdRatio": 0 })),
            vec!["thresholdRatio (0) must be a number in (0, 1]"]
        );
        assert_eq!(
            said(json!({ "thresholdTokens": 400, "retainTokens": 500 })),
            vec!["retainTokens (500) must be less than thresholdTokens (400)"]
        );
        assert_eq!(
            said(json!({ "contextWindow": 1 })),
            vec![
                "retainRatio (0.16) of contextWindow 1 is 0 tokens, which must be less than the threshold tokens (0 = thresholdRatio 0.8 of contextWindow 1)"
            ]
        );
        assert_eq!(
            said(json!({ "retainTokens": 900_000 })),
            vec![
                "retainTokens (900000) must be less than the threshold tokens (838860 = thresholdRatio 0.8 of contextWindow 1048576)"
            ]
        );
        assert_eq!(
            said(json!({ "thresholdTokens": 1000 })),
            vec![
                "retainRatio (0.16) of contextWindow 1048576 is 167772 tokens, which must be less than thresholdTokens (1000)"
            ]
        );
    }

    #[test]
    fn a_policy_is_judged_over_the_row_and_only_when_it_names_a_budget_field() {
        assert_eq!(
            said(json!({ "policies": [{ "endpoint": "small", "retainRatio": 0.9 }] })),
            vec![
                "policies[0].retainRatio (0.9) must be less than the resolved thresholdRatio (0.8)"
            ]
        );
        assert_eq!(
            said(
                json!({ "retainRatio": 0.9, "thresholdRatio": 0.95, "policies": [{ "endpoint": "a" }, { "endpoint": "b", "thresholdRatio": 0.5 }] })
            ),
            vec![
                "policies[1].retainRatio (0.9) must be less than the resolved thresholdRatio (0.5)"
            ]
        );
    }
}
