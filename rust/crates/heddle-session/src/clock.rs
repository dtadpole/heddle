//! Timestamps, spelled the way the TypeScript build spells them.
//!
//! Every `at`, `created`, `updated`, `pinnedAt` and `createdAt` the store writes is
//! `new Date().toISOString()`: UTC, milliseconds always present, a trailing `Z` —
//! `2026-10-22T18:17:41.123Z`. Those strings are compared **as strings** (the session list sorts by
//! `created`, the tree by `updated` and `pinnedAt`), so a second spelling — microseconds, or `+00:00` —
//! would sort wrong against a log the other build wrote, not merely look different.

use chrono::{DateTime, SecondsFormat, Utc};

/// Now, as `Date.prototype.toISOString` prints it.
pub fn iso_now() -> String {
    iso_from(Utc::now())
}

/// One instant as `toISOString` prints it. Exposed so a test can pin a time.
pub fn iso_from(instant: DateTime<Utc>) -> String {
    // `SecondsFormat::Millis` is exactly what `toISOString` does: always three fractional digits,
    // never more, `Z` rather than `+00:00`.
    instant.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Parse a string `toISOString` wrote back into an instant; `None` when it is not one.
///
/// Used where the TypeScript build calls `new Date(text)` — naming a definition after its
/// `createdAt` — so a record from either build names the same folder.
pub fn parse_iso(text: &str) -> Option<DateTime<Utc>> {
    // The contract is "what `toISOString` wrote", so RFC 3339 is the one accepted spelling. A
    // trailing `Z` and an explicit offset both parse; the result is normalised to UTC.
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|instant| instant.with_timezone(&Utc))
}

/// The ISO string of the epoch, which the workspace record uses for a missing time
/// (`new Date(0).toISOString()`).
pub const EPOCH_ISO: &str = "1970-01-01T00:00:00.000Z";

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-22T18:17:41.123Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn iso_from_prints_milliseconds_and_a_z() {
        assert_eq!(iso_from(fixed()), "2026-10-22T18:17:41.123Z");
    }

    #[test]
    fn iso_from_keeps_leading_zeros_in_milliseconds() {
        let instant = DateTime::parse_from_rfc3339("2026-01-02T03:04:05.007Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(iso_from(instant), "2026-01-02T03:04:05.007Z");
    }

    #[test]
    fn iso_from_never_shortens_the_fraction() {
        // `toISOString` writes `.000`, not `.0` and not nothing. A formatter that dropped a zero
        // would sort `…:05Z` after `…:05.100Z` and read as a different instant.
        let instant = DateTime::parse_from_rfc3339("2026-10-22T18:17:41Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(iso_from(instant), "2026-10-22T18:17:41.000Z");
    }

    #[test]
    fn a_printed_instant_parses_back_to_itself() {
        let text = iso_from(fixed());
        assert_eq!(parse_iso(&text), Some(fixed()));
    }

    #[test]
    fn parse_iso_accepts_an_explicit_offset_and_normalises_to_utc() {
        assert_eq!(
            parse_iso("2026-10-22T18:17:41.123+00:00")
                .map(iso_from)
                .as_deref(),
            Some("2026-10-22T18:17:41.123Z")
        );
    }

    #[test]
    fn parse_iso_refuses_what_is_not_a_time() {
        assert_eq!(parse_iso("yesterday"), None);
        assert_eq!(parse_iso(""), None);
        assert_eq!(parse_iso("2026-13-01T00:00:00.000Z"), None);
    }

    #[test]
    fn the_epoch_constant_is_what_the_record_writes() {
        assert_eq!(iso_from(DateTime::from_timestamp(0, 0).unwrap()), EPOCH_ISO);
    }
}
