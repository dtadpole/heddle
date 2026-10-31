//! Appearance and typography preferences (issue #81): DSH's dsh-client-ui-theme `ui-theme` settings namespace, as
//! heddle's `ui-theme` profile row. The twin of `src/config/theme.ts`; the rules are the same.
//!
//! The row stores the theme preference (`light`, `dark` or `system`, DSH's default `system`), the text, code and
//! terminal font sizes (whole pixels: 10-22 default 14, 10-16 default 11, 10-20 default 13) and three font-family
//! lists (empty means the built-in stack). Every browser shares them, because they are a setting, not browser
//! storage. The server hands them to the page on the served `<html>` element, as a `data-theme` attribute and CSS
//! custom properties, so the first paint already uses them. DSH embeds a boot style and script for the same
//! purpose; heddle uses attributes, because the page's script policy hashes its inline scripts.

use serde_json::{Value, json};

use crate::{ConfigError, Schema};

/// The theme preferences DSH accepts.
pub const THEME_PREFERENCES: [&str; 3] = ["light", "dark", "system"];

/// The preference when the row stores none: DSH's `DEFAULT_PREFERENCE`.
pub const DEFAULT_THEME_PREFERENCE: &str = "system";

/// One font role's size: its settings field, the CSS custom property the page reads, and its range in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FontSizeSpec {
    pub field: &'static str,
    pub variable: &'static str,
    pub min: u32,
    pub max: u32,
    pub default: u32,
}

/// DSH's `FONT_SIZE_SPECS`: text is the conversation content, code the code blocks, terminal the sidebar terminal.
pub const FONT_SIZE_SPECS: [FontSizeSpec; 3] = [
    FontSizeSpec {
        field: "fontSize",
        variable: "--heddle-content-font-size",
        min: 10,
        max: 22,
        default: 14,
    },
    FontSizeSpec {
        field: "codeFontSize",
        variable: "--heddle-code-font-size",
        min: 10,
        max: 16,
        default: 11,
    },
    FontSizeSpec {
        field: "terminalFontSize",
        variable: "--heddle-terminal-font-size",
        min: 10,
        max: 20,
        default: 13,
    },
];

/// Each role's font-family field and the CSS custom property that carries its list ahead of the built-in stack.
pub const FONT_FAMILY_FIELDS: [(&str, &str); 3] = [
    ("textFontFamily", "--heddle-font-family-text"),
    ("codeFontFamily", "--heddle-font-family-code"),
    ("terminalFontFamily", "--heddle-font-family-terminal"),
];

/// The `ui-theme` row's schema: DSH's, with `step(1)` as `integer`.
pub fn theme_schema() -> Option<Schema> {
    let mut properties = serde_json::Map::new();
    properties.insert(
        "preference".into(),
        json!({ "type": "string", "enum": THEME_PREFERENCES, "default": DEFAULT_THEME_PREFERENCE }),
    );
    for spec in FONT_SIZE_SPECS {
        properties.insert(
            spec.field.into(),
            json!({ "type": "integer", "minimum": spec.min, "maximum": spec.max, "default": spec.default }),
        );
    }
    for (field, _) in FONT_FAMILY_FIELDS {
        properties.insert(field.into(), json!({ "type": "string", "default": "" }));
    }
    Schema::from_json(json!({ "type": "object", "properties": properties })).ok()
}

/// The row's settings, defaults filled in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThemeSettings {
    pub preference: &'static str,
    /// Text, code and terminal sizes in pixels, in [`FONT_SIZE_SPECS`] order.
    pub font_sizes: [u32; 3],
    /// Text, code and terminal font lists, normalized, in [`FONT_FAMILY_FIELDS`] order; empty means the built-in stack.
    pub font_families: [String; 3],
}

impl Default for ThemeSettings {
    fn default() -> Self {
        Self {
            preference: DEFAULT_THEME_PREFERENCE,
            font_sizes: FONT_SIZE_SPECS.map(|spec| spec.default),
            font_families: Default::default(),
        }
    }
}

/// The row's configuration as settings, or the sentence a value outside the schema fails the row with.
pub fn theme_settings(config: Option<&Value>) -> Result<ThemeSettings, ConfigError> {
    let empty = Value::Object(serde_json::Map::new());
    let config = match config {
        None | Some(Value::Null) => &empty,
        Some(config) => config,
    };
    if let Some(schema) = theme_schema() {
        let problems = schema.check(config);
        if let Some(problem) = problems.first() {
            return Err(ConfigError::one(format!("ui-theme: {problem}")));
        }
    }
    let mut settings = ThemeSettings::default();
    if let Some(preference) = config.get("preference").and_then(Value::as_str) {
        settings.preference = THEME_PREFERENCES
            .iter()
            .copied()
            .find(|candidate| *candidate == preference)
            .unwrap_or(DEFAULT_THEME_PREFERENCE);
    }
    for (index, spec) in FONT_SIZE_SPECS.iter().enumerate() {
        if let Some(size) = config.get(spec.field).and_then(Value::as_u64) {
            settings.font_sizes[index] = size as u32;
        }
    }
    for (index, (field, _)) in FONT_FAMILY_FIELDS.iter().enumerate() {
        if let Some(list) = config.get(*field).and_then(Value::as_str) {
            settings.font_families[index] = normalize_font_family(list);
        }
    }
    Ok(settings)
}

