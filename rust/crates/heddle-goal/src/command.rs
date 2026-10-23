//! `heddle goal [session] [--json]`: the command this crate owns (D-043), behind the binary's entry-point
//! convention.
//!
//! The oracle is the `goal` branch of `src/cli.ts`: without the goal plugin it fails with `this profile does
//! not load the goal plugin`; it then opens the session the positional names, or the one in the working
//! directory, and prints its goal ([`cli::goal_json`](crate::cli::goal_json) / [`cli::goal_text`](crate::cli::goal_text)).
//! Opening the session is the session crate's, so the binary hands in a resolver and this command calls it
//! only after the plugin check, which keeps the oracle's order of failures.

use std::io::Write;

use crate::cli::{goal_json, goal_text};
use crate::service::GoalService;

/// The command words this crate answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// `goal`: the current goal of a session.
    Goal,
}

/// The flags `goal` reads, named after the TypeScript `Args` field. The positional session id is the
/// resolver's input, so it is not read here.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Args {
    /// `--json`: `{"session": id, "goal": view | null}`, pretty, and a newline.
    pub json: bool,
}

/// Opens the session `goal` answers for and returns its canonical id, or the sentence that says why it could
/// not: `session.start({resume: target})` when a positional was given, `session.start({cwd})` otherwise.
pub type SessionResolver<'a> = dyn Fn() -> Result<String, String> + 'a;

/// What `goal` runs against: the composed goal service, absent when the profile leaves the row out, and the
/// session resolver.
pub struct Context<'a> {
    /// The goal service the `goal` row built.
    pub goals: Option<&'a GoalService>,
    /// The session the command answers for.
    pub session: &'a SessionResolver<'a>,
}

/// Write the answer to `out` and any failure to `err` as `heddle: <sentence>`; return the exit code.
pub fn run(
    command: Command,
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    match command {
        Command::Goal => {
            let Some(goals) = context.goals else {
                return fail(err, "this profile does not load the goal plugin");
            };
            let session = match (context.session)() {
                Ok(session) => session,
                Err(message) => return fail(err, &message),
            };
            let view = match goals.get(&session) {
                Ok(view) => view,
                Err(error) => return fail(err, &error.to_string()),
            };
            let text = if args.json {
                goal_json(&session, view.as_ref())
            } else {
                goal_text(&session, view.as_ref())
            };
            match out.write_all(text.as_bytes()) {
                Ok(()) => 0,
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => 0,
                Err(error) => fail(err, &format!("could not write the goal: {error}")),
            }
        }
    }
}

/// `heddle: <sentence>` on `err`, exit 1 — the TypeScript build's `process.exitCode = 1`.
fn fail(err: &mut dyn Write, message: &str) -> i32 {
    let _ = writeln!(err, "heddle: {message}");
    1
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use serde_json::{Value, json};

    use super::*;
    use crate::service::{CreateGoal, GoalRef};
    use crate::test_support::fixture;

    fn answer(context: &Context<'_>, json: bool) -> (i32, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(Command::Goal, &Args { json }, context, &mut out, &mut err);
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    #[test]
    fn without_the_goal_plugin_it_fails_before_opening_a_session() {
        let opened = Cell::new(false);
        let resolver = || {
            opened.set(true);
            Ok("s1".to_owned())
        };
        let (code, out, err) = answer(
            &Context {
                goals: None,
                session: &resolver,
            },
            false,
        );
        assert_eq!(code, 1);
        assert_eq!(out, "");
        assert_eq!(err, "heddle: this profile does not load the goal plugin\n");
        assert!(
            !opened.get(),
            "the plugin check comes first, as in the oracle"
        );
    }

    #[test]
    fn a_session_that_cannot_be_opened_says_why() {
        let (_log, goals) = fixture("s1");
        let resolver = || Err("no session nope".to_owned());
        let (code, out, err) = answer(
            &Context {
                goals: Some(&goals),
                session: &resolver,
            },
            false,
        );
        assert_eq!(code, 1);
        assert_eq!(out, "");
        assert_eq!(err, "heddle: no session nope\n");
    }

    #[test]
    fn a_session_without_a_goal_says_so_in_both_forms() {
        let (_log, goals) = fixture("s1");
        let resolver = || Ok("s1".to_owned());
        let context = Context {
            goals: Some(&goals),
            session: &resolver,
        };
        assert_eq!(
            answer(&context, false),
            (
                0,
                "heddle: no goal is current in s1\n".to_owned(),
                String::new()
            )
        );
        let (code, out, _) = answer(&context, true);
        assert_eq!(code, 0);
        assert_eq!(out, "{\n  \"session\": \"s1\",\n  \"goal\": null\n}\n");
    }

    #[test]
    fn a_goal_prints_its_identity_phase_objective_and_rounds() {
        let (_log, goals) = fixture("s1");
        let created = goals
            .create(
                "s1",
                CreateGoal {
                    objective: "ship the port".into(),
                    max_goal_rounds: Some(4.0),
                },
            )
            .unwrap();
        let resolver = || Ok("s1".to_owned());
        let context = Context {
            goals: Some(&goals),
            session: &resolver,
        };
        let (code, out, err) = answer(&context, false);
        assert_eq!(code, 0);
        assert_eq!(err, "");
        assert_eq!(
            out,
            format!(
                "heddle: {}  revision 1  active (armed)\n  objective: ship the port\n  rounds: 0/4\n",
                created.goal.id
            )
        );
        let (code, out, _) = answer(&context, true);
        assert_eq!(code, 0);
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["session"], "s1");
        assert_eq!(parsed["goal"]["id"], json!(created.goal.id));
        assert_eq!(parsed["goal"]["maxGoalRounds"], 4);
    }

    #[test]
    fn a_blocked_goal_prints_its_reason() {
        let (_log, goals) = fixture("s1");
        let created = goals
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: Some(1.0),
                },
            )
            .unwrap();
        goals
            .block(
                "s1",
                &GoalRef { id: created.goal.id.clone(), revision: 1 },
                &json!({"code": "round-limit", "message": "Goal reached its configured limit of 1 rounds."}),
            )
            .unwrap();
        let resolver = || Ok("s1".to_owned());
        let (code, out, _) = answer(
            &Context {
                goals: Some(&goals),
                session: &resolver,
            },
            false,
        );
        assert_eq!(code, 0);
        assert!(
            out.ends_with(
                "  blocked: round-limit — Goal reached its configured limit of 1 rounds.\n"
            ),
            "{out}"
        );
        assert!(out.contains("blocked (disarmed)"), "{out}");
    }

    #[test]
    fn a_log_that_does_not_fold_is_a_failure_not_a_guess() {
        let (log, goals) = fixture("s1");
        log.append_raw("s1", json!({"type": "goal/change", "version": 99}));
        let resolver = || Ok("s1".to_owned());
        let (code, out, err) = answer(
            &Context {
                goals: Some(&goals),
                session: &resolver,
            },
            true,
        );
        assert_eq!(code, 1);
        assert_eq!(out, "");
        assert_eq!(err, "heddle: unsupported goal change version 99\n");
    }
}
