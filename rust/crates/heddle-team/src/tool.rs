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

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::error::{TeamError, TeamErrorCode, TeamResult};
use crate::service::{SendRequest, SpawnRequest, TaskUpdate, TeamService, WaitResult};
use crate::state::{LEAD_NAME, NewTask, TeamMemberContext, TeamTaskAction, TeamTaskStatus};

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
/// Success: `output` is the compact JSON of the result (or `wait_agent`'s sentence), and `data` is the same value
/// when it is a JSON object. A list result (`list_agents`, `team_task_list`) has no `data`: the tool registry's
/// `ToolResult.data` is an object map, so an array there would not convert, and `data` is never sent to the
/// model anyway — `output` is what the model reads.
/// Refusal: `output` is empty and `error` carries the code; a failure that is not a team rule is `TEAM_FAILED`,
/// a call without a session `TEAM_NO_SESSION`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolOutcome {
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Map<String, Value>>,
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
        let Some(caller) = caller else {
            return failure(TeamError::new(
                TeamErrorCode::NoSession,
                "the team tools need a session",
            ));
        };
        match self.run(name, args, caller).await {
            Ok(outcome) => outcome,
            Err(error) => failure(error),
        }
    }

    /// Dispatch one tool. A team refusal is an `Err` carrying its code; a failure of a port is already the
    /// tool layer's `TEAM_FAILED`.
    async fn run(&self, name: &str, args: &Value, caller: &str) -> TeamResult<ToolOutcome> {
        match name {
            "spawn_teammate" => {
                let view = self.service.spawn(
                    caller,
                    SpawnRequest {
                        name: arg_string(args, "name"),
                        description: arg_string(args, "description"),
                        prompt: arg_string(args, "prompt"),
                        context: if args.get("context").and_then(Value::as_str) == Some("fork") {
                            TeamMemberContext::Fork
                        } else {
                            TeamMemberContext::Fresh
                        },
                    },
                )?;
                if let Some(on_spawn) = &self.options.on_spawn {
                    on_spawn(caller, &view.id);
                }
                Ok(success(&view))
            }
            "send_message" => {
                let sent = self
                    .service
                    .send(
                        caller,
                        SendRequest {
                            target: arg_string(args, "target"),
                            content: vec![
                                json!({ "type": "text", "text": arg_string(args, "message") }),
                            ],
                        },
                    )
                    .await?;
                Ok(success(&sent))
            }
            "list_agents" => Ok(success(&self.service.list(caller)?)),
            "wait_agent" => {
                let result = self
                    .service
                    .wait_for_change(caller, Duration::from_millis(wait_millis(args)))
                    .await?;
                Ok(match result {
                    WaitResult::NoProgress => text(WAIT_NO_PROGRESS_TEXT),
                    WaitResult::TimedOut => text(WAIT_TIMED_OUT_TEXT),
                    WaitResult::Changed => text(WAIT_CHANGED_TEXT),
                })
            }
            "interrupt_agent" => {
                let outcome = self
                    .service
                    .interrupt(caller, &arg_string(args, "target"))?;
                Ok(success(&outcome))
            }
            "team_task_create" => {
                let view = self.service.create_task(
                    caller,
                    NewTask {
                        subject: arg_string(args, "subject"),
                        description: optional_string(args, "description"),
                        blocked_by: string_array(args, "blocked_by").unwrap_or_default(),
                        write_scopes: string_array(args, "write_scopes").unwrap_or_default(),
                    },
                )?;
                Ok(success(&view))
            }
            "team_task_list" => {
                let wanted = args.get("status").and_then(Value::as_str);
                let views: Vec<_> = self
                    .service
                    .tasks(caller)?
                    .into_iter()
                    .filter(|view| wanted.is_none_or(|status| status_text(view.status) == status))
                    .collect();
                Ok(success(&views))
            }
            "team_task_get" => {
                let wanted = arg_string(args, "task_id");
                match self
                    .service
                    .tasks(caller)?
                    .into_iter()
                    .find(|view| view.id == wanted)
                {
                    Some(view) => Ok(success(&view)),
                    None => Err(TeamError::new(
                        TeamErrorCode::TaskMissing,
                        "no such shared task",
                    )),
                }
            }
            "team_task_update" => {
                // The owner arrives as a member name (or `lead`), and resolves against the folded roster.
                let state = self.service.state(caller)?;
                let owner = match args.get("owner") {
                    None => None,
                    Some(_) => {
                        let name = arg_string(args, "owner");
                        if name == LEAD_NAME {
                            Some(state.id.clone())
                        } else {
                            match state.member_by_name(&name) {
                                Some(member) => Some(member.id.clone()),
                                None => {
                                    return Err(TeamError::new(
                                        TeamErrorCode::MemberInvalid,
                                        format!("no team member named '{name}'"),
                                    ));
                                }
                            }
                        }
                    }
                };
                let view = self.service.update_task(
                    caller,
                    TaskUpdate {
                        task_id: arg_string(args, "task_id"),
                        revision: arg_u64(args, "revision"),
                        action: parse_action(&arg_string(args, "action"))?,
                        subject: optional_string(args, "subject"),
                        description: optional_string(args, "description"),
                        blocked_by: string_array(args, "blocked_by"),
                        write_scopes: string_array(args, "write_scopes"),
                        owner_id: owner,
                    },
                )?;
                Ok(success(&view))
            }
            other => Err(TeamError::new(
                TeamErrorCode::Failed,
                format!("no team tool named '{other}'"),
            )),
        }
    }
}

