//! Schedule records and the rules that make them (`src/schedule/rules.ts`): selector validation, record
//! construction, the next target, the latest missed occurrence, the in-place update and the strict decoder.
//!
//! Every function is a port of DSH's `dsh-schedule` domain (SVC:18-1385, 1692-1837) and keeps its messages
//! character for character. All are pure: the caller supplies `now`.
//!
//! The record is the durable unit: `{id, kind, title, prompt, <kind fields>, scheduledAt}` in that key order, which
//! is also the order a view's JSON carries. `scheduledAt` is the **committed** target; only a delivery or a timing
//! update moves it.

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use crate::cron::{ParsedCron, canonicalize_cron_expression, parse_cron_expression, parse_cron_value};
use crate::errors::{ScheduleError, ScheduleErrorCode, ScheduleInputError, ScheduleLogError};
use crate::js;
use crate::time::{
    MAX_FOUR_DIGIT_YEAR_MS, MIN_FOUR_DIGIT_YEAR_MS, PlainDate, PlainTime, add_days, add_years,
    canonicalize_time_zone, first_of_next_month, format_instant, is_real_date, is_utc_instant,
    iso_day_of_week, last_of_previous_month, local_date, local_instant, local_time,
    parse_instant, wall_ms,
};

/// Fixed lower bound of a fixed-rate reminder, in seconds.
pub const MIN_EVERY_INTERVAL_SECONDS: i64 = 60;

/// Fixed upper bound of a stored title, in UTF-16 units.
pub const MAX_TITLE_LENGTH: usize = 120;

/// The diagnostic for a title that is missing or blank after trimming.
pub const REQUIRED_TITLE_MESSAGE: &str = "title is required and must be non-empty after trimming.";

const PROMPT_MESSAGE: &str = "prompt must be non-empty after trimming.";

/// What a record does when it comes due, with the fields of its kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScheduleRule {
    /// A one-shot a fixed delay after its creation.
    After {
        /// The delay, in seconds.
        after_seconds: i64,
    },
    /// A one-shot at an absolute instant.
    At,
    /// A fixed-rate reminder, anchored to its creation (or its last interval change).
    Every {
        /// The interval, in seconds.
        every_seconds: i64,
    },
    /// Every day at one local time in one zone.
    Daily {
        /// `HH:mm:ss.SSS`.
        time: String,
        /// The zone.
        time_zone: String,
    },
    /// On chosen ISO weekdays at one local time in one zone.
    Weekly {
        /// `HH:mm:ss.SSS`.
        time: String,
        /// The zone.
        time_zone: String,
        /// ISO weekdays, ascending, unique.
        weekdays: Vec<i64>,
    },
    /// On a five-field cron expression in one zone.
    Cron {
        /// The canonical expression.
        expression: String,
        /// The zone.
        time_zone: String,
    },
}

/// One reminder record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduleRecord {
    /// `schedule-<uuid>`.
    pub id: String,
    /// The trimmed title.
    pub title: String,
    /// The trimmed prompt.
    pub prompt: String,
    /// The kind and its fields.
    pub rule: ScheduleRule,
    /// The committed target, canonical UTC.
    pub scheduled_at: String,
}

impl ScheduleRecord {
    /// `after`, `at`, `every`, `daily`, `weekly` or `cron`.
    pub fn kind(&self) -> &'static str {
        match self.rule {
            ScheduleRule::After { .. } => "after",
            ScheduleRule::At => "at",
            ScheduleRule::Every { .. } => "every",
            ScheduleRule::Daily { .. } => "daily",
            ScheduleRule::Weekly { .. } => "weekly",
            ScheduleRule::Cron { .. } => "cron",
        }
    }

    /// Whether it recurs (every, daily, weekly, cron) rather than firing once (after, at).
    pub fn is_recurring(&self) -> bool {
        !matches!(self.rule, ScheduleRule::After { .. } | ScheduleRule::At)
    }

    /// The committed target in epoch milliseconds.
    pub fn scheduled_ms(&self) -> i64 {
        parse_instant(&self.scheduled_at).unwrap_or(i64::MAX)
    }

    /// The record as a JSON object, in DSH key order.
    pub fn to_map(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("id".into(), Value::from(self.id.clone()));
        map.insert("kind".into(), Value::from(self.kind()));
        map.insert("title".into(), Value::from(self.title.clone()));
        map.insert("prompt".into(), Value::from(self.prompt.clone()));
        match &self.rule {
            ScheduleRule::After { after_seconds } => {
                map.insert("afterSeconds".into(), Value::from(*after_seconds));
            }
            ScheduleRule::At => {}
            ScheduleRule::Every { every_seconds } => {
                map.insert("everySeconds".into(), Value::from(*every_seconds));
            }
            ScheduleRule::Daily { time, time_zone } => {
                map.insert("time".into(), Value::from(time.clone()));
                map.insert("timeZone".into(), Value::from(time_zone.clone()));
            }
            ScheduleRule::Weekly {
                time,
                time_zone,
                weekdays,
            } => {
                map.insert("time".into(), Value::from(time.clone()));
                map.insert("timeZone".into(), Value::from(time_zone.clone()));
                map.insert("weekdays".into(), Value::from(weekdays.clone()));
            }
            ScheduleRule::Cron {
                expression,
                time_zone,
            } => {
                map.insert("expression".into(), Value::from(expression.clone()));
                map.insert("timeZone".into(), Value::from(time_zone.clone()));
            }
        }
        map.insert("scheduledAt".into(), Value::from(self.scheduled_at.clone()));
        map
    }

    /// The record as a JSON value.
    pub fn to_value(&self) -> Value {
        Value::Object(self.to_map())
    }
}

impl Serialize for ScheduleRecord {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_map().serialize(serializer)
    }
}

/// One recurring decision: the occurrence delivered now, and the next target when one is representable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Occurrence {
    /// The occurrence delivered.
    pub occurrence_at: String,
    /// The next target.
    pub next_scheduled_at: Option<String>,
}

impl Occurrence {
    fn new(occurrence_at: String, next_scheduled_at: Option<String>) -> Self {
        Self {
            occurrence_at,
            next_scheduled_at,
        }
    }
}

fn input(code: ScheduleErrorCode, message: impl Into<String>) -> ScheduleInputError {
    ScheduleInputError::new(code, message)
}

fn has_exact_keys(map: &Map<String, Value>, expected: &[&str]) -> bool {
    expected.iter().all(|key| map.contains_key(*key))
        && map.keys().all(|key| expected.contains(&key.as_str()))
}

fn has_keys_with_optional(map: &Map<String, Value>, required: &[&str], optional: &[&str]) -> bool {
    required.iter().all(|key| map.contains_key(*key))
        && map
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

// -----------------------------------------------------------------------------------------------------------------
// Title, prompt and instants
// -----------------------------------------------------------------------------------------------------------------

/// Validate a supplied title: required, trimmed, at most 120 characters. Returns the trimmed title.
pub fn schedule_title(title: &Value) -> Result<String, ScheduleInputError> {
    let Some(text) = title.as_str().filter(|text| !js::trim(text).is_empty()) else {
        return Err(input(ScheduleErrorCode::InvalidPrompt, REQUIRED_TITLE_MESSAGE));
    };
    let normalized = js::trim(text);
    if js::utf16_len(normalized) > MAX_TITLE_LENGTH {
        return Err(input(
            ScheduleErrorCode::InvalidPrompt,
            format!("title must be at most {MAX_TITLE_LENGTH} characters."),
        ));
    }
    Ok(normalized.to_owned())
}

/// Validate a replacement prompt: a string, non-empty after trimming. Returns the trimmed prompt.
pub fn schedule_prompt(prompt: &Value) -> Result<String, ScheduleInputError> {
    match prompt.as_str().map(js::trim) {
        Some(trimmed) if !trimmed.is_empty() => Ok(trimmed.to_owned()),
        _ => Err(input(ScheduleErrorCode::InvalidPrompt, PROMPT_MESSAGE)),
    }
}

fn decode_stored_title(value: Option<&Value>) -> Result<String, ScheduleLogError> {
    let Some(text) = value
        .and_then(Value::as_str)
        .filter(|text| !js::trim(text).is_empty())
    else {
        return Err(ScheduleLogError::new(REQUIRED_TITLE_MESSAGE));
    };
    if js::utf16_len(text) > MAX_TITLE_LENGTH {
        return Err(ScheduleLogError::new(format!(
            "title must be at most {MAX_TITLE_LENGTH} characters"
        )));
    }
    if js::trim(text) != text {
        return Err(ScheduleLogError::new("title must be a trimmed string"));
    }
    Ok(text.to_owned())
}

fn decode_id(value: Option<&Value>) -> Result<String, ScheduleLogError> {
    match value.and_then(Value::as_str) {
        Some(text) if !text.is_empty() && js::trim(text) == text => Ok(text.to_owned()),
        _ => Err(ScheduleLogError::new(
            "schedule id must be a non-empty string without surrounding whitespace",
        )),
    }
}

/// Validate one canonical four-digit-year UTC instant.
pub fn decode_instant(value: Option<&Value>) -> Result<String, ScheduleLogError> {
    let Some(text) = value.and_then(Value::as_str).filter(|text| is_utc_instant(text)) else {
        return Err(ScheduleLogError::new(
            "scheduledAt must be a canonical four-digit-year RFC 3339 UTC instant",
        ));
    };
    match parse_instant(text) {
        Some(epoch) if format_instant(epoch) == text => Ok(text.to_owned()),
        _ => Err(ScheduleLogError::new(
            "scheduledAt is not a real UTC calendar instant",
        )),
    }
}

/// Require a safe, representable, strictly future target, and spell it canonically (SVC:178-185).
pub fn future_instant(epoch: i64, now: i64) -> Result<String, ScheduleInputError> {
    if !js::is_safe(now)
        || !js::is_safe(epoch)
        || !(MIN_FOUR_DIGIT_YEAR_MS..=MAX_FOUR_DIGIT_YEAR_MS).contains(&epoch)
    {
        return Err(input(
            ScheduleErrorCode::TimeOutOfRange,
            "The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.",
        ));
    }
    if epoch <= now {
        return Err(input(
            ScheduleErrorCode::NotFuture,
            "The scheduled time must be strictly in the future.",
        ));
    }
    Ok(format_instant(epoch))
}

const CALENDAR_MESSAGE: &str = "The at value must be a real ISO calendar date and time.";

struct CalendarParts {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millisecond: i64,
}

impl CalendarParts {
    fn date(&self) -> PlainDate {
        PlainDate::new(self.year, self.month as u32, self.day as u32)
    }

    fn time(&self) -> PlainTime {
        PlainTime::new(
            self.hour as u32,
            self.minute as u32,
            self.second as u32,
            self.millisecond as u32,
        )
    }
}

/// Exact calendar fields as an as-if-UTC epoch, refusing any value a calendar would have to normalize.
fn calendar_epoch(parts: &CalendarParts) -> Result<i64, ScheduleInputError> {
    if !is_real_date(parts.year, parts.month, parts.day) {
        return Err(ScheduleInputError::rule(CALENDAR_MESSAGE));
    }
    Ok(wall_ms(parts.date(), parts.time()))
}

fn two(bytes: &[u8], at: usize) -> Option<i64> {
    let pair = bytes.get(at..at + 2)?;
    pair.iter()
        .all(u8::is_ascii_digit)
        .then(|| i64::from(pair[0] - b'0') * 10 + i64::from(pair[1] - b'0'))
}

fn four(bytes: &[u8], at: usize) -> Option<i64> {
    Some(two(bytes, at)? * 100 + two(bytes, at + 2)?)
}

/// `Number(fraction.padEnd(3, '0'))` for a 1-3 digit fraction.
fn milliseconds(fraction: &[u8]) -> i64 {
    let mut value = 0;
    for index in 0..3 {
        value = value * 10 + fraction.get(index).map_or(0, |byte| i64::from(byte - b'0'));
    }
    value
}

/// An optional `.f{1,3}` at `at`: its digits and the index after it, or `None` when the shape is wrong.
fn fraction(bytes: &[u8], at: usize) -> Option<(&[u8], usize)> {
    if bytes.get(at) != Some(&b'.') {
        return Some((&[], at));
    }
    let start = at + 1;
    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    let count = end - start;
    (1..=3).contains(&count).then(|| (&bytes[start..end], end))
}

/// Parse a strict RFC 3339 instant whose `Z` or numeric offset is part of the input (SVC:187-206).
fn parse_offset_instant(value: &str) -> Result<i64, ScheduleInputError> {
    let shape = || {
        ScheduleInputError::rule(
            "at must use YYYY-MM-DDTHH:mm:ss with optional 1-3 digit fractional seconds and an explicit Z or numeric offset.",
        )
    };
    let b = value.as_bytes();
    let separators = b.len() >= 20
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':';
    if !separators {
        return Err(shape());
    }
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        four(b, 0),
        two(b, 5),
        two(b, 8),
        two(b, 11),
        two(b, 14),
        two(b, 17),
    ) else {
        return Err(shape());
    };
    let (fraction_digits, at) = fraction(b, 19).ok_or_else(shape)?;
    let zone = &b[at..];
    let offset = match zone {
        [b'Z'] => None,
        [sign @ (b'+' | b'-'), _, _, b':', _, _] => {
            let (Some(hours), Some(minutes)) = (two(zone, 1), two(zone, 4)) else {
                return Err(shape());
            };
            Some((*sign, hours, minutes))
        }
        _ => return Err(shape()),
    };
    let parts = CalendarParts {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond: milliseconds(fraction_digits),
    };
    if parts.year == 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59 {
        return Err(ScheduleInputError::rule(CALENDAR_MESSAGE));
    }
    let local = calendar_epoch(&parts)?;
    let Some((sign, hours, minutes)) = offset else {
        return Ok(local);
    };
    if hours > 23 || minutes > 59 || (sign == b'-' && hours == 0 && minutes == 0) {
        return Err(ScheduleInputError::rule("The at numeric offset is invalid."));
    }
    let direction = if sign == b'+' { 1 } else { -1 };
    Ok(local - direction * (hours * 60 + minutes) * 60_000)
}

