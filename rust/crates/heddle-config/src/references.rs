//! Environment references: how a value comes from the environment without being written into a tree.
//!
//! Ported from `referencesIn`, `resolveEnv` and `parseScalar` in `src/config/schema.ts`. Two shapes,
//! and the distinction between them is the point:
//!
//! - `!env NAME` — the **whole** value, read so a number stays a number and a boolean a boolean
//!   (`count: !env COUNT` with `COUNT=7` is the number `7`). This is what a port or a flag needs.
//! - `${NAME}` inside a string — textual substitution (`${PREFIX}/v1`). This is what a URL needs.
//!
//! A missing variable is an **error naming it**, never an empty string: a configuration that silently
//! resolves a missing credential to `''` fails somewhere much further away.

use serde_json::{Map, Number, Value};

use crate::env::Env;
use crate::error::ConfigError;
use crate::value::LayerValue;

/// Every `${NAME}` reference in `text`, in order, repeats included. A name is
/// `[A-Za-z_][A-Za-z0-9_]*`; anything else between `${` and `}` is not a reference and stays as written.
pub fn references_in(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut names = Vec::new();
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] == b'$' && bytes[index + 1] == b'{' {
            let start = index + 2;
            if start < bytes.len() && is_name_start(bytes[start]) {
                let mut end = start + 1;
                while end < bytes.len() && is_name_continue(bytes[end]) {
                    end += 1;
                }
                if end < bytes.len() && bytes[end] == b'}' {
                    names.push(text[start..end].to_string());
                    index = end + 1;
                    continue;
                }
            }
        }
        index += 1;
    }
    names
}

