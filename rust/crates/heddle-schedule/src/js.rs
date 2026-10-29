//! The few JavaScript semantics the TypeScript build's checks lean on, so the port refuses exactly what it
//! refuses: `String#trim` and `\s` (ECMAScript white space and line terminators), `String#length` (UTF-16 units),
//! `Number.isSafeInteger` / `Number.isInteger` over a JSON number, `Number(text)`, and `JSON.stringify` of a string.

use serde_json::Value;

/// `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Whether `c` is ECMAScript white space or a line terminator — what `trim` strips and `\s` matches.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `String#trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `String#length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.split(/\s+/)` for a string that is already trimmed and non-empty.
pub fn split_whitespace(text: &str) -> Vec<&str> {
    text.split(is_js_whitespace)
        .filter(|part| !part.is_empty())
        .collect()
}

/// `typeof value === 'number' && Number.isSafeInteger(value)`, as the integer.
pub fn safe_integer(value: &Value) -> Option<i64> {
    let Value::Number(number) = value else {
        return None;
    };
    if let Some(integer) = number.as_i64() {
        return (integer.abs() <= MAX_SAFE_INTEGER).then_some(integer);
    }
    if number.as_u64().is_some() {
        return None;
    }
    let float = number.as_f64()?;
    if float.is_finite() && float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER as f64 {
        Some(float as i64)
    } else {
        None
    }
}

/// Whether a safe integer is safe: `Number.isSafeInteger` over an `i64`.
pub fn is_safe(value: i64) -> bool {
    value.abs() <= MAX_SAFE_INTEGER
}

/// `typeof value === 'number' && Number.isInteger(value)` — any magnitude.
pub fn is_integer(value: &Value) -> bool {
    match value {
        Value::Number(number) => {
            number.is_i64()
                || number.is_u64()
                || number
                    .as_f64()
                    .is_some_and(|float| float.is_finite() && float.fract() == 0.0)
        }
        _ => false,
    }
}

/// `value === n` for a JSON value and a small integer (`1` and `1.0` are the same JavaScript number).
pub fn number_equals(value: &Value, n: i64) -> bool {
    match value {
        Value::Number(number) => number
            .as_i64()
            .map(|integer| integer == n)
            .or_else(|| number.as_f64().map(|float| float == n as f64))
            .unwrap_or(false),
        _ => false,
    }
}

/// `Number(text)`: the numeric value of a string, `NaN` when it has none.
pub fn number(text: &str) -> f64 {
    let trimmed = trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    let (sign, body) = match trimmed.as_bytes()[0] {
        b'+' => (1.0, &trimmed[1..]),
        b'-' => (-1.0, &trimmed[1..]),
        _ => (1.0, trimmed),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            return match u128::from_str_radix(digits, radix) {
                Ok(value) if !digits.is_empty() => value as f64,
                _ => f64::NAN,
            };
        }
    }
    let valid = !body.is_empty()
        && body
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !valid {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// `JSON.stringify(text)`.
pub fn json_string(text: &str) -> String {
    serde_json::to_string(text).expect("a string serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trim_and_split_follow_ecmascript_white_space() {
        assert_eq!(trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(trim("\u{0085}a"), "\u{0085}a", "NEL is not ECMAScript white space");
        assert_eq!(split_whitespace("0  9\t* * 1"), ["0", "9", "*", "*", "1"]);
        assert_eq!(utf16_len("😀"), 2);
    }

    #[test]
    fn safe_integers_are_javascript_numbers() {
        assert_eq!(safe_integer(&json!(60)), Some(60));
        assert_eq!(safe_integer(&json!(60.0)), Some(60));
        assert_eq!(safe_integer(&json!(60.5)), None);
        assert_eq!(safe_integer(&json!(9_007_199_254_740_992_i64)), None);
        assert_eq!(safe_integer(&json!("60")), None);
        assert!(is_integer(&json!(1e300)));
        assert!(!is_integer(&json!(1.5)));
        assert!(number_equals(&json!(1.0), 1));
    }

    #[test]
    fn number_reads_text_the_way_javascript_does() {
        assert_eq!(number(""), 0.0);
        assert_eq!(number(" 5 "), 5.0);
        assert_eq!(number("1e1"), 10.0);
        assert_eq!(number("0x10"), 16.0);
        assert!(number("abc").is_nan());
        assert!(number("inf").is_nan());
    }
}
