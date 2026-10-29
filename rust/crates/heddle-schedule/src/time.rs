//! Calendar and time-zone arithmetic for schedules (`src/schedule/time.ts`).
//!
//! What DSH uses of Temporal is small and reproduced exactly:
//!
//! - **plain dates** — proleptic Gregorian, carried as an epoch-day number (Howard Hinnant's `days_from_civil`), so
//!   stepping is integer arithmetic and year 0 behaves like every other year;
//! - **a zone's offset at an instant** — read from the system's IANA database ([`crate::tzif`]), at one-second
//!   resolution (local-mean-time offsets have seconds);
//! - **a local wall time to an instant**, with DSH's disambiguation `earlier` **and** its round trip (SVC:245-248):
//!   read the wall time W as if it were UTC (t); the candidate offsets are the zone's offsets a day either side of
//!   t; each candidate o gives the instant t - o, kept only if the zone shows W at that instant. None kept is a
//!   **gap**; two kept is an **overlap**, and the earlier wins.
//!
//! Canonical UTC instants are `YYYY-MM-DDTHH:mm:ss.sssZ`, `Date#toISOString` for every four-digit year.

use crate::errors::{ScheduleErrorCode, ScheduleInputError};
use crate::js;

/// Milliseconds in one day.
pub const DAY_MS: i64 = 86_400_000;

/// The first instant a four-digit-year RFC 3339 UTC string can name: `0001-01-01T00:00:00.000Z`.
pub const MIN_FOUR_DIGIT_YEAR_MS: i64 = -62_135_596_800_000;

/// The last instant a four-digit-year RFC 3339 UTC string can name: `9999-12-31T23:59:59.999Z`.
pub const MAX_FOUR_DIGIT_YEAR_MS: i64 = 253_402_300_799_999;

/// The names `Intl` resolves to `UTC` (ECMA-402's rule for `Etc/UTC`, `Etc/GMT` and their links).
const UTC_ALIASES: &[&str] = &[
    "Etc/UTC",
    "Etc/GMT",
    "Etc/Universal",
    "Etc/Zulu",
    "Etc/UCT",
    "Etc/Greenwich",
    "Etc/GMT0",
    "Etc/GMT+0",
    "Etc/GMT-0",
];

const INVALID_ZONE: &str = "time_zone must be UTC or a valid IANA Area/Location name.";

/// A calendar date with no zone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PlainDate {
    /// The proleptic Gregorian year (year 0 is 1 BC).
    pub year: i64,
    /// 1-12.
    pub month: u32,
    /// 1-31.
    pub day: u32,
}

impl PlainDate {
    /// A date from its fields.
    pub const fn new(year: i64, month: u32, day: u32) -> Self {
        Self { year, month, day }
    }
}

/// A wall-clock time of day with no zone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PlainTime {
    /// 0-23.
    pub hour: u32,
    /// 0-59.
    pub minute: u32,
    /// 0-59.
    pub second: u32,
    /// 0-999.
    pub millisecond: u32,
}

