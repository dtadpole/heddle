//! `JSON.stringify` as JavaScript writes it, numbers included.
//!
//! The text this crate shows a person, or writes into a downloaded log, is `JSON.stringify` output in the
//! TypeScript build: a tool's arguments re-indented for the inspector (`JSON.stringify(JSON.parse(text), null,
//! 2)`), the schema parameters, an unknown event's other fields, every line of the `/log` body. JavaScript reads
//! every JSON number as one double and prints it by `Number#toString`, so a model's `1.0` comes back `1`, `1e3`
//! comes back `1000`, and `1e21` comes back `1e+21`. `serde_json` keeps an integer an integer and prints a double
//! with a trailing `.0` — measured against the TypeScript inspector: `"timeout": 1.0` where it shows `1`.
//!
//! So the layout is `serde_json`'s (the same two-space indentation and escaping as `JSON.stringify`), and only
//! the numbers go through [`js_number`]. Answer bodies the page parses do not need this; it is for text a person
//! reads and bytes a download promises.

use std::io;

use serde::Serialize;
use serde_json::Value;
use serde_json::ser::{CompactFormatter, Formatter, PrettyFormatter};

/// `Number#toString()` of a finite double: the shortest digits that read back as the same number, in
/// JavaScript's layout — plain digits for `1e-6 <= |x| < 1e21`, else `d.ddde±n`. `-0` is `0`.
pub(crate) fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    if !value.is_finite() {
        // `JSON.stringify(NaN)` is `null`; a parsed JSON number is always finite, so this is defensive.
        return "null".to_owned();
    }
    let negative = value < 0.0;
    // Rust's `{:e}` writes the shortest round-trip digits, `d.ddd` then `e` and the exponent.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("`{:e}` always writes an exponent");
    let exponent: i32 = exponent.parse().expect("an integral exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    // `n` is the position of the decimal point relative to the digits, as ECMA-262's Number::toString states it.
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n >= 1 { '+' } else { '-' };
        let magnitude = (n - 1).abs();
        if k == 1 {
            format!("{digits}e{sign}{magnitude}")
        } else {
            format!("{}.{}e{sign}{magnitude}", &digits[..1], &digits[1..])
        }
    };
    if negative { format!("-{body}") } else { body }
}

/// A formatter that writes every number as JavaScript would and delegates the layout to `F`.
struct JsNumbers<F>(F);

macro_rules! delegate {
    ($($name:ident($($arg:ident: $ty:ty),*)),* $(,)?) => {
        $(
            fn $name<W: ?Sized + io::Write>(&mut self, writer: &mut W $(, $arg: $ty)*) -> io::Result<()> {
                self.0.$name(writer $(, $arg)*)
            }
        )*
    };
}

impl<F: Formatter> Formatter for JsNumbers<F> {
    delegate!(
        begin_array(),
        end_array(),
        begin_array_value(first: bool),
        end_array_value(),
        begin_object(),
        end_object(),
        begin_object_key(first: bool),
        end_object_key(),
        begin_object_value(),
        end_object_value(),
    );

    fn write_i64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: i64) -> io::Result<()> {
        writer.write_all(js_number(value as f64).as_bytes())
    }

    fn write_u64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: u64) -> io::Result<()> {
        writer.write_all(js_number(value as f64).as_bytes())
    }

    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(js_number(value).as_bytes())
    }
}

fn write_with<F: Formatter>(value: &Value, formatter: F) -> String {
    let mut out = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, JsNumbers(formatter));
    value
        .serialize(&mut serializer)
        .expect("a JSON value always serialises into memory");
    String::from_utf8(out).expect("serde_json writes UTF-8")
}

/// `JSON.stringify(value, null, 2)`.
pub(crate) fn stringify_pretty(value: &Value) -> String {
    write_with(value, PrettyFormatter::with_indent(b"  "))
}

/// `JSON.stringify(value)`.
pub(crate) fn stringify_compact(value: &Value) -> String {
    write_with(value, CompactFormatter)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// `JSON.stringify(JSON.parse(text))`, read from Node 24 on 2026-10-22, for inputs a model or a log can hold.
    const NODE: &[(&str, &str)] = &[
        ("1.0", "1"),
        ("1e3", "1000"),
        ("12345678901234567890", "12345678901234567000"),
        ("-0.5", "-0.5"),
        ("2.50", "2.5"),
        ("0.1", "0.1"),
        ("1e-7", "1e-7"),
        ("0.000001", "0.000001"),
        ("1e21", "1e+21"),
        ("1e+21", "1e+21"),
        ("123456789012345678901234", "1.2345678901234569e+23"),
        ("1.7976931348623157e308", "1.7976931348623157e+308"),
        ("5e-324", "5e-324"),
        ("-0", "0"),
        ("0", "0"),
        ("-1.5e-9", "-1.5e-9"),
        ("100", "100"),
        ("0.30000000000000004", "0.30000000000000004"),
        ("9007199254740993", "9007199254740992"),
        ("1.5e300", "1.5e+300"),
    ];

    #[test]
    fn every_number_reads_back_as_node_prints_it() {
        for (input, expected) in NODE {
            let value: Value = serde_json::from_str(input).expect("a JSON number");
            assert_eq!(
                stringify_compact(&value),
                *expected,
                "JSON.stringify(JSON.parse({input:?}))"
            );
        }
    }

    #[test]
    fn the_layout_is_json_stringifys_with_two_space_indentation() {
        // `JSON.stringify(JSON.parse('{"a":[1.0,{"b":2e2}],"c":"x\u001fy"}'), null, 2)` in Node 24.
        let value: Value =
            serde_json::from_str("{\"a\":[1.0,{\"b\":2e2}],\"c\":\"x\\u001fy\"}").unwrap();
        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": 200\n    }\n  ],\n  \"c\": \"x\\u001fy\"\n}"
        );
        assert_eq!(
            stringify_compact(&value),
            "{\"a\":[1,{\"b\":200}],\"c\":\"x\\u001fy\"}"
        );
    }

    #[test]
    fn empty_containers_and_scalars_keep_their_shape() {
        assert_eq!(stringify_pretty(&json!({})), "{}");
        assert_eq!(stringify_pretty(&json!([])), "[]");
        assert_eq!(stringify_pretty(&json!({"a": []})), "{\n  \"a\": []\n}");
        assert_eq!(
            stringify_compact(&json!([true, null, "s", -3])),
            "[true,null,\"s\",-3]"
        );
    }

    #[test]
    fn negative_zero_and_integral_doubles_lose_their_fraction() {
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(1500.0), "1500");
        assert_eq!(js_number(-2.0), "-2");
        assert_eq!(js_number(0.5), "0.5");
    }
}
