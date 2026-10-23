//! The one error this crate raises: a configuration that cannot be used, with every problem found.
//!
//! Ported from `ConfigError` in `src/config/schema.ts`. The TypeScript build also threw plain `Error`s
//! from `src/local-config.ts` and `src/endpoints.ts`; here they are the same type with one problem, so a
//! caller handles one error and prints one shape.

use std::fmt;

/// A configuration that cannot be composed, read or resolved. Carries **every** problem found, not the
/// first, because a composition reports all the rows it could not use in one run.
///
/// `Display` joins the problems with newlines, exactly as the TypeScript `message` did, so the binary
/// prints `heddle: {error}` and gets the same text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError {
    problems: Vec<String>,
}

impl ConfigError {
    /// An error carrying these problems, in order. An empty list is allowed but never raised by this
    /// crate.
    pub fn new(problems: Vec<String>) -> Self {
        Self { problems }
    }

    /// An error carrying exactly one problem.
    pub fn one(problem: impl Into<String>) -> Self {
        Self {
            problems: vec![problem.into()],
        }
    }

    /// Every problem, in the order it was found.
    pub fn problems(&self) -> &[String] {
        &self.problems
    }

    /// Consume the error, keeping its problems — how a caller collecting problems across rows appends
    /// one row's failure to its own list.
    pub fn into_problems(self) -> Vec<String> {
        self.problems
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.problems.join("\n"))
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_joins_every_problem_with_newlines() {
        let error = ConfigError::new(vec!["first".into(), "second".into()]);
        assert_eq!(error.to_string(), "first\nsecond");
        assert_eq!(error.problems().len(), 2);
    }

    #[test]
    fn one_carries_a_single_problem() {
        let error = ConfigError::one("no profile named 'x'");
        assert_eq!(error.problems(), ["no profile named 'x'"]);
        assert_eq!(
            error.into_problems(),
            vec!["no profile named 'x'".to_string()]
        );
    }
}
