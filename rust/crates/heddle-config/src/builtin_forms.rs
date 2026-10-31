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
}