impl PlainTime {
    /// A time from its fields.
    pub const fn new(hour: u32, minute: u32, second: u32, millisecond: u32) -> Self {
        Self {
            hour,
            minute,
            second,
            millisecond,
        }
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's `days_from_civil`).
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let month = i64::from(month);
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Days since 1970-01-01 of a date.
pub fn epoch_day(date: PlainDate) -> i64 {
    days_from_civil(date.year, date.month, date.day)
}

/// The proleptic Gregorian date of a day count since 1970-01-01 (Hinnant's `civil_from_days`).
pub fn date_of_epoch_day(days: i64) -> PlainDate {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    PlainDate::new(year, month as u32, day as u32)
}

/// The year of a day count since 1970-01-01.
pub fn year_of_epoch_day(days: i64) -> i64 {
    date_of_epoch_day(days).year
}

/// Whether a proleptic Gregorian year is a leap year.
pub fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Days in one month of one year.
pub fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Whether `{year, month, day}` names a real date.
pub fn is_real_date(year: i64, month: i64, day: i64) -> bool {
    (1..=12).contains(&month) && day >= 1 && day <= i64::from(days_in_month(year, month as u32))
}

/// A date stepped by whole days.
pub fn add_days(date: PlainDate, days: i64) -> PlainDate {
    date_of_epoch_day(epoch_day(date) + days)
}

/// A date stepped by whole years, clamping the day to the target month like Temporal's `constrain`.
pub fn add_years(date: PlainDate, years: i64) -> PlainDate {
    let year = date.year + years;
    PlainDate::new(
        year,
        date.month,
        date.day.min(days_in_month(year, date.month)),
    )
}

/// The first day of the month after `date`.
pub fn first_of_next_month(date: PlainDate) -> PlainDate {
    if date.month == 12 {
        PlainDate::new(date.year + 1, 1, 1)
    } else {
        PlainDate::new(date.year, date.month + 1, 1)
    }
}

/// The last day of the month before `date`.
pub fn last_of_previous_month(date: PlainDate) -> PlainDate {
    add_days(PlainDate::new(date.year, date.month, 1), -1)
}

/// ISO weekday of a date: Monday 1 through Sunday 7. 1970-01-01 was a Thursday.
pub fn iso_day_of_week(date: PlainDate) -> u32 {
    ((epoch_day(date) + 3).rem_euclid(7) + 1) as u32
}

/// Milliseconds since local midnight of a wall-clock time.
pub fn time_of_day_ms(time: PlainTime) -> i64 {
    ((i64::from(time.hour) * 60 + i64::from(time.minute)) * 60 + i64::from(time.second)) * 1000
        + i64::from(time.millisecond)
}

/// A wall-clock date and time read as if it were UTC, in epoch milliseconds.
pub fn wall_ms(date: PlainDate, time: PlainTime) -> i64 {
    epoch_day(date) * DAY_MS + time_of_day_ms(time)
}

/// The canonical UTC spelling of an instant — `Date#toISOString`: `YYYY-MM-DDTHH:mm:ss.sssZ` for every four-digit
/// year, the six-digit signed year outside them.
pub fn format_instant(epoch_ms: i64) -> String {
    let date = date_of_epoch_day(epoch_ms.div_euclid(DAY_MS));
    let mut rest = epoch_ms.rem_euclid(DAY_MS);
    let hour = rest / 3_600_000;
    rest -= hour * 3_600_000;
    let minute = rest / 60_000;
    rest -= minute * 60_000;
    let second = rest / 1000;
    let millisecond = rest - second * 1000;
    let year = if (0..=9999).contains(&date.year) {
        format!("{:04}", date.year)
    } else if date.year < 0 {
        format!("-{:06}", -date.year)
    } else {
        format!("+{:06}", date.year)
    };
    format!(
        "{year}-{:02}-{:02}T{hour:02}:{minute:02}:{second:02}.{millisecond:03}Z",
        date.month, date.day
    )
}

fn digits(bytes: &[u8]) -> Option<i64> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    bytes.iter().try_fold(0i64, |sum, byte| {
        sum.checked_mul(10)?.checked_add(i64::from(byte - b'0'))
    })
}

/// Whether `text` is the canonical stored instant: four-digit year (never 0000), milliseconds, `Z` (SVC:26).
pub fn is_utc_instant(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 24 || &b[0..4] == b"0000" {
        return false;
    }
    let shape = digits(&b[0..4]).is_some()
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'.'
        && b[23] == b'Z'
        && digits(&b[20..23]).is_some();
    if !shape {
        return false;
    }
    let (Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        digits(&b[5..7]),
        digits(&b[8..10]),
        digits(&b[11..13]),
        digits(&b[14..16]),
        digits(&b[17..19]),
    ) else {
        return false;
    };
    (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && hour <= 23
        && minute <= 59
        && second <= 59
}

/// `Date.parse` of an RFC 3339 date-time with seconds, an optional fraction and `Z` or a numeric offset: the
/// epoch milliseconds, or `None` when the text is not one or names no real calendar instant.
pub fn parse_instant(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') {
        return None;
    }
    if b[13] != b':' || b[16] != b':' {
        return None;
    }
    let year = digits(&b[0..4])?;
    let month = digits(&b[5..7])?;
    let day = digits(&b[8..10])?;
    let hour = digits(&b[11..13])?;
    let minute = digits(&b[14..16])?;
    let second = digits(&b[17..19])?;
    let mut at = 19;
    let mut millisecond = 0;
    if b.get(at) == Some(&b'.') {
        let start = at + 1;
        let mut end = start;
        while b.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        if end == start {
            return None;
        }
        let fraction = &b[start..end.min(start + 3)];
        millisecond = digits(fraction)? * 10i64.pow(3 - fraction.len() as u32);
        at = end;
    }
    let offset_minutes = match &b[at..] {
        [b'Z' | b'z'] => 0,
        [sign @ (b'+' | b'-'), h1, h2, b':', m1, m2] => {
            let hours = digits(&[*h1, *h2])?;
            let minutes = digits(&[*m1, *m2])?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let total = hours * 60 + minutes;
            if *sign == b'+' { total } else { -total }
        }
        _ => return None,
    };
    if !is_real_date(year, month, day) || hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    if hour == 24 && (minute != 0 || second != 0 || millisecond != 0) {
        return None;
    }
    let wall = days_from_civil(year, month as u32, day as u32) * DAY_MS
        + ((hour * 60 + minute) * 60 + second) * 1000
        + millisecond;
    Some(wall - offset_minutes * 60_000)
}

/// Whether `value` has the `Area/Location` shape DSH accepts before asking `Intl` (SVC:31).
pub fn is_iana_shape(value: &str) -> bool {
    let mut segments = value.split('/');
    let Some(first) = segments.next() else {
        return false;
    };
    let allowed =
        |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+' | b'.' | b'-');
    let first_ok = first
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic())
        && first.bytes().all(allowed);
    let mut rest = 0;
    for segment in segments {
        if segment.is_empty() || !segment.bytes().all(allowed) {
            return false;
        }
        rest += 1;
    }
    first_ok && rest > 0
}

