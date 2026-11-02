//! The context row's values, judged where they are written (issue #212).
//!
//! heddle-context's `resolve_budget` refuses a budget whose retained tail is not below its trigger, but it
//! runs when a turn starts, so a settings write could save a value that failed every later turn on that
//! server. This is the context row's rule over the written configuration, run by [`crate::Schema::check`]
//! for a schema that names it ([`CONTEXT_BUDGET_RULE`], which [`crate::context_schema`] does), so a Save
//! and `config --validate` refuse it first. `src/config/context-rule.ts` is its twin, word for word: the
//! TypeScript schema declares these numbers plain (a bound there would also stop a boot), so the bounds are
//! the rule's in both builds, and both say them in the same sentence.
//!
//! The words are DSH's compaction-basic (`assertPositiveInteger`, `assertNonNegativeInteger`,
//! `assertRatio`, `validateRatioRetention`): a window is a positive integer, a token count a non-negative
//! integer, a ratio a number in (0, 1], and a retained ratio must be less than the resolved threshold
//! ratio, whatever the window. Where only the window decides (a tail in tokens against
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

/// A set value as JavaScript's `String(value)` prints it; a number as [`shown`].
fn written(value: &Value) -> String {
    match value.as_f64() {
        Some(number) => shown(number),
        None => match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        },
    }
}

/// DSH's `assertPositiveInteger` (`min` 1) or `assertNonNegativeInteger` (`min` 0), for a field that is set.
fn whole(problems: &mut Vec<SchemaProblem>, scope: &Value, prefix: &str, name: &str, min: f64) {
    let Some(value) = scope.get(name) else {
        return;
    };
    let fits = value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n >= min);
    if !fits {
        let kind = if min > 0.0 {
            "a positive integer"
        } else {
            "a non-negative integer"
        };
        problems.push(problem(
            format!("{prefix}{name}"),
            format!("({}) must be {kind}", written(value)),
        ));
    }
}

/// One scope's own fields: its ratios in (0, 1] (DSH's `assertRatio`) and its token counts whole.
fn scope_bounds(problems: &mut Vec<SchemaProblem>, scope: &Value, prefix: &str) {
    for name in ["thresholdRatio", "retainRatio"] {
        let Some(value) = scope.get(name) else {
            continue;
        };
        let fits = value
            .as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.0 && n <= 1.0);
        if !fits {
            problems.push(problem(
                format!("{prefix}{name}"),
                format!("({}) must be a number in (0, 1]", written(value)),
            ));
        }
    }
    for name in ["thresholdTokens", "retainTokens"] {
        whole(problems, scope, prefix, name, 0.0);
    }
}

/// Every way the context row's values would fail a turn or a start; empty when they would not.
pub fn context_budget_problems(config: &Value) -> Vec<SchemaProblem> {
    let policies: Vec<&Value> = config
        .get("policies")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().collect())
        .unwrap_or_default();
    // Every bound first, on the fields each scope writes; the budget is only judged over numbers it can use.
    let mut problems = Vec::new();
    whole(&mut problems, config, "", "contextWindow", 1.0);
    scope_bounds(&mut problems, config, "");
    whole(&mut problems, config, "", "instructionsMaxBytes", 0.0);
    whole(&mut problems, config, "", "summarizeMaxTokens", 1.0);
    for (index, entry) in policies.iter().enumerate() {
        if entry.is_object() {
            scope_bounds(&mut problems, entry, &format!("policies[{index}]."));
        }
    }
    if !problems.is_empty() {
        return problems;
    }

    let window = field(config, "contextWindow").unwrap_or(DEFAULT_CONTEXT_WINDOW);
    let mut problems = scope_problems("", None, &|name| field(config, name), window);
    for (index, entry) in policies.iter().enumerate() {
        if !entry.is_object() || !FIELDS.iter().any(|name| entry.get(*name).is_some()) {
            continue;
        }
        let merged = |name: &str| field(entry, name).or_else(|| field(config, name));
        problems.extend(scope_problems(
            &format!("policies[{index}]."),
            Some(entry),
            &merged,
            window,
        ));
    }
    problems
}

