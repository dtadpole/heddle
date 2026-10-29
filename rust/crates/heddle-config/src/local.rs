//! The machine's own configuration file, and the rule that keeps it out of git.
//!
//! Ported from `src/local-config.ts`. Endpoint URLs, model names and anything credential-shaped belong
//! to the **machine**, not the repository, so this file is read from outside the checkout, first match
//! wins: `$HEDDLE_CONFIG` (when non-empty), then `$HEDDLE_HOME/heddle.json` (`~/.heddle/heddle.json`
//! when `HEDDLE_HOME` is unset). A file that does not exist is not an error; a file that exists and is
//! not a JSON object **fails loudly**, because falling back to offline defaults over a trailing comma
//! reads as "the real backend is broken".

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::endpoints::EndpointPatch;
use crate::env::Env;
use crate::error::ConfigError;
use crate::home::heddle_home;

/// The local file's contents.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LocalConfig {
    /// The machine's endpoints — in practice a **list** of endpoint objects, each restating a default
    /// or declaring a new one. Kept as written; [`LocalConfig::endpoint_patches`] reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoints: Option<Value>,
    /// The endpoint a run uses when nothing else says (see [`crate::nominated_default`]). A value that is not
    /// a string reads as absent, as `typeof nominated === 'string'` skipped it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "string_or_absent"
    )]
    pub default: Option<String>,
    /// Endpoint names this machine does not want offered at all, applied after every layer. A value that is
    /// not a list reads as absent (`Array.isArray(local.config.exclude) ? … : []`), and a non-string element is
    /// dropped, since it could never match an endpoint's name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "names_or_absent"
    )]
    pub exclude: Option<Vec<String>>,
    /// Anything else, passed through untouched for the caller that reads it.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl LocalConfig {
    /// `endpoints` as endpoint patches, in written order; empty when absent.
    ///
    /// Fails, naming `path`, when `endpoints` is not a list or an element is not an endpoint object.
    /// (The TypeScript doc comment showed a mapping by name, but the model plugin iterated it as a list
    /// and every verifier writes a list; a mapping crashed there, and is refused here with a sentence.)
    pub fn endpoint_patches(&self, path: &Path) -> Result<Vec<EndpointPatch>, ConfigError> {
        let Some(value) = &self.endpoints else {
            return Ok(Vec::new());
        };
        let Value::Array(items) = value else {
            return Err(ConfigError::one(format!(
                "{}: endpoints must be a list of endpoint objects",
                path.display()
            )));
        };
        let mut patches = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            if !item.is_object() {
                return Err(ConfigError::one(format!(
                    "{}: endpoints[{index}] is not an endpoint object",
                    path.display()
                )));
            }
            let patch = serde_json::from_value(item.clone()).map_err(|error| {
                ConfigError::one(format!(
                    "{}: endpoints[{index}] is not an endpoint object: {error}",
                    path.display()
                ))
            })?;
            patches.push(patch);
        }
        Ok(patches)
    }
}

/// `default` as the TypeScript build read it: a string, or nothing.
fn string_or_absent<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) => Some(text),
        _ => None,
    })
}

/// `exclude` as the TypeScript build read it: a list's string elements, or nothing.
fn names_or_absent<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::Array(items) => Some(
            items
                .into_iter()
                .filter_map(|item| match item {
                    Value::String(name) => Some(name),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    })
}

/// Where the local configuration was found, and what it holds.
#[derive(Clone, Debug, PartialEq)]
pub struct LocalConfigLocation {
    /// The file that was read.
    pub path: PathBuf,
    /// Its contents.
    pub config: LocalConfig,
}

/// The candidate files, in precedence order: `$HEDDLE_CONFIG` when non-empty, then
/// `$HEDDLE_HOME/heddle.json`, or `{home}/.heddle/heddle.json` when `HEDDLE_HOME` is unset.
pub fn local_config_candidates(env: &Env) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = env.non_empty("HEDDLE_CONFIG") {
        candidates.push(PathBuf::from(path));
    }
    candidates.push(heddle_home(env).join("heddle.json"));
    candidates
}

