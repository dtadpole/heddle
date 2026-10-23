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

/// The local file's contents.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LocalConfig {
    /// The machine's endpoints — in practice a **list** of endpoint objects, each restating a default
    /// or declaring a new one. Kept as written; [`LocalConfig::endpoint_patches`] reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoints: Option<Value>,
    /// The endpoint a run uses when nothing else says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// Endpoint names this machine does not want offered at all, applied after every layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
        let _ = path;
        todo!("heddle-config: LocalConfig::endpoint_patches")
    }
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
    let _ = env;
    todo!("heddle-config: local_config_candidates")
}

/// The first candidate that exists, read; `Ok(None)` when none does.
///
/// A candidate that cannot be read is skipped, as a missing one is. One that is read and is not JSON
/// fails with `{path}: not valid JSON — {why}`; one whose top level is not an object fails with
/// `{path}: expected a JSON object at the top level`.
pub fn read_local_config(
    candidates: &[PathBuf],
) -> Result<Option<LocalConfigLocation>, ConfigError> {
    let _ = candidates;
    todo!("heddle-config: read_local_config")
}
