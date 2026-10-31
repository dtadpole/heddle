//! The running work that keeps a session from being archived quietly — DSH's `workspace/session-activity`.
//!
//! Ported from `src/session/activity.ts`. DSH refuses a plain `workspace/archiveSession` while a session has
//! work in flight and names that work by family (`dsh-workspace` `archiveSession`,
//! `WorkspaceActiveSessionError.activity`, `lib/index.js:527-541`): `{ "kind": "turn" }` when the session's own
//! turn is running; `{ "kind": "job", "items": [...] }` for the running or stopping background jobs it owns;
//! `{ "kind": "subagent", "items": [...] }` for its running subagent descendants, found by durable lineage — a
//! child whose record names its parent **and** carries the subagent origin, at any depth (a fork shares the
//! lineage field without the origin and never holds its source); and `{ "kind": "schedule", "items": [...] }`
//! for its active reminders, each labelled by its title.
//!
//! **The order is DSH's listener order.** The event is a Cordis waterfall: listeners run in registration order
//! (`cordis/lib/index.js:317-345`) and each answers `[own, ...rest]`. `turn` registers in the Agent registry's
//! constructor (`dsh-agent/lib/index.js:26-37`, `:358`, no injections); `job` in the job registry seam's
//! constructor (`dsh-jobs/lib/index.js:19-43`, `:119`; `dsh-jobs-local` injects nothing and its row follows
//! `agent` in `dsh-base/cordis.patch.yml:82-97`); `subagent` inside `ctx.inject(['agents'])`
//! (`dsh-subagent/lib/index.js:2510-2529`, `:3014-3016`), so after the Agent registry; `schedule` in the
//! Schedule service's constructor effect (`dsh-schedule/lib/index.js:2043-2064`), whose service injects
//! `agents`, `sessions`, `storageDomain`, `sessionController` and `sessionPersistence` (`:1969-1975`). A fiber
//! starts one microtask after it is asked (`cordis/lib/index.js:1349-1356`), so a constructor finishes before
//! a dependant starts. DSH's own type comment lists the shipped providers in this order
//! (`dsh-workspace/lib/types/types.d.ts:28-35`).
//!
//! The turn and the lineage are read here; the job and schedule families come from their rows, already read
//! ([`RowActivity`]): the server asks them through its `SessionActivity` port.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

/// What the lineage walk reads of a session record.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineageMeta {
    pub id: String,
    pub title: Option<String>,
    pub parent_session: Option<String>,
    pub origin: Option<String>,
}

impl LineageMeta {
    /// The lineage fields of a meta record as JSON (`id`, `title`, `parentSession`, `origin`).
    pub fn from_map(map: &serde_json::Map<String, serde_json::Value>) -> Option<LineageMeta> {
        let text = |key: &str| {
            map.get(key)
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        };
        Some(LineageMeta {
            id: text("id")?,
            title: text("title"),
            parent_session: text("parentSession"),
            origin: text("origin"),
        })
    }
}

/// One item of a counted family: its id, and its label when it has one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActivityItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// One family of running work, in DSH's shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActivityEntry {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<ActivityItem>>,
}

/// The families the session's other rows report, already read: its live background jobs (DSH's
/// `runningJobs`) and its active reminders. An empty family is not reported.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RowActivity {
    pub jobs: Vec<ActivityItem>,
    pub schedules: Vec<ActivityItem>,
}

