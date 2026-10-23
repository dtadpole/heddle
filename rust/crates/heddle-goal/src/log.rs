//! The ports this crate needs: the session log it event-sources from, and the clock that stamps a change.
//!
//! The same shapes as `heddle-todo`'s, kept separate so either plugin loads without the other; both go once
//! `heddle-session` exports the store trait they stand in for.

use std::time::SystemTime;

use serde_json::{Map, Value};

/// The session log could not be opened, read or appended.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct LogError(pub String);

/// The session log, as a plugin that event-sources its state needs it — the TypeScript `SessionStore`'s
/// `open`, `read` and `append`. Events are JSON objects as written: `{"seq":…,"at":…,"type":…, …}`.
pub trait SessionLog: Send + Sync {
    /// The canonical id of the session `id` names, or `None` when there is no such session.
    fn open(&self, id: &str) -> Option<String>;
    /// Every event of the session, in order.
    fn read(&self, session: &str) -> Result<Vec<Value>, LogError>;
    /// Append one event body — `type` and its fields, in order; the log adds `seq` and `at` in front — and
    /// return the event as written.
    fn append(&self, session: &str, event: Map<String, Value>) -> Result<Value, LogError>;
}

/// Where a change's timestamps come from; injected so a test can fix them.
pub trait Clock: Send + Sync {
    /// Now, as [`iso_timestamp`] formats it.
    fn now(&self) -> String;
}

/// The system clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> String {
        iso_timestamp(SystemTime::now())
    }
}

/// A time as JavaScript's `Date.prototype.toISOString` writes it: UTC, milliseconds, `Z`.
pub fn iso_timestamp(time: SystemTime) -> String {
    let millis = match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(after) => after.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    };
    let seconds = millis.div_euclid(1000);
    let milliseconds = millis.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = of_day / 3_600;
    let minute = (of_day % 3_600) / 60;
    let second = of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z")
}

/// The civil date a count of days since 1970-01-01 names (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_timestamp_is_the_javascript_iso_string() {
        assert_eq!(
            iso_timestamp(SystemTime::UNIX_EPOCH),
            "1970-01-01T00:00:00.000Z"
        );
        assert_eq!(
            iso_timestamp(SystemTime::UNIX_EPOCH + Duration::from_millis(1_700_000_000_123)),
            "2023-11-14T22:13:20.123Z"
        );
        assert_eq!(
            iso_timestamp(SystemTime::UNIX_EPOCH - Duration::from_millis(1_000)),
            "1969-12-31T23:59:59.000Z"
        );
    }
}
