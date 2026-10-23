//! The ports this crate needs: the session log it event-sources from, and the clock that stamps a write.

use std::time::SystemTime;

use serde_json::{Map, Value};

/// The session log could not be opened, read or appended.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct LogError(pub String);

/// The session log, as a plugin that event-sources its state needs it — the TypeScript `SessionStore`'s
/// `open`, `read` and `append`.
///
/// Events are JSON objects as written: `{"seq":…,"at":…,"type":…, …}`. Implemented for `heddle-session`'s
/// store once its API lands; tests use an in-memory double.
pub trait SessionLog: Send + Sync {
    /// The canonical id of the session `id` names, or `None` when there is no such session.
    fn open(&self, id: &str) -> Option<String>;
    /// Every event of the session, in order.
    fn read(&self, session: &str) -> Result<Vec<Value>, LogError>;
    /// Append one event body — `type` and its fields, in order; the log adds `seq` and `at` in front — and
    /// return the event as written.
    fn append(&self, session: &str, event: Map<String, Value>) -> Result<Value, LogError>;
}

/// Where a write's `updatedAt` comes from; injected so a test can fix it.
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

/// A time as JavaScript's `Date.prototype.toISOString` writes it: UTC, milliseconds, `Z` —
/// `2026-10-22T18:17:40.123Z`. The session log's timestamps are compared as text, so the format is exact.
pub fn iso_timestamp(time: SystemTime) -> String {
    let millis = unix_millis(time);
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

/// Milliseconds since the Unix epoch, negative before it (JavaScript's `Date` range).
fn unix_millis(time: SystemTime) -> i64 {
    match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(after) => after.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    }
}

/// The civil date a count of days since 1970-01-01 names (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(millis: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_millis(millis)
    }

    #[test]
    fn the_epoch_is_written_the_way_javascript_writes_it() {
        assert_eq!(iso_timestamp(at(0)), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn milliseconds_and_seconds_are_zero_padded() {
        assert_eq!(iso_timestamp(at(1_000)), "1970-01-01T00:00:01.000Z");
        assert_eq!(iso_timestamp(at(1_234)), "1970-01-01T00:00:01.234Z");
    }

    #[test]
    fn a_known_later_instant_is_utc() {
        assert_eq!(
            iso_timestamp(at(1_700_000_000_000)),
            "2023-11-14T22:13:20.000Z"
        );
        assert_eq!(
            iso_timestamp(at(1_792_725_273_000)),
            "2026-10-23T03:14:33.000Z"
        );
    }

    #[test]
    fn a_leap_day_is_a_day() {
        assert_eq!(
            iso_timestamp(at(1_709_164_800_000)),
            "2024-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn before_the_epoch_is_written_without_an_off_by_one() {
        assert_eq!(
            iso_timestamp(SystemTime::UNIX_EPOCH - Duration::from_millis(1_000)),
            "1969-12-31T23:59:59.000Z"
        );
    }
}
