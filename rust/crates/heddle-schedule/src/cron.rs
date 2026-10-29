//! Five-field Vixie cron, exactly as DSH parses, canonicalizes and matches it (`src/schedule/cron.ts`,
//! SVC:706-741, 1131-1359).
//!
//! The grammar: `minute hour day-of-month month day-of-week`, each field a comma list of `*`, `n`, `a-b`, `*/n` or
//! `a-b/n` (n at least 1). No names, `L`, `W`, `#`, `@` macros or seconds. Day-of-week runs 0-7 and 7 means Sunday,
//! stored as 0.
//!
//! Canonicalization keeps whether the field **text started with `*`** (Vixie's `DOM_STAR` / `DOW_STAR`), which
//! decides the day rule: both day fields restricted is OR, otherwise AND. A `*`-led field is always re-spelled
//! `*`-led and a field that did not start with `*` never is, so re-parsing a canonical expression reproduces both
//! the matched set and the flag.

use std::collections::BTreeSet;

use crate::errors::{ScheduleInputError, ScheduleLogError};
use crate::js;
use crate::time::{PlainDate, PlainTime, iso_day_of_week};

/// One field's range, and the value it folds its maximum onto.
struct FieldSpec {
    name: &'static str,
    min: u32,
    max: u32,
    canonical_max: u32,
}

const FIELDS: [FieldSpec; 5] = [
    FieldSpec {
        name: "minute",
        min: 0,
        max: 59,
        canonical_max: 59,
    },
    FieldSpec {
        name: "hour",
        min: 0,
        max: 23,
        canonical_max: 23,
    },
    FieldSpec {
        name: "day-of-month",
        min: 1,
        max: 31,
        canonical_max: 31,
    },
    FieldSpec {
        name: "month",
        min: 1,
        max: 12,
        canonical_max: 12,
    },
    FieldSpec {
        name: "day-of-week",
        min: 0,
        max: 7,
        canonical_max: 6,
    },
];

/// One parsed field.
struct Field {
    values: Vec<u32>,
    canonical: String,
    star: bool,
}

/// A parsed expression: canonical text, each field's matched values ascending, and the day-field star flags.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedCron {
    /// The canonical spelling.
    pub expression: String,
    /// Matched minutes.
    pub minutes: Vec<u32>,
    /// Matched hours.
    pub hours: Vec<u32>,
    /// Matched days of the month.
    pub days_of_month: Vec<u32>,
    /// Matched months.
    pub months: Vec<u32>,
    /// Matched days of the week, Sunday 0.
    pub days_of_week: Vec<u32>,
    /// Whether the day-of-month text started with `*`.
    pub day_of_month_star: bool,
    /// Whether the day-of-week text started with `*`.
    pub day_of_week_star: bool,
}

fn invalid_element(spec: &FieldSpec, element: &str) -> ScheduleInputError {
    ScheduleInputError::rule(format!(
        "cron.expression {} field element {} must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.",
        spec.name,
        js::json_string(element)
    ))
}

/// `Number(text)` for a digit string, when it is a safe integer.
fn digit_value(text: &str) -> Option<u64> {
    let mut value: u64 = 0;
    for byte in text.bytes() {
        value = value.checked_mul(10)?.checked_add(u64::from(byte - b'0'))?;
    }
    (value <= js::MAX_SAFE_INTEGER as u64).then_some(value)
}

fn field_value(text: &str, spec: &FieldSpec) -> Result<u32, ScheduleInputError> {
    match digit_value(text) {
        Some(value) if value >= u64::from(spec.min) && value <= u64::from(spec.max) => Ok(value as u32),
        _ => Err(ScheduleInputError::rule(format!(
            "cron.expression {} field value {text} is outside {}-{}.",
            spec.name, spec.min, spec.max
        ))),
    }
}