fn is_name_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_name_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `value` with every reference resolved, as JSON.
///
/// `file` names the layer in a problem: `{file}: the environment reference !env NAME is not set`, or
/// `${NAME}` for the textual shape; `{file}: include is only allowed as a layer entry, not inside a
/// value` for an [`LayerValue::Include`]. The first problem found is returned.
pub fn resolve_env(value: &LayerValue, file: &str, env: &Env) -> Result<Value, ConfigError> {
    Ok(match value {
        LayerValue::Null => Value::Null,
        LayerValue::Bool(flag) => Value::Bool(*flag),
        LayerValue::Number(number) => Value::Number(number.clone()),
        LayerValue::String(text) => Value::String(resolve_text(text, file, env)?),
        LayerValue::Sequence(items) => Value::Array(
            items
                .iter()
                .map(|item| resolve_env(item, file, env))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        LayerValue::Mapping(entries) => {
            let mut map = Map::new();
            for (key, entry) in entries {
                map.insert(key.clone(), resolve_env(entry, file, env)?);
            }
            Value::Object(map)
        }
        LayerValue::Env(name) => {
            let raw = env
                .get(name)
                .ok_or_else(|| missing_whole_value(file, name))?;
            parse_scalar(raw)
        }
        LayerValue::Include(_) => {
            return Err(ConfigError::one(format!(
                "{file}: include is only allowed as a layer entry, not inside a value"
            )));
        }
    })
}

/// A string with every reference replaced by what the environment holds for it.
///
/// The names are read from the string as it was written and replaced in that order, exactly as the
/// TypeScript build's `split(...).join(...)` loop did: a replacement is re-read only when a later name
/// from the same written string occurs in it, and `${...}` it introduces for an unreferenced name stays
/// as written.
fn resolve_text(text: &str, file: &str, env: &Env) -> Result<String, ConfigError> {
    let mut resolved = text.to_string();
    for name in references_in(text) {
        let raw = env.get(&name).ok_or_else(|| missing_textual(file, &name))?;
        resolved = resolved.replace(&format!("${{{name}}}"), raw);
    }
    Ok(resolved)
}

fn missing_whole_value(file: &str, name: &str) -> ConfigError {
    ConfigError::one(format!(
        "{file}: the environment reference !env {name} is not set"
    ))
}

fn missing_textual(file: &str, name: &str) -> ConfigError {
    ConfigError::one(format!(
        "{file}: the environment reference ${{{name}}} is not set"
    ))
}

/// What an environment string spells, as the TypeScript `parseScalar` read it: `true`, `false` and
/// `null` (after trimming) are those values; an optionally negative decimal integer or fraction
/// (`-?\d+(\.\d+)?`, after trimming) is a number; anything else is the string **untrimmed**.
pub fn parse_scalar(raw: &str) -> Value {
    let trimmed = raw.trim();
    match trimmed {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        "null" => return Value::Null,
        _ => {}
    }
    if is_decimal(trimmed) {
        if !trimmed.contains('.')
            && let Ok(integer) = trimmed.parse::<i64>()
        {
            return Value::Number(Number::from(integer));
        }
        if let Ok(float) = trimmed.parse::<f64>() {
            if float.is_finite()
                && float.fract() == 0.0
                && float >= i64::MIN as f64
                && float <= i64::MAX as f64
            {
                return Value::Number(Number::from(float as i64));
            }
            if let Some(number) = Number::from_f64(float) {
                return Value::Number(number);
            }
        }
    }
    Value::String(raw.to_string())
}

/// The TypeScript reading's number test, `^-?\d+(\.\d+)?$`, on an already trimmed string.
fn is_decimal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    if bytes.first() == Some(&b'-') {
        index = 1;
    }
    let whole = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index == whole {
        return false;
    }
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        let fraction = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == fraction {
            return false;
        }
    }
    index == bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env() -> Env {
        Env::from_pairs([
            ("A", "one"),
            ("B", "two"),
            ("COUNT", "7"),
            ("FLAG", "true"),
            ("RATIO", "1.5"),
            ("EMPTY", ""),
        ])
    }

    #[test]
    fn references_are_read_in_order_with_repeats() {
        assert_eq!(references_in("${A}/${B}/${A}"), ["A", "B", "A"]);
        assert_eq!(references_in("no references"), Vec::<String>::new());
        assert_eq!(references_in("$A {B} ${A-B} ${}"), Vec::<String>::new());
        assert_eq!(references_in("${9BAD} ${ A} ${OK_2}"), ["OK_2"]);
        assert_eq!(references_in("an unterminated ${A"), Vec::<String>::new());
        assert_eq!(references_in("a ${A}} brace"), ["A"]);
    }

    #[test]
    fn a_whole_value_reference_keeps_the_type_the_environment_spells() {
        let value = LayerValue::Mapping(vec![
            ("count".into(), LayerValue::Env("COUNT".into())),
            ("flag".into(), LayerValue::Env("FLAG".into())),
            ("ratio".into(), LayerValue::Env("RATIO".into())),
            ("empty".into(), LayerValue::Env("EMPTY".into())),
        ]);
        assert_eq!(
            resolve_env(&value, "dev/heddle.patch.yml", &env()).unwrap(),
            json!({ "count": 7, "flag": true, "ratio": 1.5, "empty": "" })
        );
    }

    #[test]
    fn a_textual_reference_substitutes_every_occurrence() {
        let value = LayerValue::String("${A}${A}/${B}".into());
        assert_eq!(
            resolve_env(&value, "(inline)", &env()).unwrap(),
            json!("oneone/two")
        );
    }

    #[test]
    fn a_replacement_is_reread_only_for_a_name_the_string_also_wrote() {
        let env = Env::from_pairs([("A", "${B}"), ("B", "x")]);
        assert_eq!(
            resolve_env(&LayerValue::String("${A}-${B}".into()), "f.yml", &env).unwrap(),
            json!("x-x")
        );
        assert_eq!(
            resolve_env(&LayerValue::String("${A}".into()), "f.yml", &env).unwrap(),
            json!("${B}"),
            "a name the string never wrote is not a reference to resolve"
        );
    }

    #[test]
    fn text_without_a_reference_is_left_exactly_as_written() {
        assert_eq!(
            resolve_env(
                &LayerValue::String("plain ${not a name}".into()),
                "f.yml",
                &env()
            )
            .unwrap(),
            json!("plain ${not a name}")
        );
    }

    #[test]
    fn a_missing_textual_reference_is_an_error_naming_it() {
        let error = resolve_env(
            &LayerValue::String("${ABSENT}/v1".into()),
            "dev/heddle.patch.yml",
            &env(),
        )
        .unwrap_err();
        assert_eq!(
            error.problems(),
            ["dev/heddle.patch.yml: the environment reference ${ABSENT} is not set"]
        );
    }

    #[test]
    fn a_missing_whole_value_reference_is_an_error_naming_it() {
        let error = resolve_env(&LayerValue::Env("ABSENT".into()), "(inline)", &env()).unwrap_err();
        assert_eq!(
            error.problems(),
            ["(inline): the environment reference !env ABSENT is not set"]
        );
    }

    #[test]
    fn an_include_inside_a_value_is_refused() {
        let error = resolve_env(
            &LayerValue::Include("./other.yml".into()),
            "dev/heddle.patch.yml",
            &env(),
        )
        .unwrap_err();
        assert_eq!(
            error.problems(),
            ["dev/heddle.patch.yml: include is only allowed as a layer entry, not inside a value"]
        );
    }

    #[test]
    fn references_resolve_through_sequences_and_nested_mappings_in_order() {
        let value = LayerValue::Sequence(vec![
            LayerValue::Null,
            LayerValue::String("${A}".into()),
            LayerValue::Mapping(vec![
                ("n".into(), LayerValue::Env("COUNT".into())),
                (
                    "deep".into(),
                    LayerValue::Sequence(vec![LayerValue::String("${B}!".into())]),
                ),
            ]),
        ]);
        assert_eq!(
            resolve_env(&value, "f.yml", &env()).unwrap(),
            json!([null, "one", { "n": 7, "deep": ["two!"] }])
        );
    }

    #[test]
    fn the_first_problem_in_a_value_is_the_one_returned() {
        let value = LayerValue::Sequence(vec![
            LayerValue::Env("FIRST_ABSENT".into()),
            LayerValue::Env("SECOND_ABSENT".into()),
        ]);
        let error = resolve_env(&value, "f.yml", &env()).unwrap_err();
        assert_eq!(
            error.problems(),
            ["f.yml: the environment reference !env FIRST_ABSENT is not set"]
        );
    }

    #[test]
    fn parse_scalar_reads_what_the_typescript_build_read() {
        assert_eq!(parse_scalar("true"), json!(true));
        assert_eq!(parse_scalar(" false "), json!(false));
        assert_eq!(parse_scalar("null"), json!(null));
        assert_eq!(parse_scalar("7"), json!(7));
        assert_eq!(parse_scalar("-12"), json!(-12));
        assert_eq!(parse_scalar("007"), json!(7));
        assert_eq!(parse_scalar(" 42 "), json!(42));
        assert_eq!(parse_scalar("1.5"), json!(1.5));
        assert_eq!(parse_scalar("1.0"), json!(1));
        assert_eq!(parse_scalar("-0"), json!(0));
        assert_eq!(parse_scalar("hello"), json!("hello"));
        assert_eq!(
            parse_scalar(" hello "),
            json!(" hello "),
            "anything that is not a scalar keeps the text untrimmed"
        );
        assert_eq!(parse_scalar(""), json!(""));
        assert_eq!(parse_scalar(".5"), json!(".5"));
        assert_eq!(parse_scalar("1."), json!("1."));
        assert_eq!(parse_scalar("+7"), json!("+7"));
        assert_eq!(parse_scalar("1e3"), json!("1e3"));
        assert_eq!(parse_scalar("NaN"), json!("NaN"));
        assert_eq!(parse_scalar("TRUE"), json!("TRUE"));
    }
}
