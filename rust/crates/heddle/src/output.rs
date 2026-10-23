//! Where a command writes, and how it prints JSON.
//!
//! Every command writes through an [`Output`] rather than to the process's streams, so a unit test
//! captures both streams with [`Captured`] and asserts on the bytes a verifier would read.
//!
//! JSON is printed by [`stringify`], the port of `JSON.stringify(value, null, 2)`: two-space indent,
//! `[]` and `{}` for empty containers, and a whole number printed without a fraction, because the
//! TypeScript build prints `7` where `serde_json`'s own pretty printer would print `7.0`.

use std::io::Write;

use serde_json::Value;

use crate::Exit;

/// The two streams one run writes to.
pub struct Output<'a> {
    stdout: &'a mut dyn Write,
    stderr: &'a mut dyn Write,
}

impl<'a> Output<'a> {
    /// Write to these streams.
    pub fn new(stdout: &'a mut dyn Write, stderr: &'a mut dyn Write) -> Self {
        Self { stdout, stderr }
    }

    /// Text to stdout, as given. A closed pipe is not an error worth a second message.
    pub fn out(&mut self, text: &str) {
        let _ = self.stdout.write_all(text.as_bytes());
    }

    /// Text to stderr, as given.
    pub fn err(&mut self, text: &str) {
        let _ = self.stderr.write_all(text.as_bytes());
    }

    /// One JSON document to stdout, as `JSON.stringify(value, null, 2)` followed by a newline.
    pub fn json(&mut self, value: &Value) {
        let mut text = stringify(value);
        text.push('\n');
        self.out(&text);
    }

    /// The TypeScript build's top-level failure: `heddle: <message>` on stderr, and exit 1.
    pub fn fail(&mut self, message: &str) -> Exit {
        self.err(&format!("heddle: {message}\n"));
        Exit::Failure
    }
}

/// Both streams captured in memory, for tests.
#[derive(Debug, Default)]
pub struct Captured {
    /// What was written to stdout.
    pub stdout: Vec<u8>,
    /// What was written to stderr.
    pub stderr: Vec<u8>,
}

impl Captured {
    /// An [`Output`] writing into this capture.
    pub fn output(&mut self) -> Output<'_> {
        Output::new(&mut self.stdout, &mut self.stderr)
    }

    /// Stdout as text.
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// Stderr as text.
    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify(value: &Value) -> String {
    let mut text = String::new();
    write_value(&mut text, value, 0);
    text
}

fn write_value(text: &mut String, value: &Value, depth: usize) {
    match value {
        Value::Null => text.push_str("null"),
        Value::Bool(flag) => text.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => text.push_str(&js_number(number)),
        Value::String(string) => text.push_str(&Value::String(string.clone()).to_string()),
        Value::Array(items) if items.is_empty() => text.push_str("[]"),
        Value::Array(items) => {
            text.push_str("[\n");
            for (index, item) in items.iter().enumerate() {
                indent(text, depth + 1);
                write_value(text, item, depth + 1);
                if index + 1 < items.len() {
                    text.push(',');
                }
                text.push('\n');
            }
            indent(text, depth);
            text.push(']');
        }
        Value::Object(map) if map.is_empty() => text.push_str("{}"),
        Value::Object(map) => {
            text.push_str("{\n");
            for (index, (key, item)) in map.iter().enumerate() {
                indent(text, depth + 1);
                text.push_str(&Value::String(key.clone()).to_string());
                text.push_str(": ");
                write_value(text, item, depth + 1);
                if index + 1 < map.len() {
                    text.push(',');
                }
                text.push('\n');
            }
            indent(text, depth);
            text.push('}');
        }
    }
}

fn indent(text: &mut String, depth: usize) {
    for _ in 0..depth {
        text.push_str("  ");
    }
}

/// A number as JavaScript prints it: a whole `f64` below 1e21 without a fraction.
fn js_number(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(float)
            if !number.is_i64()
                && !number.is_u64()
                && float.fract() == 0.0
                && float.abs() < 1e21 =>
        {
            format!("{float:.0}")
        }
        _ => number.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stringify_matches_json_stringify_with_two_space_indent() {
        let value =
            json!({ "id": "alpha", "config": { "label": "x", "count": 7 }, "inject": ["a", "b"] });
        let text = stringify(&value);
        // The shape is JSON.stringify's: one key per line, two spaces per level, `": "` between a
        // key and its value.
        assert!(text.starts_with("{\n  \""), "{text}");
        assert!(text.ends_with("\n}"), "{text}");
        for line in text.lines().skip(1) {
            let indent = line.len() - line.trim_start_matches(' ').len();
            assert_eq!(indent % 2, 0, "two spaces per level: {line:?}");
            assert!(indent <= 4, "this value nests two levels: {line:?}");
        }
        // Key order is the map's own — insertion order when `preserve_order` is on, which the
        // workspace unifies across crates. The contract is the shape and the values, not one order.
        assert_eq!(
            serde_json::from_str::<Value>(&text).expect("the text parses back"),
            value
        );
        assert!(text.contains("\"label\": \"x\""), "{text}");
        assert!(text.contains("\"count\": 7"), "{text}");
        // Arrays keep their order, and every nested level indents by two.
        assert!(
            text.contains("\"inject\": [\n    \"a\",\n    \"b\"\n  ]"),
            "{text}"
        );
    }

    #[test]
    fn empty_containers_print_on_one_line() {
        assert_eq!(stringify(&json!([])), "[]");
        assert_eq!(stringify(&json!({})), "{}");
        assert_eq!(stringify(&json!({ "rows": [] })), "{\n  \"rows\": []\n}");
    }

    #[test]
    fn a_whole_float_prints_as_javascript_prints_it() {
        assert_eq!(stringify(&json!(7.0)), "7");
        assert_eq!(stringify(&json!(-3.0)), "-3");
        assert_eq!(stringify(&json!(0.5)), "0.5");
        assert_eq!(stringify(&json!(42)), "42");
    }

    #[test]
    fn strings_are_escaped_as_json() {
        assert_eq!(stringify(&json!("a\"b\nc")), "\"a\\\"b\\nc\"");
    }

    #[test]
    fn fail_prints_the_typescript_prefix_and_exits_one() {
        let mut captured = Captured::default();
        let exit = captured.output().fail("unknown argument: --bogus");
        assert_eq!(exit, Exit::Failure);
        assert_eq!(
            captured.stderr_text(),
            "heddle: unknown argument: --bogus\n"
        );
        assert!(captured.stdout.is_empty());
    }
}
