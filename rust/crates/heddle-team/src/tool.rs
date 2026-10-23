//! The nine model-facing team tools, modelled on DSH's `tool-agent-team`.
//!
//! Port of `src/team/tool.ts`. They are thin on purpose: every rule lives in the service or the pure state
//! layer, so the refusal a teammate meets here is the one a test asserts. A tool only translates arguments,
//! calls the service and reports the outcome — including `noProgress`, which is an answer, not an error.
//!
//! This crate does not depend on the tool registry. [`team_tool_specs`] gives each tool's name, description
//! and JSON-schema parameters, and [`TeamTools::call`] runs one; the registry's adapter wraps each spec as a
//! registered tool whose result is a [`ToolOutcome`] — the TypeScript `ToolResult` shape,
//! `{ output, data?, error?: { code, message } }`.

// Contract stage: the bodies below are `todo!()` until the tools land (port plan, step M3).
#![allow(unused_variables, dead_code)]

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Value, json};

use crate::service::TeamService;

/// The nine tool names, exactly DSH's set.
pub const TEAM_TOOL_NAMES: [&str; 9] = [
    "spawn_teammate",
    "send_message",
    "list_agents",
    "wait_agent",
    "interrupt_agent",
    "team_task_create",
    "team_task_list",
    "team_task_get",
    "team_task_update",
];

/// `wait_agent`'s timeout when `timeout_ms` is absent.
pub const WAIT_DEFAULT_MS: u64 = 30_000;
/// The longest `wait_agent` honours; a larger `timeout_ms` is clamped.
pub const WAIT_MAX_MS: u64 = 120_000;

/// `wait_agent`'s answer when nobody can act.
pub const WAIT_NO_PROGRESS_TEXT: &str = "noProgress: no other member is running or provisioning; re-list with list_agents and wake one with send_message";
/// `wait_agent`'s answer when the wait ran out.
pub const WAIT_TIMED_OUT_TEXT: &str =
    "timedOut: no change before the wait ended; re-list with list_agents and team_task_list";
/// `wait_agent`'s answer when the team changed.
pub const WAIT_CHANGED_TEXT: &str = "changed: re-list with list_agents and team_task_list";

/// One tool as the model is told about it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TeamToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// A JSON-schema object with `additionalProperties: false`.
    pub parameters: Value,
}

/// A tool refusal: a stable code (a [`crate::TeamErrorCode`] string) and a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolFailure {
    pub code: String,
    pub message: String,
}

/// One tool call's result, the TypeScript `ToolResult` shape.
///
/// Success: `output` is the compact JSON of the result (or `wait_agent`'s sentence) and `data` the same value.
/// Refusal: `output` is empty and `error` carries the code; a failure that is not a team rule is `TEAM_FAILED`,
/// a call without a session `TEAM_NO_SESSION`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolOutcome {
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolFailure>,
}

/// Called after a successful spawn with the Lead's and the new member's session ids, so the profile can make
/// the collaboration policy durable for the child.
pub type OnSpawn = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Options of the tool set.
#[derive(Clone, Default)]
pub struct TeamToolOptions {
    pub on_spawn: Option<OnSpawn>,
}

/// The nine tools' descriptions and parameter schemas, verbatim from the TypeScript build, in
/// [`TEAM_TOOL_NAMES`] order.
pub fn team_tool_specs() -> Vec<TeamToolSpec> {
    vec![
        TeamToolSpec {
            name: "spawn_teammate",
            description: "Create one named, durable teammate. Only the Team Lead may call this tool. The teammate works in its own session and starts on the prompt you give it; use fresh context unless its work depends on the Lead’s completed turns.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Unique lower-kebab-case teammate name." },
                    "description": { "type": "string", "description": "Short description of the delegated responsibility." },
                    "prompt": { "type": "string", "description": "Complete initial task for the teammate." },
                    "context": { "type": "string", "enum": ["fresh", "fork"], "description": "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh." },
                },
                "required": ["name", "description", "prompt"],
                "additionalProperties": false,
            }),
        },
        TeamToolSpec {
            name: "send_message",
            description: "Send one durable message to another team member. A running target receives it at its nearest step boundary; an inactive target starts or resumes a turn. The result’s status is accepted when the target’s own log holds it, queued when the target is still provisioning.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Member target returned by spawn_teammate or list_agents, or \"lead\"." },
                    "message": { "type": "string", "description": "The message; it is delivered as durable content with its id and sender name." },
                },
                "required": ["target", "message"],
                "additionalProperties": false,
            }),
        },
        TeamToolSpec {
            name: "list_agents",
            description: "List the Lead and every durable teammate with its addressable name and current availability. inactive means no turn is executing; provisioning and failed describe member creation.",
            parameters: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        TeamToolSpec {
            name: "wait_agent",
            description: "Wait for the next teammate status, mailbox or shared-task change after this call starts. Never wakes an inactive member, and returns noProgress immediately when no other member is running or provisioning. Re-list after waking or timing out.",
            parameters: json!({
                "type": "object",
                "properties": { "timeout_ms": { "type": "integer", "description": "Longest wait in milliseconds; defaults to 30000." } },
                "additionalProperties": false,
            }),
        },
        TeamToolSpec {
            name: "interrupt_agent",
            description: "Interrupt one teammate’s current turn while preserving its pending inbox. Team Lead only.",
            parameters: json!({
                "type": "object",
                "properties": { "target": { "type": "string", "description": "Member target from spawn_teammate or list_agents." } },
                "required": ["target"],
                "additionalProperties": false,
            }),
        },
        TeamToolSpec {
            name: "team_task_create",
            description: "Create one unowned pending task on the shared team task board.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "subject": { "type": "string", "description": "Short task title." },
                    "description": { "type": "string", "description": "Complete task details." },
                    "blocked_by": { "type": "array", "items": { "type": "string" }, "description": "Task ids that must complete first." },
                    "write_scopes": { "type": "array", "items": { "type": "string" }, "description": "Advisory file or directory prefixes this task expects to write." },
                },
                "required": ["subject"],
                "additionalProperties": false,
            }),
        },
        TeamToolSpec {
            name: "team_task_list",
            description: "List shared tasks, including readiness, owner, revision, blockers and write-scope warnings.",
            parameters: json!({
                "type": "object",
                "properties": { "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "deleted"] } },
                "additionalProperties": false,
            }),
        },
        TeamToolSpec {
            name: "team_task_get",
            description: "Read the complete latest value of one shared task before changing or executing it.",
            parameters: json!({
                "type": "object",
                "properties": { "task_id": { "type": "string", "description": "Shared task id." } },
                "required": ["task_id"],
                "additionalProperties": false,
            }),
        },
        TeamToolSpec {
            name: "team_task_update",
            description: "Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list. Actions: claim, release, edit, set_dependencies, complete, reopen, reassign (Lead-only), delete.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "string", "description": "Shared task id." },
                    "revision": { "type": "integer", "description": "Current task revision used as the CAS precondition." },
                    "action": { "type": "string", "enum": ["claim", "release", "edit", "set_dependencies", "complete", "reopen", "reassign", "delete"] },
                    "subject": { "type": "string", "description": "Replacement title for edit." },
                    "description": { "type": "string", "description": "Replacement details for edit." },
                    "blocked_by": { "type": "array", "items": { "type": "string" }, "description": "Complete blocker list for set_dependencies." },
                    "write_scopes": { "type": "array", "items": { "type": "string" }, "description": "Replacement advisory write scopes for edit." },
                    "owner": { "type": "string", "description": "Member target for a Lead-only reassign; omit to unassign." },
                },
                "required": ["task_id", "revision", "action"],
                "additionalProperties": false,
            }),
        },
    ]
}

