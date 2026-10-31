//! The interface language (issue #80): DSH's dsh-client-locale, as heddle's `locale` profile row. The twin of
//! `src/config/locale.ts`; the rules are the same.
//!
//! DSH ships English and Chinese. A person's choice is a setting: it persists as `locale.preference` through the
//! settings service, here the `locale` row's `preference`, which the settings API reads and writes like any other
//! row. With no stored preference, a browser gets the first supported language it asks for, matched by full tag and
//! then by primary subtag, else English. DSH's preference takes any BCP 47 id because client plugins may add language
//! packs; heddle ships no language-pack mechanism, so its `preference` takes the two shipped ids only.

use serde_json::Value;

use crate::{ConfigError, Schema};

/// The `locale` row's stored choice, as the service a server reads: `None` follows each browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LocalePreference(pub Option<&'static str>);

impl LocalePreference {
    /// The language for a request: the stored preference, else what its `Accept-Language` asks for, else English.
    pub fn for_request(&self, accept_language: Option<&str>) -> &'static str {
        negotiate_locale(self.0, &accepted_languages(accept_language))
    }
}

/// The `locale` row's preference as a running server holds it (issue #80): every page request reads it, and a settings
/// write to the row replaces it, so the next page is served in the language just chosen without a restart. The TypeScript
/// build gets the same from its loader, which re-applies the written row; this is the Rust loader's stand-in.
#[derive(Debug, Default)]
pub struct LiveLocale(std::sync::RwLock<LocalePreference>);

impl LiveLocale {
    /// A holder starting at the preference the row booted with.
    pub fn new(preference: LocalePreference) -> Self {
        Self(std::sync::RwLock::new(preference))
    }

    /// The preference now.
    pub fn get(&self) -> LocalePreference {
        *self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Take the row's newly written configuration; a value its schema refuses leaves the preference as it was.
    pub fn set_config(&self, config: &Value) -> Result<(), String> {
        let preference = locale_preference(Some(config)).map_err(|error| error.to_string())?;
        *self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = LocalePreference(preference);
        Ok(())
    }
}

/// The languages heddle ships, in the order a tie is broken.
pub const SUPPORTED_LOCALES: [&str; 2] = ["en", "zh"];

/// The language a browser gets when nothing it asks for is supported.
pub const FALLBACK_LOCALE: &str = "en";

/// What the settings row offers, as DSH labels its shipped locales.
pub fn locale_label(locale: &str) -> Option<&'static str> {
    match locale {
        "en" => Some("English"),
        "zh" => Some("中文"),
        _ => None,
    }
}

/// The `<html lang>` tag for a locale: DSH writes `zh-CN` for Chinese and the id otherwise.
pub fn document_language(locale: &str) -> &str {
    if locale == "zh" { "zh-CN" } else { locale }
}

/// The `locale` row's schema: `preference` is `en` or `zh`, and absent means "follow the browser".
pub fn locale_schema() -> Option<Schema> {
    Schema::from_json(serde_json::json!({
        "type": "object",
        "properties": {
            "preference": { "type": "string", "enum": SUPPORTED_LOCALES }
        }
    }))
    .ok()
}

/// The row's stored preference: `Ok(None)` for none, or the sentence a bad value fails the row with.
pub fn locale_preference(config: Option<&Value>) -> Result<Option<&'static str>, ConfigError> {
    match config.and_then(|config| config.get("preference")) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => supported(value).map(Some).ok_or_else(|| {
            ConfigError::one(format!(
                "locale: preference must be one of {}, not '{value}'",
                SUPPORTED_LOCALES.join(", ")
            ))
        }),
        Some(_) => Err(ConfigError::one("locale: preference must be a string")),
    }
}

/// The languages an `Accept-Language` header asks for, most wanted first: q-values order them, a `q=0` entry is
/// refused, and `*` names nothing in particular so it is dropped.
pub fn accepted_languages(header: Option<&str>) -> Vec<String> {
    let Some(header) = header else {
        return Vec::new();
    };
    let mut entries: Vec<(String, f64, usize)> = header
        .split(',')
        .enumerate()
        .filter_map(|(index, part)| {
            let mut pieces = part.trim().split(';');
            let tag = pieces.next().unwrap_or("").trim().to_owned();
            let weight = pieces
                .map(str::trim)
                .find_map(|param| param.strip_prefix("q="))
                .map_or(Some(1.0), |q| q.parse::<f64>().ok())
                .unwrap_or(0.0);
            (!tag.is_empty() && tag != "*" && weight > 0.0).then_some((tag, weight, index))
        })
        .collect();
    entries.sort_by(|left, right| right.1.total_cmp(&left.1).then(left.2.cmp(&right.2)));
    entries.into_iter().map(|(tag, _, _)| tag).collect()
}

