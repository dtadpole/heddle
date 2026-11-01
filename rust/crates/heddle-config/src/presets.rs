//! Agent presets (inventory A96): DSH's dsh-agent-preset, dsh-agent-preset-registry and dsh-persona, as the
//! `presets` profile row. The twin of `src/config/presets.ts`; the rules and sentences are the same.
//!
//! A preset is a named composition a session runs under. It names what it narrows: the **tools** its sessions are
//! offered (absent means every tool the profile registers) and the **persona** their system prompt is written from
//! (absent means the profile's own). The registry's `default` is the preset a new session gets when it names none.
//!
//! DSH's rules kept here: a session records its preset id when it is created and keeps it; duplicate ids fail the
//! declaration; a recorded id that is no longer declared is rejected, not silently replaced. A profile that declares
//! no presets gets one implicit `standard` preset with every tool, so nothing changes until a profile opts in.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ConfigError;

/// One declared preset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetDefinition {
    /// The stable identity a session records.
    pub id: String,
    /// What a person reads; the id when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Roster order, lowest first; declaration order breaks ties.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
    /// The tools its sessions are offered, by name. Absent means every registered tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    /// The system prompt its sessions are written from, shadowing the profile's (DSH's persona `prefix`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
}

impl PresetDefinition {
    /// Whether this preset's sessions may call `tool`.
    pub fn allows(&self, tool: &str) -> bool {
        self.tools
            .as_ref()
            .is_none_or(|tools| tools.iter().any(|name| name == tool))
    }

    /// The items a preset's sessions are offered, in their own order: every item for a preset with no `tools`
    /// list, otherwise only the named ones. A name nothing registered is simply absent.
    pub fn narrow<T>(&self, items: Vec<T>, name_of: impl Fn(&T) -> &str) -> Vec<T> {
        match &self.tools {
            None => items,
            Some(tools) => items
                .into_iter()
                .filter(|item| tools.iter().any(|name| name == name_of(item)))
                .collect(),
        }
    }
}

/// The implicit preset of a profile that declares none: every tool, the profile's own system prompt.
pub fn standard_preset() -> PresetDefinition {
    PresetDefinition {
        id: "standard".to_owned(),
        name: Some("Standard".to_owned()),
        description: Some(
            "Every tool this profile registers, with its own system prompt.".to_owned(),
        ),
        order: None,
        tools: None,
        persona: None,
    }
}

/// The validated roster: every preset, in roster order, and the one a new session gets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PresetRoster {
    pub default: String,
    pub presets: Vec<PresetDefinition>,
}

/// What resolving a session's preset answered: the definition, or the id that is no longer declared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PresetResolution<'a> {
    Found(&'a PresetDefinition),
    Missing {
        missing: String,
        declared: Vec<String>,
    },
}

impl PresetRoster {
    /// The preset `id` names, or the default for a session that recorded none.
    pub fn resolve(&self, id: Option<&str>) -> PresetResolution<'_> {
        let wanted = id.filter(|id| !id.is_empty()).unwrap_or(&self.default);
        match self.presets.iter().find(|preset| preset.id == wanted) {
            Some(preset) => PresetResolution::Found(preset),
            None => PresetResolution::Missing {
                missing: wanted.to_owned(),
                declared: self.ids(),
            },
        }
    }

    /// Every declared id, in roster order.
    pub fn ids(&self) -> Vec<String> {
        self.presets
            .iter()
            .map(|preset| preset.id.clone())
            .collect()
    }
}

/// The sentence a turn is refused with when its session's preset is no longer declared.
pub fn missing_preset_message(missing: &str, declared: &[String]) -> String {
    format!(
        "the session's preset '{missing}' is not declared in this profile; declared: {}",
        declared.join(", ")
    )
}

