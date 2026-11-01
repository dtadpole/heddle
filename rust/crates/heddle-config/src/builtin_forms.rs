//! The built-in rows' form projections (issue #123): the schema descriptor `GET /api/settings` answers for each row,
//! DSH's form projection, the same bytes the TypeScript build answers.
//!
//! The binary has no Schemastery to serialize a schema the way DSH's settings view does, so the projections are
//! generated from the TypeScript `Config`s by `src/config/builtin-forms.ts` into `builtin_forms.json` beside this
//! file, and embedded. The TypeScript schemas stay the one source; `test/builtin-forms.test.ts` fails when the file
//! is stale. A default the schema computes from the environment is stored as `$HEDDLE_HOME/…` and resolved here
//! against the run's own `HEDDLE_HOME`, as the TypeScript build computes it.

use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::{Env, heddle_home};

/// The placeholder a home-derived default is stored with.
pub const HEDDLE_HOME_PLACEHOLDER: &str = "$HEDDLE_HOME";

fn forms() -> &'static Map<String, Value> {
    static FORMS: OnceLock<Map<String, Value>> = OnceLock::new();
    FORMS.get_or_init(|| {
        serde_json::from_str(include_str!("builtin_forms.json"))
            .expect("builtin_forms.json is the generator's JSON object")
    })
}

/// The form projection of the built-in at `module` (its path under `src/`, `plugins/model` or `context/service`),
/// with home-derived defaults resolved against `env`; `None` for a built-in whose TypeScript plugin has no `Config`.
pub fn builtin_form(module: &str, env: &Env) -> Option<Value> {
    let mut form = forms().get(module)?.clone();
    let home = heddle_home(env);
    resolve_home(&mut form, &home);
    Some(form)
}

/// Every built-in module that has a form, in file order.
pub fn builtin_form_modules() -> impl Iterator<Item = &'static str> {
    forms().keys().map(String::as_str)
}

fn resolve_home(value: &mut Value, home: &std::path::Path) {
    match value {
        Value::String(text) => {
            if let Some(rest) = text.strip_prefix(HEDDLE_HOME_PLACEHOLDER) {
                *text = home
                    .join(rest.trim_start_matches('/'))
                    .to_string_lossy()
                    .into_owned();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| resolve_home(item, home)),
        Value::Object(map) => map.values_mut().for_each(|item| resolve_home(item, home)),
        _ => {}
    }
}

/// The first way `value` does not fit `form`, a form projection as [`builtin_form`] returns it, in Schemastery's own
/// words (`$.mode expected "read-only" | "workspace-write" | "danger-full-access" but got "yolo"`), or `None` when it
/// fits (issue #125). This is the check the TypeScript build runs on a row's config, at boot and before a settings
/// write is persisted. Schemastery stops at the first problem, and so does this; a missing or `null` value takes its
/// default, and keys the form does not name are left alone, as Schemastery leaves them.
pub fn form_problem(form: &Value, value: &Value) -> Option<String> {
    let refs = form.get("refs")?.as_object()?;
    let root = form.get("uid")?;
    check_node(refs, root, value, "$")
}

fn node<'a>(refs: &'a Map<String, Value>, uid: &Value) -> Option<&'a Value> {
    refs.get(&uid.to_string())
}

