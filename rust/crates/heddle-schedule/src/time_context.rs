//! The clock reading DSH's `dsh-time-context` gives the model (`src/schedule/time-context.ts`, cited `TC:n`).
//!
//! A reminder is only as good as the model's sense of *now*. DSH answers that with one durable user-role reading per
//! eligible step, source `{kind 'time-context', form 'snapshot'}`, at most once per refresh interval (ten minutes by
//! default). This module is that reading: a fold over the session log that recovers DSH's three baselines, the
//! decision whether this step gets a reading, its exact text, and [`record_time_context`], which the turn loop calls
//! once per step right after the runtime-context snapshot.
//!
//! heddle's log differs from DSH's in two ways, both mapped as the TypeScript build maps them: there is no
//! `turn/start` event, so the turn number is one more than the turns already ended (`turn/completed`,
//! `turn/failed`) and the per-turn baseline resets at a turn's end; and a reading is a `context/note` event, like the
//! runtime-context snapshot, rather than a user message.

use std::collections::BTreeSet;

use heddle_session::{AppendOptions, NewEvent, SessionEvent, SessionHandle, SessionStore, SurfaceOp};
use serde_json::{Map, Value, json};

use crate::time::{canonicalize_time_zone, local_date, local_time, offset_at, parse_instant};

/// The reading's source kind and its section name (TC:102, 236-243).
pub const TIME_CONTEXT_KIND: &str = "time-context";

/// DSH's default refresh interval, ten minutes (TC:162).
pub const DEFAULT_REFRESH_INTERVAL_MS: i64 = 600_000;

/// The three baselines DSH keeps in its `timeContext` projection (TC:103-110).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TimeContextState {
    /// Time of the latest model-visible event.
    pub last_message_time: Option<i64>,
    /// Time of the latest reading.
    pub last_injection_time: Option<i64>,
    /// Time of the latest reading in the open turn.
    pub last_turn_injection_time: Option<i64>,
}

/// The parts of a log event the reading reads: its type, its time and its message.
#[derive(Clone, Copy, Debug)]
pub struct LogEvent<'a> {
    /// `type`.
    pub kind: &'a str,
    /// `at`.
    pub at: &'a str,
    /// `message`, when the event carries one.
    pub message: Option<&'a Value>,
}

impl<'a> LogEvent<'a> {
    /// The view of a stored session event.
    pub fn of_session(event: &'a SessionEvent) -> Self {
        Self {
            kind: &event.kind,
            at: &event.at,
            message: event.get("message"),
        }
    }

    /// The view of an event as a JSON object.
    pub fn of_value(event: &'a Value) -> Self {
        Self {
            kind: event.get("type").and_then(Value::as_str).unwrap_or(""),
            at: event.get("at").and_then(Value::as_str).unwrap_or(""),
            message: event.get("message"),
        }
    }
}

fn is_turn_end(kind: &str) -> bool {
    matches!(kind, "turn/completed" | "turn/failed")
}

fn message_field<'a>(event: &LogEvent<'a>, key: &str) -> Option<&'a Value> {
    event.message?.get(key)
}

/// Whether an event is a reading this module wrote.
pub fn is_time_context_reading(event: &LogEvent<'_>) -> bool {
    event.kind == "context/note"
        && message_field(event, "source")
            .and_then(|source| source.get("kind"))
            .and_then(Value::as_str)
            == Some(TIME_CONTEXT_KIND)
}

