//! `heddle goal [session] [--json]`, rendered: the command line opens the session and prints these.

use serde::Serialize;

use crate::service::GoalView;

/// The `--json` answer: `{"session": id, "goal": view | null}`, pretty, with a trailing newline.
pub fn goal_json(session: &str, view: Option<&GoalView>) -> String {
    #[derive(Serialize)]
    struct Answer<'a> {
        session: &'a str,
        goal: Option<&'a GoalView>,
    }

    let mut text = serde_json::to_string_pretty(&Answer {
        session,
        goal: view,
    })
    .expect("a goal view is plain data");
    text.push('\n');
    text
}

/// The text answer: `heddle: no goal is current in <id>`, or the goal's id, revision, phase and activation,
/// then its objective, rounds, and block reason when blocked — each line ending in a newline.
pub fn goal_text(session: &str, view: Option<&GoalView>) -> String {
    let Some(view) = view else {
        return format!("heddle: no goal is current in {session}\n");
    };
    let mut text = format!(
        "heddle: {}  revision {}  {} ({})\n",
        view.goal.id,
        view.goal.revision,
        view.goal.phase.as_str(),
        view.activation.as_str()
    );
    text.push_str(&format!("  objective: {}\n", view.goal.objective));
    text.push_str(&format!(
        "  rounds: {}/{}\n",
        view.rounds_started, view.goal.max_goal_rounds
    ));
    if let Some(reason) = &view.goal.blocked_reason {
        text.push_str(&format!(
            "  blocked: {} — {}\n",
            reason.code, reason.message
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::service::{CreateGoal, GoalRef, GoalService};
    use crate::test_support::fixture;

    fn goal(goals: &GoalService) -> GoalView {
        goals
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: Some(4.0),
                },
            )
            .unwrap()
    }

    #[test]
    fn the_json_answer_is_pretty_and_null_without_a_goal() {
        let (_log, goals) = fixture("s1");
        assert_eq!(
            goal_json("s1", None),
            "{\n  \"session\": \"s1\",\n  \"goal\": null\n}\n"
        );
        let view = goal(&goals);
        let parsed: Value = serde_json::from_str(&goal_json("s1", Some(&view))).unwrap();
        assert_eq!(parsed["session"], "s1");
        assert_eq!(parsed["goal"]["id"], view.goal.id);
        assert_eq!(parsed["goal"]["roundsStarted"], 0);
        assert_eq!(parsed["goal"]["activation"], "armed");
    }

    #[test]
    fn the_text_answer_names_the_goal_and_its_rounds() {
        let (_log, goals) = fixture("s1");
        assert_eq!(goal_text("s1", None), "heddle: no goal is current in s1\n");
        let view = goal(&goals);
        let text = goal_text("s1", Some(&view));
        assert!(text.starts_with(&format!(
            "heddle: {}  revision 1  active (armed)\n",
            view.goal.id
        )));
        assert!(text.contains("  objective: one\n"));
        assert!(text.contains("  rounds: 0/4\n"));
        assert!(!text.contains("  blocked:"));
    }

    #[test]
    fn a_blocked_goal_prints_its_reason() {
        let (_log, goals) = fixture("s1");
        let created = goal(&goals);
        let blocked = goals
            .block(
                "s1",
                &GoalRef {
                    id: created.goal.id,
                    revision: 1,
                },
                &serde_json::json!({"code": "missing-input", "message": "needs a key"}),
            )
            .unwrap();
        let text = goal_text("s1", Some(&blocked));
        assert!(
            text.contains("  blocked: missing-input — needs a key\n"),
            "saw: {text}"
        );
    }
}