/// Parse strict local calendar fields without consulting any zone (SVC:225-243).
fn parse_local_at(date: &str, time: &str) -> Result<(PlainDate, PlainTime), ScheduleInputError> {
    let shape = || {
        ScheduleInputError::rule(
            "Local at requires date YYYY-MM-DD and time HH:mm:ss with optional one-to-three digit milliseconds.",
        )
    };
    let d = date.as_bytes();
    let t = time.as_bytes();
    if d.len() != 10 || d[4] != b'-' || d[7] != b'-' {
        return Err(shape());
    }
    let (Some(year), Some(month), Some(day)) = (four(d, 0), two(d, 5), two(d, 8)) else {
        return Err(shape());
    };
    if t.len() < 8 || t[2] != b':' || t[5] != b':' {
        return Err(shape());
    }
    let (Some(hour), Some(minute), Some(second)) = (two(t, 0), two(t, 3), two(t, 6)) else {
        return Err(shape());
    };
    let (fraction_digits, end) = fraction(t, 8).ok_or_else(shape)?;
    if end != t.len() {
        return Err(shape());
    }
    let parts = CalendarParts {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond: milliseconds(fraction_digits),
    };
    if parts.year == 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59 {
        return Err(ScheduleInputError::rule(
            "The local at value must be a real ISO calendar date and time.",
        ));
    }
    calendar_epoch(&parts)?;
    Ok((parts.date(), parts.time()))
}

fn time_zone_string(value: Option<&Value>) -> Result<&str, ScheduleInputError> {
    value
        .and_then(Value::as_str)
        .ok_or_else(|| input(ScheduleErrorCode::InvalidTimeZone, "time_zone must be a string."))
}

/// Parse an absolute selector without requiring it to be future (SVC:977-996): a string carries its own offset;
/// an object is a local date and time in a named zone, where a gap is refused and an overlap takes the earlier
/// instant.
pub fn parse_at_input(at: &Value) -> Result<i64, ScheduleInputError> {
    if let Some(text) = at.as_str() {
        return parse_offset_instant(text);
    }
    let Some(map) = at.as_object() else {
        return Err(ScheduleInputError::rule(
            "at must be an explicit-offset string or local calendar object.",
        ));
    };
    if !has_exact_keys(map, &["date", "time", "time_zone"]) {
        return Err(ScheduleInputError::rule(
            "Local at must contain exactly date, time, and time_zone.",
        ));
    }
    let (Some(date), Some(time)) = (
        map.get("date").and_then(Value::as_str),
        map.get("time").and_then(Value::as_str),
    ) else {
        return Err(ScheduleInputError::rule(
            "Local at date and time must be strings.",
        ));
    };
    let raw_zone = time_zone_string(map.get("time_zone"))?;
    let (date, time) = parse_local_at(date, time)?;
    local_instant(date, time, &canonicalize_time_zone(raw_zone)?).ok_or_else(|| {
        ScheduleInputError::rule("The local at time does not exist in the selected time zone.")
    })
}

// -----------------------------------------------------------------------------------------------------------------
// Wall-clock selectors
// -----------------------------------------------------------------------------------------------------------------

/// `HH:mm:ss.SSS`, the stored spelling of a wall-clock selector's time.
pub fn format_plain_time(time: PlainTime) -> String {
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        time.hour, time.minute, time.second, time.millisecond
    )
}

/// Parse the strict local clock time shared by daily and weekly (SVC:333-336).
fn local_clock_time(value: &str, selector: &str) -> Result<PlainTime, ScheduleInputError> {
    let refusal = || {
        ScheduleInputError::rule(format!(
            "{selector}.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00."
        ))
    };
    let b = value.as_bytes();
    if b.len() < 8 || b[2] != b':' || b[5] != b':' {
        return Err(refusal());
    }
    let (Some(hour), Some(minute), Some(second)) = (two(b, 0), two(b, 3), two(b, 6)) else {
        return Err(refusal());
    };
    if hour > 23 || minute > 59 || second > 59 {
        return Err(refusal());
    }
    let (fraction_digits, end) = fraction(b, 8).ok_or_else(refusal)?;
    if end != b.len() {
        return Err(refusal());
    }
    Ok(PlainTime::new(
        hour as u32,
        minute as u32,
        second as u32,
        milliseconds(fraction_digits) as u32,
    ))
}

/// Normalize the ISO weekday set of a weekly rule: non-empty, unique, 1-7, returned ascending (SVC:394-405).
pub fn normalize_weekdays(weekdays: &Value) -> Result<Vec<i64>, ScheduleInputError> {
    let Some(entries) = weekdays.as_array().filter(|entries| !entries.is_empty()) else {
        return Err(ScheduleInputError::rule(
            "weekly.weekdays must be a non-empty array of ISO weekday numbers.",
        ));
    };
    let mut unique: Vec<i64> = Vec::new();
    for entry in entries {
        let weekday = match js::safe_integer(entry) {
            Some(weekday) if js::is_integer(entry) && (1..=7).contains(&weekday) => weekday,
            _ => {
                return Err(ScheduleInputError::rule(
                    "Each weekly.weekdays entry must be an integer from 1 (Monday) through 7 (Sunday).",
                ));
            }
        };
        if unique.contains(&weekday) {
            return Err(ScheduleInputError::rule(format!(
                "weekly.weekdays must not repeat weekday {weekday}."
            )));
        }
        unique.push(weekday);
    }
    unique.sort_unstable();
    Ok(unique)
}

/// Normalize a daily selector without computing a target: the stored time and the canonical zone.
pub fn parse_daily_input(daily: &Value) -> Result<(String, String), ScheduleInputError> {
    let shape = || {
        ScheduleInputError::rule(
            "daily must contain exactly time and time_zone, with time HH:mm:ss and optional 1-3 fractional digits.",
        )
    };
    let map = daily
        .as_object()
        .filter(|map| has_exact_keys(map, &["time", "time_zone"]))
        .ok_or_else(shape)?;
    let time = map.get("time").and_then(Value::as_str).ok_or_else(shape)?;
    let zone = time_zone_string(map.get("time_zone"))?;
    let time = format_plain_time(local_clock_time(time, "daily")?);
    Ok((time, canonicalize_time_zone(zone)?))
}

/// Normalize a weekly selector without computing a target: the stored time, the canonical zone, the weekdays.
pub fn parse_weekly_input(weekly: &Value) -> Result<(String, String, Vec<i64>), ScheduleInputError> {
    let shape = || {
        ScheduleInputError::rule(
            "weekly must contain exactly time, time_zone, and weekdays, with time HH:mm:ss and optional 1-3 fractional digits.",
        )
    };
    let map = weekly
        .as_object()
        .filter(|map| has_exact_keys(map, &["time", "time_zone", "weekdays"]))
        .ok_or_else(shape)?;
    let time = map.get("time").and_then(Value::as_str).ok_or_else(shape)?;
    let zone = time_zone_string(map.get("time_zone"))?;
    let time = format_plain_time(local_clock_time(time, "weekly")?);
    let zone = canonicalize_time_zone(zone)?;
    let weekdays = normalize_weekdays(map.get("weekdays").unwrap_or(&Value::Null))?;
    Ok((time, zone, weekdays))
}

/// Normalize a cron selector without computing a target: the canonical expression and zone.
pub fn parse_cron_input(cron: &Value) -> Result<(String, String), ScheduleInputError> {
    let shape = || {
        ScheduleInputError::rule(
            "cron must contain exactly expression and time_zone, with a five-field cron expression.",
        )
    };
    let map = cron
        .as_object()
        .filter(|map| has_exact_keys(map, &["expression", "time_zone"]))
        .ok_or_else(shape)?;
    let expression = map.get("expression").filter(|value| value.is_string()).ok_or_else(shape)?;
    let zone = time_zone_string(map.get("time_zone"))?;
    let expression = parse_cron_value(expression)?.expression;
    Ok((expression, canonicalize_time_zone(zone)?))
}