/// A successful result: the compact JSON of the value, also carried as `data`.
fn success(value: &impl Serialize) -> ToolOutcome {
    let value = serde_json::to_value(value).expect("a tool result serializes to JSON");
    let output = serde_json::to_string(&value).expect("a tool result serializes compactly");
    let data = match value {
        Value::Object(object) => Some(object),
        _ => None,
    };
    ToolOutcome {
        output,
        data,
        error: None,
    }
}

/// A successful result that is a sentence rather than data, as `wait_agent` answers are.
fn text(output: &str) -> ToolOutcome {
    ToolOutcome {
        output: output.to_owned(),
        data: None,
        error: None,
    }
}

/// A refusal, as the TypeScript `ToolResult` shape.
fn failure(error: TeamError) -> ToolOutcome {
    ToolOutcome {
        output: String::new(),
        data: None,
        error: Some(ToolFailure {
            code: error.code.as_str().to_owned(),
            message: error.message,
        }),
    }
}

/// `String(value)` as the TypeScript tools coerce an argument.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        other => other.to_string(),
    }
}

/// `String(args[key] ?? '')`: an absent or null argument reads as empty.
fn arg_string(args: &Value, key: &str) -> String {
    match args.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

/// `String(args[key])` for a key that is present; absent stays absent.
fn optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key).map(js_string)
}

/// `args[key].map(String)` for an array; a non-array is treated as absent.
fn string_array(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().map(js_string).collect())
}

