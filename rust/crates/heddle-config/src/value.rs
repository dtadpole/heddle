//! A value as a layer file holds it: YAML's data, plus the two tags this configuration adds.
//!
//! The TypeScript build parsed `!env NAME` and `!include path` into marker objects
//! (`{ __env: NAME }`, `{ __include: path }`) and resolved them when a row was composed. Here the
//! markers are variants, so a value can never be mistaken for a marker and a marker can never reach a
//! component unresolved. Mappings keep the order they were written in, because provenance lists a
//! row's fields in that order.

use serde_json::{Map, Number, Value};

/// One value in a layer file, before environment references are resolved.
#[derive(Clone, Debug, PartialEq)]
pub enum LayerValue {
    /// `~`, `null`, or nothing.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// An integer or a float, as JSON can carry it.
    Number(Number),
    /// A string, which may hold `${NAME}` references.
    String(String),
    /// A YAML sequence.
    Sequence(Vec<LayerValue>),
    /// A YAML mapping, in written order. A non-string key is stored as its text, as JavaScript did.
    Mapping(Vec<(String, LayerValue)>),
    /// `!env NAME` — a whole value from the environment, resolved when the row is composed.
    Env(String),
    /// `!include path` written as a value. Only `include:` as a layer entry includes a file; this
    /// variant exists so composing a row that holds one fails with that sentence.
    Include(String),
}

impl LayerValue {
    /// The value under `key` when this is a mapping holding it.
    pub fn get(&self, key: &str) -> Option<&LayerValue> {
        match self {
            LayerValue::Mapping(entries) => entries
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    /// The text when this is a plain string.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            LayerValue::String(text) => Some(text),
            _ => None,
        }
    }
}

impl From<Value> for LayerValue {
    /// A JSON value as a layer value, with no references in it — how an in-memory override layer is
    /// written (`heddle --session-root` restates the `session` row this way).
    fn from(value: Value) -> Self {
        match value {
            Value::Null => LayerValue::Null,
            Value::Bool(flag) => LayerValue::Bool(flag),
            Value::Number(number) => LayerValue::Number(number),
            Value::String(text) => LayerValue::String(text),
            Value::Array(items) => {
                LayerValue::Sequence(items.into_iter().map(LayerValue::from).collect())
            }
            Value::Object(entries) => LayerValue::Mapping(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, LayerValue::from(value)))
                    .collect(),
            ),
        }
    }
}

/// A layer value with no references left in it, as JSON; `None` when it still holds an
/// [`LayerValue::Env`] or [`LayerValue::Include`]. Composition resolves references first; this is for
/// a caller that knows the value is plain.
pub fn plain_json(value: &LayerValue) -> Option<Value> {
    Some(match value {
        LayerValue::Null => Value::Null,
        LayerValue::Bool(flag) => Value::Bool(*flag),
        LayerValue::Number(number) => Value::Number(number.clone()),
        LayerValue::String(text) => Value::String(text.clone()),
        LayerValue::Sequence(items) => {
            Value::Array(items.iter().map(plain_json).collect::<Option<Vec<_>>>()?)
        }
        LayerValue::Mapping(entries) => {
            let mut map = Map::new();
            for (key, value) in entries {
                map.insert(key.clone(), plain_json(value)?);
            }
            Value::Object(map)
        }
        LayerValue::Env(_) | LayerValue::Include(_) => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_round_trips_through_a_layer_value() {
        let value = json!({ "id": "session", "config": { "root": "/x", "depth": 2, "on": true, "tags": ["a", null] } });
        let layer = LayerValue::from(value.clone());
        assert_eq!(plain_json(&layer), Some(value));
        assert_eq!(
            layer.get("id").and_then(LayerValue::as_str),
            Some("session")
        );
    }

    #[test]
    fn a_value_holding_a_reference_is_not_plain() {
        let layer = LayerValue::Mapping(vec![(
            "count".into(),
            LayerValue::Env("HEDDLE_FIXTURE_COUNT".into()),
        )]);
        assert_eq!(plain_json(&layer), None);
        assert_eq!(plain_json(&LayerValue::Include("./x.yml".into())), None);
    }
}