/// Validate and canonicalize one raw time-zone selector — DSH's `canonicalizeTimeZone` (SVC:212-223).
///
/// `UTC` or an `Area/Location` shape first, so a bare abbreviation such as `PST` or a lowercase `utc` is refused;
/// then the database's own spelling. The names `Intl` resolves to `UTC` answer `UTC`.
pub fn canonicalize_time_zone(value: &str) -> Result<String, ScheduleInputError> {
    let invalid = || ScheduleInputError::new(ScheduleErrorCode::InvalidTimeZone, INVALID_ZONE);
    if value.is_empty() || js::trim(value) != value || (value != "UTC" && !is_iana_shape(value)) {
        return Err(invalid());
    }
    if value == "UTC"
        || UTC_ALIASES
            .iter()
            .any(|alias| alias.eq_ignore_ascii_case(value))
    {
        return Ok("UTC".to_owned());
    }
    let (canonical, _) = crate::tzif::lookup(value).ok_or_else(invalid)?;
    if canonical != "UTC" && !is_iana_shape(&canonical) {
        return Err(ScheduleInputError::new(
            ScheduleErrorCode::InvalidTimeZone,
            "time_zone must resolve to UTC or an IANA Area/Location name.",
        ));
    }
    Ok(canonical)
}

/// A zone's UTC offset at one instant, in milliseconds (wall time minus UTC). An unknown zone reads as UTC: every
/// stored zone was validated when it was decoded.
pub fn offset_at(epoch_ms: i64, time_zone: &str) -> i64 {
    if time_zone == "UTC" {
        return 0;
    }
    match crate::tzif::lookup(time_zone) {
        Some((_, data)) => data.offset_at(epoch_ms.div_euclid(1000)) * 1000,
        None => 0,
    }
}

/// The wall-clock reading of an instant in a zone, as an as-if-UTC epoch.
pub fn zoned_wall_ms(epoch_ms: i64, time_zone: &str) -> i64 {
    epoch_ms + offset_at(epoch_ms, time_zone)
}

/// The local calendar date of an instant in a zone.
pub fn local_date(epoch_ms: i64, time_zone: &str) -> PlainDate {
    date_of_epoch_day(zoned_wall_ms(epoch_ms, time_zone).div_euclid(DAY_MS))
}

/// The local wall-clock time of an instant in a zone.
pub fn local_time(epoch_ms: i64, time_zone: &str) -> PlainTime {
    let wall = zoned_wall_ms(epoch_ms, time_zone);
    let mut rest = wall.rem_euclid(DAY_MS);
    let hour = rest / 3_600_000;
    rest -= hour * 3_600_000;
    let minute = rest / 60_000;
    rest -= minute * 60_000;
    let second = rest / 1000;
    PlainTime::new(
        hour as u32,
        minute as u32,
        second as u32,
        (rest - second * 1000) as u32,
    )
}

