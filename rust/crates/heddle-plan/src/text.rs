//! The JavaScript behaviours plan mode reproduces: `String#trim`, the `\s` class, and the session-id shape.
//!
//! The TypeScript build trims a plan and a review's feedback with `String#trim`, tests a plan's heading with `\s`
//! and `\S`, and checks a route's id with `/^session-[0-9a-f-]{36}$/i`. Each is a place a port silently differs,
//! so each is written once, here.

/// Whether `c` is in JavaScript's `String#trim` and `\s` set (`WhiteSpace` + `LineTerminator`).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Whether `c` is a line terminator, which a regular expression's `.` does not match.
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `String#trim`, in JavaScript's whitespace set.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// Whether `id` is a session id as the store mints it: `^session-[0-9a-f-]{36}$`, case-insensitive.
pub fn is_session_id(id: &str) -> bool {
    const PREFIX: &str = "session-";
    let bytes = id.as_bytes();
    bytes.len() == PREFIX.len() + 36
        && bytes[..PREFIX.len()].eq_ignore_ascii_case(PREFIX.as_bytes())
        && bytes[PREFIX.len()..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() || *byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_and_the_space_class_are_javascripts() {
        assert_eq!(trim("  # plan \n"), "# plan");
        assert_eq!(trim("\u{feff}\u{a0}x\u{2028}"), "x");
        assert_eq!(
            trim("\u{85}x"),
            "\u{85}x",
            "NEL is not JavaScript whitespace"
        );
        assert!(is_space('\u{3000}') && !is_space('x'));
        assert!(is_line_terminator('\u{2029}') && !is_line_terminator('\t'));
    }

    #[test]
    fn a_session_id_is_session_dash_a_uuid_shape() {
        assert!(is_session_id(
            "session-00000000-0000-4000-8000-000000000000"
        ));
        assert!(
            is_session_id("SESSION-00000000-0000-4000-8000-000000000000"),
            "the prefix is matched case-insensitively"
        );
        assert!(!is_session_id("nope"));
        assert!(!is_session_id(
            "session-00000000-0000-4000-8000-00000000000g"
        ));
        assert!(!is_session_id(""));
    }
}