/// A value as Schemastery writes it after "but got": a string bare, anything else as JSON.
fn got(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn at(path: &str) -> String {
    if path == "$" {
        String::new()
    } else {
        format!("{path} ")
    }
}

fn check_node(refs: &Map<String, Value>, uid: &Value, value: &Value, path: &str) -> Option<String> {
    let node = node(refs, uid)?;
    let meta = node.get("meta").cloned().unwrap_or(Value::Null);
    if value.is_null() {
        let required = meta.get("required").and_then(Value::as_bool) == Some(true);
        let has_default = meta.get("default").is_some();
        return (required && !has_default).then(|| format!("{}missing required value", at(path)));
    }
    let expected = |what: &str| {
        Some(format!(
            "{}expected {what} but got {}",
            at(path),
            got(value)
        ))
    };
    match node.get("type").and_then(Value::as_str)? {
        "string" => (!value.is_string()).then(|| expected("string")).flatten(),
        "boolean" => (!value.is_boolean()).then(|| expected("boolean")).flatten(),
        "number" => {
            let Some(number) = value.as_f64() else {
                return expected("number");
            };
            if let Some(min) = meta.get("min").and_then(Value::as_f64)
                && number < min
            {
                return expected(&format!("number >= {}", meta["min"]));
            }
            if let Some(max) = meta.get("max").and_then(Value::as_f64)
                && number > max
            {
                return expected(&format!("number <= {}", meta["max"]));
            }
            if let Some(step) = meta.get("step").and_then(Value::as_f64)
                && step > 0.0
            {
                let from = meta.get("min").and_then(Value::as_f64).unwrap_or(0.0);
                let steps = (number - from) / step;
                if (steps - steps.round()).abs() > 1e-9 {
                    return expected(&format!("number multiple of {}", meta["step"]));
                }
            }
            None
        }
        "const" => {
            let constant = node.get("value")?;
            (constant != value)
                .then(|| Some(format!("{}expected {constant} but got {value}", at(path))))
                .flatten()
        }
        "union" => {
            let list = node.get("list")?.as_array()?;
            if list
                .iter()
                .any(|choice| check_node(refs, choice, value, path).is_none())
            {
                return None;
            }
            let names: Vec<String> = list
                .iter()
                .filter_map(|choice| node_name(refs, choice))
                .collect();
            Some(format!(
                "{}expected {} but got {value}",
                at(path),
                names.join(" | ")
            ))
        }
        "array" => {
            let Some(items) = value.as_array() else {
                return expected("array");
            };
            let inner = node.get("inner")?;
            items.iter().enumerate().find_map(|(index, item)| {
                check_node(refs, inner, item, &format!("{path}[{index}]"))
            })
        }
        "dict" => {
            let Some(map) = value.as_object() else {
                return expected("dict");
            };
            let inner = node.get("inner")?;
            map.iter()
                .find_map(|(key, item)| check_node(refs, inner, item, &format!("{path}.{key}")))
        }
        "object" => {
            let Some(map) = value.as_object() else {
                return expected("object");
            };
            let dict = node.get("dict")?.as_object()?;
            dict.iter().find_map(|(key, child)| {
                check_node(
                    refs,
                    child,
                    map.get(key).unwrap_or(&Value::Null),
                    &format!("{path}.{key}"),
                )
            })
        }
        // A node kind the generator has not produced yet is not judged here; the component's own schema still is.
        _ => None,
    }
}

/// How a union names one choice: a constant as JSON, any other node by its type.
fn node_name(refs: &Map<String, Value>, uid: &Value) -> Option<String> {
    let node = node(refs, uid)?;
    match node.get("type").and_then(Value::as_str)? {
        "const" => node.get("value").map(Value::to_string),
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_form_is_dsh_s_projection_with_home_defaults_resolved() {
        let env = Env::default().with("HEDDLE_HOME", "/srv/heddle-home");
        let session = builtin_form("plugins/session", &env).expect("the session row has a Config");
        let root = &session["refs"][session["uid"].to_string()];
        assert_eq!(root["type"], "object");
        let field = root["dict"]["root"].to_string();
        assert_eq!(
            session["refs"][field]["meta"]["default"], "/srv/heddle-home/sessions",
            "the placeholder is this run's HEDDLE_HOME"
        );
        assert!(
            !include_str!("builtin_forms.json").contains("/Users/"),
            "no machine path is committed"
        );
    }

    #[test]
    fn a_built_in_without_a_config_has_no_form() {
        assert_eq!(builtin_form("plugins/turns", &Env::default()), None);
        assert!(builtin_form_modules().any(|module| module == "plugins/jobs"));
    }

    #[test]
    fn a_value_is_judged_as_schemastery_judges_it() {
        let env = Env::default();
        let sandbox = builtin_form("sandbox/service", &env).unwrap();
        assert_eq!(
            form_problem(&sandbox, &serde_json::json!({ "mode": "yolo" })).as_deref(),
            Some(
                r#"$.mode expected "read-only" | "workspace-write" | "danger-full-access" but got "yolo""#
            )
        );
        assert_eq!(
            form_problem(&sandbox, &serde_json::json!({ "mode": "read-only" })),
            None
        );
        assert_eq!(
            form_problem(&sandbox, &serde_json::json!({})),
            None,
            "a missing value takes its default"
        );
        let context = builtin_form("context/service", &env).unwrap();
        assert_eq!(
            form_problem(&context, &serde_json::json!({ "contextWindow": "huge" })).as_deref(),
            Some("$.contextWindow expected number but got huge")
        );
        let jobs = builtin_form("plugins/jobs", &env).unwrap();
        assert_eq!(
            form_problem(
                &jobs,
                &serde_json::json!({ "maxConcurrentJobsPerOwner": 0 })
            )
            .as_deref(),
            Some("$.maxConcurrentJobsPerOwner expected number >= 1 but got 0")
        );
        assert_eq!(
            form_problem(
                &jobs,
                &serde_json::json!({ "maxConcurrentJobsPerOwner": 2.5 })
            )
            .as_deref(),
            Some("$.maxConcurrentJobsPerOwner expected number multiple of 1 but got 2.5")
        );
        let todo = builtin_form("plugins/todo-tool", &env).unwrap();
        assert_eq!(
            form_problem(&todo, &serde_json::json!({})).as_deref(),
            Some("$.allowParallelInProgress missing required value")
        );
        let model = builtin_form("plugins/model", &env).unwrap();
        assert_eq!(
            form_problem(
                &model,
                &serde_json::json!({ "endpoints": [{ "name": "a", "kind": "telnet" }] })
            )
            .map(|problem| problem.starts_with("$.endpoints[0].kind expected ")),
            Some(true)
        );
        assert_eq!(
            form_problem(&model, &serde_json::json!(5)).as_deref(),
            Some("expected object but got 5")
        );
    }
}