/// Fold a session log into DSH's three baselines (TC:190-213).
pub fn fold_time_context(events: &[LogEvent<'_>]) -> TimeContextState {
    let mut state = TimeContextState::default();
    for event in events {
        if is_turn_end(event.kind) {
            state.last_turn_injection_time = None;
            continue;
        }
        let visible = event.kind == "message"
            || event.kind == "tool/result"
            || (event.kind == "context/note"
                && message_field(event, "role").and_then(Value::as_str) == Some("user"));
        if !visible {
            continue;
        }
        let Some(time) = parse_instant(event.at) else {
            continue;
        };
        state.last_message_time = Some(time);
        if is_time_context_reading(event) {
            state.last_injection_time = Some(time);
            state.last_turn_injection_time = Some(time);
        }
    }
    state
}

/// DSH's compact duration: `Nd Nh Nm Ns`, zero days, hours and minutes left out, seconds always (TC:119-133).
pub fn format_duration(elapsed_ms: i64) -> String {
    let mut seconds = elapsed_ms.max(0) / 1000;
    let days = seconds / 86_400;
    seconds %= 86_400;
    let hours = seconds / 3600;
    seconds %= 3600;
    let minutes = seconds / 60;
    seconds %= 60;
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    parts.push(format!("{seconds}s"));
    parts.join(" ")
}

/// DSH's timestamp: local fields, the long numeric offset, and the zone in brackets (TC:68-92).
pub fn format_timestamp(now: i64, time_zone: &str) -> String {
    let date = local_date(now, time_zone);
    let time = local_time(now, time_zone);
    let offset = offset_at(now, time_zone) / 1000;
    let sign = if offset < 0 { '-' } else { '+' };
    let magnitude = offset.abs();
    let mut zone = format!("{sign}{:02}:{:02}", magnitude / 3600, magnitude % 3600 / 60);
    if magnitude % 60 != 0 {
        zone.push_str(&format!(":{:02}", magnitude % 60));
    }
    format!(
        "{}-{:02}-{:02}T{:02}:{:02}:{:02}{zone}[{time_zone}]",
        date.year, date.month, date.day, time.hour, time.minute, time.second
    )
}

/// The browser zone facts for one open turn: one zone, several, or none (TC:30-45).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrowserTimeZone {
    /// One zone.
    Resolved(String),
    /// Several, sorted.
    Mixed(Vec<String>),
    /// None.
    Missing,
}