/// One scope's merged budget: the retained tail below its trigger.
fn scope_problems(
    prefix: &str,
    own: Option<&Value>,
    merged: &dyn Fn(&str) -> Option<f64>,
    window: f64,
) -> Vec<SchemaProblem> {
    let threshold_tokens = merged("thresholdTokens");
    let retain_tokens = merged("retainTokens");
    let threshold_ratio = merged("thresholdRatio").unwrap_or(THRESHOLD_RATIO);
    let retain_ratio = merged("retainRatio").unwrap_or(RETAIN_RATIO);
    let threshold = threshold_tokens.unwrap_or_else(|| (window * threshold_ratio).floor());
    let retain = retain_tokens.unwrap_or_else(|| (window * retain_ratio).floor());
    // Ratios alone are judged whatever the window, as DSH's validateRatioRetention judges them at load.
    let ratios_conflict =
        threshold_tokens.is_none() && retain_tokens.is_none() && retain_ratio >= threshold_ratio;
    if !ratios_conflict && retain < threshold {
        return Vec::new();
    }
    let threshold_from = written_at(
        prefix,
        own,
        if threshold_tokens.is_some() {
            "thresholdTokens"
        } else {
            "thresholdRatio"
        },
    );
    let retain_from = written_at(
        prefix,
        own,
        if retain_tokens.is_some() {
            "retainTokens"
        } else {
            "retainRatio"
        },
    );
    vec![retain_not_below(&RetainNotBelow {
        threshold_from: &threshold_from,
        retain_from: &retain_from,
        window_name: "contextWindow",
        window,
        threshold_tokens,
        retain_tokens,
        threshold_ratio,
        retain_ratio,
        threshold,
        retain,
    })]
}

/// Where a side's field was written: `policy_prefix` when the policy names that field, else `""` for the
/// row or a default nobody wrote.
pub fn written_at(policy_prefix: &str, policy: Option<&Value>, name: &str) -> String {
    match policy {
        Some(policy) if policy.get(name).is_some() => policy_prefix.to_owned(),
        _ => String::new(),
    }
}

/// A budget whose retained tail is not below its trigger, as [`retain_not_below`] names it.
#[derive(Clone, Copy, Debug)]
pub struct RetainNotBelow<'a> {
    /// Where the trigger's field was written: `""` for the row or the default, `policies[i].` for a policy.
    pub threshold_from: &'a str,
    /// Where the tail's field was written, the same way.
    pub retain_from: &'a str,
    /// What the window is called: `contextWindow`, or `endpoint 'name' window` when the endpoint declares it.
    pub window_name: &'a str,
    /// The window the ratios were taken of.
    pub window: f64,
    /// Set when the trigger is written in tokens.
    pub threshold_tokens: Option<f64>,
    /// Set when the tail is written in tokens.
    pub retain_tokens: Option<f64>,
    /// The resolved trigger ratio, the default filled in.
    pub threshold_ratio: f64,
    /// The resolved tail ratio, the default filled in.
    pub retain_ratio: f64,
    /// The resolved trigger in tokens.
    pub threshold: f64,
    /// The resolved tail in tokens.
    pub retain: f64,
}