fn parse_plain_time(stored: &str) -> PlainTime {
    local_clock_time(stored, "daily").unwrap_or(PlainTime::new(0, 0, 0, 0))
}

// -----------------------------------------------------------------------------------------------------------------
// Record construction
// -----------------------------------------------------------------------------------------------------------------

fn normalized_prompt_of(prompt: &Value) -> Result<String, ScheduleInputError> {
    schedule_prompt(prompt)
}

fn require_creation_time(now: i64, label: &str) -> Result<(), ScheduleInputError> {
    if !js::is_safe(now) || !(MIN_FOUR_DIGIT_YEAR_MS..=MAX_FOUR_DIGIT_YEAR_MS).contains(&now) {
        return Err(input(
            ScheduleErrorCode::TimeOutOfRange,
            format!("{label} creation time must be a representable four-digit-year UTC instant."),
        ));
    }
    Ok(())
}

fn record(id: &str, title: String, prompt: String, rule: ScheduleRule, scheduled_at: String) -> ScheduleRecord {
    ScheduleRecord {
        id: id.to_owned(),
        title,
        prompt,
        rule,
        scheduled_at,
    }
}

/// An `after_seconds` reminder: target = now + seconds (SVC:938-951).
pub fn create_after_schedule_record(
    id: &str,
    prompt: &Value,
    after_seconds: &Value,
    now: i64,
    title: &Value,
) -> Result<ScheduleRecord, ScheduleInputError> {
    let prompt = normalized_prompt_of(prompt)?;
    let Some(seconds) = js::safe_integer(after_seconds).filter(|seconds| *seconds > 0) else {
        return Err(ScheduleInputError::rule(
            "after_seconds must be a positive safe integer.",
        ));
    };
    let target = now.saturating_add(seconds.saturating_mul(1000));
    let title = schedule_title(title)?;
    let scheduled_at = future_instant(target, now)?;
    Ok(record(
        id,
        title,
        prompt,
        ScheduleRule::After {
            after_seconds: seconds,
        },
        scheduled_at,
    ))
}

/// An absolute reminder: the selector's instant, which must be strictly future (SVC:961-971).
pub fn create_at_schedule_record(
    id: &str,
    prompt: &Value,
    at: &Value,
    now: i64,
    title: &Value,
) -> Result<ScheduleRecord, ScheduleInputError> {
    let prompt = normalized_prompt_of(prompt)?;
    let title = schedule_title(title)?;
    let scheduled_at = future_instant(parse_at_input(at)?, now)?;
    Ok(record(id, title, prompt, ScheduleRule::At, scheduled_at))
}

fn every_interval(every_seconds: &Value) -> Result<i64, ScheduleInputError> {
    let Some(seconds) = js::safe_integer(every_seconds) else {
        return Err(ScheduleInputError::rule("every_seconds must be a safe integer."));
    };
    if seconds < MIN_EVERY_INTERVAL_SECONDS {
        return Err(input(
            ScheduleErrorCode::FrequencyTooHigh,
            format!("every_seconds must be at least {MIN_EVERY_INTERVAL_SECONDS}."),
        ));
    }
    Ok(seconds)
}

/// A fixed-rate reminder: first target = now + interval, anchoring every later occurrence (SVC:1006-1020).
pub fn create_every_schedule_record(
    id: &str,
    prompt: &Value,
    every_seconds: &Value,
    now: i64,
    title: &Value,
) -> Result<ScheduleRecord, ScheduleInputError> {
    let prompt = normalized_prompt_of(prompt)?;
    let seconds = every_interval(every_seconds)?;
    let target = now.saturating_add(seconds.saturating_mul(1000));
    let title = schedule_title(title)?;
    let scheduled_at = future_instant(target, now)?;
    Ok(record(
        id,
        title,
        prompt,
        ScheduleRule::Every {
            every_seconds: seconds,
        },
        scheduled_at,
    ))
}

/// A daily reminder: the first actual local occurrence after now (SVC:1030-1046).
pub fn create_daily_schedule_record(
    id: &str,
    prompt: &Value,
    daily: &Value,
    now: i64,
    title: &Value,
) -> Result<ScheduleRecord, ScheduleInputError> {
    let prompt = normalized_prompt_of(prompt)?;
    let (time, time_zone) = parse_daily_input(daily)?;
    require_creation_time(now, "Daily")?;
    let scheduled_at = next_daily_target(parse_plain_time(&time), &time_zone, now, None).ok_or_else(|| {
        input(
            ScheduleErrorCode::TimeOutOfRange,
            "No future daily occurrence is representable as a four-digit-year UTC instant.",
        )
    })?;
    let title = schedule_title(title)?;
    Ok(record(
        id,
        title,
        prompt,
        ScheduleRule::Daily { time, time_zone },
        scheduled_at,
    ))
}

/// A weekly reminder: the first actual local occurrence on a chosen weekday after now (SVC:1069-1086).
pub fn create_weekly_schedule_record(
    id: &str,
    prompt: &Value,
    weekly: &Value,
    now: i64,
    title: &Value,
) -> Result<ScheduleRecord, ScheduleInputError> {
    let prompt = normalized_prompt_of(prompt)?;
    let (time, time_zone, weekdays) = parse_weekly_input(weekly)?;
    require_creation_time(now, "Weekly")?;
    let scheduled_at = next_weekly_target(parse_plain_time(&time), &time_zone, &weekdays, now, None)
        .ok_or_else(|| {
            input(
                ScheduleErrorCode::TimeOutOfRange,
                "No future weekly occurrence is representable as a four-digit-year UTC instant.",
            )
        })?;
    let title = schedule_title(title)?;
    Ok(record(
        id,
        title,
        prompt,
        ScheduleRule::Weekly {
            time,
            time_zone,
            weekdays,
        },
        scheduled_at,
    ))
}

/// A cron reminder: the first matching local occurrence after now (SVC:1096-1112).
pub fn create_cron_schedule_record(
    id: &str,
    prompt: &Value,
    cron: &Value,
    now: i64,
    title: &Value,
) -> Result<ScheduleRecord, ScheduleInputError> {
    let prompt = normalized_prompt_of(prompt)?;
    let (expression, time_zone) = parse_cron_input(cron)?;
    require_creation_time(now, "Cron")?;
    let parsed = parse_cron_expression(&expression)?;
    let scheduled_at = next_cron_target(&parsed, &time_zone, now).ok_or_else(|| {
        input(
            ScheduleErrorCode::TimeOutOfRange,
            "No future cron occurrence is representable as a four-digit-year UTC instant.",
        )
    })?;
    let title = schedule_title(title)?;
    Ok(record(
        id,
        title,
        prompt,
        ScheduleRule::Cron {
            expression,
            time_zone,
        },
        scheduled_at,
    ))
}

// -----------------------------------------------------------------------------------------------------------------
// Next targets and the latest missed occurrence
// -----------------------------------------------------------------------------------------------------------------

/// The local date after the last four-digit-year instant, where every forward walk stops.
fn walk_ceiling() -> PlainDate {
    add_days(local_date(MAX_FOUR_DIGIT_YEAR_MS, "UTC"), 1)
}

/// The first actual occurrence strictly after now — and, when `after_date` is given, on a later local date than
/// it (SVC:624-635). A gap date is **skipped**, never shifted; an overlap takes its earlier instant.
fn next_matching_target(
    time: PlainTime,
    time_zone: &str,
    now: i64,
    matches: &dyn Fn(PlainDate) -> bool,
    after_date: Option<PlainDate>,
) -> Option<String> {
    let mut date = local_date(now, time_zone);
    if let Some(after) = after_date
        && date <= after
    {
        date = add_days(after, 1);
    }
    let ceiling = walk_ceiling();
    while date <= ceiling {
        if matches(date)
            && let Some(target) = local_instant(date, time, time_zone)
        {
            if target > MAX_FOUR_DIGIT_YEAR_MS {
                return None;
            }
            if target >= MIN_FOUR_DIGIT_YEAR_MS && target > now {
                return Some(format_instant(target));
            }
        }
        date = add_days(date, 1);
    }
    None
}

/// The latest actual occurrence at or before the decision, never earlier than the committed target
/// (SVC:637-645). The walk starts the day after the decision's **UTC** date and goes back.
fn latest_due_occurrence(
    time_zone: &str,
    matches: &dyn Fn(PlainDate) -> bool,
    time: PlainTime,
    accepted_at: i64,
    saved_target: i64,
) -> i64 {
    let floor = add_days(local_date(MIN_FOUR_DIGIT_YEAR_MS, "UTC"), -1);
    let mut date = add_days(local_date(accepted_at, "UTC"), 1);
    while date >= floor {
        if matches(date)
            && let Some(candidate) = local_instant(date, time, time_zone)
            && candidate <= accepted_at
        {
            return candidate.max(saved_target);
        }
        date = add_days(date, -1);
    }
    saved_target
}

fn accepted_decision(selector: &str, accepted_at: i64) -> Result<i64, ScheduleLogError> {
    if !js::is_safe(accepted_at)
        || !(MIN_FOUR_DIGIT_YEAR_MS..=MAX_FOUR_DIGIT_YEAR_MS).contains(&accepted_at)
    {
        return Err(ScheduleLogError::new(format!(
            "{selector} acceptedAt must be a representable four-digit-year instant"
        )));
    }
    Ok(accepted_at)
}

/// The first actual daily occurrence after now (and after a delivered local date, when given).
pub fn next_daily_target(
    time: PlainTime,
    time_zone: &str,
    now: i64,
    after_date: Option<PlainDate>,
) -> Option<String> {
    next_matching_target(time, time_zone, now, &|_| true, after_date)
}

/// The first actual weekly occurrence after now (and after a delivered local date, when given).
pub fn next_weekly_target(
    time: PlainTime,
    time_zone: &str,
    weekdays: &[i64],
    now: i64,
    after_date: Option<PlainDate>,
) -> Option<String> {
    let matches = |date: PlainDate| weekdays.contains(&i64::from(iso_day_of_week(date)));
    next_matching_target(time, time_zone, now, &matches, after_date)
}

/// One fixed-rate decision (SVC:595-611): the anchor plus a whole number of intervals at or before the decision,
/// and the next target one interval later.
pub fn resolve_every_occurrence(
    record: &ScheduleRecord,
    every_seconds: i64,
    accepted_at: i64,
) -> Result<Occurrence, ScheduleLogError> {
    let target = record.scheduled_ms();
    let interval = every_seconds.checked_mul(1000);
    if !js::is_safe(accepted_at)
        || !(MIN_FOUR_DIGIT_YEAR_MS..=MAX_FOUR_DIGIT_YEAR_MS).contains(&accepted_at)
    {
        return Err(ScheduleLogError::new(
            "every acceptedAt must be a representable four-digit-year instant",
        ));
    }
    let Some(interval) = interval.filter(|interval| js::is_safe(*interval) && *interval > 0) else {
        return Err(ScheduleLogError::new(
            "every interval milliseconds must be a positive safe integer",
        ));
    };
    if accepted_at < target {
        return Err(ScheduleLogError::new(
            "every dispatch cannot precede the active scheduledAt",
        ));
    }
    let occurrence = target + (accepted_at - target).div_euclid(interval) * interval;
    let occurrence_at = format_instant(occurrence);
    let next = occurrence.checked_add(interval);
    match next {
        Some(next) if js::is_safe(next) && next <= MAX_FOUR_DIGIT_YEAR_MS => {
            Ok(Occurrence::new(occurrence_at, Some(format_instant(next))))
        }
        _ => Ok(Occurrence::new(occurrence_at, None)),
    }
}