/// The instant a local date and time names in a zone, or `None` when that wall time does not exist there
/// (DSH's `localInstant`, SVC:245-248): a gap has no instant, and an overlap answers its earlier one.
pub fn local_instant(date: PlainDate, time: PlainTime, time_zone: &str) -> Option<i64> {
    let wall = wall_ms(date, time);
    let before = offset_at(wall - DAY_MS, time_zone);
    let after = offset_at(wall + DAY_MS, time_zone);
    let mut earliest: Option<i64> = None;
    for offset in if before == after {
        vec![before]
    } else {
        vec![before, after]
    } {
        let instant = wall - offset;
        if zoned_wall_ms(instant, time_zone) != wall {
            continue;
        }
        if earliest.is_none_or(|current| instant < current) {
            earliest = Some(instant);
        }
    }
    earliest
}

#[cfg(test)]
mod tests {
    use super::*;

    const LA: &str = "America/Los_Angeles";

    fn time(hour: u32, minute: u32) -> PlainTime {
        PlainTime::new(hour, minute, 0, 0)
    }

    fn at(text: &str) -> i64 {
        parse_instant(text).unwrap_or_else(|| panic!("{text} parses"))
    }

    fn refuses_zone(value: &str) {
        let error = canonicalize_time_zone(value).expect_err(value);
        assert_eq!(error.code, ScheduleErrorCode::InvalidTimeZone, "{value}");
        assert_eq!(error.message, INVALID_ZONE, "{value}");
    }

    #[test]
    fn zones_canonicalize_and_anything_else_is_invalid_time_zone() {
        assert_eq!(canonicalize_time_zone("UTC").unwrap(), "UTC");
        assert_eq!(
            canonicalize_time_zone("Asia/Shanghai").unwrap(),
            "Asia/Shanghai"
        );
        assert_eq!(
            canonicalize_time_zone("Etc/UTC").unwrap(),
            "UTC",
            "an alias resolves to UTC"
        );
        assert_eq!(
            canonicalize_time_zone("asia/shanghai").unwrap(),
            "Asia/Shanghai",
            "the database spelling"
        );
        assert!(
            canonicalize_time_zone("America/Argentina/Buenos_Aires")
                .unwrap()
                .contains("Buenos_Aires"),
            "a three-part name is an Area/Location name"
        );
        for bad in [
            "",
            "utc",
            "PST",
            " UTC",
            "UTC ",
            "Mars/Phobos",
            "Asia/",
            "/Asia",
            "asia shanghai",
        ] {
            refuses_zone(bad);
        }
    }

    #[test]
    fn epoch_days_round_trip_across_leap_years_year_0_and_the_four_digit_edges() {
        for date in [
            PlainDate::new(1970, 1, 1),
            PlainDate::new(2000, 2, 29),
            PlainDate::new(1900, 3, 1),
            PlainDate::new(0, 12, 31),
            PlainDate::new(1, 1, 1),
            PlainDate::new(9999, 12, 31),
            PlainDate::new(2026, 10, 29),
        ] {
            assert_eq!(date_of_epoch_day(epoch_day(date)), date);
        }
        assert_eq!(epoch_day(PlainDate::new(1970, 1, 1)), 0);
        assert_eq!(
            add_days(PlainDate::new(2028, 2, 28), 1),
            PlainDate::new(2028, 2, 29)
        );
        assert_eq!(
            add_days(PlainDate::new(2026, 1, 1), -1),
            PlainDate::new(2025, 12, 31)
        );
    }

    #[test]
    fn weekday_month_and_year_steps_follow_temporal() {
        assert_eq!(iso_day_of_week(PlainDate::new(2026, 10, 26)), 1, "a Monday");
        assert_eq!(iso_day_of_week(PlainDate::new(2026, 11, 1)), 7, "a Sunday");
        assert_eq!(iso_day_of_week(PlainDate::new(1970, 1, 1)), 4, "a Thursday");
        assert_eq!(
            first_of_next_month(PlainDate::new(2026, 1, 31)),
            PlainDate::new(2026, 2, 1)
        );
        assert_eq!(
            first_of_next_month(PlainDate::new(2026, 12, 5)),
            PlainDate::new(2027, 1, 1)
        );
        assert_eq!(
            last_of_previous_month(PlainDate::new(2028, 3, 17)),
            PlainDate::new(2028, 2, 29)
        );
        assert_eq!(
            add_years(PlainDate::new(2028, 2, 29), 1),
            PlainDate::new(2029, 2, 28)
        );
        assert_eq!(
            add_years(PlainDate::new(2028, 2, 29), 400),
            PlainDate::new(2428, 2, 29)
        );
    }