/// The sentence for a tail not below its trigger, naming each side by what was written: one sentence for the
/// write-time rule and for heddle-context's `resolve_budget` when a turn starts, so a refusal at Save and a
/// failure at a turn read alike. `src/config/budget-words.ts` is its twin, word for word.
pub fn retain_not_below(budget: &RetainNotBelow<'_>) -> SchemaProblem {
    let RetainNotBelow {
        threshold_from: t,
        retain_from: r,
        window_name,
        window,
        threshold_tokens,
        retain_tokens,
        threshold_ratio,
        retain_ratio,
        threshold,
        retain,
    } = *budget;
    match (threshold_tokens, retain_tokens) {
        (Some(threshold), Some(retain)) => {
            return problem(
                format!("{r}retainTokens"),
                format!(
                    "({}) must be less than {t}thresholdTokens ({})",
                    shown(retain),
                    shown(threshold)
                ),
            );
        }
        (None, None) if retain_ratio >= threshold_ratio => {
            return problem(
                format!("{r}retainRatio"),
                format!(
                    "({}) must be less than the resolved {t}thresholdRatio ({})",
                    shown(retain_ratio),
                    shown(threshold_ratio)
                ),
            );
        }
        _ => {}
    }
    let (path, tail) = match retain_tokens {
        Some(tokens) => (format!("{r}retainTokens"), format!("({})", shown(tokens))),
        None => (
            format!("{r}retainRatio"),
            format!(
                "({}) of {window_name} {} is {} tokens, which",
                shown(retain_ratio),
                shown(window),
                shown(retain)
            ),
        ),
    };
    let trigger = match threshold_tokens {
        Some(tokens) => format!("{t}thresholdTokens ({})", shown(tokens)),
        None => format!(
            "the threshold tokens ({} = {t}thresholdRatio {} of {window_name} {})",
            shown(threshold),
            shown(threshold_ratio),
            shown(window)
        ),
    };
    problem(path, format!("{tail} must be less than {trigger}"))
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
    fn the_bounds_are_dshs_on_the_row_and_in_each_policy() {
        assert_eq!(
            said(json!({ "contextWindow": -5 })),
            vec!["contextWindow (-5) must be a positive integer"]
        );
        assert_eq!(
            said(json!({ "contextWindow": 1.5 })),
            vec!["contextWindow (1.5) must be a positive integer"]
        );
        assert_eq!(
            said(json!({ "contextWindow": 0 })),
            vec!["contextWindow (0) must be a positive integer"]
        );
        assert_eq!(
            said(json!({ "thresholdRatio": -1 })),
            vec!["thresholdRatio (-1) must be a number in (0, 1]"]
        );
        assert_eq!(
            said(json!({ "thresholdRatio": 2 })),
            vec!["thresholdRatio (2) must be a number in (0, 1]"]
        );
        assert_eq!(
            said(json!({ "retainTokens": 2.5 })),
            vec!["retainTokens (2.5) must be a non-negative integer"]
        );
        assert_eq!(
            said(json!({ "instructionsMaxBytes": -1 })),
            vec!["instructionsMaxBytes (-1) must be a non-negative integer"]
        );
        assert_eq!(
            said(json!({ "summarizeMaxTokens": 0 })),
            vec!["summarizeMaxTokens (0) must be a positive integer"]
        );
        assert_eq!(
            said(json!({ "policies": [{ "endpoint": "x", "retainTokens": -1 }] })),
            vec!["policies[0].retainTokens (-1) must be a non-negative integer"]
        );
        assert_eq!(
            said(json!({ "contextWindow": 0, "retainRatio": 0.99, "thresholdRatio": 0.5 })),
            vec!["contextWindow (0) must be a positive integer"],
            "a bound speaks before the budget"
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
                "retainRatio (0.9) must be less than the resolved policies[1].thresholdRatio (0.5)"
            ],
            "each side is named where it was written"
        );
        assert_eq!(
            said(
                json!({ "contextWindow": 1000, "policies": [{ "endpoint": "small", "thresholdTokens": 100 }] })
            ),
            vec![
                "retainRatio (0.16) of contextWindow 1000 is 160 tokens, which must be less than policies[0].thresholdTokens (100)"
            ]
        );
        assert_eq!(
            said(
                json!({ "contextWindow": 2000, "thresholdTokens": 1000, "policies": [{ "endpoint": "small", "retainTokens": 2000 }] })
            ),
            vec!["policies[0].retainTokens (2000) must be less than thresholdTokens (1000)"]
        );
    }
}
