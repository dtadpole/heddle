//! The environment a configuration reads, passed explicitly.
//!
//! The TypeScript build took `env: NodeJS.ProcessEnv = process.env` on every function that reads a
//! variable, and its checks passed their own maps. This is that parameter made a type, for a reason
//! Rust adds: edition 2024 makes `std::env::set_var` `unsafe`, the workspace forbids `unsafe`, so a test
//! cannot set a variable for the code under test — it builds an [`Env`] instead. Every function in this
//! crate that reads `HEDDLE_HOME`, `HEDDLE_CONFIG`, `HOME` or a `${NAME}` reference reads it from here.

use std::collections::BTreeMap;
use std::path::PathBuf;

/// A snapshot of environment variables.
///
/// Built once from the process at startup with [`Env::from_process`], or from pairs in a test with
/// [`Env::from_pairs`]. A variable set to the empty string is **present**: the TypeScript build used
/// `??`, which honours `''`, wherever it read `HEDDLE_HOME`, and this keeps that reading. The one place
/// that treated `''` as absent (`HEDDLE_CONFIG`) says so where it reads it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Env {
    vars: BTreeMap<String, String>,
}

impl Env {
    /// The process's environment, as it is now. Variables whose name or value is not UTF-8 are left
    /// out, because nothing this crate reads can be spelled that way.
    pub fn from_process() -> Self {
        let vars = std::env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        Self { vars }
    }

    /// An environment holding exactly these variables; a later pair for the same name wins.
    pub fn from_pairs<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let vars = pairs
            .into_iter()
            .map(|(name, value)| (name.into(), value.into()))
            .collect();
        Self { vars }
    }

    /// The value of `name`, or `None` when it is not set.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }

    /// The value of `name` when it is set **and not empty** — JavaScript's truthiness test, which the
    /// TypeScript build used for `HEDDLE_CONFIG` and the `HEDDLE_<ENDPOINT>_*` overrides.
    pub fn non_empty(&self, name: &str) -> Option<&str> {
        self.get(name).filter(|value| !value.is_empty())
    }

    /// This environment with `name` set to `value`, for building one in a test.
    pub fn with(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.vars.insert(name.into(), value.into());
        self
    }

    /// This environment without `name`.
    pub fn without(mut self, name: &str) -> Self {
        self.vars.remove(name);
        self
    }

    /// The user's home directory: `$HOME` from this environment, else the platform's answer, else `/`.
    ///
    /// `$HOME` first is Node's `os.homedir()` rule on POSIX, and it is what lets a check point the
    /// whole harness at a fixture home (`10-llm-backends` passes `HOME` for exactly that).
    pub fn home_dir(&self) -> PathBuf {
        match self.get("HOME") {
            Some(home) if !home.is_empty() => PathBuf::from(home),
            _ => std::env::home_dir().unwrap_or_else(|| PathBuf::from("/")),
        }
    }

    /// Every variable, in name order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.vars
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_value_is_present_but_not_non_empty() {
        let env = Env::from_pairs([("HEDDLE_HOME", ""), ("HEDDLE_CONFIG", "/x.json")]);
        assert_eq!(env.get("HEDDLE_HOME"), Some(""));
        assert_eq!(env.non_empty("HEDDLE_HOME"), None);
        assert_eq!(env.non_empty("HEDDLE_CONFIG"), Some("/x.json"));
        assert_eq!(env.get("ABSENT"), None);
    }

    #[test]
    fn home_dir_reads_home_from_the_snapshot_first() {
        let env = Env::default().with("HOME", "/fixture/home");
        assert_eq!(env.home_dir(), PathBuf::from("/fixture/home"));
    }

    #[test]
    fn with_and_without_edit_a_copy() {
        let env = Env::from_pairs([("A", "1")]).with("B", "2").without("A");
        assert_eq!(env.get("A"), None);
        assert_eq!(env.get("B"), Some("2"));
        assert_eq!(env.iter().collect::<Vec<_>>(), vec![("B", "2")]);
    }

    #[test]
    fn a_later_pair_wins() {
        let env = Env::from_pairs([("A", "1"), ("A", "2")]);
        assert_eq!(env.get("A"), Some("2"));
    }
}
