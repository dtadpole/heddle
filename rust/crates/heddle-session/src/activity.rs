//! The running work that keeps a session from being archived quietly — DSH's `workspace/session-activity`.
//!
//! Ported from `src/session/activity.ts`. DSH refuses a plain `workspace/archiveSession` while a session has
//! work in flight and names that work by family (`dsh-workspace` `archiveSession`,
//! `WorkspaceActiveSessionError.activity`): `{ "kind": "turn" }` when the session's own turn is running, and
//! `{ "kind": "subagent", "items": [...] }` for its running subagent descendants, found by durable lineage —
//! a child whose record names its parent **and** carries the subagent origin, at any depth (a fork shares the
//! lineage field without the origin and never holds its source).
//!
//! Heddle reports those two families. DSH's background jobs (`dsh-jobs`) have no runtime here. Scheduled
//! reminders (`dsh-schedule`) landed on main (`heddle-schedule`) after this walk was written; asking them is a
//! follow-up for both builds.

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

/// The session's running work, in DSH's listener order: its turn first, then its running subagent
/// descendants. `running` answers whether one session has a turn in flight in this process. The walk is
/// breadth-first and visits each id once, so a damaged chain that loops cannot hang it. A child's label is
/// its title when it has one.
pub fn session_activity(
    session_id: &str,
    metas: &[LineageMeta],
    running: impl Fn(&str) -> bool,
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
    activity
}

/// The sessions a stop-and-archive stops: the session itself and every running subagent the activity named.
pub fn activity_sessions(session_id: &str, activity: &[ActivityEntry]) -> Vec<String> {
    let mut ids = vec![session_id.to_owned()];
    for item in activity
        .iter()
        .flat_map(|entry| entry.items.iter().flatten())
    {
        if !ids.contains(&item.id) {
            ids.push(item.id.clone());
        }
    }
    ids
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
        assert!(session_activity("a", &metas, |_| false).is_empty());
    }

    #[test]
    fn a_running_turn_is_named_as_dsh_names_it() {
        let metas = [meta("a", None, None, None)];
        let activity = session_activity("a", &metas, |id| id == "a");
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
        let activity = session_activity("a", &metas, running);
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
        let activity = session_activity("a", &metas, |_| true);
        assert_eq!(
            serde_json::to_value(&activity).unwrap(),
            serde_json::json!([{ "kind": "turn" }, { "kind": "subagent", "items": [{ "id": "b" }, { "id": "a" }] }])
        );
    }
}