/// Validate a `presets` row's configuration into its roster, or a `ConfigError` naming every problem.
///
/// An id must be non-empty and declared once; `default` must name a declared preset, and defaults to `standard` (or
/// the only declared preset, when there is one). The roster is sorted by `order`, then by declaration. A missing or
/// null configuration is the implicit roster.
pub fn preset_roster(config: Option<&Value>) -> Result<PresetRoster, ConfigError> {
    let config = config.filter(|value| !value.is_null());
    let wanted_default = match config.and_then(|value| value.get("default")) {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) => Some(name.clone()),
        Some(_) => return Err(ConfigError::one("presets: `default` must be a string")),
    };
    let declared: Vec<PresetDefinition> = match config.and_then(|value| value.get("presets")) {
        None | Some(Value::Null) => Vec::new(),
        Some(list @ Value::Array(_)) => serde_json::from_value(list.clone())
            .map_err(|error| ConfigError::one(format!("presets: {error}")))?,
        Some(_) => return Err(ConfigError::one("presets: `presets` must be a list")),
    };
    let standard = standard_preset();
    if declared.is_empty() {
        if let Some(wanted) = wanted_default.filter(|wanted| *wanted != standard.id) {
            return Err(ConfigError::one(format!(
                "presets: the default preset '{wanted}' is not declared; declared: {}",
                standard.id
            )));
        }
        return Ok(PresetRoster {
            default: standard.id.clone(),
            presets: vec![standard],
        });
    }
    let mut problems = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for (index, preset) in declared.iter().enumerate() {
        let id = preset.id.trim();
        if id.is_empty() {
            problems.push(format!("presets: entry {} has no id", index + 1));
        } else if seen.iter().any(|known| known == id) {
            problems.push(format!("presets: the preset '{id}' is declared twice"));
        } else {
            seen.push(id.to_owned());
        }
    }
    let default = wanted_default.unwrap_or_else(|| {
        if seen.len() == 1 {
            seen[0].clone()
        } else {
            standard.id.clone()
        }
    });
    if !seen.contains(&default) {
        problems.push(format!(
            "presets: the default preset '{default}' is not declared; declared: {}",
            seen.join(", ")
        ));
    }
    if !problems.is_empty() {
        return Err(ConfigError::new(problems));
    }
    let mut indexed: Vec<(usize, PresetDefinition)> = declared
        .into_iter()
        .map(|mut preset| {
            preset.id = preset.id.trim().to_owned();
            preset
        })
        .enumerate()
        .collect();
    indexed.sort_by(|(left_index, left), (right_index, right)| {
        left.order
            .unwrap_or(0)
            .cmp(&right.order.unwrap_or(0))
            .then(left_index.cmp(right_index))
    });
    Ok(PresetRoster {
        default,
        presets: indexed.into_iter().map(|(_, preset)| preset).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_profile_without_presets_has_the_implicit_standard_one() {
        assert_eq!(
            preset_roster(None).unwrap(),
            PresetRoster {
                default: "standard".into(),
                presets: vec![standard_preset()]
            }
        );
        assert!(preset_roster(Some(&json!({ "default": "gone" }))).is_err());
    }

    #[test]
    fn duplicates_and_an_undeclared_default_are_refused_with_every_problem() {
        let error = preset_roster(Some(&json!({
            "default": "gone",
            "presets": [{ "id": "a" }, { "id": "a" }]
        })))
        .unwrap_err();
        assert_eq!(
            error.problems(),
            [
                "presets: the preset 'a' is declared twice".to_owned(),
                "presets: the default preset 'gone' is not declared; declared: a".to_owned(),
            ]
        );
    }

    #[test]
    fn the_roster_is_ordered_and_a_single_preset_is_the_default() {
        assert_eq!(
            preset_roster(Some(&json!({ "presets": [{ "id": "only" }] })))
                .unwrap()
                .default,
            "only"
        );
        let roster = preset_roster(Some(&json!({
            "default": "b",
            "presets": [{ "id": "a", "order": 2 }, { "id": "b", "order": 1 }, { "id": "c", "order": 2 }]
        })))
        .unwrap();
        assert_eq!(roster.ids(), ["b", "a", "c"]);
        assert_eq!(
            roster.resolve(Some("zzz")),
            PresetResolution::Missing {
                missing: "zzz".into(),
                declared: vec!["b".into(), "a".into(), "c".into()]
            }
        );
        assert!(
            matches!(roster.resolve(None), PresetResolution::Found(preset) if preset.id == "b")
        );
    }

    #[test]
    fn a_preset_narrows_tools_by_name_and_allows_only_those() {
        let reader = PresetDefinition {
            tools: Some(vec!["read_file".into()]),
            ..standard_preset()
        };
        assert_eq!(
            reader.narrow(vec!["read_file", "bash"], |name| name),
            ["read_file"]
        );
        assert!(reader.allows("read_file"));
        assert!(!reader.allows("bash"));
        assert!(standard_preset().allows("bash"));
        assert_eq!(
            missing_preset_message("retired", &["standard".into(), "reader".into()]),
            "the session's preset 'retired' is not declared in this profile; declared: standard, reader"
        );
    }
}