/// CSS generic and system family keywords, which stay unquoted (DSH's `GENERIC_FAMILIES`).
const GENERIC_FAMILIES: [&str; 15] = [
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong",
    "-apple-system",
    "blinkmacsystemfont",
];

/// DSH's `normalizeFontFamily`: comma-separated names; quotes, backslashes, angle brackets and control characters
/// dropped; runs of whitespace folded; every name but a generic family double-quoted. Normalizing a result returns
/// it unchanged, and the result is always a valid list, safe inside CSS.
pub fn normalize_font_family(value: &str) -> String {
    value
        .split(',')
        .map(|name| {
            let kept: String = name
                .chars()
                .filter(|c| !matches!(c, '"' | '\'' | '\\' | '<' | '>') && !c.is_control())
                .collect();
            kept.split_whitespace().collect::<Vec<_>>().join(" ")
        })
        .filter(|name| !name.is_empty())
        .map(|name| {
            if GENERIC_FAMILIES.contains(&name.to_lowercase().as_str()) {
                name
            } else {
                format!("\"{name}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

impl ThemeSettings {
    /// What the served `<html>` element carries: ` data-theme="…" style="…"`, with a leading space. The style holds
    /// each font size, and each font list that is not empty, as the custom properties the page's CSS reads.
    pub fn document_attributes(&self) -> String {
        let mut style = String::new();
        for (index, spec) in FONT_SIZE_SPECS.iter().enumerate() {
            style.push_str(&format!("{}:{}px;", spec.variable, self.font_sizes[index]));
        }
        for (index, (_, variable)) in FONT_FAMILY_FIELDS.iter().enumerate() {
            let list = &self.font_families[index];
            if !list.is_empty() {
                style.push_str(&format!("{variable}:{list};"));
            }
        }
        format!(
            " data-theme=\"{}\" style=\"{}\"",
            self.preference,
            style.replace('&', "&amp;").replace('"', "&quot;")
        )
    }
}

/// The `ui-theme` row's settings as a running server holds them: every page request reads them, and a settings
/// write to the row replaces them, so the next page is served with the new values without a restart.
#[derive(Debug, Default)]
pub struct LiveTheme(std::sync::RwLock<ThemeSettings>);

impl LiveTheme {
    /// A holder starting at the settings the row booted with.
    pub fn new(settings: ThemeSettings) -> Self {
        Self(std::sync::RwLock::new(settings))
    }

    /// The settings now.
    pub fn get(&self) -> ThemeSettings {
        self.0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Take the row's newly written configuration; a value its schema refuses leaves the settings as they were.
    pub fn set_config(&self, config: &Value) -> Result<(), String> {
        let settings = theme_settings(Some(config)).map_err(|error| error.to_string())?;
        *self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = settings;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_configuration_is_dsh_s_defaults_on_the_document() {
        let settings = theme_settings(None).unwrap();
        assert_eq!(settings, ThemeSettings::default());
        assert_eq!(
            settings.document_attributes(),
            " data-theme=\"system\" style=\"--heddle-content-font-size:14px;--heddle-code-font-size:11px;--heddle-terminal-font-size:13px;\""
        );
    }

    #[test]
    fn stored_values_reach_the_document_with_font_lists_normalized_and_escaped() {
        let settings = theme_settings(Some(&json!({
            "preference": "light",
            "fontSize": 18,
            "codeFontSize": 13,
            "textFontFamily": " 'Inter' ,  system-ui,, <b>Fira\\ Sans ",
        })))
        .unwrap();
        assert_eq!(settings.preference, "light");
        assert_eq!(settings.font_sizes, [18, 13, 13]);
        assert_eq!(
            settings.font_families[0],
            "\"Inter\", system-ui, \"bFira Sans\""
        );
        assert_eq!(
            settings.document_attributes(),
            " data-theme=\"light\" style=\"--heddle-content-font-size:18px;--heddle-code-font-size:13px;--heddle-terminal-font-size:13px;--heddle-font-family-text:&quot;Inter&quot;, system-ui, &quot;bFira Sans&quot;;\""
        );
        assert_eq!(
            normalize_font_family(&settings.font_families[0]),
            settings.font_families[0],
            "normalizing a result returns it unchanged"
        );
    }

    #[test]
    fn a_value_outside_the_schema_fails_the_row_and_a_live_holder_keeps_what_it_had() {
        assert!(theme_settings(Some(&json!({ "fontSize": 30 }))).is_err());
        assert!(theme_settings(Some(&json!({ "fontSize": 14.5 }))).is_err());
        assert!(theme_settings(Some(&json!({ "preference": "sepia" }))).is_err());
        let live = LiveTheme::default();
        live.set_config(&json!({ "codeFontSize": 15 })).unwrap();
        assert_eq!(live.get().font_sizes[1], 15);
        assert!(live.set_config(&json!({ "codeFontSize": 9 })).is_err());
        assert_eq!(
            live.get().font_sizes[1],
            15,
            "a refused value changes nothing"
        );
    }
}
