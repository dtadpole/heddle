//! The two JavaScript string rules the TypeScript build's numbers rest on.
//!
//! Every length this crate compares — four characters per token, the pruner's thresholds — was a
//! JavaScript `.length`, which counts UTF-16 code units, and every digest was taken over
//! `String.prototype.trim()`, whose whitespace set is not Rust's. Matching both is what keeps an
//! estimate, a prune boundary and a baseline identity equal across the two builds, so a session one
//! build wrote is priced and recognised the same by the other.

/// The length JavaScript reports for `text`: its UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    // `encode_utf16` counts a character outside the BMP as the surrogate pair JavaScript sees.
    text.encode_utf16().count()
}

/// `text` trimmed the way `String.prototype.trim()` trims it.
///
/// JavaScript's set is WhiteSpace plus LineTerminator: it includes U+FEFF and excludes U+0085,
/// where Rust's `char::is_whitespace` does the opposite.
// `js_trim` is used by `instructions` and `compaction`, which land after this file.
#[allow(dead_code)]
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// The characters `String.prototype.trim()` removes: WhiteSpace plus LineTerminator.
fn is_js_whitespace(character: char) -> bool {
    // The Zs category's EN QUAD .. HAIR SPACE run is the one contiguous block.
    if ('\u{2000}'..='\u{200A}').contains(&character) {
        return true;
    }
    matches!(
        character,
        '\u{0009}' // TAB
            | '\u{000A}' // LF
            | '\u{000B}' // VT
            | '\u{000C}' // FF
            | '\u{000D}' // CR
            | '\u{0020}' // SP
            | '\u{00A0}' // NBSP
            | '\u{1680}' // OGHAM SPACE MARK
            | '\u{2028}' // LINE SEPARATOR
            | '\u{2029}' // PARAGRAPH SEPARATOR
            | '\u{202F}' // NARROW NBSP
            | '\u{205F}' // MEDIUM MATHEMATICAL SPACE
            | '\u{3000}' // IDEOGRAPHIC SPACE
            | '\u{FEFF}' // ZERO WIDTH NO-BREAK SPACE
    )
}

#[cfg(test)]
mod tests {
    use super::{js_trim, utf16_len};

    #[test]
    fn utf16_len_counts_surrogate_pairs_and_not_characters() {
        assert_eq!(utf16_len(""), 0);
        assert_eq!(utf16_len("abc"), 3);
        // Outside the BMP a Rust character is two JavaScript code units.
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(utf16_len("a😀b"), 4);
        // A combining mark is one code unit even though it is two bytes of UTF-8.
        assert_eq!(utf16_len("é"), 1);
    }

    #[test]
    fn trim_matches_javascript_and_not_rust() {
        // Rust trims U+0085 as whitespace; JavaScript does not, so the two agree only if it stays.
        assert_eq!(js_trim("\u{0085}hi\u{0085}"), "\u{0085}hi\u{0085}");
        // U+FEFF is the reverse: JavaScript trims it and Rust does not.
        assert_eq!(js_trim("\u{FEFF}hi\u{FEFF}"), "hi");
    }

    #[test]
    fn trim_removes_the_whole_javascript_set_from_both_ends() {
        let padded = "\t\n\u{000B}\u{000C}\r \u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}hi\u{FEFF}\u{3000}\u{205F}\u{202F}\u{2029}\u{2028}\u{200A}\u{2000}\u{1680}\u{00A0} \r\u{000C}\u{000B}\n\t";
        assert_eq!(js_trim(padded), "hi");
    }

    #[test]
    fn trim_keeps_interior_whitespace_and_a_lone_surrogate_lookalike() {
        assert_eq!(js_trim("  a b  "), "a b");
        // U+FFFD is not whitespace, and neither is an unpaired surrogate's replacement.
        assert_eq!(js_trim("\u{FFFD}x\u{FFFD}"), "\u{FFFD}x\u{FFFD}");
    }
}