/// One daily decision: the latest due occurrence, and the next one on a later local date (SVC:661-673).
pub fn resolve_daily_occurrence(
    record: &ScheduleRecord,
    time: &str,
    time_zone: &str,
    accepted_at: i64,
) -> Result<Occurrence, ScheduleError> {
    let decision = accepted_decision("daily", accepted_at)?;
    let saved = record.scheduled_ms();
    if decision < saved {
        return Err(ScheduleLogError::new("daily dispatch cannot precede the active scheduledAt").into());
    }
    let time = local_clock_time(time, "daily")?;
    let occurrence = latest_due_occurrence(time_zone, &|_| true, time, decision, saved);
    let next = next_daily_target(time, time_zone, decision, Some(local_date(occurrence, time_zone)));
    Ok(Occurrence::new(format_instant(occurrence), next))
}

/// One weekly decision: the latest due occurrence, and the next one on a later selected local date
/// (SVC:692-705).
pub fn resolve_weekly_occurrence(
    record: &ScheduleRecord,
    time: &str,
    time_zone: &str,
    weekdays: &[i64],
    accepted_at: i64,
) -> Result<Occurrence, ScheduleError> {
    let decision = accepted_decision("weekly", accepted_at)?;
    let saved = record.scheduled_ms();
    if decision < saved {
        return Err(ScheduleLogError::new("weekly dispatch cannot precede the active scheduledAt").into());
    }
    let time = local_clock_time(time, "weekly")?;
    let weekdays = normalize_weekdays(&Value::from(weekdays.to_vec()))?;
    let matches = |date: PlainDate| weekdays.contains(&i64::from(iso_day_of_week(date)));
    let occurrence = latest_due_occurrence(time_zone, &matches, time, decision, saved);
    let next = next_weekly_target(
        time,
        time_zone,
        &weekdays,
        decision,
        Some(local_date(occurrence, time_zone)),
    );
    Ok(Occurrence::new(format_instant(occurrence), next))
}

/// How far a cron walk searches before it calls a rule exhausted.
const CRON_SEARCH_HORIZON_YEARS: i64 = 400;

/// The first matching cron occurrence strictly after `floor` (SVC:753-777).
pub fn next_cron_target(parsed: &ParsedCron, time_zone: &str, floor: i64) -> Option<String> {
    let times = parsed.times();
    let first_date = local_date(floor, time_zone);
    let floor_time = local_time(floor, time_zone);
    let horizon = add_years(first_date, CRON_SEARCH_HORIZON_YEARS);
    let ceiling = walk_ceiling();
    let last_date = if horizon < ceiling { horizon } else { ceiling };
    let mut date = first_date;
    while date <= last_date {
        if !parsed.months.contains(&date.month) {
            date = first_of_next_month(date);
            continue;
        }
        if parsed.date_matches(date) {
            let on_first_date = date == first_date;
            for time in &times {
                if on_first_date && *time < floor_time {
                    continue;
                }
                let Some(target) = local_instant(date, *time, time_zone) else {
                    continue;
                };
                if target > MAX_FOUR_DIGIT_YEAR_MS {
                    return None;
                }
                if target >= MIN_FOUR_DIGIT_YEAR_MS && target > floor {
                    return Some(format_instant(target));
                }
            }
        }
        date = add_days(date, 1);
    }
    None
}

/// The latest matching cron occurrence at or before the decision, never earlier than the committed target
/// (SVC:791-819).
pub fn latest_cron_occurrence(parsed: &ParsedCron, time_zone: &str, decision: i64, saved_target: i64) -> i64 {
    let times = parsed.times();
    let mut date = add_days(local_date(decision, "UTC"), 1);
    let floor_date = local_date(MIN_FOUR_DIGIT_YEAR_MS, time_zone);
    let horizon = add_years(date, -CRON_SEARCH_HORIZON_YEARS);
    let first_date = if horizon > floor_date { horizon } else { floor_date };
    while date >= first_date {
        if !parsed.months.contains(&date.month) {
            date = last_of_previous_month(date);
            continue;
        }
        if parsed.date_matches(date) {
            let earliest = times
                .iter()
                .find_map(|time| local_instant(date, *time, time_zone));
            if earliest.is_some_and(|earliest| earliest > decision) {
                date = add_days(date, -1);
                continue;
            }
            for time in times.iter().rev() {
                let Some(candidate) = local_instant(date, *time, time_zone) else {
                    continue;
                };
                if candidate > decision || candidate < MIN_FOUR_DIGIT_YEAR_MS {
                    continue;
                }
                return candidate.max(saved_target);
            }
        }
        date = add_days(date, -1);
    }
    saved_target
}

/// One cron decision: the latest due occurrence, and the first match after the decision (SVC:826-838).
pub fn resolve_cron_occurrence(
    record: &ScheduleRecord,
    expression: &str,
    time_zone: &str,
    accepted_at: i64,
) -> Result<Occurrence, ScheduleError> {
    let decision = accepted_decision("cron", accepted_at)?;
    let saved = record.scheduled_ms();
    if decision < saved {
        return Err(ScheduleLogError::new("cron dispatch cannot precede the active scheduledAt").into());
    }
    let parsed = parse_cron_expression(expression)?;
    let occurrence = latest_cron_occurrence(&parsed, time_zone, decision, saved);
    let next = next_cron_target(&parsed, time_zone, decision);
    Ok(Occurrence::new(format_instant(occurrence), next))
}

/// One due recurring record's decision, by its own arithmetic; `None` for a one-shot.
pub fn resolve_recurring_occurrence(
    record: &ScheduleRecord,
    accepted_at: i64,
) -> Option<Result<Occurrence, ScheduleError>> {
    Some(match &record.rule {
        ScheduleRule::After { .. } | ScheduleRule::At => return None,
        ScheduleRule::Every { every_seconds } => {
            resolve_every_occurrence(record, *every_seconds, accepted_at).map_err(ScheduleError::from)
        }
        ScheduleRule::Daily { time, time_zone } => {
            resolve_daily_occurrence(record, time, time_zone, accepted_at)
        }
        ScheduleRule::Weekly {
            time,
            time_zone,
            weekdays,
        } => resolve_weekly_occurrence(record, time, time_zone, weekdays, accepted_at),
        ScheduleRule::Cron {
            expression,
            time_zone,
        } => resolve_cron_occurrence(record, expression, time_zone, accepted_at),
    })
}

/// A record as a reader sees it at one instant (SVC:1379-1385): the record, then `state` and `deliveryMode`.
pub fn schedule_view(record: &ScheduleRecord, now: i64) -> Value {
    let mut map = record.to_map();
    let state = if now >= record.scheduled_ms() {
        "overdue"
    } else {
        "scheduled"
    };
    map.insert("state".into(), Value::from(state));
    map.insert("deliveryMode".into(), Value::from("host"));
    Value::Object(map)
}

// -----------------------------------------------------------------------------------------------------------------
// The strict decoder for stored records
// -----------------------------------------------------------------------------------------------------------------

fn rethrow(error: ScheduleInputError) -> ScheduleLogError {
    ScheduleLogError::new(format!("ScheduleInputError: {}", error.message))
}

fn decode_stored_prompt(value: Option<&Value>, kind: &str) -> Result<String, ScheduleLogError> {
    match value.and_then(Value::as_str) {
        Some(text) if !text.is_empty() && js::trim(text) == text => Ok(text.to_owned()),
        _ => Err(ScheduleLogError::new(format!(
            "{kind} prompt must be non-empty and already trimmed"
        ))),
    }
}

/// The one-shot and fixed-rate variants check their key set before the title, as DSH's historical decoder does.
fn decode_legacy_title(
    map: &Map<String, Value>,
    expected: &[&str],
    message: &str,
) -> Result<Option<String>, ScheduleLogError> {
    let required: Vec<&str> = expected.iter().copied().filter(|key| *key != "title").collect();
    if !has_keys_with_optional(map, &required, &["title"]) {
        return Err(ScheduleLogError::new(message));
    }
    match map.get("title") {
        None => Ok(None),
        Some(title) => decode_stored_title(Some(title)).map(Some),
    }
}

/// The wall-clock variants check their title before their key set.
fn decode_record_title(
    map: &Map<String, Value>,
    expected: &[&str],
    message: &str,
) -> Result<String, ScheduleLogError> {
    let title = decode_stored_title(map.get("title"))?;
    if !has_exact_keys(map, expected) {
        return Err(ScheduleLogError::new(message));
    }
    Ok(title)
}

fn require_title(title: Option<String>) -> Result<String, ScheduleLogError> {
    title.ok_or_else(|| ScheduleLogError::new(REQUIRED_TITLE_MESSAGE))
}