/// `Number(args[key])` where the field is a non-negative integer; a missing or non-numeric value reads as `0`
/// (the TypeScript `NaN` compares unequal to every revision, which is the same refusal).
fn arg_u64(args: &Value, key: &str) -> u64 {
    match args.get(key) {
        Some(Value::Number(number)) => number
            .as_u64()
            .or_else(|| {
                number
                    .as_f64()
                    .filter(|value| *value >= 0.0)
                    .map(|value| value as u64)
            })
            .unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// `Math.min(120_000, Math.max(0, Number(args.timeout_ms ?? 30_000)))`.
fn wait_millis(args: &Value) -> u64 {
    let Some(value) = args.get("timeout_ms") else {
        return WAIT_DEFAULT_MS;
    };
    let number = match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => text.trim().parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if number.is_finite() {
        number.clamp(0.0, WAIT_MAX_MS as f64) as u64
    } else {
        0
    }
}

/// Decode one `team_task_update` action; an action outside the eight is `TEAM_TASK_INVALID`.
fn parse_action(action: &str) -> TeamResult<TeamTaskAction> {
    serde_json::from_value(Value::String(action.to_owned())).map_err(|_| {
        TeamError::new(
            TeamErrorCode::TaskInvalid,
            format!("unknown task action '{action}'"),
        )
    })
}

/// The status as the schema and the filters name it.
fn status_text(status: TeamTaskStatus) -> &'static str {
    match status {
        TeamTaskStatus::Pending => "pending",
        TeamTaskStatus::InProgress => "in_progress",
        TeamTaskStatus::Completed => "completed",
        TeamTaskStatus::Deleted => "deleted",
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

    // --- M3: the nine tools over a real service ---

    use std::sync::Mutex;

    use crate::ports::{ChildSession, SessionMetaView, TeamLive, TeamRunner, TeamStore};
    use crate::service::{TeamDeps, TeamLimits};
    use crate::state::NewTask;
    use crate::testing::{FakeLive, MemoryStore, RecordingRunner, SequentialIds};

    struct Harness {
        service: Arc<TeamService>,
        tools: TeamTools,
        lead: String,
        live: Arc<FakeLive>,
        store: Arc<MemoryStore>,
        spawn_hooks: Arc<Mutex<Vec<String>>>,
    }

    fn harness() -> Harness {
        let store = Arc::new(MemoryStore::new());
        let lead = "session-lead".to_owned();
        store.add_session(SessionMetaView {
            id: lead.clone(),
            cwd: Some("/work".to_owned()),
            endpoint: Some("scripted".to_owned()),
            model: Some("m".to_owned()),
            team_id: None,
        });
        let live = Arc::new(FakeLive::new());
        let runner = Arc::new(RecordingRunner::new(Arc::clone(&store), None));
        let spawn_hooks = Arc::new(Mutex::new(Vec::new()));
        let on_spawn: OnSpawn = {
            let hooks = Arc::clone(&spawn_hooks);
            Arc::new(move |lead: &str, member: &str| {
                hooks
                    .lock()
                    .expect("the hooks lock")
                    .push(format!("{lead}:{member}"));
            })
        };
        let store_dependency: Arc<dyn TeamStore> = store.clone();
        let runner_dependency: Arc<dyn TeamRunner> = runner.clone();
        let live_dependency: Arc<dyn TeamLive> = live.clone();
        let service = Arc::new(TeamService::new(TeamDeps {
            store: store_dependency,
            runner: runner_dependency,
            live: Some(live_dependency),
            limits: TeamLimits::default(),
            notify: None,
            warn: None,
            ids: Arc::new(SequentialIds::new()),
        }));
        let tools = TeamTools::new(
            Arc::clone(&service),
            TeamToolOptions {
                on_spawn: Some(on_spawn),
            },
        );
        Harness {
            service,
            tools,
            lead,
            live,
            store,
            spawn_hooks,
        }
    }

    async fn call(h: &Harness, name: &str, args: Value, caller: Option<&str>) -> ToolOutcome {
        h.tools.call(name, &args, caller).await
    }

    fn json_of(outcome: &ToolOutcome) -> Value {
        serde_json::from_str(&outcome.output).expect("a successful output is JSON")
    }

    async fn spawn(h: &Harness, name: &str) -> String {
        let outcome = call(
            h,
            "spawn_teammate",
            json!({ "name": name, "description": "x", "prompt": "go" }),
            Some(&h.lead),
        )
        .await;
        json_of(&outcome)["id"].as_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn the_nine_tools_are_dshs_set_and_each_refuses_without_a_session() {
        let h = harness();
        let names: Vec<&str> = h.tools.specs().iter().map(|spec| spec.name).collect();
        assert_eq!(names, TEAM_TOOL_NAMES.to_vec());
        for name in TEAM_TOOL_NAMES {
            let outcome = call(&h, name, json!({}), None).await;
            assert_eq!(
                outcome.error.as_ref().map(|error| error.code.as_str()),
                Some("TEAM_NO_SESSION"),
                "{name} needs a session"
            );
        }
    }

    #[tokio::test]
    async fn spawn_teammate_creates_the_member_reports_it_and_runs_the_policy_hook() {
        let h = harness();
        let outcome = call(
            &h,
            "spawn_teammate",
            json!({ "name": "alpha", "description": "the helper", "prompt": "start" }),
            Some(&h.lead),
        )
        .await;
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        let view = json_of(&outcome);
        assert_eq!(view["name"], "alpha");
        assert_eq!(view["role"], "teammate");
        assert_eq!(
            h.spawn_hooks.lock().unwrap().as_slice(),
            &[format!("{}:{}", h.lead, view["id"].as_str().unwrap())],
            "the profile made the policy durable for the child"
        );
    }

    #[tokio::test]
    async fn lead_only_tools_refuse_from_a_teammate() {
        let h = harness();
        let member = spawn(&h, "alpha").await;
        let spawn_refused = call(
            &h,
            "spawn_teammate",
            json!({ "name": "beta", "description": "x", "prompt": "go" }),
            Some(&member),
        )
        .await;
        assert_eq!(
            spawn_refused.error.as_ref().unwrap().code,
            "TEAM_LEAD_REQUIRED"
        );
        let interrupt_refused = call(
            &h,
            "interrupt_agent",
            json!({ "target": "lead" }),
            Some(&member),
        )
        .await;
        assert_eq!(
            interrupt_refused.error.as_ref().unwrap().code,
            "TEAM_LEAD_REQUIRED"
        );
    }

    #[tokio::test]
    async fn send_message_reports_accepted_and_self_messages_are_refused() {
        let h = harness();
        spawn(&h, "alpha").await;
        let sent = call(
            &h,
            "send_message",
            json!({ "target": "alpha", "message": "hello" }),
            Some(&h.lead),
        )
        .await;
        assert!(sent.error.is_none(), "{:?}", sent.error);
        assert_eq!(json_of(&sent)["status"], "accepted");
        let itself = call(
            &h,
            "send_message",
            json!({ "target": "lead", "message": "hello" }),
            Some(&h.lead),
        )
        .await;
        assert_eq!(itself.error.as_ref().unwrap().code, "TEAM_SELF_MESSAGE");
    }

    #[tokio::test]
    async fn list_agents_reports_the_lead_and_teammates_with_live_status() {
        let h = harness();
        let member = spawn(&h, "alpha").await;
        h.live.set_running(&member, true);
        let list = json_of(&call(&h, "list_agents", json!({}), Some(&h.lead)).await);
        let rows: Vec<(String, String, String)> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row["name"].as_str().unwrap().to_owned(),
                    row["role"].as_str().unwrap().to_owned(),
                    row["status"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                ("lead".to_owned(), "lead".to_owned(), "inactive".to_owned()),
                (
                    "alpha".to_owned(),
                    "teammate".to_owned(),
                    "running".to_owned()
                ),
            ]
        );
    }

    #[tokio::test]
    async fn wait_agent_answers_no_progress_changed_and_timed_out_as_text() {
        let h = harness();
        spawn(&h, "alpha").await;
        let idle = call(&h, "wait_agent", json!({ "timeout_ms": 10 }), Some(&h.lead)).await;
        assert!(idle.output.contains("noProgress"), "{}", idle.output);

        // A provisioning member makes progress possible; a task write is the change that wakes the wait.
        h.store
            .create(&ChildSession {
                id: "session-beta".to_owned(),
                cwd: Some("/work".to_owned()),
                endpoint: None,
                model: None,
                parent_session: h.lead.clone(),
                origin: "subagent",
                delegation_depth: 1,
                team_id: h.lead.clone(),
                title: "teammate beta".to_owned(),
            })
            .unwrap();
        h.store
            .append(
                &h.lead,
                json!({
                    "type": "team/member",
                    "version": 2,
                    "teamId": h.lead,
                    "member": { "id": "session-beta", "name": "beta", "description": "x", "context": "fresh", "phase": "provisioning" },
                }),
            )
            .unwrap();
        let service = Arc::clone(&h.service);
        let lead = h.lead.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            service
                .create_task(
                    &lead,
                    NewTask {
                        subject: "wake up".to_owned(),
                        ..NewTask::default()
                    },
                )
                .unwrap();
        });
        let changed = call(
            &h,
            "wait_agent",
            json!({ "timeout_ms": 2_000 }),
            Some(&h.lead),
        )
        .await;
        assert!(changed.output.contains("changed"), "{}", changed.output);
        let timed = call(&h, "wait_agent", json!({ "timeout_ms": 10 }), Some(&h.lead)).await;
        assert!(timed.output.contains("timedOut"), "{}", timed.output);
    }

    #[tokio::test]
    async fn interrupt_agent_stops_the_target_through_the_live_turn_registry() {
        let h = harness();
        let member = spawn(&h, "alpha").await;
        h.live.set_running(&member, true);
        let result = call(
            &h,
            "interrupt_agent",
            json!({ "target": "alpha" }),
            Some(&h.lead),
        )
        .await;
        assert!(result.error.is_none(), "{:?}", result.error);
        assert_eq!(json_of(&result)["previousStatus"], "running");
        assert_eq!(h.live.aborted(), vec![member]);
        let unknown = call(
            &h,
            "interrupt_agent",
            json!({ "target": "nobody" }),
            Some(&h.lead),
        )
        .await;
        assert_eq!(unknown.error.as_ref().unwrap().code, "TEAM_MEMBER_INVALID");
    }

    #[tokio::test]
    async fn the_task_tools_create_read_list_and_compare_and_set() {
        let h = harness();
        let created = json_of(
            &call(
                &h,
                "team_task_create",
                json!({ "subject": "write it", "write_scopes": ["src/team"] }),
                Some(&h.lead),
            )
            .await,
        );
        assert_eq!(created["id"], "task-1");
        assert_eq!(created["status"], "pending");
        assert_eq!(created["writeScopes"][0], "src/team");

        let got = json_of(
            &call(
                &h,
                "team_task_get",
                json!({ "task_id": "task-1" }),
                Some(&h.lead),
            )
            .await,
        );
        assert_eq!(got["id"], "task-1");
        let missing = call(
            &h,
            "team_task_get",
            json!({ "task_id": "task-404" }),
            Some(&h.lead),
        )
        .await;
        assert_eq!(missing.error.as_ref().unwrap().code, "TEAM_TASK_MISSING");

        // The revision is coerced from a string the way `Number(...)` would.
        let claimed = json_of(
            &call(
                &h,
                "team_task_update",
                json!({ "task_id": "task-1", "revision": "1", "action": "claim" }),
                Some(&h.lead),
            )
            .await,
        );
        assert_eq!(claimed["status"], "in_progress");
        assert_eq!(claimed["ownerName"], "lead");
        let stale = call(
            &h,
            "team_task_update",
            json!({ "task_id": "task-1", "revision": 1, "action": "complete" }),
            Some(&h.lead),
        )
        .await;
        assert_eq!(stale.error.as_ref().unwrap().code, "TEAM_TASK_STALE");
        let bad_action = call(
            &h,
            "team_task_update",
            json!({ "task_id": "task-1", "revision": 2, "action": "explode" }),
            Some(&h.lead),
        )
        .await;
        assert_eq!(bad_action.error.as_ref().unwrap().code, "TEAM_TASK_INVALID");

        let completed = json_of(
            &call(
                &h,
                "team_task_update",
                json!({ "task_id": "task-1", "revision": 2, "action": "complete" }),
                Some(&h.lead),
            )
            .await,
        );
        assert_eq!(completed["status"], "completed");
        let listed = json_of(
            &call(
                &h,
                "team_task_list",
                json!({ "status": "completed" }),
                Some(&h.lead),
            )
            .await,
        );
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["id"], "task-1");
    }

    #[tokio::test]
    async fn reassign_names_an_owner_through_the_tool_and_refuses_an_unknown_member() {
        let h = harness();
        spawn(&h, "alpha").await;
        call(
            &h,
            "team_task_create",
            json!({ "subject": "hand over" }),
            Some(&h.lead),
        )
        .await;
        let reassigned = json_of(
            &call(
                &h,
                "team_task_update",
                json!({ "task_id": "task-1", "revision": 1, "action": "reassign", "owner": "alpha" }),
                Some(&h.lead),
            )
            .await,
        );
        assert_eq!(reassigned["ownerName"], "alpha");
        assert_eq!(reassigned["status"], "in_progress");
        let unknown = call(
            &h,
            "team_task_update",
            json!({ "task_id": "task-1", "revision": 2, "action": "reassign", "owner": "nobody" }),
            Some(&h.lead),
        )
        .await;
        assert_eq!(unknown.error.as_ref().unwrap().code, "TEAM_MEMBER_INVALID");
    }

    /// The tool registry's `ToolResult` (`heddle-tools`): `data` is an object map. A binary adapter converts a
    /// `ToolOutcome` into it through serde, so every outcome must deserialize into this shape.
    #[derive(Debug, serde::Deserialize)]
    #[allow(dead_code)]
    struct RegistryResult {
        output: String,
        #[serde(default)]
        error: Option<ToolFailureShape>,
        #[serde(default)]
        data: Option<Map<String, Value>>,
    }

    #[derive(Debug, serde::Deserialize)]
    #[allow(dead_code)]
    struct ToolFailureShape {
        code: String,
        message: String,
    }

    #[tokio::test]
    async fn every_outcome_converts_into_the_registrys_tool_result() {
        let h = harness();
        let calls = [
            (
                "spawn_teammate",
                json!({ "name": "alpha", "description": "x", "prompt": "go" }),
            ),
            ("list_agents", json!({})),
            ("team_task_create", json!({ "subject": "write it" })),
            ("team_task_list", json!({})),
            ("team_task_get", json!({ "task_id": "task-1" })),
            (
                "team_task_update",
                json!({ "task_id": "task-1", "revision": 1, "action": "claim" }),
            ),
            (
                "send_message",
                json!({ "target": "alpha", "message": "hello" }),
            ),
            ("wait_agent", json!({ "timeout_ms": 10 })),
            ("interrupt_agent", json!({ "target": "nobody" })),
        ];
        for (name, args) in calls {
            let outcome = call(&h, name, args, Some(&h.lead)).await;
            let converted: RegistryResult = serde_json::from_value(
                serde_json::to_value(&outcome).expect("an outcome serializes"),
            )
            .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(converted.output, outcome.output, "{name}");
        }
        // A list result keeps its JSON in output and carries no data; a single result carries both.
        let listed = call(&h, "list_agents", json!({}), Some(&h.lead)).await;
        assert!(listed.data.is_none());
        assert_eq!(json_of(&listed).as_array().map(Vec::len), Some(2));
        let got = call(
            &h,
            "team_task_get",
            json!({ "task_id": "task-1" }),
            Some(&h.lead),
        )
        .await;
        assert_eq!(
            got.data.as_ref().map(|data| data["id"].clone()),
            Some(json!("task-1"))
        );
    }

    #[tokio::test]
    async fn a_non_team_failure_becomes_team_failed_and_an_unknown_tool_is_refused() {
        let h = harness();
        let missing = call(&h, "list_agents", json!({}), Some("session-missing")).await;
        assert_eq!(missing.error.as_ref().unwrap().code, "TEAM_FAILED");
        assert!(
            missing
                .error
                .as_ref()
                .unwrap()
                .message
                .contains("no session")
        );
        let unknown = call(&h, "spawn_subagent", json!({}), Some(&h.lead)).await;
        assert_eq!(unknown.error.as_ref().unwrap().code, "TEAM_FAILED");
    }
}
