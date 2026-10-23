//! Where `$HEDDLE_HOME` is, where profiles live, and how a leading `~` is read.
//!
//! Ported from `heddleHome`, `profilesDir` and `expandHome` in `src/config/schema.ts`. Several crates
//! read these — the context's instruction files, the sandbox's protected roots, the server's upload
//! directory — so they live here once rather than as a second copy that disagrees.

use std::path::PathBuf;

use crate::env::Env;

/// `$HEDDLE_HOME` when it is set (even to `''`, as the TypeScript `??` did), else `~/.heddle`.
pub fn heddle_home(env: &Env) -> PathBuf {
    match env.get("HEDDLE_HOME") {
        Some(home) => PathBuf::from(home),
        None => env.home_dir().join(".heddle"),
    }
}

/// `$HEDDLE_HOME/profiles`, the directory whose children are the named profiles.
pub fn profiles_dir(env: &Env) -> PathBuf {
    heddle_home(env).join("profiles")
}

/// A path with a leading `~` or `~/` replaced by the home directory, because a configuration may write
/// every path that way.
///
/// One deliberate difference from the TypeScript build: it replaced **any** leading `~`, so `~user/x`
/// became `<home>user/x`. Here `~user/x` is returned unchanged, since that spelling names another
/// user's home and no layer in the repository writes it.
pub fn expand_home(path: &str, env: &Env) -> PathBuf {
    if path == "~" {
        return env.home_dir();
    }
    match path.strip_prefix("~/") {
        Some(rest) => env.home_dir().join(rest),
        None => PathBuf::from(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Env {
        Env::default().with("HOME", "/home/someone")
    }

    #[test]
    fn heddle_home_honours_the_variable_first() {
        assert_eq!(
            heddle_home(&env().with("HEDDLE_HOME", "/fixture")),
            PathBuf::from("/fixture")
        );
        assert_eq!(heddle_home(&env()), PathBuf::from("/home/someone/.heddle"));
    }

    #[test]
    fn an_empty_heddle_home_is_still_the_answer() {
        // The TypeScript build read it with `??`, so `''` was used rather than replaced.
        assert_eq!(
            heddle_home(&env().with("HEDDLE_HOME", "")),
            PathBuf::from("")
        );
    }

    #[test]
    fn profiles_live_under_heddle_home() {
        assert_eq!(
            profiles_dir(&env().with("HEDDLE_HOME", "/fixture")),
            PathBuf::from("/fixture/profiles")
        );
    }

    #[test]
    fn expand_home_replaces_only_a_leading_tilde_segment() {
        assert_eq!(expand_home("~", &env()), PathBuf::from("/home/someone"));
        assert_eq!(
            expand_home("~/.heddle/sessions", &env()),
            PathBuf::from("/home/someone/.heddle/sessions")
        );
        assert_eq!(expand_home("/abs/~/x", &env()), PathBuf::from("/abs/~/x"));
        assert_eq!(expand_home("rel/x", &env()), PathBuf::from("rel/x"));
        assert_eq!(expand_home("~other/x", &env()), PathBuf::from("~other/x"));
    }
}
