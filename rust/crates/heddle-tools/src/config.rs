//! The `tools` configuration row.
//!
//! Ported from `ToolsPlugin.Config` in `src/plugins/tools.ts`. The configuration crate hands a row's
//! `config` object over as JSON; this is how the tools row reads it, with the TypeScript defaults.

use serde::{Deserialize, Serialize};

/// What a `tools` row's `config` may say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ToolsConfig {
    /// Tools to enable, by name. Empty means every registered tool. A name nothing registers fails the run
    /// once the tree has loaded (see [`ToolRegistry::missing`](crate::ToolRegistry::missing)).
    pub allow: Vec<String>,
    /// Register the harness's own four tools.
    pub include_builtins: bool,
    /// Wall time a `bash` call may take before it is killed, in milliseconds.
    pub bash_timeout_ms: u64,
}

impl Default for ToolsConfig {
    fn default() -> Self {
        Self {
            allow: Vec::new(),
            include_builtins: true,
            bash_timeout_ms: 30_000,
        }
    }
}

impl ToolsConfig {
    /// Read a row's `config` object; `null` or an absent object reads as the defaults.
    pub fn from_row(config: &serde_json::Value) -> Result<Self, serde_json::Error> {
        if config.is_null() {
            return Ok(Self::default());
        }
        serde_json::from_value(config.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_config_reads_as_the_typescript_defaults() {
        let config = ToolsConfig::from_row(&serde_json::Value::Null).unwrap();
        assert_eq!(
            config,
            ToolsConfig {
                allow: vec![],
                include_builtins: true,
                bash_timeout_ms: 30_000
            }
        );
    }

    #[test]
    fn a_row_names_its_allow_list_in_camel_case() {
        let config = ToolsConfig::from_row(
            &serde_json::json!({ "allow": ["read_file"], "bashTimeoutMs": 5 }),
        )
        .unwrap();
        assert_eq!(config.allow, ["read_file"]);
        assert_eq!(config.bash_timeout_ms, 5);
        assert!(config.include_builtins);
    }

    #[test]
    fn a_misspelled_key_is_refused_rather_than_ignored() {
        assert!(ToolsConfig::from_row(&serde_json::json!({ "allowed": ["read_file"] })).is_err());
    }
}
