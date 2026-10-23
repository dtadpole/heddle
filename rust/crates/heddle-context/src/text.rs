//! The two JavaScript string rules the TypeScript build's numbers rest on.
//!
//! Every length this crate compares — four characters per token, the pruner's thresholds — was a
//! JavaScript `.length`, which counts UTF-16 code units, and every digest was taken over
//! `String.prototype.trim()`, whose whitespace set is not Rust's. Matching both is what keeps an
//! estimate, a prune boundary and a baseline identity equal across the two builds, so a session one
//! build wrote is priced and recognised the same by the other.

// Temporary, while the API lands ahead of the bodies: the meter, the pruner and the instructions
// module call these once they are implemented, and this allowance goes with that change.
#![allow(dead_code)]

/// The length JavaScript reports for `text`: its UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    let _ = text;
    todo!("utf16_len")
}

/// `text` trimmed the way `String.prototype.trim()` trims it.
///
/// JavaScript's set is WhiteSpace plus LineTerminator: it includes U+FEFF and excludes U+0085,
/// where Rust's `char::is_whitespace` does the opposite.
pub(crate) fn js_trim(text: &str) -> &str {
    let _ = text;
    todo!("js_trim")
}