/// The zones the open turn's person-entered messages carry (TC:10-45): `clientTimeZone` on a user source with an
/// `rpcId`, kept only when it is already canonical.
pub fn derive_browser_time_zone(events: &[LogEvent<'_>]) -> BrowserTimeZone {
    let start = events
        .iter()
        .rposition(|event| is_turn_end(event.kind))
        .map_or(0, |index| index + 1);
    let mut zones = BTreeSet::new();
    for event in &events[start..] {
        if event.kind != "message" {
            continue;
        }
        let Some(source) = message_field(event, "source") else {
            continue;
        };
        let from_person = source.get("kind").and_then(Value::as_str) == Some("user")
            && source.get("rpcId").is_some_and(Value::is_string);
        let Some(zone) = source.get("clientTimeZone").and_then(Value::as_str).filter(|_| from_person) else {
            continue;
        };
        if canonicalize_time_zone(zone).is_ok_and(|canonical| canonical == zone) {
            zones.insert(zone.to_owned());
        }
    }
    let sorted: Vec<String> = zones.into_iter().collect();
    match sorted.len() {
        0 => BrowserTimeZone::Missing,
        1 => BrowserTimeZone::Resolved(sorted[0].clone()),
        _ => BrowserTimeZone::Mixed(sorted),
    }
}

/// The policy line for the browser zone (TC:51-59).
pub fn render_browser_time_zone(context: &BrowserTimeZone) -> String {
    match context {
        BrowserTimeZone::Resolved(zone) => format!(
            "Browser time zone for this request: {zone}. Interpret otherwise-unqualified dates and times in this zone."
        ),
        BrowserTimeZone::Mixed(zones) => format!(
            "Browser time zone for this request: mixed {}. Ask the user to clarify otherwise-unqualified dates and times.",
            serde_json::to_string(zones).expect("zones serialize")
        ),
        BrowserTimeZone::Missing => "Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.".to_owned(),
    }
}

/// What a step needs to decide on a reading.
#[derive(Clone, Debug, Default)]
pub struct TimeContextOptions {
    /// The step's number within its turn, from 1.
    pub step: u32,
    /// Now, in epoch milliseconds.
    pub now: i64,
    /// The interval between readings; 0 gives one on every step; DSH's default when absent.
    pub refresh_interval_ms: Option<i64>,
    /// The zone when the turn carries no browser zone; the process's own when absent.
    pub fallback_time_zone: Option<String>,
}

/// The process's own zone, as `Intl.DateTimeFormat().resolvedOptions().timeZone` reads it: `TZ`, else the system
/// zone `/etc/localtime` points at, else UTC.
pub fn process_time_zone() -> String {
    let from_path = |path: &str| {
        path.find("zoneinfo/")
            .and_then(|index| canonicalize_time_zone(&path[index + "zoneinfo/".len()..]).ok())
    };
    if let Ok(tz) = std::env::var("TZ") {
        let name = tz.trim_start_matches(':');
        if let Ok(canonical) = canonicalize_time_zone(name) {
            return canonical;
        }
        if let Some(canonical) = from_path(name) {
            return canonical;
        }
    }
    if let Ok(target) = std::fs::read_link("/etc/localtime")
        && let Some(canonical) = from_path(&target.to_string_lossy())
    {
        return canonical;
    }
    "UTC".to_owned()
}

/// The reading this step should carry, or `None` when the last one is recent enough (TC:215-228).
pub fn time_context_reading(events: &[LogEvent<'_>], options: &TimeContextOptions) -> Result<Option<String>, String> {
    let interval = options.refresh_interval_ms.unwrap_or(DEFAULT_REFRESH_INTERVAL_MS);
    if interval < 0 || !crate::js::is_safe(interval) {
        return Err(format!(
            "time-context: refreshIntervalMs must be a non-negative safe integer, got {interval}"
        ));
    }
    let state = fold_time_context(events);
    if let Some(last) = state.last_injection_time
        && interval > 0
        && options.now >= last
        && options.now - last < interval
    {
        return Ok(None);
    }
    let previous = if options.step == 1 {
        state.last_message_time
    } else {
        state.last_turn_injection_time
    };
    let turn = 1 + events.iter().filter(|event| is_turn_end(event.kind)).count();
    let browser = derive_browser_time_zone(events);
    let zone = match &browser {
        BrowserTimeZone::Resolved(zone) => zone.clone(),
        _ => options.fallback_time_zone.clone().unwrap_or_else(process_time_zone),
    };
    let elapsed = previous.map_or_else(|| "unavailable".to_owned(), |previous| format_duration(options.now - previous));
    let baseline = if options.step == 1 {
        "model-visible message"
    } else {
        "step context"
    };
    Ok(Some(format!(
        "Time sampled while preparing turn {turn}, step {}: {}\n{}\nElapsed since the preceding {baseline}: {elapsed}.",
        options.step,
        format_timestamp(options.now, &zone),
        render_browser_time_zone(&browser)
    )))
}

fn system_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Append this step's reading to the session when it is due, and say whether one was written.
///
/// The loop calls it once per step, right after the runtime-context snapshot and before it reads what the person
/// said. The note is model-visible (`role: user`) and attributed to the harness (`origin: time-context`).
pub fn record_time_context(
    store: &SessionStore,
    handle: &SessionHandle,
    step: u32,
    now: Option<i64>,
    fallback_time_zone: Option<String>,
) -> Result<bool, String> {
    let events = store.read(handle).map_err(|error| error.to_string())?;
    let views: Vec<LogEvent<'_>> = events.iter().map(|event| LogEvent::of_session(event)).collect();
    let options = TimeContextOptions {
        step,
        now: now.unwrap_or_else(system_now),
        refresh_interval_ms: None,
        fallback_time_zone,
    };
    let Some(text) = time_context_reading(&views, &options)? else {
        return Ok(false);
    };
    let mut fields = Map::new();
    fields.insert(
        "message".into(),
        json!({
            "role": "user",
            "content": [{"type": "text", "text": text}],
            "source": {"kind": TIME_CONTEXT_KIND, "form": "snapshot", "sections": [{"name": TIME_CONTEXT_KIND, "text": text}]},
        }),
    );
    fields.insert("origin".into(), Value::from(TIME_CONTEXT_KIND));
    store
        .append(
            handle,
            NewEvent {
                kind: "context/note".to_owned(),
                fields,
            },
            AppendOptions {
                surface_op: Some(SurfaceOp::Append),
                source_event_seqs: None,
            },
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::format_instant;

    /// 2026-10-29T11:30:16Z.
    const T0: i64 = 1_793_273_416_000;
    const UNAVAILABLE: &str = "Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.";

    fn event(kind: &str, at: i64, extra: Value) -> Value {
        let mut map = Map::new();
        map.insert("type".into(), Value::from(kind));
        map.insert("at".into(), Value::from(format_instant(at)));
        if let Value::Object(extra) = extra {
            map.extend(extra);
        }
        Value::Object(map)
    }

    fn user(at: i64, source: Value) -> Value {
        event("message", at, json!({"message": {"role": "user", "content": [{"type": "text", "text": "hi"}], "source": source}}))
    }

    fn plain_user(at: i64) -> Value {
        user(at, json!({"kind": "user"}))
    }

    fn assistant(at: i64) -> Value {
        event("message", at, json!({"message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}}))
    }

    fn reading(at: i64) -> Value {
        event("context/note", at, json!({"message": {"role": "user", "content": [{"type": "text", "text": "r"}], "source": {"kind": "time-context", "form": "snapshot"}}, "origin": "time-context"}))
    }

    fn turn_end(at: i64) -> Value {
        event("turn/completed", at, json!({"rounds": 1}))
    }

    fn views(events: &[Value]) -> Vec<LogEvent<'_>> {
        events.iter().map(LogEvent::of_value).collect()
    }

    fn read(events: &[Value], step: u32, now: i64, interval: Option<i64>, fallback: Option<&str>) -> Option<String> {
        time_context_reading(
            &views(events),
            &TimeContextOptions { step, now, refresh_interval_ms: interval, fallback_time_zone: fallback.map(str::to_owned) },
        )
        .unwrap()
    }

    #[test]
    fn the_duration_is_dsh_compact_form() {
        assert_eq!(format_duration(0), "0s");
        assert_eq!(format_duration(999), "0s");
        assert_eq!(format_duration(65_000), "1m 5s");
        assert_eq!(format_duration(3_600_000), "1h 0s");
        assert_eq!(format_duration(90_061_000), "1d 1h 1m 1s");
        assert_eq!(format_duration(-5_000), "0s", "a negative elapsed time reads as zero");
    }

    #[test]
    fn the_timestamp_carries_local_fields_the_long_numeric_offset_and_the_zone_in_brackets() {
        assert_eq!(format_instant(T0), "2026-10-29T11:30:16.000Z");
        assert_eq!(format_timestamp(T0, "America/Los_Angeles"), "2026-10-29T04:30:16-07:00[America/Los_Angeles]");
        assert_eq!(format_timestamp(T0, "Asia/Shanghai"), "2026-10-29T19:30:16+08:00[Asia/Shanghai]");
        assert_eq!(format_timestamp(T0, "UTC"), "2026-10-29T11:30:16+00:00[UTC]", "GMT reads as +00:00");
    }

    #[test]
    fn the_browser_zone_line_has_dsh_three_forms() {
        assert_eq!(
            render_browser_time_zone(&BrowserTimeZone::Resolved("Asia/Shanghai".into())),
            "Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone."
        );
        assert_eq!(
            render_browser_time_zone(&BrowserTimeZone::Mixed(vec!["Asia/Shanghai".into(), "Europe/Paris".into()])),
            "Browser time zone for this request: mixed [\"Asia/Shanghai\",\"Europe/Paris\"]. Ask the user to clarify otherwise-unqualified dates and times."
        );
        assert_eq!(render_browser_time_zone(&BrowserTimeZone::Missing), UNAVAILABLE);
    }

    #[test]
    fn the_browser_zone_comes_from_the_open_turn_person_entered_messages_only() {
        let rpc = |zone: &str| json!({"kind": "user", "rpcId": "rpc-1", "clientTimeZone": zone});
        assert_eq!(derive_browser_time_zone(&views(&[plain_user(T0)])), BrowserTimeZone::Missing, "a message without a zone says nothing");
        assert_eq!(derive_browser_time_zone(&views(&[user(T0, rpc("Asia/Shanghai"))])), BrowserTimeZone::Resolved("Asia/Shanghai".into()));
        assert_eq!(
            derive_browser_time_zone(&views(&[user(T0, rpc("Europe/Paris")), user(T0, rpc("Asia/Shanghai"))])),
            BrowserTimeZone::Mixed(vec!["Asia/Shanghai".into(), "Europe/Paris".into()])
        );
        assert_eq!(
            derive_browser_time_zone(&views(&[user(T0, rpc("Europe/Paris")), turn_end(T0), user(T0, rpc("Asia/Shanghai"))])),
            BrowserTimeZone::Resolved("Asia/Shanghai".into()),
            "an ended turn does not count"
        );
        assert_eq!(derive_browser_time_zone(&views(&[user(T0, rpc("asia/shanghai"))])), BrowserTimeZone::Missing, "a non-canonical zone is ignored");
    }

    #[test]
    fn the_fold_recovers_dsh_three_baselines_and_a_turn_end_clears_only_the_per_turn_one() {
        assert_eq!(fold_time_context(&[]), TimeContextState::default());
        let events = vec![plain_user(T0), assistant(T0 + 1000), reading(T0 + 2000)];
        let all = TimeContextState { last_message_time: Some(T0 + 2000), last_injection_time: Some(T0 + 2000), last_turn_injection_time: Some(T0 + 2000) };
        assert_eq!(fold_time_context(&views(&events)), all);
        let mut ended = events.clone();
        ended.push(turn_end(T0 + 3000));
        assert_eq!(fold_time_context(&views(&ended)), TimeContextState { last_turn_injection_time: None, ..all });
        let mut with_system = events.clone();
        with_system.push(event("context/note", T0 + 4000, json!({"message": {"role": "system", "content": []}})));
        assert_eq!(fold_time_context(&views(&with_system)).last_message_time, Some(T0 + 2000), "a note the model does not read is not a message");
    }

    #[test]
    fn the_first_step_of_a_turn_reads_dsh_full_text_counting_from_the_latest_model_visible_message() {
        assert_eq!(
            read(&[plain_user(T0)], 1, T0 + 65_000, None, Some("Asia/Shanghai")).unwrap(),
            format!("Time sampled while preparing turn 1, step 1: 2026-10-29T19:31:21+08:00[Asia/Shanghai]\n{UNAVAILABLE}\nElapsed since the preceding model-visible message: 1m 5s.")
        );
        assert!(read(&[], 1, T0, None, Some("UTC")).unwrap().ends_with("Elapsed since the preceding model-visible message: unavailable."));
    }

    #[test]
    fn a_resolved_browser_zone_chooses_the_timestamp_zone_over_the_fallback() {
        let text = read(&[user(T0, json!({"kind": "user", "rpcId": "rpc-1", "clientTimeZone": "Asia/Shanghai"}))], 1, T0, None, Some("UTC")).unwrap();
        assert!(text.contains(": 2026-10-29T19:30:16+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai."), "{text}");
    }

    #[test]
    fn a_reading_is_skipped_while_the_last_one_is_younger_than_the_interval() {
        assert_eq!(DEFAULT_REFRESH_INTERVAL_MS, 600_000);
        let events = [plain_user(T0), reading(T0)];
        assert_eq!(read(&events, 1, T0 + 599_999, None, Some("UTC")), None);
        assert!(read(&events, 1, T0 + 600_000, None, Some("UTC")).is_some(), "at the interval a new reading is due");
        assert!(read(&events, 1, T0 + 1000, Some(0), Some("UTC")).is_some(), "an interval of 0 reads on every step");
        assert!(read(&events, 1, T0 - 1000, None, Some("UTC")).is_some(), "a reading from the future does not suppress one");
        let refused = time_context_reading(&views(&events), &TimeContextOptions { step: 1, now: T0, refresh_interval_ms: Some(-1), fallback_time_zone: None });
        assert!(refused.unwrap_err().contains("refreshIntervalMs must be a non-negative safe integer"));
    }

    #[test]
    fn later_steps_count_from_the_turns_latest_reading_and_the_turn_number_follows_the_ended_turns() {
        let in_turn = [plain_user(T0), reading(T0)];
        let text = read(&in_turn, 2, T0 + 700_000, None, Some("UTC")).unwrap();
        assert!(text.starts_with("Time sampled while preparing turn 1, step 2: "), "{text}");
        assert!(text.ends_with("\nElapsed since the preceding step context: 11m 40s."), "{text}");
        let two_ended = [plain_user(T0), reading(T0), turn_end(T0 + 1), plain_user(T0 + 2), turn_end(T0 + 3), plain_user(T0 + 4)];
        let text = read(&two_ended, 2, T0 + 700_000, None, Some("UTC")).unwrap();
        assert!(text.starts_with("Time sampled while preparing turn 3, step 2: "), "{text}");
        assert!(text.ends_with("step context: unavailable."), "a new turn has no reading of its own yet: {text}");
    }

    #[test]
    fn record_time_context_appends_one_model_visible_note_with_dsh_source_then_waits_out_the_interval() {
        let root = crate::store::tests::scratch("time-context");
        let store = SessionStore::new(&root.display().to_string(), &heddle_config::Env::default());
        let handle = store
            .create(heddle_session::CreateOptions { cwd: Some(root.display().to_string()), ..Default::default() })
            .unwrap();
        assert_eq!(record_time_context(&store, &handle, 1, Some(system_now()), Some("UTC".into())), Ok(true));
        let events = store.read(&handle).unwrap();
        let notes: Vec<&SessionEvent> = events.iter().map(|event| event.as_ref()).filter(|event| event.kind == "context/note").collect();
        assert_eq!(notes.len(), 1);
        let message = notes[0].get("message").unwrap();
        let text = message["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("Time sampled while preparing turn 1, step 1: "), "{text}");
        assert!(text.split('\n').next().unwrap().ends_with("+00:00[UTC]"), "{text}");
        assert_eq!(message["role"], "user");
        assert_eq!(notes[0].get("origin"), Some(&json!("time-context")));
        assert_eq!(message["source"], json!({"kind": "time-context", "form": "snapshot", "sections": [{"name": "time-context", "text": text}]}));
        assert_eq!(record_time_context(&store, &handle, 2, Some(system_now()), Some("UTC".into())), Ok(false), "a second step inside the interval adds nothing");
        let _ = std::fs::remove_dir_all(&root);
    }
}