/// The first candidate that exists, read; `Ok(None)` when none does.
///
/// A candidate that cannot be read is skipped, as a missing one is. One that is read and is not JSON
/// fails with `{path}: not valid JSON — {why}`; one whose top level is not an object fails with
/// `{path}: expected a JSON object at the top level`.
pub fn read_local_config(
    candidates: &[PathBuf],
) -> Result<Option<LocalConfigLocation>, ConfigError> {
    for path in candidates {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let parsed: Value = serde_json::from_str(&text).map_err(|error| {
            ConfigError::one(format!("{}: not valid JSON — {error}", path.display()))
        })?;
        if !parsed.is_object() {
            return Err(ConfigError::one(format!(
                "{}: expected a JSON object at the top level",
                path.display()
            )));
        }
        let config: LocalConfig = serde_json::from_value(parsed).map_err(|error| {
            ConfigError::one(format!("{}: not valid JSON — {error}", path.display()))
        })?;
        return Ok(Some(LocalConfigLocation {
            path: path.clone(),
            config,
        }));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "heddle-config-local-{}-{label}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn candidates_are_heddle_config_then_the_heddle_home_file() {
        let env = Env::default()
            .with("HOME", "/home/someone")
            .with("HEDDLE_CONFIG", "/etc/heddle.json")
            .with("HEDDLE_HOME", "/home/someone/.heddle");
        assert_eq!(
            local_config_candidates(&env),
            [
                PathBuf::from("/etc/heddle.json"),
                PathBuf::from("/home/someone/.heddle/heddle.json"),
            ]
        );

        let plain = Env::default().with("HOME", "/home/someone");
        assert_eq!(
            local_config_candidates(&plain),
            [PathBuf::from("/home/someone/.heddle/heddle.json")]
        );
    }

    #[test]
    fn an_empty_heddle_config_is_not_a_candidate() {
        let env = Env::default()
            .with("HOME", "/home/someone")
            .with("HEDDLE_CONFIG", "");
        assert_eq!(local_config_candidates(&env).len(), 1);
    }

    #[test]
    fn the_first_candidate_that_exists_is_read() {
        let root = scratch("first");
        let missing = root.join("missing.json");
        let real = root.join("heddle.json");
        write(
            &real,
            r#"{"default":"scripted","endpoints":[{"name":"scripted"}]}"#,
        );
        let found = read_local_config(&[missing, real.clone()])
            .unwrap()
            .unwrap();
        assert_eq!(found.path, real);
        assert_eq!(found.config.default.as_deref(), Some("scripted"));
        assert_eq!(found.config.endpoint_patches(&found.path).unwrap().len(), 1);

        assert!(read_local_config(&[]).unwrap().is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_malformed_file_fails_loudly_and_names_its_path() {
        let root = scratch("malformed");
        let path = root.join("heddle.json");
        write(&path, "{ not json");
        let error = read_local_config(std::slice::from_ref(&path)).unwrap_err();
        assert!(error.problems()[0].starts_with(&format!("{}: not valid JSON", path.display())));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_top_level_that_is_not_an_object_is_refused() {
        let root = scratch("array");
        let path = root.join("heddle.json");
        write(&path, "[]");
        let error = read_local_config(std::slice::from_ref(&path)).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "{}: expected a JSON object at the top level",
                path.display()
            )]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn endpoints_must_be_a_list_of_objects() {
        let root = scratch("endpoints");
        let path = root.join("heddle.json");
        let config: LocalConfig =
            serde_json::from_str(r#"{"endpoints":{"scripted":{"model":"x"}}}"#).unwrap();
        assert_eq!(
            config.endpoint_patches(&path).unwrap_err().problems(),
            [format!(
                "{}: endpoints must be a list of endpoint objects",
                path.display()
            )]
        );

        let config: LocalConfig = serde_json::from_str(r#"{"endpoints":["scripted"]}"#).unwrap();
        assert_eq!(
            config.endpoint_patches(&path).unwrap_err().problems(),
            [format!(
                "{}: endpoints[0] is not an endpoint object",
                path.display()
            )]
        );

        let config: LocalConfig = serde_json::from_str(r#"{"endpoints":[{"name":"a"}]}"#).unwrap();
        assert_eq!(
            config.endpoint_patches(&path).unwrap()[0].name.as_deref(),
            Some("a")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