    #[test]
    fn offsets_come_from_the_iana_data_including_the_hour_change_and_local_mean_time() {
        assert_eq!(offset_at(at("2026-01-15T12:00:00Z"), LA), -8 * 3_600_000);
        assert_eq!(offset_at(at("2026-07-15T12:00:00Z"), LA), -7 * 3_600_000);
        assert_eq!(
            offset_at(at("2026-07-15T12:00:00Z"), "Asia/Kolkata"),
            5 * 3_600_000 + 1_800_000
        );
        assert_eq!(
            offset_at(at("2026-07-15T12:00:00Z"), "Asia/Shanghai"),
            8 * 3_600_000
        );
        assert_eq!(offset_at(at("2026-07-15T12:00:00Z"), "UTC"), 0);
        assert_eq!(
            offset_at(MIN_FOUR_DIGIT_YEAR_MS, LA),
            -(7 * 3600 + 52 * 60 + 58) * 1000,
            "Los Angeles' local mean time"
        );
    }

    #[test]
    fn local_date_and_time_of_an_instant_in_a_zone() {
        let instant = at("2026-11-01T08:30:00.250Z");
        assert_eq!(local_date(instant, LA), PlainDate::new(2026, 11, 1));
        assert_eq!(local_time(instant, LA), PlainTime::new(1, 30, 0, 250));
        assert_eq!(
            local_date(MIN_FOUR_DIGIT_YEAR_MS, LA),
            PlainDate::new(0, 12, 31)
        );
        assert_eq!(
            local_date(MAX_FOUR_DIGIT_YEAR_MS, "UTC"),
            PlainDate::new(9999, 12, 31)
        );
    }

    #[test]
    fn a_wall_time_in_a_dst_gap_has_no_instant() {
        let day = PlainDate::new(2026, 3, 8);
        assert_eq!(local_instant(day, time(2, 30), LA), None);
        assert_eq!(local_instant(day, time(2, 0), LA), None);
        assert_eq!(
            format_instant(local_instant(day, time(3, 0), LA).unwrap()),
            "2026-03-08T10:00:00.000Z"
        );
        assert_eq!(
            format_instant(local_instant(day, PlainTime::new(1, 59, 59, 999), LA).unwrap()),
            "2026-03-08T09:59:59.999Z"
        );
    }

    #[test]
    fn a_wall_time_in_a_dst_overlap_resolves_to_the_earlier_instant() {
        let day = PlainDate::new(2026, 11, 1);
        assert_eq!(
            format_instant(local_instant(day, time(1, 30), LA).unwrap()),
            "2026-11-01T08:30:00.000Z"
        );
        assert_eq!(
            format_instant(local_instant(day, time(1, 0), LA).unwrap()),
            "2026-11-01T08:00:00.000Z"
        );
        assert_eq!(
            format_instant(local_instant(day, time(2, 0), LA).unwrap()),
            "2026-11-01T10:00:00.000Z"
        );
    }

    #[test]
    fn half_hour_and_date_line_zones_resolve_exactly() {
        assert_eq!(
            format_instant(
                local_instant(PlainDate::new(2026, 10, 29), time(23, 0), "Asia/Shanghai").unwrap()
            ),
            "2026-10-29T15:00:00.000Z"
        );
        assert_eq!(
            format_instant(
                local_instant(PlainDate::new(2026, 1, 1), time(0, 0), "Asia/Kathmandu").unwrap()
            ),
            "2025-12-31T18:15:00.000Z"
        );
        assert_eq!(
            local_instant(PlainDate::new(2011, 12, 30), time(12, 0), "Pacific/Apia"),
            None,
            "Samoa skipped 2011-12-30 entirely"
        );
    }

    #[test]
    fn instants_are_spelled_canonically() {
        assert_eq!(
            format_instant(at("2026-10-29T15:00:00Z")),
            "2026-10-29T15:00:00.000Z"
        );
        assert_eq!(
            format_instant(MIN_FOUR_DIGIT_YEAR_MS),
            "0001-01-01T00:00:00.000Z"
        );
        assert_eq!(
            format_instant(MAX_FOUR_DIGIT_YEAR_MS),
            "9999-12-31T23:59:59.999Z"
        );
        assert!(is_utc_instant("2026-10-29T15:00:00.000Z"));
        assert!(!is_utc_instant("2026-10-29T15:00:00Z"));
        assert!(!is_utc_instant("0000-10-29T15:00:00.000Z"));
        assert_eq!(
            parse_instant("2026-10-30T20:00:00.5+08:00"),
            Some(at("2026-10-30T12:00:00.500Z"))
        );
        assert_eq!(parse_instant("2026-02-30T00:00:00.000Z"), None);
    }
}