fn field_step(text: &str, spec: &FieldSpec) -> Result<u64, ScheduleInputError> {
    match digit_value(text) {
        Some(step) if step >= 1 => Ok(step),
        _ => Err(ScheduleInputError::rule(format!(
            "cron.expression {} field step must be a positive integer.",
            spec.name
        ))),
    }
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn walk(set: &mut BTreeSet<u32>, start: u32, last: u32, step: u64) {
    let mut value = u64::from(start);
    while value <= u64::from(last) {
        set.insert(value as u32);
        value += step;
    }
}

/// Expand one comma-separated field into its matched values, folding the maximum where the field says so.
fn field_values(raw: &str, spec: &FieldSpec) -> Result<Vec<u32>, ScheduleInputError> {
    let mut matched = BTreeSet::new();
    for element in raw.split(',') {
        if element.is_empty() {
            return Err(ScheduleInputError::rule(format!(
                "cron.expression {} field must not contain an empty list element.",
                spec.name
            )));
        }
        if element == "*" {
            walk(&mut matched, spec.min, spec.max, 1);
            continue;
        }
        if let Some(rest) = element.strip_prefix('*') {
            let Some(step_text) = rest.strip_prefix('/').filter(|text| is_digits(text)) else {
                return Err(invalid_element(spec, element));
            };
            let step = field_step(step_text, spec)?;
            walk(&mut matched, spec.min, spec.max, step);
            continue;
        }
        let (range_text, step_text) = match element.split_once('/') {
            Some((range, step)) => (range, Some(step)),
            None => (element, None),
        };
        let (start_text, end_text) = match range_text.split_once('-') {
            Some((start, end)) => (start, Some(end)),
            None => (range_text, None),
        };
        let shape = is_digits(start_text)
            && end_text.is_none_or(is_digits)
            && step_text.is_none_or(is_digits);
        if !shape {
            return Err(invalid_element(spec, element));
        }
        let start = field_value(start_text, spec)?;
        let Some(end_text) = end_text else {
            if step_text.is_some() {
                return Err(invalid_element(spec, element));
            }
            matched.insert(start);
            continue;
        };
        let last = field_value(end_text, spec)?;
        if start > last {
            return Err(ScheduleInputError::rule(format!(
                "cron.expression {} field range {start}-{last} is inverted.",
                spec.name
            )));
        }
        let step = match step_text {
            Some(text) => field_step(text, spec)?,
            None => 1,
        };
        walk(&mut matched, start, last, step);
    }
    Ok(fold(spec, matched))
}

fn fold(spec: &FieldSpec, values: BTreeSet<u32>) -> Vec<u32> {
    values
        .into_iter()
        .map(|value| {
            if spec.canonical_max != spec.max && value == spec.max {
                spec.min
            } else {
                value
            }
        })
        .collect::<BTreeSet<u32>>()
        .into_iter()
        .collect()
}

/// The shortest list spelling of an ascending value set, never `*`-led.
fn encode_field(values: &[u32]) -> Result<String, ScheduleLogError> {
    let first = *values
        .first()
        .ok_or_else(|| ScheduleLogError::new("cron field encoding requires a non-empty value set"))?;
    if values.len() == 1 {
        return Ok(first.to_string());
    }
    let last = values[values.len() - 1];
    let step = values[1] - first;
    let uniform = values.windows(2).all(|pair| pair[1] - pair[0] == step);
    if uniform {
        return Ok(if step == 1 {
            format!("{first}-{last}")
        } else {
            format!("{first}-{last}/{step}")
        });
    }
    let mut parts: Vec<String> = Vec::new();
    let mut run_start = first;
    for pair in values.windows(2) {
        let (previous, current) = (pair[0], pair[1]);
        if current == previous + 1 {
            continue;
        }
        parts.push(if run_start == previous {
            run_start.to_string()
        } else {
            format!("{run_start}-{previous}")
        });
        run_start = current;
    }
    parts.push(if run_start == last {
        run_start.to_string()
    } else {
        format!("{run_start}-{last}")
    });
    Ok(parts.join(","))
}

/// The values one `*/step` walk produces, folded the way a parsed field folds.
fn star_walk(spec: &FieldSpec, step: u32) -> Vec<u32> {
    let mut walked = BTreeSet::new();
    walk(&mut walked, spec.min, spec.max, u64::from(step));
    fold(spec, walked)
}

/// The canonical `*`-led spelling: a bare `*`, or the widest star-step walk plus the remaining values.
fn encode_star_field(values: &[u32], spec: &FieldSpec) -> Result<String, ScheduleInputError> {
    if values.len() as u32 == spec.canonical_max - spec.min + 1 {
        return Ok("*".to_owned());
    }
    let present: BTreeSet<u32> = values.iter().copied().collect();
    let mut best: Option<(u32, Vec<u32>)> = None;
    for step in 1..=(spec.max - spec.min + 1) {
        let walk = star_walk(spec, step);
        let longer = best.as_ref().is_none_or(|(_, current)| walk.len() > current.len());
        if longer && walk.iter().all(|value| present.contains(value)) {
            best = Some((step, walk));
        }
    }
    let Some((step, walk)) = best else {
        return Err(ScheduleInputError::rule(format!(
            "{} cannot keep a leading `*`.",
            spec.name
        )));
    };
    let walked: BTreeSet<u32> = walk.into_iter().collect();
    let remaining: Vec<u32> = values
        .iter()
        .copied()
        .filter(|value| !walked.contains(value))
        .collect();
    if remaining.is_empty() {
        return Ok(format!("*/{step}"));
    }
    let rest = encode_field(&remaining).map_err(|error| ScheduleInputError::rule(error.message))?;
    Ok(format!("*/{step},{rest}"))
}

fn parse_field(raw: &str, spec: &FieldSpec) -> Result<Field, ScheduleInputError> {
    let values = field_values(raw, spec)?;
    let star = raw.starts_with('*');
    let canonical = if star {
        encode_star_field(&values, spec)?
    } else {
        encode_field(&values).map_err(|error| ScheduleInputError::rule(error.message))?
    };
    Ok(Field {
        values,
        canonical,
        star,
    })
}

/// Parse and canonicalize one strict five-field cron expression, with DSH's exact diagnostics.
pub fn parse_cron_expression(expression: &str) -> Result<ParsedCron, ScheduleInputError> {
    if expression.is_empty() || js::trim(expression) != expression {
        return Err(ScheduleInputError::rule(
            "cron.expression must be a non-empty trimmed string.",
        ));
    }
    let fields = js::split_whitespace(expression);
    if fields.len() != 5 {
        return Err(ScheduleInputError::rule(
            "cron.expression must contain exactly five whitespace-separated fields: minute hour day-of-month month day-of-week.",
        ));
    }
    let mut parsed: Vec<Field> = Vec::with_capacity(5);
    for (field, spec) in fields.iter().zip(FIELDS.iter()) {
        parsed.push(parse_field(field, spec)?);
    }
    let expression = parsed
        .iter()
        .map(|field| field.canonical.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let mut fields = parsed.into_iter();
    let mut next = || fields.next().expect("five fields were parsed");
    let (minute, hour, day_of_month, month, day_of_week) = (next(), next(), next(), next(), next());
    Ok(ParsedCron {
        expression,
        minutes: minute.values,
        hours: hour.values,
        days_of_month: day_of_month.values,
        months: month.values,
        days_of_week: day_of_week.values,
        day_of_month_star: day_of_month.star,
        day_of_week_star: day_of_week.star,
    })
}

/// [`parse_cron_expression`] over a JSON value: anything but a string is the non-empty-trimmed-string refusal.
pub fn parse_cron_value(expression: &serde_json::Value) -> Result<ParsedCron, ScheduleInputError> {
    match expression.as_str() {
        Some(text) => parse_cron_expression(text),
        None => Err(ScheduleInputError::rule(
            "cron.expression must be a non-empty trimmed string.",
        )),
    }
}

/// The canonical spelling of one strict five-field expression.
pub fn canonicalize_cron_expression(expression: &str) -> Result<String, ScheduleInputError> {
    parse_cron_expression(expression).map(|parsed| parsed.expression)
}

impl ParsedCron {
    /// The local-date predicate under the Vixie day rule (SVC:718-732): both day fields restricted combine with
    /// OR; otherwise AND, where a bare `*` matches every value.
    pub fn date_matches(&self, date: PlainDate) -> bool {
        if !self.months.contains(&date.month) {
            return false;
        }
        let day_of_month = self.days_of_month.contains(&date.day);
        let day_of_week = self.days_of_week.contains(&(iso_day_of_week(date) % 7));
        if !self.day_of_month_star && !self.day_of_week_star {
            day_of_month || day_of_week
        } else {
            day_of_month && day_of_week
        }
    }

    /// The rule's local times of day, ascending (hours outer, minutes inner).
    pub fn times(&self) -> Vec<PlainTime> {
        self.hours
            .iter()
            .flat_map(|hour| {
                self.minutes
                    .iter()
                    .map(move |minute| PlainTime::new(*hour, *minute, 0, 0))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn refuses(expression: serde_json::Value, message: &str) {
        let error = parse_cron_value(&expression).expect_err(&expression.to_string());
        assert_eq!(error.code, crate::errors::ScheduleErrorCode::InvalidRule);
        assert_eq!(error.message, message, "{expression}");
    }

    #[test]
    fn the_expression_must_be_a_trimmed_non_empty_string_of_exactly_five_fields() {
        refuses(json!(""), "cron.expression must be a non-empty trimmed string.");
        refuses(json!(" * * * * *"), "cron.expression must be a non-empty trimmed string.");
        refuses(json!(5), "cron.expression must be a non-empty trimmed string.");
        let five = "cron.expression must contain exactly five whitespace-separated fields: minute hour day-of-month month day-of-week.";
        refuses(json!("* * * *"), five);
        refuses(json!("0 * * * * *"), five);
    }

    #[test]
    fn each_field_element_error_names_the_field_and_the_element() {
        refuses(json!("MON * * * *"), "cron.expression minute field element \"MON\" must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.");
        refuses(json!("* L * * *"), "cron.expression hour field element \"L\" must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.");
        refuses(json!("* * * * 5/2"), "cron.expression day-of-week field element \"5/2\" must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.");
        refuses(json!("*/x * * * *"), "cron.expression minute field element \"*/x\" must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.");
        refuses(json!("60 * * * *"), "cron.expression minute field value 60 is outside 0-59.");
        refuses(json!("* 24 * * *"), "cron.expression hour field value 24 is outside 0-23.");
        refuses(json!("* * 0 * *"), "cron.expression day-of-month field value 0 is outside 1-31.");
        refuses(json!("* * * 13 *"), "cron.expression month field value 13 is outside 1-12.");
        refuses(json!("* * * * 8"), "cron.expression day-of-week field value 8 is outside 0-7.");
        refuses(json!("*/0 * * * *"), "cron.expression minute field step must be a positive integer.");
        refuses(json!("1-5/0 * * * *"), "cron.expression minute field step must be a positive integer.");
        refuses(json!("5-1 * * * *"), "cron.expression minute field range 5-1 is inverted.");
        refuses(json!("1,,2 * * * *"), "cron.expression minute field must not contain an empty list element.");
    }

    #[test]
    fn canonicalization_dedupes_merges_folds_sunday_and_keeps_star_led_fields_star_led() {
        let cases = [
            ("*/15 9-17 * * 1-5", "*/15 9-17 * * 1-5"),
            ("0,15,30,45 * * * *", "0-45/15 * * * *"),
            ("5,10,15,20 * * * *", "5-20/5 * * * *"),
            ("1,2,3,5 * * * *", "1-3,5 * * * *"),
            ("3,1,2,2 * * * *", "1-3 * * * *"),
            ("0-59/1 * * * *", "0-59 * * * *"),
            ("* * * * 7", "* * * * 0"),
            ("* * * * 0,7", "* * * * 0"),
            ("* * * * 0-7", "* * * * 0-6"),
            ("* * * * */1", "* * * * *"),
            ("*/1 * * * *", "* * * * *"),
            ("*/2,1 * * * *", "*/2,1 * * * *"),
            ("*/30,15,45 * * * *", "*/15 * * * *"),
            ("*/30,15 * * * *", "*/30,15 * * * *"),
            ("0 0 1-31 * *", "0 0 1-31 * *"),
            ("007 * * * *", "7 * * * *"),
            ("0  9   * * 1", "0 9 * * 1"),
        ];
        for (input, canonical) in cases {
            assert_eq!(canonicalize_cron_expression(input).unwrap(), canonical, "{input}");
            assert_eq!(canonicalize_cron_expression(canonical).unwrap(), canonical, "{canonical} is a fixed point");
        }
    }

    #[test]
    fn parsing_exposes_matched_values_and_the_two_day_field_star_flags() {
        let parsed = parse_cron_expression("*/20 9 1,15 * */2").unwrap();
        assert_eq!(parsed.minutes, [0, 20, 40]);
        assert_eq!(parsed.hours, [9]);
        assert_eq!(parsed.days_of_month, [1, 15]);
        assert_eq!(parsed.months.len(), 12);
        assert_eq!(parsed.days_of_week, [0, 2, 4, 6]);
        assert!(!parsed.day_of_month_star);
        assert!(parsed.day_of_week_star);
        assert_eq!(
            parse_cron_expression("0,30 9-10 * * *").unwrap().times(),
            [
                PlainTime::new(9, 0, 0, 0),
                PlainTime::new(9, 30, 0, 0),
                PlainTime::new(10, 0, 0, 0),
                PlainTime::new(10, 30, 0, 0),
            ]
        );
    }

    #[test]
    fn the_vixie_day_rule_both_restricted_is_or_a_star_on_either_side_is_and() {
        let first_of_month = PlainDate::new(2026, 10, 1);
        let monday = PlainDate::new(2026, 10, 26);
        let other_day = PlainDate::new(2026, 10, 28);
        let either = parse_cron_expression("0 9 1 * 1").unwrap();
        assert!(either.date_matches(first_of_month), "day 1 matches although it is not a Monday");
        assert!(either.date_matches(monday), "a Monday matches although it is not day 1");
        assert!(!either.date_matches(other_day));
        let mondays = parse_cron_expression("0 9 * * 1").unwrap();
        assert!(!mondays.date_matches(first_of_month), "a bare star degrades the AND to the other field");
        assert!(mondays.date_matches(monday));
        let stepped = parse_cron_expression("0 9 */2 * 1").unwrap();
        assert!(!stepped.date_matches(monday), "a stepped star is a star: AND");
        assert!(stepped.date_matches(PlainDate::new(2026, 10, 5)), "day 5 is odd and a Monday");
        let months = parse_cron_expression("0 9 1 3 1").unwrap();
        assert!(!months.date_matches(first_of_month), "the month must match first");
        let sunday = parse_cron_expression("0 9 * * 7").unwrap();
        assert!(sunday.date_matches(PlainDate::new(2026, 11, 1)), "7 means Sunday");
    }
}
