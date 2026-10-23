//! Timestamps, spelled the way the TypeScript build spells them.
//!
//! Every `at`, `created`, `updated`, `pinnedAt` and `createdAt` the store writes is
//! `new Date().toISOString()`: UTC, milliseconds always present, a trailing `Z` —
//! `2026-10-22T18:17:41.123Z`. Those strings are compared **as strings** (the session list sorts by
//! `created`, the tree by `updated` and `pinnedAt`), so a second spelling — microseconds, or `+00:00` —
//! would sort wrong against a log the other build wrote, not merely look different.

/// Now, as `Date.prototype.toISOString` prints it.
pub fn iso_now() -> String {
    todo!("port: chrono::Utc::now() formatted as %Y-%m-%dT%H:%M:%S%.3fZ")
}

/// One instant as `toISOString` prints it. Exposed so a test can pin a time.
pub fn iso_from(instant: chrono::DateTime<chrono::Utc>) -> String {
    todo!()
}

/// Parse a string `toISOString` wrote back into an instant; `None` when it is not one.
///
/// Used where the TypeScript build calls `new Date(text)` — naming a definition after its
/// `createdAt` — so a record from either build names the same folder.
pub fn parse_iso(text: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    todo!()
}

/// The ISO string of the epoch, which the workspace record uses for a missing time
/// (`new Date(0).toISOString()`).
pub const EPOCH_ISO: &str = "1970-01-01T00:00:00.000Z";