/// The session's running work, in DSH's listener order: its turn, its live jobs, its running subagent
/// descendants, its active reminders. `running` answers whether one session has a turn in flight in this
/// process. The walk is breadth-first and visits each id once, so a damaged chain that loops cannot hang it.
/// A child's label is its title when it has one.
pub fn session_activity(
    session_id: &str,
    metas: &[LineageMeta],
    running: impl Fn(&str) -> bool,
    rows: RowActivity,
) -> Vec<ActivityEntry> {
    let mut children_of: HashMap<&str, Vec<&LineageMeta>> = HashMap::new();
    for meta in metas {
        let (Some(parent), Some("subagent")) =
            (meta.parent_session.as_deref(), meta.origin.as_deref())
        else {
            continue;
        };
        children_of.entry(parent).or_default().push(meta);
    }
    let mut subagents: Vec<&LineageMeta> = Vec::new();
    let mut pending: VecDeque<&str> = VecDeque::from([session_id]);
    let mut visited: HashSet<&str> = HashSet::new();
    while let Some(parent) = pending.pop_front() {
        if !visited.insert(parent) {
            continue;
        }
        for child in children_of
            .get(parent)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if running(&child.id) {
                subagents.push(child);
            }
            pending.push_back(&child.id);
        }
    }
    let mut activity = Vec::new();
    if running(session_id) {
        activity.push(ActivityEntry {
            kind: "turn",
            items: None,
        });
    }
    if !rows.jobs.is_empty() {
        activity.push(ActivityEntry {
            kind: "job",
            items: Some(rows.jobs),
        });
    }
    if !subagents.is_empty() {
        activity.push(ActivityEntry {
            kind: "subagent",
            items: Some(
                subagents
                    .into_iter()
                    .map(|child| ActivityItem {
                        id: child.id.clone(),
                        label: child.title.clone().filter(|title| !title.is_empty()),
                    })
                    .collect(),
            ),
        });
    }
    if !rows.schedules.is_empty() {
        activity.push(ActivityEntry {
            kind: "schedule",
            items: Some(rows.schedules),
        });
    }
    activity
}

/// The sessions a stop-and-archive stops: the session itself and every running subagent the activity named.
/// A job's or a reminder's id names no session; those families are stopped by their own rows.
pub fn activity_sessions(session_id: &str, activity: &[ActivityEntry]) -> Vec<String> {
    let mut ids = vec![session_id.to_owned()];
    for item in activity
        .iter()
        .filter(|entry| entry.kind == "subagent")
        .flat_map(|entry| entry.items.iter().flatten())
    {
        if !ids.contains(&item.id) {
            ids.push(item.id.clone());
        }
    }
    ids
}

