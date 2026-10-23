//! The few JavaScript behaviours the projections must reproduce to stay byte-compatible.
//!
//! The TypeScript build writes timestamps with `Date#toISOString`, measures with `Date.parse`, truncates with
//! `String#slice` on UTF-16 units, folds whitespace with JavaScript's `\s`, escapes HTML with the project's
//! renderer, and names downloads with `encodeURIComponent`. Each is a place a port silently differs, so each
//! helper is written once, here, and judged by its own tests rather than re-invented per module.
//!
//! The known divergences are the deliberate ones: a timestamp without a zone is read as UTC (JavaScript reads
//! it as local time, and the log always writes `toISOString()`), and a slice at a UTF-16 boundary never splits
//! a surrogate pair (JavaScript can leave a lone half).

use serde_json::Value;

/// Whether `c` is in JavaScript's `\s` set (`WhiteSpace` + `LineTerminator`).
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

/// `String#trim`, in JavaScript's `\s` set.
pub fn trim(text: &str) -> &str {
    let start = text
        .char_indices()
        .find(|(_, c)| !is_space(*c))
        .map(|(index, _)| index)
        .unwrap_or(text.len());
    let end = text
        .char_indices()
        .rev()
        .find(|(_, c)| !is_space(*c))
        .map(|(index, c)| index + c.len_utf8())
        .unwrap_or(0);
    if start >= end { "" } else { &text[start..end] }
}

/// `text.replace(/\s+/g, ' ')`, in JavaScript's `\s` set.
pub fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_space(c) {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// The length of `text` in UTF-16 code units, which is what JavaScript's `String#length` counts.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, max)` in UTF-16 code units, cut at a character boundary.
pub fn utf16_slice(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, c) in text.char_indices() {
        let width = c.len_utf16();
        if units + width > max {
            return &text[..index];
        }
        units += width;
    }
    text
}

/// `encodeURIComponent(text)`: the unreserved set is `A-Za-z0-9-_.!~*'()`, everything else a `%XX` of its
/// UTF-8 bytes.
pub fn encode_uri_component(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(c);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

/// The project's HTML escaper (`escapeHtml` of `src/server/markdown.ts`).
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// `JSON.stringify(value, null, 2)` — two-space indentation, no trailing newline.
pub fn stringify_pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_owned())
}

/// `JSON.stringify(value)`.
pub fn stringify_compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned())
}

/// `Date.parse(text)` for the ISO-8601 the harness writes, in epoch milliseconds.
///
/// Accepts `YYYY-MM-DD` (UTC midnight) and `YYYY-MM-DDTHH:MM[:SS[.fff]]` with `Z` or a `±HH:MM` / `±HHMM`
/// offset. A timestamp with no zone is read as UTC — the documented divergence; the log always writes `Z`.
pub fn parse_time_ms(text: &str) -> Option<i64> {
    let text = trim(text);
    let bytes = text.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let year: i64 = digits(bytes.get(0..4)?)?;
    if bytes.get(4)? != &b'-' {
        return None;
    }
    let month: i64 = digits(bytes.get(5..7)?)?;
    if bytes.get(7)? != &b'-' {
        return None;
    }
    let day: i64 = digits(bytes.get(8..10)?)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut hour = 0i64;
    let mut minute = 0i64;
    let mut second = 0i64;
    let mut millis = 0i64;
    let mut offset_ms = 0i64;
    let rest = &text[10..];
    if !rest.is_empty() {
        let rest = rest.strip_prefix('T').or_else(|| rest.strip_prefix(' '))?;
        let bytes = rest.as_bytes();
        if bytes.len() < 5 {
            return None;
        }
        hour = digits(bytes.get(0..2)?)?;
        if bytes.get(2)? != &b':' {
            return None;
        }
        minute = digits(bytes.get(3..5)?)?;
        if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
            return None;
        }
        let mut tail = &rest[5..];
        if let Some(next) = tail.strip_prefix(':') {
            let bytes = next.as_bytes();
            if bytes.len() < 2 {
                return None;
            }
            second = digits(bytes.get(0..2)?)?;
            if !(0..=59).contains(&second) {
                return None;
            }
            tail = &next[2..];
        }
        if let Some(next) = tail.strip_prefix('.') {
            let digits_end = next
                .bytes()
                .position(|byte| !byte.is_ascii_digit())
                .unwrap_or(next.len());
            let fraction = &next[..digits_end];
            if fraction.is_empty() {
                return None;
            }
            // `Date.parse` truncates a longer fraction rather than rounding it.
            let mut value = 0i64;
            for (index, byte) in fraction.bytes().take(3).enumerate() {
                value += (byte - b'0') as i64 * 10i64.pow(2 - index as u32);
            }
            millis = value;
            tail = &next[digits_end..];
        }
        if !tail.is_empty() {
            let sign = match tail.as_bytes().first()? {
                b'Z' | b'z' => {
                    if tail.len() != 1 {
                        return None;
                    }
                    0
                }
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            if sign != 0 {
                let zone = &tail[1..];
                let (hours, minutes) = match zone.len() {
                    5 if zone.as_bytes()[2] == b':' => (
                        digits(&zone.as_bytes()[0..2])?,
                        digits(&zone.as_bytes()[3..5])?,
                    ),
                    4 => (
                        digits(&zone.as_bytes()[0..2])?,
                        digits(&zone.as_bytes()[2..4])?,
                    ),
                    _ => return None,
                };
                offset_ms = sign * (hours * 3_600_000 + minutes * 60_000);
            }
        }
    }
    let days = days_from_civil(year, month as u32, day as u32);
    Some(
        days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis
            - offset_ms,
    )
}

