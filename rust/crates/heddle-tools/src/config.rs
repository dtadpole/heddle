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
    /// The most wall time a `bash` call may ask for with its own `timeoutMs`, in milliseconds; a larger request is
    /// cut to this (DSH's `maxTimeoutMs`, "the executor applies its configured default and cap").
    pub bash_max_timeout_ms: u64,
    /// Characters of a `bash` call's combined output the model is shown; the rest is cut and marked (DSH's
    /// output cap). At least 1.
    pub bash_output_limit: usize,
    /// Parallel-safe tool calls one model step runs at once; 1 runs every call alone (DSH's
    /// `maxParallelToolCalls`). At least 1.
    pub max_parallel_tool_calls: usize,
}

/// The default for `maxParallelToolCalls` (DSH's default).
pub const DEFAULT_MAX_PARALLEL_TOOL_CALLS: usize = 10;

impl Default for ToolsConfig {
    fn default() -> Self {
        Self {
            allow: Vec::new(),
            include_builtins: true,
            bash_timeout_ms: 30_000,
            bash_max_timeout_ms: crate::builtin::BASH_MAX_TIMEOUT_MS,
            bash_output_limit: crate::builtin::BASH_OUTPUT_LIMIT,
            max_parallel_tool_calls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
        }
    }
}

impl ToolsConfig {
    /// Read a row's `config` object; `null` or an absent object reads as the defaults.
    pub fn from_row(config: &serde_json::Value) -> Result<Self, serde_json::Error> {
        if config.is_null() {
            return Ok(Self::default());
        }
        let parsed: Self = serde_json::from_value(config.clone())?;
        if parsed.bash_output_limit == 0 {
            return Err(serde::de::Error::custom(
                "bashOutputLimit must be at least 1",
            ));
        }
        if parsed.bash_max_timeout_ms == 0 {
            return Err(serde::de::Error::custom(
                "bashMaxTimeoutMs must be at least 1",
            ));
        }
        if parsed.max_parallel_tool_calls == 0 {
            return Err(serde::de::Error::custom(
                "maxParallelToolCalls must be at least 1",
            ));
        }
        Ok(parsed)
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
                bash_timeout_ms: 30_000,
                bash_max_timeout_ms: 600_000,
                bash_output_limit: 20_000,
                max_parallel_tool_calls: 10
            }
        );
    }

    #[test]
    fn the_parallel_cap_is_a_setting_of_at_least_one() {
        let config =
            ToolsConfig::from_row(&serde_json::json!({ "maxParallelToolCalls": 3 })).unwrap();
        assert_eq!(config.max_parallel_tool_calls, 3);
        let zero =
            ToolsConfig::from_row(&serde_json::json!({ "maxParallelToolCalls": 0 })).unwrap_err();
        assert!(
            zero.to_string()
                .contains("maxParallelToolCalls must be at least 1")
        );
    }

    #[test]
    fn the_output_limit_is_a_setting_of_at_least_one() {
        let capped =
            ToolsConfig::from_row(&serde_json::json!({ "bashMaxTimeoutMs": 400 })).unwrap();
        assert_eq!(capped.bash_max_timeout_ms, 400);
        let none =
            ToolsConfig::from_row(&serde_json::json!({ "bashMaxTimeoutMs": 0 })).unwrap_err();
        assert!(
            none.to_string()
                .contains("bashMaxTimeoutMs must be at least 1")
        );
        let config = ToolsConfig::from_row(&serde_json::json!({ "bashOutputLimit": 50 })).unwrap();
        assert_eq!(config.bash_output_limit, 50);
        let zero = ToolsConfig::from_row(&serde_json::json!({ "bashOutputLimit": 0 })).unwrap_err();
        assert!(
            zero.to_string()
                .contains("bashOutputLimit must be at least 1")
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