fn supported(tag: &str) -> Option<&'static str> {
    SUPPORTED_LOCALES
        .iter()
        .copied()
        .find(|locale| locale.eq_ignore_ascii_case(tag))
}

/// The language to use: the stored preference when there is one, else the first requested language that matches a
/// supported one by full tag and then by primary subtag (`zh-CN` -> `zh`), else English. DSH's selection rule.
pub fn negotiate_locale(preference: Option<&str>, requested: &[String]) -> &'static str {
    if let Some(chosen) = preference.and_then(supported) {
        return chosen;
    }
    for tag in requested {
        if let Some(exact) = supported(tag) {
            return exact;
        }
        if let Some(primary) = supported(tag.split('-').next().unwrap_or("")) {
            return primary;
        }
    }
    FALLBACK_LOCALE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_written_preference_reaches_the_next_request_and_a_refused_one_changes_nothing() {
        let live = LiveLocale::new(LocalePreference(None));
        assert_eq!(live.get().for_request(Some("en-US")), "en");
        live.set_config(&serde_json::json!({"preference": "zh"}))
            .unwrap();
        assert_eq!(
            live.get().for_request(Some("en-US")),
            "zh",
            "the stored choice wins over the browser"
        );
        assert!(
            live.set_config(&serde_json::json!({"preference": "fr"}))
                .is_err()
        );
        assert_eq!(
            live.get(),
            LocalePreference(Some("zh")),
            "a refused value leaves the choice as it was"
        );
        live.set_config(&serde_json::json!({})).unwrap();
        assert_eq!(
            live.get().for_request(Some("zh-TW")),
            "zh",
            "no choice: the browser's language again"
        );
    }
    use serde_json::json;

    #[test]
    fn accept_language_is_read_most_wanted_first_and_q0_and_star_name_nothing() {
        assert_eq!(
            accepted_languages(Some("zh-CN,zh;q=0.9,en;q=0.8")),
            ["zh-CN", "zh", "en"]
        );
        assert_eq!(accepted_languages(Some("en;q=0.5, zh-TW")), ["zh-TW", "en"]);
        assert!(accepted_languages(Some("fr;q=0, *;q=0.1")).is_empty());
        assert!(accepted_languages(None).is_empty());
    }

    #[test]
    fn a_preference_wins_then_full_tag_then_primary_subtag_then_english() {
        let tags = |list: &[&str]| list.iter().map(|tag| (*tag).to_owned()).collect::<Vec<_>>();
        assert_eq!(negotiate_locale(Some("zh"), &tags(&["en"])), "zh");
        assert_eq!(negotiate_locale(None, &tags(&["zh-CN", "en"])), "zh");
        assert_eq!(negotiate_locale(None, &tags(&["fr", "en-GB", "zh"])), "en");
        assert_eq!(negotiate_locale(None, &tags(&["fr", "de"])), "en");
        assert_eq!(negotiate_locale(Some("xx"), &tags(&["zh"])), "zh");
    }

    #[test]
    fn the_row_takes_en_or_zh_and_keeps_an_absent_preference_absent() {
        assert_eq!(locale_preference(None).unwrap(), None);
        assert_eq!(locale_preference(Some(&json!({}))).unwrap(), None);
        assert_eq!(
            locale_preference(Some(&json!({ "preference": "zh" }))).unwrap(),
            Some("zh")
        );
        assert_eq!(
            locale_preference(Some(&json!({ "preference": "fr" })))
                .unwrap_err()
                .problems(),
            ["locale: preference must be one of en, zh, not 'fr'".to_owned()]
        );
        assert!(locale_schema().is_some());
    }

    #[test]
    fn the_document_tag_and_labels_are_dshs() {
        assert_eq!(document_language("zh"), "zh-CN");
        assert_eq!(document_language("en"), "en");
        assert_eq!(locale_label("zh"), Some("中文"));
        assert_eq!(locale_label("en"), Some("English"));
    }
}