/// The refusal's sentence: what blocks the archive, and that `stop: true` stops it. A turn or a subagent is
/// the session running; with neither, the sentence names the row's work instead (the jobs sentence is the jobs
/// row's own). `src/session/activity.ts` `refusalSentence` says the same.
pub fn refusal_sentence(session_id: &str, activity: &[ActivityEntry]) -> String {
    let has = |kind: &str| activity.iter().any(|entry| entry.kind == kind);
    if has("turn") || has("subagent") {
        format!("session {session_id} is running; pass stop: true to stop it and archive")
    } else if has("job") {
        format!(
            "session {session_id} has running background jobs; pass stop: true to stop them and archive"
        )
    } else {
        format!(
            "session {session_id} has active scheduled reminders; pass stop: true to stop them and archive"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(
        id: &str,
        parent: Option<&str>,
        origin: Option<&str>,
        title: Option<&str>,
    ) -> LineageMeta {
        LineageMeta {
            id: id.to_owned(),
            title: title.map(str::to_owned),
            parent_session: parent.map(str::to_owned),
            origin: origin.map(str::to_owned),
        }
    }

    #[test]
    fn a_quiet_session_has_no_activity() {
        let metas = [meta("a", None, None, None)];
        assert!(session_activity("a", &metas, |_| false, RowActivity::default()).is_empty());
    }

    #[test]
    fn a_running_turn_is_named_as_dsh_names_it() {
        let metas = [meta("a", None, None, None)];
        let activity = session_activity("a", &metas, |id| id == "a", RowActivity::default());
        assert_eq!(
            serde_json::to_value(&activity).unwrap(),
            serde_json::json!([{ "kind": "turn" }])
        );
    }

    #[test]
    fn running_subagent_descendants_are_listed_at_any_depth_and_forks_are_not() {
        let metas = [
            meta("a", None, None, None),
            meta("child", Some("a"), Some("subagent"), Some("look things up")),
            meta("grandchild", Some("child"), Some("subagent"), None),
            meta("idle-child", Some("a"), Some("subagent"), None),
            meta("fork", Some("a"), None, Some("a fork")),
            meta("other", Some("b"), Some("subagent"), None),
        ];
        let running = |id: &str| matches!(id, "child" | "grandchild" | "fork" | "other");
        let activity = session_activity("a", &metas, running, RowActivity::default());
        assert_eq!(
            serde_json::to_value(&activity).unwrap(),
            serde_json::json!([{ "kind": "subagent", "items": [
                { "id": "child", "label": "look things up" },
                { "id": "grandchild" }
            ] }])
        );
        assert_eq!(
            activity_sessions("a", &activity),
            vec!["a".to_owned(), "child".to_owned(), "grandchild".to_owned()]
        );
    }

    #[test]
    fn a_lineage_that_loops_is_walked_once() {
        let metas = [
            meta("a", Some("b"), Some("subagent"), None),
            meta("b", Some("a"), Some("subagent"), None),
        ];
        let activity = session_activity("a", &metas, |_| true, RowActivity::default());
        assert_eq!(
            serde_json::to_value(&activity).unwrap(),
            serde_json::json!([{ "kind": "turn" }, { "kind": "subagent", "items": [{ "id": "b" }, { "id": "a" }] }])
        );
    }
    fn item(id: &str, label: &str) -> ActivityItem {
        ActivityItem {
            id: id.to_owned(),
            label: Some(label.to_owned()),
        }
    }

    #[test]
    fn the_four_families_come_in_dsh_listener_order() {
        let metas = [
            meta("a", None, None, None),
            meta("child", Some("a"), Some("subagent"), Some("look things up")),
        ];
        let rows = RowActivity {
            jobs: vec![item("bash-0123456789abcdef", "sleep 30")],
            schedules: vec![item("schedule-1", "Stand-up")],
        };
        let activity = session_activity("a", &metas, |_| true, rows.clone());
        assert_eq!(
            serde_json::to_value(&activity).unwrap(),
            serde_json::json!([
                { "kind": "turn" },
                { "kind": "job", "items": [{ "id": "bash-0123456789abcdef", "label": "sleep 30" }] },
                { "kind": "subagent", "items": [{ "id": "child", "label": "look things up" }] },
                { "kind": "schedule", "items": [{ "id": "schedule-1", "label": "Stand-up" }] }
            ])
        );
        let idle = session_activity(
            "a",
            &metas,
            |_| false,
            RowActivity {
                jobs: Vec::new(),
                schedules: rows.schedules,
            },
        );
        assert_eq!(
            serde_json::to_value(&idle).unwrap(),
            serde_json::json!([{ "kind": "schedule", "items": [{ "id": "schedule-1", "label": "Stand-up" }] }]),
            "an idle session with an active reminder is still active"
        );
        assert!(session_activity("a", &metas, |_| false, RowActivity::default()).is_empty());
    }

    #[test]
    fn a_stop_reaches_sessions_only_and_not_job_or_reminder_ids() {
        let activity = vec![
            ActivityEntry {
                kind: "turn",
                items: None,
            },
            ActivityEntry {
                kind: "job",
                items: Some(vec![item("bash-0123456789abcdef", "sleep 30")]),
            },
            ActivityEntry {
                kind: "subagent",
                items: Some(vec![ActivityItem {
                    id: "child".to_owned(),
                    label: None,
                }]),
            },
            ActivityEntry {
                kind: "schedule",
                items: Some(vec![item("schedule-1", "Stand-up")]),
            },
        ];
        assert_eq!(
            activity_sessions("a", &activity),
            vec!["a".to_owned(), "child".to_owned()]
        );
    }

    #[test]
    fn the_refusal_says_what_blocks_the_archive() {
        let entry = |kind: &'static str| ActivityEntry {
            kind,
            items: Some(vec![item("x", "x")]),
        };
        assert_eq!(
            refusal_sentence("s", &[entry("turn")]),
            "session s is running; pass stop: true to stop it and archive"
        );
        assert_eq!(
            refusal_sentence("s", &[entry("subagent")]),
            "session s is running; pass stop: true to stop it and archive"
        );
        assert_eq!(
            refusal_sentence("s", &[entry("job"), entry("schedule")]),
            "session s has running background jobs; pass stop: true to stop them and archive"
        );
        assert_eq!(
            refusal_sentence("s", &[entry("schedule")]),
            "session s has active scheduled reminders; pass stop: true to stop them and archive"
        );
    }
}