/// The nine tools over one service.
#[derive(Clone)]
pub struct TeamTools {
    service: Arc<TeamService>,
    options: TeamToolOptions,
}

impl TeamTools {
    pub fn new(service: Arc<TeamService>, options: TeamToolOptions) -> Self {
        Self { service, options }
    }

    /// The specs to register, as [`team_tool_specs`].
    pub fn specs(&self) -> Vec<TeamToolSpec> {
        team_tool_specs()
    }

    /// Whether `name` is one of the nine.
    pub fn handles(name: &str) -> bool {
        TEAM_TOOL_NAMES.contains(&name)
    }

    /// Run one tool for the session `caller` (the session whose turn called it). Arguments are coerced the way
    /// the TypeScript tools coerce them (`String(x ?? '')`, `Number(x)`); every refusal becomes a
    /// [`ToolOutcome`] with an error code, never a panic or an `Err`.
    pub async fn call(&self, name: &str, args: &Value, caller: Option<&str>) -> ToolOutcome {
        todo!("M3: port of teamTools' run functions (src/team/tool.ts)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_specs_are_the_nine_names_in_order() {
        let names: Vec<_> = team_tool_specs().iter().map(|spec| spec.name).collect();
        assert_eq!(names, TEAM_TOOL_NAMES);
        assert!(TeamTools::handles("team_task_update"));
        assert!(!TeamTools::handles("spawn_subagent"));
    }

    #[test]
    fn every_schema_is_a_closed_object_whose_required_keys_exist() {
        for spec in team_tool_specs() {
            let parameters = &spec.parameters;
            assert_eq!(parameters["type"], "object", "{}", spec.name);
            assert_eq!(parameters["additionalProperties"], false, "{}", spec.name);
            let properties = parameters["properties"].as_object().expect("properties");
            for required in parameters["required"].as_array().into_iter().flatten() {
                let key = required.as_str().expect("a required key is a string");
                assert!(properties.contains_key(key), "{} requires {key}", spec.name);
            }
            assert!(!spec.description.is_empty());
        }
    }

    #[test]
    fn the_task_update_schema_offers_every_action() {
        let specs = team_tool_specs();
        let update = specs
            .iter()
            .find(|spec| spec.name == "team_task_update")
            .unwrap();
        let actions: Vec<_> = update.parameters["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|action| {
                serde_json::from_value::<crate::state::TeamTaskAction>(action.clone())
                    .expect("every offered action parses")
            })
            .collect();
        assert_eq!(actions.len(), 8);
    }

    #[test]
    fn an_outcome_omits_absent_data_and_error() {
        let ok = ToolOutcome {
            output: "changed".into(),
            data: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_string(&ok).unwrap(),
            r#"{"output":"changed"}"#
        );
        let refused = ToolOutcome {
            output: String::new(),
            data: None,
            error: Some(ToolFailure {
                code: "TEAM_LEAD_REQUIRED".into(),
                message: "only the Team Lead can do that".into(),
            }),
        };
        assert_eq!(
            serde_json::to_string(&refused).unwrap(),
            r#"{"output":"","error":{"code":"TEAM_LEAD_REQUIRED","message":"only the Team Lead can do that"}}"#
        );
    }
}