/// `Date#toISOString`: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn to_iso_string(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        month,
        day,
        rem / 3_600_000,
        (rem / 60_000) % 60,
        (rem / 1_000) % 60,
        rem % 1_000
    )
}

fn digits(bytes: &[u8]) -> Option<i64> {
    let mut value = 0i64;
    for &byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + (byte - b'0') as i64;
    }
    Some(value)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 } as i64;
    let day_of_year = (153 * shifted_month + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The proleptic Gregorian date for a day count since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_space_set_is_javascripts() {
        for text in
            [" \t\n\u{0b}\u{0c}\r\u{a0}\u{1680}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}"]
        {
            for c in text.chars() {
                assert!(is_space(c), "{c:?} is whitespace");
            }
        }
        // U+0085 is Unicode whitespace but not JavaScript's.
        assert!(!is_space('\u{0085}'));
        assert_eq!(trim("\u{3000} a b \u{feff}"), "a b");
        assert_eq!(trim("   "), "");
        assert_eq!(collapse_spaces("a \n\t b   c"), "a b c");
        assert_eq!(collapse_spaces("\u{3000}lead"), " lead");
    }

    #[test]
    fn slicing_counts_utf16_units_and_never_splits_a_pair() {
        assert_eq!(utf16_len("abc"), 3);
        // U+1F600 is one character but two UTF-16 units.
        assert_eq!(utf16_len("a😀b"), 4);
        assert_eq!(utf16_slice("abcdef", 3), "abc");
        assert_eq!(utf16_slice("a😀b", 2), "a");
        assert_eq!(utf16_slice("a😀b", 3), "a😀");
        assert_eq!(utf16_slice("abc", 99), "abc");
        assert_eq!(utf16_slice("abc", 0), "");
    }

    #[test]
    fn encode_uri_component_matches_the_browser() {
        assert_eq!(encode_uri_component("a b"), "a%20b");
        assert_eq!(encode_uri_component("a/b:c?d"), "a%2Fb%3Ac%3Fd");
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
        assert_eq!(encode_uri_component("é"), "%C3%A9");
        assert_eq!(encode_uri_component("a\"b'"), "a%22b'");
    }

    #[test]
    fn html_escaping_covers_the_five_characters_the_renderer_escapes() {
        assert_eq!(
            escape_html("a & <b> \"c\" 'd'"),
            "a &amp; &lt;b&gt; &quot;c&quot; &#39;d&#39;"
        );
        assert_eq!(escape_html("plain"), "plain");
    }

    #[test]
    fn times_parse_and_round_trip_as_iso_strings() {
        assert_eq!(parse_time_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_time_ms("2026-10-11T10:00:00.100Z"),
            Some(1_791_712_800_100)
        );
        assert_eq!(
            parse_time_ms("2026-10-11T10:00:00Z"),
            Some(1_791_712_800_000)
        );
        assert_eq!(
            parse_time_ms("2026-10-11"),
            Some(1_791_676_800_000),
            "a date with no zone is UTC midnight"
        );
        // A two-hour offset is two hours earlier in UTC.
        assert_eq!(
            parse_time_ms("2026-10-11T12:00:00+02:00"),
            Some(parse_time_ms("2026-10-11T10:00:00Z").unwrap())
        );
        assert_eq!(
            parse_time_ms("2026-10-11T08:00:00-0200"),
            Some(parse_time_ms("2026-10-11T10:00:00Z").unwrap())
        );
        // A longer fraction is truncated, as `Date.parse` does.
        assert_eq!(
            parse_time_ms("2026-10-11T10:00:00.1239Z"),
            parse_time_ms("2026-10-11T10:00:00.123Z")
        );
        assert_eq!(parse_time_ms("not a time"), None);
        assert_eq!(parse_time_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_time_ms(""), None);
        assert_eq!(to_iso_string(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(to_iso_string(1_791_712_800_100), "2026-10-11T10:00:00.100Z");
        assert_eq!(to_iso_string(-86_400_000), "1969-12-31T00:00:00.000Z");
    }

    #[test]
    fn iso_strings_round_trip_every_month_boundary() {
        for text in [
            "2026-01-01T00:00:00.000Z",
            "2026-02-28T23:59:59.999Z",
            "2026-03-01T00:00:00.000Z",
            "2024-02-29T12:34:56.789Z",
            "2026-12-31T23:59:59.999Z",
        ] {
            let ms = parse_time_ms(text).unwrap();
            assert_eq!(to_iso_string(ms), text, "{text} round-trips");
        }
    }

    #[test]
    fn a_value_stringifies_as_json_stringify_does() {
        let value: Value = serde_json::json!({"a": 1, "b": [true, null]});
        assert_eq!(stringify_compact(&value), "{\"a\":1,\"b\":[true,null]}");
        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"a\": 1,\n  \"b\": [\n    true,\n    null\n  ]\n}"
        );
    }
}