/// Decode one stored record strictly, preserving its committed target and its stored zone spelling
/// (SVC:255-532).
pub fn decode_schedule_record(value: &Value) -> Result<ScheduleRecord, ScheduleLogError> {
    let Some(map) = value.as_object() else {
        return Err(ScheduleLogError::new("schedule record must be an object"));
    };
    match map.get("kind").and_then(Value::as_str) {
        Some("after") => {
            let title = decode_legacy_title(
                map,
                &["id", "kind", "title", "prompt", "afterSeconds", "scheduledAt"],
                "after schedule must contain exactly id, kind, title, prompt, afterSeconds, and scheduledAt",
            )?;
            let prompt = decode_stored_prompt(map.get("prompt"), "after")?;
            let Some(after_seconds) = map
                .get("afterSeconds")
                .and_then(js::safe_integer)
                .filter(|seconds| *seconds > 0)
            else {
                return Err(ScheduleLogError::new("afterSeconds must be a positive safe integer"));
            };
            let id = decode_id(map.get("id"))?;
            let scheduled_at = decode_instant(map.get("scheduledAt"))?;
            Ok(record(
                &id,
                require_title(title)?,
                prompt,
                ScheduleRule::After { after_seconds },
                scheduled_at,
            ))
        }
        Some("at") => {
            let title = decode_legacy_title(
                map,
                &["id", "kind", "title", "prompt", "scheduledAt"],
                "at schedule must contain exactly id, kind, title, prompt, and scheduledAt",
            )?;
            let prompt = decode_stored_prompt(map.get("prompt"), "at")?;
            let id = decode_id(map.get("id"))?;
            let scheduled_at = decode_instant(map.get("scheduledAt"))?;
            Ok(record(&id, require_title(title)?, prompt, ScheduleRule::At, scheduled_at))
        }
        Some("every") => {
            let title = decode_legacy_title(
                map,
                &["id", "kind", "title", "prompt", "everySeconds", "scheduledAt"],
                "every schedule must contain exactly id, kind, title, prompt, everySeconds, and scheduledAt",
            )?;
            let prompt = decode_stored_prompt(map.get("prompt"), "every")?;
            let Some(every_seconds) = map
                .get("everySeconds")
                .and_then(js::safe_integer)
                .filter(|seconds| {
                    *seconds >= MIN_EVERY_INTERVAL_SECONDS
                        && seconds.checked_mul(1000).is_some_and(js::is_safe)
                })
            else {
                return Err(ScheduleLogError::new(format!(
                    "everySeconds must be a safe integer of at least {MIN_EVERY_INTERVAL_SECONDS}"
                )));
            };
            let id = decode_id(map.get("id"))?;
            let scheduled_at = decode_instant(map.get("scheduledAt"))?;
            Ok(record(
                &id,
                require_title(title)?,
                prompt,
                ScheduleRule::Every { every_seconds },
                scheduled_at,
            ))
        }
        Some("daily") => {
            let title = decode_record_title(
                map,
                &["id", "kind", "title", "prompt", "time", "timeZone", "scheduledAt"],
                "daily schedule must contain exactly id, kind, title, prompt, time, timeZone, and scheduledAt",
            )?;
            let prompt = decode_stored_prompt(map.get("prompt"), "daily")?;
            let (Some(time), Some(time_zone)) = (
                map.get("time").and_then(Value::as_str),
                map.get("timeZone").and_then(Value::as_str),
            ) else {
                return Err(ScheduleLogError::new("daily time and timeZone must be strings"));
            };
            let normalized = format_plain_time(local_clock_time(time, "daily").map_err(rethrow)?);
            canonicalize_time_zone(time_zone).map_err(rethrow)?;
            if time != normalized {
                return Err(ScheduleLogError::new("daily time must be normalized to HH:mm:ss.SSS"));
            }
            let id = decode_id(map.get("id"))?;
            let scheduled_at = decode_instant(map.get("scheduledAt"))?;
            Ok(record(
                &id,
                title,
                prompt,
                ScheduleRule::Daily {
                    time: time.to_owned(),
                    time_zone: time_zone.to_owned(),
                },
                scheduled_at,
            ))
        }
        Some("weekly") => {
            let title = decode_record_title(
                map,
                &["id", "kind", "title", "prompt", "time", "timeZone", "weekdays", "scheduledAt"],
                "weekly schedule must contain exactly id, kind, title, prompt, time, timeZone, weekdays, and scheduledAt",
            )?;
            let prompt = decode_stored_prompt(map.get("prompt"), "weekly")?;
            let (Some(time), Some(time_zone)) = (
                map.get("time").and_then(Value::as_str),
                map.get("timeZone").and_then(Value::as_str),
            ) else {
                return Err(ScheduleLogError::new("weekly time and timeZone must be strings"));
            };
            canonicalize_time_zone(time_zone).map_err(rethrow)?;
            let normalized = format_plain_time(local_clock_time(time, "weekly").map_err(rethrow)?);
            if time != normalized {
                return Err(ScheduleLogError::new("weekly time must be normalized to HH:mm:ss.SSS"));
            }
            let stored = map.get("weekdays").unwrap_or(&Value::Null);
            let weekdays = normalize_weekdays(stored).map_err(rethrow)?;
            let entries = stored.as_array().map(Vec::as_slice).unwrap_or(&[]);
            let reordered = weekdays
                .iter()
                .enumerate()
                .any(|(index, weekday)| !entries.get(index).is_some_and(|entry| js::number_equals(entry, *weekday)));
            if reordered {
                return Err(ScheduleLogError::new(
                    "weekly weekdays must be normalized to unique ascending ISO weekday numbers",
                ));
            }
            let id = decode_id(map.get("id"))?;
            let scheduled_at = decode_instant(map.get("scheduledAt"))?;
            Ok(record(
                &id,
                title,
                prompt,
                ScheduleRule::Weekly {
                    time: time.to_owned(),
                    time_zone: time_zone.to_owned(),
                    weekdays,
                },
                scheduled_at,
            ))
        }
        Some("cron") => {
            let title = decode_record_title(
                map,
                &["id", "kind", "title", "prompt", "expression", "timeZone", "scheduledAt"],
                "cron schedule must contain exactly id, kind, title, prompt, expression, timeZone, and scheduledAt",
            )?;
            let prompt = decode_stored_prompt(map.get("prompt"), "cron")?;
            let (Some(expression), Some(time_zone)) = (
                map.get("expression").and_then(Value::as_str),
                map.get("timeZone").and_then(Value::as_str),
            ) else {
                return Err(ScheduleLogError::new("cron expression and timeZone must be strings"));
            };
            canonicalize_time_zone(time_zone).map_err(rethrow)?;
            let canonical = parse_cron_expression(expression).map_err(rethrow)?.expression;
            if expression != canonical {
                return Err(ScheduleLogError::new("cron expression must be canonical"));
            }
            let id = decode_id(map.get("id"))?;
            let scheduled_at = decode_instant(map.get("scheduledAt"))?;
            Ok(record(
                &id,
                title,
                prompt,
                ScheduleRule::Cron {
                    expression: expression.to_owned(),
                    time_zone: time_zone.to_owned(),
                },
                scheduled_at,
            ))
        }
        _ => Err(ScheduleLogError::new(
            "v1 schedule kind must be \"after\", \"at\", or \"every\"",
        )),
    }
}

// -----------------------------------------------------------------------------------------------------------------
// The in-place update
// -----------------------------------------------------------------------------------------------------------------

/// What resolving an update gives: the record (changed or not), a conflict, or a bounded input refusal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateResolution {
    /// `{id, updated, record}`.
    Record {
        /// The task.
        id: String,
        /// Whether anything changed.
        updated: bool,
        /// The record, changed or not.
        record: ScheduleRecord,
    },
    /// `{id, updated: false, code: "schedule_conflict"}`.
    Conflict {
        /// The task.
        id: String,
    },
    /// `{code, message}`.
    Refused {
        /// The public code.
        code: String,
        /// The sentence.
        message: String,
    },
}

impl UpdateResolution {
    /// The value DSH answers, in its key order.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        match self {
            Self::Record {
                id,
                updated,
                record,
            } => {
                map.insert("id".into(), Value::from(id.clone()));
                map.insert("updated".into(), Value::from(*updated));
                map.insert("record".into(), record.to_value());
            }
            Self::Conflict { id } => {
                map.insert("id".into(), Value::from(id.clone()));
                map.insert("updated".into(), Value::from(false));
                map.insert("code".into(), Value::from("schedule_conflict"));
            }
            Self::Refused { code, message } => {
                map.insert("code".into(), Value::from(code.clone()));
                map.insert("message".into(), Value::from(message.clone()));
            }
        }
        Value::Object(map)
    }

    fn refused(error: ScheduleInputError) -> Self {
        Self::Refused {
            code: error.code.as_str().to_owned(),
            message: error.message,
        }
    }
}

/// The new name and instruction an update carries; `None` keeps the stored one.
#[derive(Clone, Copy, Debug, Default)]
pub struct UpdateContent<'a> {
    /// The new title, as supplied.
    pub title: Option<&'a Value>,
    /// The new prompt, as supplied.
    pub prompt: Option<&'a Value>,
}

fn timing_selector(kind: Option<&Value>) -> Option<&'static str> {
    match kind?.as_str()? {
        "at" => Some("at"),
        "every" => Some("every_seconds"),
        "daily" => Some("daily"),
        "weekly" => Some("weekly"),
        "cron" => Some("cron"),
        _ => None,
    }
}

/// Validate the exact keys of a timing change (SVC:1710-1717): its kind and the selector value.
fn validate_change(value: &Value) -> Result<(&'static str, &Value), ScheduleInputError> {
    let Some(map) = value.as_object() else {
        return Err(ScheduleInputError::rule(
            "Timing change must be an object with exactly one supported timing selector.",
        ));
    };
    let selector = timing_selector(map.get("kind"));
    match selector {
        Some(selector) if map.len() == 2 && map.contains_key("kind") && map.contains_key(selector) => {
            let kind = map["kind"].as_str().unwrap_or_default();
            let kind = match kind {
                "at" => "at",
                "every" => "every",
                "daily" => "daily",
                "weekly" => "weekly",
                _ => "cron",
            };
            Ok((kind, &map[selector]))
        }
        _ => Err(ScheduleInputError::rule(
            "Timing change must contain exactly kind and its matching timing selector.",
        )),
    }
}

/// The same record when name and instruction are unchanged, else a copy carrying the new ones.
fn with_content(current: &ScheduleRecord, title: &str, prompt: &str) -> (ScheduleRecord, bool) {
    if title == current.title && prompt == current.prompt {
        return (current.clone(), false);
    }
    let mut changed = current.clone();
    changed.title = title.to_owned();
    changed.prompt = prompt.to_owned();
    (changed, true)
}

/// Apply the requested rule to the current record (SVC:1760-1791): an equivalent normalized rule within the same
/// kind keeps the committed target; any other change computes its target as creation does, from the save time.
fn changed_record(
    current: &ScheduleRecord,
    title: &str,
    prompt: &str,
    change: Option<&Value>,
    now: i64,
) -> Result<(ScheduleRecord, bool), ScheduleInputError> {
    let Some(value) = change else {
        return Ok(with_content(current, title, prompt));
    };
    let (kind, selector) = validate_change(value)?;
    let title_value = Value::from(title);
    let prompt_value = Value::from(prompt);
    let created = match kind {
        "at" => {
            if matches!(current.rule, ScheduleRule::After { .. } | ScheduleRule::At)
                && parse_at_input(selector)? == current.scheduled_ms()
            {
                return Ok(with_content(current, title, prompt));
            }
            create_at_schedule_record(&current.id, &prompt_value, selector, now, &title_value)?
        }
        "every" => {
            if let ScheduleRule::Every { every_seconds } = current.rule
                && js::number_equals(selector, every_seconds)
            {
                return Ok(with_content(current, title, prompt));
            }
            create_every_schedule_record(&current.id, &prompt_value, selector, now, &title_value)?
        }
        "daily" => {
            if let ScheduleRule::Daily { time, time_zone } = &current.rule {
                let (new_time, new_zone) = parse_daily_input(selector)?;
                if &new_time == time && new_zone == canonicalize_time_zone(time_zone)? {
                    return Ok(with_content(current, title, prompt));
                }
            }
            create_daily_schedule_record(&current.id, &prompt_value, selector, now, &title_value)?
        }
        "weekly" => {
            if let ScheduleRule::Weekly {
                time,
                time_zone,
                weekdays,
            } = &current.rule
            {
                let (new_time, new_zone, new_weekdays) = parse_weekly_input(selector)?;
                if &new_time == time
                    && new_zone == canonicalize_time_zone(time_zone)?
                    && &new_weekdays == weekdays
                {
                    return Ok(with_content(current, title, prompt));
                }
            }
            create_weekly_schedule_record(&current.id, &prompt_value, selector, now, &title_value)?
        }
        _ => {
            if let ScheduleRule::Cron {
                expression,
                time_zone,
            } = &current.rule
            {
                let (new_expression, new_zone) = parse_cron_input(selector)?;
                if new_expression == canonicalize_cron_expression(expression)?
                    && new_zone == canonicalize_time_zone(time_zone)?
                {
                    return Ok(with_content(current, title, prompt));
                }
            }
            create_cron_schedule_record(&current.id, &prompt_value, selector, now, &title_value)?
        }
    };
    Ok((created, true))
}

