//! The few JavaScript semantics the job checks lean on: `JSON.stringify` of a number or a value inside a refusal
//! sentence, `Number(text)` for the follow route's offset, and `Number.isSafeInteger`.

use serde_json::Value;

/// The largest integer a double holds exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `Number.isSafeInteger(value)`.
pub fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER
}

/// `JSON.stringify(number)`: `null` for NaN and the infinities, an integral value without a fraction, `-0` as `0`.
pub fn json_number(value: f64) -> String {
    if !value.is_finite() {
        return "null".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    format!("{value}")
}

/// `JSON.stringify(value)` for a value a model wrote, with an integral number written as JavaScript writes it.
pub fn json_value(value: &Value) -> String {
    match value {
        Value::Number(number) => match number.as_f64() {
            Some(float) if !number.is_i64() && !number.is_u64() => json_number(float),
            _ => number.to_string(),
        },
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_owned()),
    }
}

fn is_js_space(c: char) -> bool {
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
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `Number(text)`: surrounding whitespace ignored, empty is 0, `Infinity` with an optional sign, `0x`/`0o`/`0b`
/// integers, else a decimal literal; anything else is NaN.
pub fn number_from_text(text: &str) -> f64 {
    let trimmed = text.trim_matches(is_js_space);
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let radix = match trimmed.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &trimmed[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        return digits.chars().fold(0.0, |total, c| {
            total * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
        });
    }
    if decimal_literal(trimmed) {
        trimmed.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `[+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?`
fn decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        index += 1;
    }
    let integral = bytes[index..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count();
    index += integral;
    let mut fraction = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        fraction = bytes[index..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        index += fraction;
    }
    if integral == 0 && fraction == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let exponent = bytes[index..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if exponent == 0 {
            return false;
        }
        index += exponent;
    }
    index == bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_and_parse_as_javascript_does() {
        assert_eq!(json_number(-3.0), "-3");
        assert_eq!(json_number(1.5), "1.5");
        assert_eq!(json_number(f64::NAN), "null");
        assert_eq!(json_number(-0.0), "0");
        assert_eq!(number_from_text(" 12 "), 12.0);
        assert_eq!(number_from_text(""), 0.0);
        assert_eq!(number_from_text("-3"), -3.0);
        assert_eq!(number_from_text("1e3"), 1000.0);
        assert_eq!(number_from_text("0x1F"), 31.0);
        assert!(number_from_text("abc").is_nan());
        assert!(number_from_text("inf").is_nan());
        assert!(number_from_text("1.2.3").is_nan());
        assert_eq!(number_from_text(".5"), 0.5);
        assert!(is_safe_integer(4.0) && !is_safe_integer(1.5) && !is_safe_integer(f64::NAN));
        assert_eq!(json_value(&serde_json::json!(5)), "5");
        assert_eq!(json_value(&serde_json::json!(true)), "true");
        assert_eq!(json_value(&serde_json::json!("")), "\"\"");
    }
}
