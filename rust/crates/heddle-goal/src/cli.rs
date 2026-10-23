//! `heddle goal [session] [--json]`, rendered: the command line opens the session and prints these.

use crate::service::GoalView;

/// The `--json` answer: `{"session": id, "goal": view | null}`, pretty, with a trailing newline.
pub fn goal_json(session: &str, view: Option<&GoalView>) -> String {
    let _ = (session, view);
    todo!("heddle-goal: cli::goal_json")
}

/// The text answer: `heddle: no goal is current in <id>`, or the goal's id, revision, phase and activation,
/// then its objective, rounds, and block reason when blocked — each line ending in a newline.
pub fn goal_text(session: &str, view: Option<&GoalView>) -> String {
    let _ = (session, view);
    todo!("heddle-goal: cli::goal_text")
}