/// Compare the complete observed record with the current one and resolve a name, instruction and timing update
/// from one queue-time sample (SVC:1806-1837). An `expected` that is not a complete valid record is an
/// `invalid_rule`; one that differs is a `schedule_conflict`; input refusals come back as `{code, message}`.
pub fn resolve_schedule_update(
    current: &ScheduleRecord,
    expected: &Value,
    change: Option<&Value>,
    now: i64,
    content: UpdateContent<'_>,
) -> Result<UpdateResolution, ScheduleError> {
    let Ok(decoded) = decode_schedule_record(expected) else {
        return Ok(UpdateResolution::Refused {
            code: "invalid_rule".to_owned(),
            message: "expected must be a complete valid Schedule record.".to_owned(),
        });
    };
    if *current != decoded {
        return Ok(UpdateResolution::Conflict {
            id: current.id.clone(),
        });
    }
    let retained = decode_stored_title(Some(&Value::from(current.title.clone())))?;
    let resolved = (|| {
        let title = match content.title {
            None => retained,
            Some(title) => schedule_title(title)?,
        };
        let prompt = match content.prompt {
            None => current.prompt.clone(),
            Some(prompt) => schedule_prompt(prompt)?,
        };
        changed_record(current, &title, &prompt, change, now)
    })();
    Ok(match resolved {
        Ok((record, updated)) => UpdateResolution::Record {
            id: current.id.clone(),
            updated,
            record,
        },
        Err(error) => UpdateResolution::refused(error),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LA: &str = "America/Los_Angeles";

    fn at(text: &str) -> i64 {
        parse_instant(text).unwrap_or_else(|| panic!("{text} parses"))
    }

    fn now() -> i64 {
        at("2026-10-29T12:00:00.000Z")
    }

    #[track_caller]
    fn refuses<T: std::fmt::Debug>(result: Result<T, ScheduleInputError>, code: &str, message: &str) {
        let error = result.expect_err("a refusal");
        assert_eq!(error.code.as_str(), code, "{}", error.message);
        assert_eq!(error.message, message);
    }

    fn after(id: &str, prompt: &str, seconds: Value, now: i64, title: &str) -> Result<ScheduleRecord, ScheduleInputError> {
        create_after_schedule_record(id, &json!(prompt), &seconds, now, &json!(title))
    }

    fn daily(selector: Value, now: i64) -> Result<ScheduleRecord, ScheduleInputError> {
        create_daily_schedule_record("s", &json!("p"), &selector, now, &json!("t"))
    }

    fn weekly(selector: Value, now: i64) -> Result<ScheduleRecord, ScheduleInputError> {
        create_weekly_schedule_record("s", &json!("p"), &selector, now, &json!("t"))
    }

    fn cron(selector: Value, now: i64) -> Result<ScheduleRecord, ScheduleInputError> {
        create_cron_schedule_record("s", &json!("p"), &selector, now, &json!("t"))
    }

    fn occurrence(record: &ScheduleRecord, decision: i64) -> Occurrence {
        resolve_recurring_occurrence(record, decision)
            .expect("a recurring record")
            .expect("a decision")
    }

    fn occ(at: &str, next: Option<&str>) -> Occurrence {
        Occurrence::new(at.to_owned(), next.map(str::to_owned))
    }

    #[test]
    fn prompt_and_title_trimmed_non_empty_title_at_most_120_characters() {
        refuses(after("s", "   ", json!(60), now(), "t"), "invalid_prompt", "prompt must be non-empty after trimming.");
        refuses(after("s", "p", json!(60), now(), "  "), "invalid_prompt", "title is required and must be non-empty after trimming.");
        refuses(after("s", "p", json!(60), now(), &"x".repeat(121)), "invalid_prompt", "title must be at most 120 characters.");
        let record = after("s", "  check CI  ", json!(60), now(), &format!("  {}  ", "x".repeat(120))).unwrap();
        assert_eq!(record.prompt, "check CI");
        assert_eq!(record.title.len(), 120);
    }

    #[test]
    fn after_seconds_a_positive_safe_integer_target_is_now_plus_seconds() {
        for bad in [json!(0), json!(-1), json!(1.5), json!(9_007_199_254_740_992_i64), json!("60")] {
            refuses(after("s", "p", bad, now(), "t"), "invalid_rule", "after_seconds must be a positive safe integer.");
        }
        assert_eq!(
            after("s", "p", json!(90), now(), "t").unwrap().to_value(),
            json!({"id": "s", "kind": "after", "title": "t", "prompt": "p", "afterSeconds": 90, "scheduledAt": "2026-10-29T12:01:30.000Z"})
        );
        refuses(
            after("s", "p", json!(9_000_000_000_000_i64), now(), "t"),
            "time_out_of_range",
            "The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.",
        );
    }

    #[test]
    fn every_seconds_a_safe_integer_of_at_least_60_first_target_now_plus_interval() {
        let every = |seconds: Value| create_every_schedule_record("s", &json!("p"), &seconds, now(), &json!("t"));
        refuses(every(json!(60.5)), "invalid_rule", "every_seconds must be a safe integer.");
        refuses(every(json!(59)), "frequency_too_high", "every_seconds must be at least 60.");
        assert_eq!(every(json!(3600)).unwrap().scheduled_at, "2026-10-29T13:00:00.000Z");
    }

    #[test]
    fn at_as_a_string_is_strict_rfc_3339_with_an_explicit_offset() {
        let shape = "at must use YYYY-MM-DDTHH:mm:ss with optional 1-3 digit fractional seconds and an explicit Z or numeric offset.";
        for bad in ["2026-10-30T12:00Z", "2026-10-30T12:00:00", "2026-10-30 12:00:00Z", "2026-10-30T12:00:00.1234Z", "2026-10-30T12:00:00+0800"] {
            refuses(parse_at_input(&json!(bad)), "invalid_rule", shape);
        }
        let calendar = "The at value must be a real ISO calendar date and time.";
        for bad in ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "0000-01-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:60Z"] {
            refuses(parse_at_input(&json!(bad)), "invalid_rule", calendar);
        }
        for bad in ["2026-10-30T12:00:00-00:00", "2026-10-30T12:00:00+24:00", "2026-10-30T12:00:00+05:60"] {
            refuses(parse_at_input(&json!(bad)), "invalid_rule", "The at numeric offset is invalid.");
        }
        assert_eq!(parse_at_input(&json!("2026-10-30T20:00:00.5+08:00")).unwrap(), at("2026-10-30T12:00:00.500Z"));
        refuses(parse_at_input(&json!(42)), "invalid_rule", "at must be an explicit-offset string or local calendar object.");
    }

    #[test]
    fn at_as_a_local_object_exact_keys_strings_a_real_date_and_a_wall_time_that_exists() {
        refuses(parse_at_input(&json!({"date": "2026-10-30", "time": "09:00:00"})), "invalid_rule", "Local at must contain exactly date, time, and time_zone.");
        refuses(parse_at_input(&json!({"date": "2026-10-30", "time": "09:00:00", "time_zone": "UTC", "x": 1})), "invalid_rule", "Local at must contain exactly date, time, and time_zone.");
        refuses(parse_at_input(&json!({"date": 20261030, "time": "09:00:00", "time_zone": "UTC"})), "invalid_rule", "Local at date and time must be strings.");
        refuses(parse_at_input(&json!({"date": "2026-10-30", "time": "09:00:00", "time_zone": 8})), "invalid_time_zone", "time_zone must be a string.");
        refuses(
            parse_at_input(&json!({"date": "2026-10-30", "time": "9:00", "time_zone": "UTC"})),
            "invalid_rule",
            "Local at requires date YYYY-MM-DD and time HH:mm:ss with optional one-to-three digit milliseconds.",
        );
        refuses(parse_at_input(&json!({"date": "2026-10-30", "time": "25:00:00", "time_zone": "UTC"})), "invalid_rule", "The local at value must be a real ISO calendar date and time.");
        refuses(parse_at_input(&json!({"date": "2026-02-29", "time": "09:00:00", "time_zone": "UTC"})), "invalid_rule", "The at value must be a real ISO calendar date and time.");
        refuses(parse_at_input(&json!({"date": "2026-10-30", "time": "09:00:00", "time_zone": "PST"})), "invalid_time_zone", "time_zone must be UTC or a valid IANA Area/Location name.");
        refuses(
            parse_at_input(&json!({"date": "2026-03-08", "time": "02:30:00", "time_zone": LA})),
            "invalid_rule",
            "The local at time does not exist in the selected time zone.",
        );
        assert_eq!(
            parse_at_input(&json!({"date": "2026-11-01", "time": "01:30:00", "time_zone": LA})).unwrap(),
            at("2026-11-01T08:30:00.000Z"),
            "an overlap takes the earlier instant"
        );
    }

    #[test]
    fn at_must_be_strictly_future_and_keeps_only_the_utc_instant() {
        let create = |at: Value, prompt: &str| create_at_schedule_record("s", &json!(prompt), &at, now(), &json!("t"));
        refuses(create(json!("2026-10-29T12:00:00Z"), "p"), "not_future", "The scheduled time must be strictly in the future.");
        refuses(create(json!("2026-10-29T11:00:00Z"), "p"), "not_future", "The scheduled time must be strictly in the future.");
        refuses(
            create(json!("0001-01-01T00:00:00+01:00"), "p"),
            "time_out_of_range",
            "The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.",
        );
        assert_eq!(
            create(json!({"date": "2026-10-30", "time": "09:00:00", "time_zone": "Asia/Shanghai"}), " p ").unwrap().to_value(),
            json!({"id": "s", "kind": "at", "title": "t", "prompt": "p", "scheduledAt": "2026-10-30T01:00:00.000Z"})
        );
    }

    #[test]
    fn daily_shape_strict_time_and_zone_diagnostics() {
        let shape = "daily must contain exactly time and time_zone, with time HH:mm:ss and optional 1-3 fractional digits.";
        refuses(daily(json!({"time": "09:00:00"}), now()), "invalid_rule", shape);
        refuses(daily(json!({"time": 9, "time_zone": "UTC"}), now()), "invalid_rule", shape);
        refuses(daily(json!("daily"), now()), "invalid_rule", shape);
        refuses(daily(json!({"time": "09:00:00", "time_zone": null}), now()), "invalid_time_zone", "time_zone must be a string.");
        for bad in ["24:00:00", "23:59:60", "9:00:00", "09:00", "09:00:00.1234"] {
            refuses(
                daily(json!({"time": bad, "time_zone": "UTC"}), now()),
                "invalid_rule",
                "daily.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00.",
            );
        }
        refuses(daily(json!({"time": "09:00:00", "time_zone": "Mars/Base"}), now()), "invalid_time_zone", "time_zone must be UTC or a valid IANA Area/Location name.");
    }

    #[test]
    fn daily_stores_the_normalized_time_and_canonical_zone_and_targets_today_or_tomorrow() {
        let record = create_daily_schedule_record("s", &json!("Review"), &json!({"time": "23:00:00", "time_zone": "Asia/Shanghai"}), now(), &json!("Daily review")).unwrap();
        assert_eq!(
            record.to_value(),
            json!({"id": "s", "kind": "daily", "title": "Daily review", "prompt": "Review", "time": "23:00:00.000", "timeZone": "Asia/Shanghai", "scheduledAt": "2026-10-29T15:00:00.000Z"})
        );
        assert_eq!(daily(json!({"time": "19:00:00.5", "time_zone": "Asia/Shanghai"}), now()).unwrap().scheduled_at, "2026-10-30T11:00:00.500Z");
        assert!(matches!(daily(json!({"time": "12:00:00", "time_zone": "Etc/UTC"}), now()).unwrap().rule, ScheduleRule::Daily { ref time_zone, .. } if time_zone == "UTC"));
        assert_eq!(daily(json!({"time": "12:00:00", "time_zone": "UTC"}), now()).unwrap().scheduled_at, "2026-10-30T12:00:00.000Z", "now itself is not the future");
    }

    #[test]
    fn daily_across_dst_a_gap_skips_the_date_an_overlap_fires_once_at_the_earlier_instant() {
        let gap = daily(json!({"time": "02:30:00", "time_zone": LA}), at("2026-03-08T08:00:00Z")).unwrap();
        assert_eq!(gap.scheduled_at, "2026-03-09T09:30:00.000Z", "2026-03-08 02:30 does not exist; the next date is taken");
        let overlap = daily(json!({"time": "01:30:00", "time_zone": LA}), at("2026-11-01T07:00:00Z")).unwrap();
        assert_eq!(overlap.scheduled_at, "2026-11-01T08:30:00.000Z");
        assert_eq!(
            occurrence(&overlap, at("2026-11-01T08:30:00Z")),
            occ("2026-11-01T08:30:00.000Z", Some("2026-11-02T09:30:00.000Z")),
            "the repeated 01:30 PST is not a second occurrence"
        );
    }

    #[test]
    fn weekly_shape_weekday_diagnostics_sorted_weekdays_and_the_next_selected_day() {
        let shape = "weekly must contain exactly time, time_zone, and weekdays, with time HH:mm:ss and optional 1-3 fractional digits.";
        refuses(weekly(json!({"time": "09:00:00", "time_zone": "UTC"}), now()), "invalid_rule", shape);
        refuses(weekly(json!({"time": "09:00:00", "time_zone": 1, "weekdays": [1]}), now()), "invalid_time_zone", "time_zone must be a string.");
        refuses(
            weekly(json!({"time": "9:00", "time_zone": "UTC", "weekdays": [1]}), now()),
            "invalid_rule",
            "weekly.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00.",
        );
        refuses(weekly(json!({"time": "09:00:00", "time_zone": "UTC", "weekdays": []}), now()), "invalid_rule", "weekly.weekdays must be a non-empty array of ISO weekday numbers.");
        refuses(weekly(json!({"time": "09:00:00", "time_zone": "UTC", "weekdays": "mon"}), now()), "invalid_rule", "weekly.weekdays must be a non-empty array of ISO weekday numbers.");
        for bad in [json!([0]), json!([8]), json!([1.5]), json!(["1"])] {
            refuses(
                weekly(json!({"time": "09:00:00", "time_zone": "UTC", "weekdays": bad}), now()),
                "invalid_rule",
                "Each weekly.weekdays entry must be an integer from 1 (Monday) through 7 (Sunday).",
            );
        }
        refuses(weekly(json!({"time": "09:00:00", "time_zone": "UTC", "weekdays": [3, 1, 3]}), now()), "invalid_rule", "weekly.weekdays must not repeat weekday 3.");
        let record = weekly(json!({"time": "09:00:00", "time_zone": "Asia/Shanghai", "weekdays": [5, 1]}), now()).unwrap();
        assert!(matches!(&record.rule, ScheduleRule::Weekly { weekdays, .. } if weekdays == &[1, 5]));
        assert_eq!(record.scheduled_at, "2026-10-30T01:00:00.000Z", "Friday 2026-10-30 09:00 in Shanghai");
        let gap = weekly(json!({"time": "02:30:00", "time_zone": LA, "weekdays": [7]}), at("2026-03-07T12:00:00Z")).unwrap();
        assert_eq!(gap.scheduled_at, "2026-03-15T09:30:00.000Z", "Sunday 2026-03-08 02:30 is in the gap");
    }

    #[test]
    fn cron_shape_and_zone_diagnostics_the_next_match_and_no_future_exhaustion() {
        let shape = "cron must contain exactly expression and time_zone, with a five-field cron expression.";
        refuses(cron(json!({"expression": "* * * * *"}), now()), "invalid_rule", shape);
        refuses(cron(json!({"expression": 5, "time_zone": "UTC"}), now()), "invalid_rule", shape);
        refuses(cron(json!({"expression": "* * * * *", "time_zone": []}), now()), "invalid_time_zone", "time_zone must be a string.");
        refuses(cron(json!({"expression": "61 * * * *", "time_zone": "UTC"}), now()), "invalid_rule", "cron.expression minute field value 61 is outside 0-59.");
        refuses(
            cron(json!({"expression": "0 0 31 2 *", "time_zone": "UTC"}), now()),
            "time_out_of_range",
            "No future cron occurrence is representable as a four-digit-year UTC instant.",
        );
        let record = cron(json!({"expression": "0,15,30,45 9-17 * * 1-5", "time_zone": "Asia/Shanghai"}), now()).unwrap();
        assert!(matches!(&record.rule, ScheduleRule::Cron { expression, .. } if expression == "0-45/15 9-17 * * 1-5"));
        assert_eq!(record.scheduled_at, "2026-10-30T01:00:00.000Z", "Friday 09:00 in Shanghai");
        let or = cron(json!({"expression": "0 9 1 * 1", "time_zone": "UTC"}), at("2026-10-27T10:00:00Z")).unwrap();
        assert_eq!(or.scheduled_at, "2026-11-01T09:00:00.000Z", "day 1 comes before the next Monday under the OR rule");
    }

    #[test]
    fn cron_across_dst_a_gap_time_is_skipped_an_overlap_time_fires_once() {
        let gap = cron(json!({"expression": "30 2 * * *", "time_zone": LA}), at("2026-03-08T08:00:00Z")).unwrap();
        assert_eq!(gap.scheduled_at, "2026-03-09T09:30:00.000Z");
        let overlap = cron(json!({"expression": "30 1 * * *", "time_zone": LA}), at("2026-11-01T07:00:00Z")).unwrap();
        assert_eq!(overlap.scheduled_at, "2026-11-01T08:30:00.000Z");
        assert_eq!(occurrence(&overlap, at("2026-11-01T08:30:00Z")).next_scheduled_at.as_deref(), Some("2026-11-02T09:30:00.000Z"));
    }

    #[test]
    fn no_future_daily_or_weekly_occurrence_near_the_year_9999_ceiling() {
        let late = at("9999-12-31T23:00:00Z");
        refuses(daily(json!({"time": "22:00:00", "time_zone": "UTC"}), late), "time_out_of_range", "No future daily occurrence is representable as a four-digit-year UTC instant.");
        refuses(
            weekly(json!({"time": "22:00:00", "time_zone": "UTC", "weekdays": [5]}), late),
            "time_out_of_range",
            "No future weekly occurrence is representable as a four-digit-year UTC instant.",
        );
        refuses(
            daily(json!({"time": "22:00:00", "time_zone": "UTC"}), MAX_FOUR_DIGIT_YEAR_MS + 1),
            "time_out_of_range",
            "Daily creation time must be a representable four-digit-year UTC instant.",
        );
    }

    fn every(scheduled_at: &str, every_seconds: i64) -> ScheduleRecord {
        record("e", "t".into(), "p".into(), ScheduleRule::Every { every_seconds }, scheduled_at.into())
    }

    #[test]
    fn every_fixed_rate_from_the_anchor_downtime_delivers_one_occurrence_and_keeps_the_phase() {
        assert_eq!(
            occurrence(&every("2026-10-29T12:00:00.000Z", 60), at("2026-10-29T12:00:00Z")),
            occ("2026-10-29T12:00:00.000Z", Some("2026-10-29T12:01:00.000Z"))
        );
        assert_eq!(
            occurrence(&every("2026-10-29T12:00:00.000Z", 60), at("2026-10-29T12:02:30Z")),
            occ("2026-10-29T12:02:00.000Z", Some("2026-10-29T12:03:00.000Z")),
            "the 12:00 and 12:01 occurrences are dropped; the next keeps the :00 phase"
        );
        assert!(matches!(
            resolve_recurring_occurrence(&every("2026-10-29T12:00:00.000Z", 60), at("2026-10-29T11:59:00Z")),
            Some(Err(ScheduleError::Log(_)))
        ));
    }

    fn daily_record(scheduled_at: &str) -> ScheduleRecord {
        record(
            "d",
            "t".into(),
            "p".into(),
            ScheduleRule::Daily { time: "09:00:00.000".into(), time_zone: "UTC".into() },
            scheduled_at.into(),
        )
    }

    #[test]
    fn daily_and_weekly_downtime_only_the_latest_missed_occurrence_the_next_on_a_later_local_date() {
        let daily = daily_record("2026-03-01T09:00:00.000Z");
        assert_eq!(occurrence(&daily, at("2026-03-05T10:00:00Z")), occ("2026-03-05T09:00:00.000Z", Some("2026-03-06T09:00:00.000Z")));
        assert_eq!(occurrence(&daily, at("2026-03-05T08:00:00Z")), occ("2026-03-04T09:00:00.000Z", Some("2026-03-05T09:00:00.000Z")));
        let drifted = daily_record("2026-03-05T09:30:00.000Z");
        assert_eq!(occurrence(&drifted, at("2026-03-05T09:45:00Z")).occurrence_at, "2026-03-05T09:30:00.000Z", "never earlier than the committed target");
        let weekly = record(
            "w",
            "t".into(),
            "p".into(),
            ScheduleRule::Weekly { time: "09:00:00.000".into(), time_zone: "UTC".into(), weekdays: vec![1, 4] },
            "2026-10-01T09:00:00.000Z".into(),
        );
        assert_eq!(
            occurrence(&weekly, at("2026-10-28T12:00:00Z")),
            occ("2026-10-26T09:00:00.000Z", Some("2026-10-29T09:00:00.000Z")),
            "Monday 26th is the latest selected day; Thursday 29th is next"
        );
    }

    #[test]
    fn cron_downtime_the_latest_matching_time_at_or_before_the_decision_then_the_first_after_it() {
        let hourly = record(
            "c",
            "t".into(),
            "p".into(),
            ScheduleRule::Cron { expression: "0 * * * *".into(), time_zone: "UTC".into() },
            "2026-10-29T06:00:00.000Z".into(),
        );
        assert_eq!(occurrence(&hourly, at("2026-10-29T11:30:00Z")), occ("2026-10-29T11:00:00.000Z", Some("2026-10-29T12:00:00.000Z")));
        assert_eq!(occurrence(&hourly, at("2026-10-29T12:00:00Z")), occ("2026-10-29T12:00:00.000Z", Some("2026-10-29T13:00:00.000Z")));
    }

    #[test]
    fn a_view_adds_state_and_delivery_mode_after_the_record_in_dsh_key_order() {
        let record = create_daily_schedule_record("schedule-1", &json!("Review today's tasks"), &json!({"time": "23:00:00", "time_zone": "Asia/Shanghai"}), now(), &json!("Daily review")).unwrap();
        assert_eq!(
            serde_json::to_string(&schedule_view(&record, now())).unwrap(),
            r#"{"id":"schedule-1","kind":"daily","title":"Daily review","prompt":"Review today's tasks","time":"23:00:00.000","timeZone":"Asia/Shanghai","scheduledAt":"2026-10-29T15:00:00.000Z","state":"scheduled","deliveryMode":"host"}"#
        );
        assert_eq!(schedule_view(&record, at("2026-10-29T15:00:00Z"))["state"], "overdue", "now >= scheduledAt is overdue");
    }

    fn daily_fixture() -> ScheduleRecord {
        record(
            "d",
            "Review".into(),
            "p".into(),
            ScheduleRule::Daily { time: "09:00:00.000".into(), time_zone: "UTC".into() },
            "2026-10-30T09:00:00.000Z".into(),
        )
    }

    fn update(current: &ScheduleRecord, expected: &Value, change: Option<Value>, title: Option<Value>, prompt: Option<Value>) -> UpdateResolution {
        resolve_schedule_update(current, expected, change.as_ref(), now(), UpdateContent { title: title.as_ref(), prompt: prompt.as_ref() }).unwrap()
    }

    fn refused(code: &str, message: &str) -> UpdateResolution {
        UpdateResolution::Refused { code: code.into(), message: message.into() }
    }

    #[test]
    fn update_an_incomplete_expected_is_invalid_rule_a_different_one_is_schedule_conflict() {
        let current = daily_fixture();
        let mut extra = current.to_map();
        extra.insert("extra".into(), json!(1));
        let invalid = refused("invalid_rule", "expected must be a complete valid Schedule record.");
        assert_eq!(update(&current, &Value::Object(extra), None, Some(json!("x")), None), invalid);
        assert_eq!(update(&current, &Value::Null, None, Some(json!("x")), None), invalid);
        let mut other = current.to_map();
        other.insert("prompt".into(), json!("other"));
        assert_eq!(update(&current, &Value::Object(other), None, Some(json!("x")), None), UpdateResolution::Conflict { id: "d".into() });
    }

    #[test]
    fn update_title_or_prompt_alone_keeps_the_target_an_unchanged_request_is_a_no_op() {
        let current = daily_fixture();
        let expected = current.to_value();
        let mut renamed = current.clone();
        renamed.title = "Evening review".into();
        renamed.prompt = "new".into();
        assert_eq!(
            update(&current, &expected, None, Some(json!("  Evening review ")), Some(json!(" new "))),
            UpdateResolution::Record { id: "d".into(), updated: true, record: renamed }
        );
        assert_eq!(
            update(&current, &expected, None, Some(json!("Review")), None),
            UpdateResolution::Record { id: "d".into(), updated: false, record: current.clone() }
        );
        assert_eq!(update(&current, &expected, None, None, Some(json!("  "))), refused("invalid_prompt", "prompt must be non-empty after trimming."));
        assert_eq!(update(&current, &expected, None, Some(json!("x".repeat(121))), None), refused("invalid_prompt", "title must be at most 120 characters."));
    }

    #[test]
    fn update_every_re_anchors_to_the_save_time_on_a_different_interval_the_same_interval_is_a_no_op() {
        let current = every("2026-10-29T12:00:30.000Z", 60);
        let expected = current.to_value();
        let UpdateResolution::Record { record: changed, .. } = update(&current, &expected, Some(json!({"kind": "every", "every_seconds": 120})), None, None) else {
            panic!("a record");
        };
        assert_eq!(changed.scheduled_at, "2026-10-29T12:02:00.000Z", "save time + new interval, not the old anchor");
        let UpdateResolution::Record { updated, record: same, .. } = update(&current, &expected, Some(json!({"kind": "every", "every_seconds": 60})), None, None) else {
            panic!("a record");
        };
        assert!(!updated);
        assert_eq!(same.scheduled_at, current.scheduled_at);
        assert_eq!(update(&current, &expected, Some(json!({"kind": "every", "every_seconds": 30})), None, None), refused("frequency_too_high", "every_seconds must be at least 60."));
    }

    #[test]
    fn update_equivalent_normalized_rules_keep_the_target_a_different_rule_or_kind_recomputes() {
        let current = daily_fixture();
        let not_updated = |resolution: UpdateResolution| matches!(resolution, UpdateResolution::Record { updated: false, .. });
        assert!(not_updated(update(&current, &current.to_value(), Some(json!({"kind": "daily", "daily": {"time": "09:00:00", "time_zone": "Etc/UTC"}})), None, None)));
        let weekly = record("w", "t".into(), "p".into(), ScheduleRule::Weekly { time: "09:00:00.000".into(), time_zone: "UTC".into(), weekdays: vec![1, 5] }, "2026-10-30T09:00:00.000Z".into());
        assert!(not_updated(update(&weekly, &weekly.to_value(), Some(json!({"kind": "weekly", "weekly": {"time": "09:00:00.000", "time_zone": "UTC", "weekdays": [5, 1]}})), None, None)));
        let cron_record = record("c", "t".into(), "p".into(), ScheduleRule::Cron { expression: "0-45/15 * * * *".into(), time_zone: "UTC".into() }, "2026-10-29T12:15:00.000Z".into());
        assert!(not_updated(update(&cron_record, &cron_record.to_value(), Some(json!({"kind": "cron", "cron": {"expression": "0,15,30,45 * * * *", "time_zone": "UTC"}})), None, None)));
        let to_cron = update(&current, &current.to_value(), Some(json!({"kind": "cron", "cron": {"expression": "30 12 * * *", "time_zone": "UTC"}})), None, None);
        assert_eq!(
            to_cron.to_value(),
            json!({"id": "d", "updated": true, "record": {"id": "d", "kind": "cron", "title": "Review", "prompt": "p", "expression": "30 12 * * *", "timeZone": "UTC", "scheduledAt": "2026-10-29T12:30:00.000Z"}})
        );
    }

    #[test]
    fn update_at_keeps_an_after_record_when_the_instant_is_the_same_and_refuses_a_past_instant() {
        let current = after("a", "p", json!(3600), now(), "t").unwrap();
        let expected = current.to_value();
        let UpdateResolution::Record { updated, record: same, .. } = update(&current, &expected, Some(json!({"kind": "at", "at": "2026-10-29T13:00:00Z"})), None, None) else {
            panic!("a record");
        };
        assert!(!updated && same.kind() == "after");
        let UpdateResolution::Record { record: moved, .. } = update(&current, &expected, Some(json!({"kind": "at", "at": "2026-10-29T14:00:00+00:00"})), None, None) else {
            panic!("a record");
        };
        assert_eq!((moved.kind(), moved.scheduled_at.as_str()), ("at", "2026-10-29T14:00:00.000Z"));
        assert_eq!(update(&current, &expected, Some(json!({"kind": "at", "at": "2026-10-29T11:00:00Z"})), None, None), refused("not_future", "The scheduled time must be strictly in the future."));
    }

    #[test]
    fn update_a_malformed_timing_change_is_invalid_rule_with_dsh_wording() {
        let current = daily_fixture();
        let expected = current.to_value();
        assert_eq!(update(&current, &expected, Some(Value::Null), None, None), refused("invalid_rule", "Timing change must be an object with exactly one supported timing selector."));
        let exact = refused("invalid_rule", "Timing change must contain exactly kind and its matching timing selector.");
        assert_eq!(update(&current, &expected, Some(json!({"kind": "hourly", "at": "x"})), None, None), exact);
        assert_eq!(update(&current, &expected, Some(json!({"kind": "at"})), None, None), exact);
        assert_eq!(update(&current, &expected, Some(json!({"kind": "at", "at": "x", "cron": {}})), None, None), exact);
    }

    #[test]
    fn decode_every_kind_round_trips_malformed_stored_records_are_log_errors() {
        let records = [
            after("a", "p", json!(60), now(), "t").unwrap(),
            create_at_schedule_record("b", &json!("p"), &json!("2026-11-01T00:00:00Z"), now(), &json!("t")).unwrap(),
            create_every_schedule_record("c", &json!("p"), &json!(60), now(), &json!("t")).unwrap(),
            daily_fixture(),
            create_weekly_schedule_record("w", &json!("p"), &json!({"time": "09:00:00", "time_zone": "UTC", "weekdays": [3, 1]}), now(), &json!("t")).unwrap(),
            create_cron_schedule_record("x", &json!("p"), &json!({"expression": "0 9 * * 7", "time_zone": "UTC"}), now(), &json!("t")).unwrap(),
        ];
        for record in &records {
            let text = serde_json::to_string(record).unwrap();
            assert_eq!(&decode_schedule_record(&serde_json::from_str(&text).unwrap()).unwrap(), record);
        }
        let corrupt = |value: Value, message: &str| {
            assert_eq!(decode_schedule_record(&value).expect_err(message).message, message);
        };
        let with = |record: &ScheduleRecord, key: &str, value: Value| {
            let mut map = record.to_map();
            map.insert(key.into(), value);
            Value::Object(map)
        };
        let mut untitled = records[2].to_map();
        untitled.remove("title");
        corrupt(Value::Object(untitled), "title is required and must be non-empty after trimming.");
        corrupt(with(&records[3], "prompt", json!(" p")), "daily prompt must be non-empty and already trimmed");
        corrupt(with(&records[3], "time", json!("09:00:00")), "daily time must be normalized to HH:mm:ss.SSS");
        corrupt(with(&records[3], "extra", json!(1)), "daily schedule must contain exactly id, kind, title, prompt, time, timeZone, and scheduledAt");
        corrupt(with(&records[3], "scheduledAt", json!("2026-10-30T09:00:00Z")), "scheduledAt must be a canonical four-digit-year RFC 3339 UTC instant");
        corrupt(with(&records[4], "weekdays", json!([3, 1])), "weekly weekdays must be normalized to unique ascending ISO weekday numbers");
        corrupt(with(&records[5], "expression", json!("0 9 * * 7")), "cron expression must be canonical");
        corrupt(with(&records[3], "kind", json!("hourly")), "v1 schedule kind must be \"after\", \"at\", or \"every\"");
        corrupt(json!("x"), "schedule record must be an object");
        corrupt(with(&records[3], "timeZone", json!("Mars/Base")), "ScheduleInputError: time_zone must be UTC or a valid IANA Area/Location name.");
    }
}
