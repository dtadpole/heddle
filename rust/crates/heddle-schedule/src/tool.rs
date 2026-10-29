//! The four model-facing reminder tools (`src/schedule/tool.ts`), a port of DSH's `dsh-tool-schedule`
//! (TOOL:1-661).
//!
//! `schedule_create`, `schedule_list`, `schedule_update` and `schedule_delete` act on the session of the turn that
//! called them. Descriptions, parameter schemas, validation order and every `{code, message}` are DSH's.
//!
//! **How a DSH value becomes a heddle `ToolResult`.** DSH renders every value its tools return — a view, a list,
//! a receipt and every `{code, message}` refusal — as one text block `JSON.stringify(value)` that is not an error.
//! So they are returned as `output` with no `error`, and `data.schedule` carries the same value. The one genuine
//! failure is arguments that break the parameter schema: `INVALID_ARGS`, `invalid arguments: …`.

use std::sync::Arc;

use heddle_tools::{CancellationToken, ToolError, ToolResult, ToolSpec};
use serde_json::{Map, Value, json};

use crate::js;
use crate::rules::{
    MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, REQUIRED_TITLE_MESSAGE, schedule_view,
};
use crate::service::{ScheduleService, ServiceError, UpdateRequest, UpdateResult};

/// `schedule_create`'s description (TOOL:257).
pub const CREATE_DESCRIPTION: &str = "Create a reminder in the current session that delivers prompt when it becomes due. Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. Local times that do not exist in the zone are skipped; repeated local times fire once, at the earlier instant. After downtime, a recurring reminder delivers only its latest missed occurrence. Delivery can repeat after a crash.";
/// `schedule_list`'s description.
pub const LIST_DESCRIPTION: &str = "List the active reminders in the current session.";
/// `schedule_delete`'s description.
pub const DELETE_DESCRIPTION: &str = "Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued.";
/// `schedule_update`'s description.
pub const UPDATE_DESCRIPTION: &str = "Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; omitted fields keep their stored values. To change a relative delay, create a new reminder.";

const TIME_ZONE_DESCRIPTION: &str = "UTC or IANA Area/Location, for example Asia/Shanghai.";

fn create_title_description() -> String {
    format!(
        "Concise task name in the user's language, at most {MAX_TITLE_LENGTH} characters. Name only the core action and subject; keep essential target identifiers such as PR numbers and branch names. Do not include execution frequency (e.g. daily, hourly), scheduled dates/times, time zones, task status, or configuration and execution details (e.g. read-only mode, profile-tag filters), even when embedded in the requested or existing title. Do not append parenthetical notes. Put scheduling information in the timing parameters and execution instructions in prompt."
    )
}

/// The selector parameters, in DSH's catalog order (TOOL:404-487): every_seconds, daily, weekly, cron, at.
fn selector_parameters(properties: &mut Map<String, Value>) {
    properties.insert(
        "every_seconds".into(),
        json!({
            "type": "number",
            "description": format!("Fixed-rate interval in whole seconds, at least {MIN_EVERY_INTERVAL_SECONDS}, aligned to the creation time; changing it with schedule_update re-aligns it to the save time."),
        }),
    );
    properties.insert(
        "daily".into(),
        json!({
            "type": "object",
            "description": "Every day at a local time.",
            "additionalProperties": false,
            "properties": {
                "time": {"type": "string", "description": "HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00."},
                "time_zone": {"type": "string", "description": TIME_ZONE_DESCRIPTION},
            },
            "required": ["time", "time_zone"],
        }),
    );
    properties.insert(
        "weekly".into(),
        json!({
            "type": "object",
            "description": "On the given weekdays at a local time.",
            "additionalProperties": false,
            "properties": {
                "time": {"type": "string", "description": "HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00."},
                "time_zone": {"type": "string", "description": TIME_ZONE_DESCRIPTION},
                "weekdays": {"type": "array", "description": "ISO weekdays, Monday 1 through Sunday 7, without repetitions.", "items": {"type": "integer"}},
            },
            "required": ["time", "time_zone", "weekdays"],
        }),
    );
    properties.insert(
        "cron".into(),
        json!({
            "type": "object",
            "description": "Five-field Vixie cron expression in a time zone.",
            "additionalProperties": false,
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "minute hour day-of-month month day-of-week, for example \"*/15 9-17 * * 1-5\". When both day fields are restricted, a date matches if either one matches.",
                },
                "time_zone": {"type": "string", "description": TIME_ZONE_DESCRIPTION},
            },
            "required": ["expression", "time_zone"],
        }),
    );
    properties.insert(
        "at".into(),
        json!({
            "oneOf": [
                {"type": "string"},
                {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {"date": {"type": "string"}, "time": {"type": "string"}, "time_zone": {"type": "string"}},
                    "required": ["date", "time", "time_zone"],
                },
            ],
            "description": "Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone.",
        }),
    );
}

/// `schedule_create`'s parameters: an **open** root (no root `additionalProperties`, TOOLS:802-811).
pub fn create_parameters() -> Value {
    let mut properties = Map::new();
    properties.insert(
        "prompt".into(),
        json!({"type": "string", "description": "Reminder content to present when the target becomes due."}),
    );
    properties.insert(
        "title".into(),
        json!({"type": "string", "description": create_title_description()}),
    );
    properties.insert(
        "after_seconds".into(),
        json!({"type": "number", "description": "Delay in whole seconds."}),
    );
    selector_parameters(&mut properties);
    json!({"type": "object", "properties": properties, "required": ["prompt", "title"]})
}

/// `schedule_list`'s parameters.
pub fn list_parameters() -> Value {
    json!({"type": "object", "properties": {}})
}

/// `schedule_update`'s parameters, without `after_seconds`.
pub fn update_parameters() -> Value {
    let mut properties = Map::new();
    properties.insert(
        "id".into(),
        json!({"type": "string", "description": "Schedule id returned by schedule_list."}),
    );
    properties.insert(
        "title".into(),
        json!({"type": "string", "description": "New task name; follow the schedule_create title rules."}),
    );
    properties.insert(
        "prompt".into(),
        json!({"type": "string", "description": "New reminder content."}),
    );
    selector_parameters(&mut properties);
    json!({"type": "object", "properties": properties, "required": ["id"]})
}

/// `schedule_delete`'s parameters.
pub fn delete_parameters() -> Value {
    json!({"type": "object", "properties": {"id": {"type": "string", "description": "Exact schedule id."}}, "required": ["id"]})
}

/// The four tools' specs, in the order `schedule_create`, `schedule_list`, `schedule_delete`, `schedule_update`.
pub fn schedule_tool_specs() -> Vec<ToolSpec> {
    let spec = |name: &str, description: &str, parameters: Value| ToolSpec {
        name: name.to_owned(),
        description: description.to_owned(),
        parameters,
    };
    vec![
        spec("schedule_create", CREATE_DESCRIPTION, create_parameters()),
        spec("schedule_list", LIST_DESCRIPTION, list_parameters()),
        spec("schedule_delete", DELETE_DESCRIPTION, delete_parameters()),
        spec("schedule_update", UPDATE_DESCRIPTION, update_parameters()),
    ]
}

fn diagnostic_path(path: &str) -> &str {
    if path.is_empty() { "arguments" } else { path }
}

fn property_path(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_owned()
    } else {
        format!("{path}.{key}")
    }
}

/// Validate arguments against a schema with DSH's diagnostics (TOOLS:380-521): for an object, missing required
/// properties first, then each declared property's own violations in declaration order, then undeclared keys when
/// `additionalProperties` is false; a `oneOf` must match exactly one branch.
pub fn validate_args(schema: &Value, value: &Value, path: &str) -> Vec<String> {
    if let Some(branches) = schema.get("oneOf").and_then(Value::as_array) {
        let matches = branches
            .iter()
            .filter(|branch| validate_args(branch, value, path).is_empty())
            .count();
        return if matches == 1 {
            Vec::new()
        } else {
            vec![format!(
                "\"{}\" must match exactly one oneOf branch (matched {matches})",
                diagnostic_path(path)
            )]
        };
    }
    let here = diagnostic_path(path);
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => {
            let Some(object) = value.as_object() else {
                return vec![format!("\"{here}\" must be an object")];
            };
            let empty = Map::new();
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            let mut violations = Vec::new();
            for key in schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if !object.contains_key(key) {
                    violations.push(format!(
                        "missing required property \"{}\"",
                        property_path(path, key)
                    ));
                }
            }
            for (key, child) in properties {
                if let Some(entry) = object.get(key) {
                    violations.extend(validate_args(child, entry, &property_path(path, key)));
                }
            }
            if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                for key in object.keys() {
                    if !properties.contains_key(key) {
                        violations.push(format!(
                            "\"{}\" is not a declared property (additionalProperties: false)",
                            property_path(path, key)
                        ));
                    }
                }
            }
            violations
        }
        Some("array") => {
            let Some(entries) = value.as_array() else {
                return vec![format!("\"{here}\" must be an array")];
            };
            match schema.get("items") {
                None => Vec::new(),
                Some(items) => entries
                    .iter()
                    .enumerate()
                    .flat_map(|(index, entry)| {
                        validate_args(items, entry, &format!("{path}[{index}]"))
                    })
                    .collect(),
            }
        }
        Some("string") if !value.is_string() => vec![format!("\"{here}\" must be a string")],
        Some("number") if !value.is_number() => vec![format!("\"{here}\" must be a number")],
        Some("integer") if !js::is_integer(value) => vec![format!("\"{here}\" must be an integer")],
        Some("boolean") if !value.is_boolean() => vec![format!("\"{here}\" must be a boolean")],
        Some("null") if !value.is_null() => vec![format!("\"{here}\" must be null")],
        _ => Vec::new(),
    }
}

fn coded(code: &str, message: &str) -> Value {
    let mut map = Map::new();
    map.insert("code".into(), Value::from(code));
    map.insert("message".into(), Value::from(message));
    Value::Object(map)
}

/// The stable value for a failure not safe to expose (TOOL:279-284).
fn internal_error() -> Value {
    coded("internal_error", "The schedule operation failed.")
}

/// The refusal every tool gives a delegated child (TOOL:299-305).
fn subagent_caller() -> Value {
    coded(
        "subagent_session",
        "A delegated subagent cannot use reminders.",
    )
}

const CREATE_KEYS: [&str; 8] = [
    "prompt",
    "title",
    "after_seconds",
    "at",
    "every_seconds",
    "daily",
    "weekly",
    "cron",
];
const UPDATE_KEYS: [&str; 8] = [
    "id",
    "title",
    "prompt",
    "at",
    "every_seconds",
    "daily",
    "weekly",
    "cron",
];

/// Translate invalid input; withhold anything else behind `internal_error` (TOOL:286-291).
fn operation_error(error: &ServiceError) -> Value {
    match error {
        ServiceError::Input(error) => coded(error.code.as_str(), &error.message),
        _ => internal_error(),
    }
}

/// A DSH value as heddle's result: the JSON the model reads, and the value itself for a caller that wants it.
pub fn rendered(value: Value) -> ToolResult {
    let mut data = Map::new();
    data.insert("schedule".into(), value.clone());
    ToolResult {
        output: serde_json::to_string(&value).expect("a value serializes"),
        error: None,
        data: Some(data),
    }
}

/// DSH's schema failure (TOOLS:812-821, 866-869), as heddle's error.
fn invalid_arguments(violations: &[String]) -> ToolResult {
    ToolResult {
        output: String::new(),
        error: Some(ToolError {
            code: "INVALID_ARGS".to_owned(),
            message: format!("invalid arguments: {}", violations.join("; ")),
        }),
        data: None,
    }
}

/// The fixed-rate rule the tools check before the service sees it (TOOL:307-317).
fn invalid_interval(every_seconds: Option<&Value>) -> Option<Value> {
    let value = every_seconds?;
    match js::safe_integer(value) {
        None => Some(coded(
            "invalid_rule",
            "every_seconds must be a safe integer.",
        )),
        Some(seconds) if seconds < MIN_EVERY_INTERVAL_SECONDS => Some(coded(
            "frequency_too_high",
            &format!("every_seconds must be at least {MIN_EVERY_INTERVAL_SECONDS}."),
        )),
        Some(_) => None,
    }
}

fn title_problem(title: &str) -> Option<Value> {
    let trimmed = js::trim(title);
    if trimmed.is_empty() {
        return Some(coded("invalid_prompt", REQUIRED_TITLE_MESSAGE));
    }
    if js::utf16_len(trimmed) > MAX_TITLE_LENGTH {
        return Some(coded(
            "invalid_prompt",
            &format!("title must be at most {MAX_TITLE_LENGTH} characters."),
        ));
    }
    None
}

/// The create constraints the open root cannot express, in DSH's order (TOOL:319-341).
fn validate_create_args(args: &Map<String, Value>) -> Option<Value> {
    let selectors = [
        "after_seconds",
        "at",
        "every_seconds",
        "daily",
        "weekly",
        "cron",
    ]
    .iter()
    .filter(|key| args.contains_key(**key))
    .count();
    if args.keys().any(|key| !CREATE_KEYS.contains(&key.as_str())) || selectors != 1 {
        return Some(coded(
            "invalid_selector",
            "schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.",
        ));
    }
    let prompt = args
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if js::trim(prompt).is_empty() {
        return Some(coded(
            "invalid_prompt",
            "prompt must be non-empty after trimming.",
        ));
    }
    if let Some(problem) = title_problem(title) {
        return Some(problem);
    }
    if let Some(after) = args.get("after_seconds")
        && !js::safe_integer(after).is_some_and(|seconds| seconds > 0)
    {
        return Some(coded(
            "invalid_rule",
            "after_seconds must be a positive safe integer.",
        ));
    }
    invalid_interval(args.get("every_seconds"))
}

/// The update constraints, in DSH's order (TOOL:343-376).
fn validate_update_args(args: &Map<String, Value>) -> Option<Value> {
    let selectors = ["at", "every_seconds", "daily", "weekly", "cron"]
        .iter()
        .filter(|key| args.contains_key(**key))
        .count();
    if args.keys().any(|key| !UPDATE_KEYS.contains(&key.as_str())) || selectors > 1 {
        return Some(coded(
            "invalid_selector",
            "schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.",
        ));
    }
    let id = args.get("id").and_then(Value::as_str).unwrap_or_default();
    if id.is_empty() || js::trim(id) != id {
        return Some(coded(
            "invalid_rule",
            "schedule_update id must be non-empty without surrounding whitespace.",
        ));
    }
    if selectors == 0 && !args.contains_key("title") && !args.contains_key("prompt") {
        return Some(coded(
            "invalid_selector",
            "schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.",
        ));
    }
    if let Some(title) = args.get("title").and_then(Value::as_str)
        && let Some(problem) = title_problem(title)
    {
        return Some(problem);
    }
    if let Some(prompt) = args.get("prompt").and_then(Value::as_str)
        && js::trim(prompt).is_empty()
    {
        return Some(coded(
            "invalid_prompt",
            "prompt must be non-empty after trimming.",
        ));
    }
    invalid_interval(args.get("every_seconds"))
}

/// The one timing replacement an update carries (TOOL:378-399).
fn timing_change_from(args: &Map<String, Value>) -> Option<Value> {
    for (key, kind) in [
        ("at", "at"),
        ("every_seconds", "every"),
        ("daily", "daily"),
        ("weekly", "weekly"),
        ("cron", "cron"),
    ] {
        if let Some(value) = args.get(key) {
            let mut change = Map::new();
            change.insert("kind".into(), Value::from(kind));
            change.insert(key.into(), value.clone());
            return Some(Value::Object(change));
        }
    }
    None
}

/// The delegation depth of a session: above 0 is a delegated child, which cannot use reminders.
pub type DelegationDepth = Arc<dyn Fn(&str) -> u64 + Send + Sync>;

/// The four reminder tools, bound to one schedule service.
#[derive(Clone)]
pub struct ScheduleTools {
    service: Arc<ScheduleService>,
    delegation_depth: DelegationDepth,
}

impl ScheduleTools {
    /// The tools over `service`, refusing sessions whose delegation depth is above 0.
    pub fn new(service: Arc<ScheduleService>, delegation_depth: DelegationDepth) -> Self {
        Self {
            service,
            delegation_depth,
        }
    }

    /// The calling session, or the value that refuses the call.
    fn caller(&self, session: Option<&str>) -> Result<String, Value> {
        let Some(session) = session else {
            return Err(internal_error());
        };
        if (self.delegation_depth)(session) > 0 {
            return Err(subagent_caller());
        }
        Ok(session.to_owned())
    }

    /// Run one tool call for `session` (the turn's own session, never the model's argument).
    pub async fn call(
        &self,
        name: &str,
        args: &Value,
        session: Option<&str>,
        cancel: Option<CancellationToken>,
    ) -> ToolResult {
        let aborted = cancel.as_ref().is_some_and(CancellationToken::is_cancelled);
        match name {
            "schedule_create" => {
                let violations = validate_args(&create_parameters(), args, "");
                if !violations.is_empty() {
                    return invalid_arguments(&violations);
                }
                let session = match self.caller(session) {
                    Ok(session) => session,
                    Err(refusal) => return rendered(refusal),
                };
                let map = args.as_object().cloned().unwrap_or_default();
                if let Some(invalid) = validate_create_args(&map) {
                    return rendered(invalid);
                }
                if aborted {
                    return rendered(internal_error());
                }
                match self.service.create(&session, &map, cancel).await {
                    Ok(record) => rendered(schedule_view(&record, self.service.now())),
                    Err(error) => rendered(operation_error(&error)),
                }
            }
            "schedule_list" => {
                let violations = validate_args(&list_parameters(), args, "");
                if !violations.is_empty() {
                    return invalid_arguments(&violations);
                }
                let session = match self.caller(session) {
                    Ok(session) => session,
                    Err(refusal) => return rendered(refusal),
                };
                if aborted {
                    return rendered(internal_error());
                }
                let records = self.service.list(&session);
                let now = self.service.now();
                rendered(Value::Array(
                    records
                        .iter()
                        .map(|record| schedule_view(record, now))
                        .collect(),
                ))
            }
            "schedule_delete" => {
                let violations = validate_args(&delete_parameters(), args, "");
                if !violations.is_empty() {
                    return invalid_arguments(&violations);
                }
                // The id is checked before the caller, as DSH does (TOOL:581-590).
                let id = args["id"].as_str().unwrap_or_default().to_owned();
                if id.is_empty() || js::trim(&id) != id {
                    return rendered(coded(
                        "invalid_rule",
                        "schedule_delete id must be non-empty without surrounding whitespace.",
                    ));
                }
                let session = match self.caller(session) {
                    Ok(session) => session,
                    Err(refusal) => return rendered(refusal),
                };
                if aborted {
                    return rendered(internal_error());
                }
                match self.service.delete(&session, &id, cancel).await {
                    Ok(result) => rendered(result.to_value()),
                    Err(error) => rendered(operation_error(&error)),
                }
            }
            "schedule_update" => {
                let violations = validate_args(&update_parameters(), args, "");
                if !violations.is_empty() {
                    return invalid_arguments(&violations);
                }
                let session = match self.caller(session) {
                    Ok(session) => session,
                    Err(refusal) => return rendered(refusal),
                };
                let map = args.as_object().cloned().unwrap_or_default();
                if let Some(invalid) = validate_update_args(&map) {
                    return rendered(invalid);
                }
                if aborted {
                    return rendered(internal_error());
                }
                let id = map["id"].as_str().unwrap_or_default().to_owned();
                let Some(expected) = self
                    .service
                    .list(&session)
                    .into_iter()
                    .find(|record| record.id == id)
                else {
                    let ended = self
                        .service
                        .catalog()
                        .iter()
                        .any(|task| task.session_id == session && task.record.id == id);
                    let miss = if ended {
                        UpdateResult::Ended { id }
                    } else {
                        UpdateResult::NotFound { id }
                    };
                    return rendered(miss.to_value());
                };
                let request = UpdateRequest {
                    session_id: session,
                    id,
                    expected: expected.to_value(),
                    title: map.get("title").cloned(),
                    prompt: map.get("prompt").cloned(),
                    change: timing_change_from(&map),
                };
                match self.service.update(request, cancel).await {
                    Ok(UpdateResult::Resolved(crate::rules::UpdateResolution::Record {
                        record,
                        ..
                    })) => rendered(schedule_view(&record, self.service.now())),
                    Ok(other) => rendered(other.to_value()),
                    Err(error) => rendered(operation_error(&error)),
                }
            }
            other => ToolResult::refused(
                heddle_tools::codes::UNKNOWN_TOOL,
                format!("no schedule tool {other}"),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::tests::{T0, setup_with};
    use crate::store::TaskStatus;
    use std::collections::HashMap;
    use std::sync::atomic::Ordering;

    struct Tools {
        tools: ScheduleTools,
        setup: crate::service::tests::Setup,
    }

    fn setup(label: &str, depths: &[(&str, u64)]) -> Tools {
        let setup = setup_with(label, |_| ());
        let depths: HashMap<String, u64> = depths
            .iter()
            .map(|(id, depth)| ((*id).to_owned(), *depth))
            .collect();
        let tools = ScheduleTools::new(
            Arc::clone(&setup.service),
            Arc::new(move |id: &str| depths.get(id).copied().unwrap_or(0)),
        );
        Tools { tools, setup }
    }

    impl Tools {
        async fn call(&self, name: &str, args: Value) -> ToolResult {
            self.tools.call(name, &args, Some("session-1"), None).await
        }

        async fn call_as(&self, name: &str, args: Value, session: Option<&str>) -> ToolResult {
            self.tools.call(name, &args, session, None).await
        }
    }

    /// A DSH value: the exact JSON text, no error.
    #[track_caller]
    fn value(result: &ToolResult) -> Value {
        assert_eq!(result.error, None, "expected a value");
        serde_json::from_str(&result.output).unwrap()
    }

    fn keys(value: &Value) -> Vec<String> {
        value.as_object().unwrap().keys().cloned().collect()
    }

    #[test]
    fn four_tools_with_dsh_names_descriptions_and_an_open_root_schema() {
        let specs = schedule_tool_specs();
        assert_eq!(
            specs
                .iter()
                .map(|spec| spec.name.as_str())
                .collect::<Vec<_>>(),
            [
                "schedule_create",
                "schedule_list",
                "schedule_delete",
                "schedule_update"
            ]
        );
        let create = &specs[0];
        assert_eq!(create.description, CREATE_DESCRIPTION);
        assert!(
            create.parameters.get("additionalProperties").is_none(),
            "the root is open"
        );
        assert_eq!(
            keys(&create.parameters["properties"]),
            [
                "prompt",
                "title",
                "after_seconds",
                "every_seconds",
                "daily",
                "weekly",
                "cron",
                "at"
            ]
        );
        assert_eq!(create.parameters["required"], json!(["prompt", "title"]));
        assert_eq!(
            create.parameters["properties"]["daily"]["additionalProperties"],
            json!(false)
        );
        assert_eq!(
            keys(&create.parameters["properties"]["daily"]),
            [
                "type",
                "description",
                "additionalProperties",
                "properties",
                "required"
            ]
        );
        assert_eq!(
            create.parameters["properties"]["weekly"]["required"],
            json!(["time", "time_zone", "weekdays"])
        );
        assert_eq!(
            keys(&specs[3].parameters["properties"]),
            [
                "id",
                "title",
                "prompt",
                "every_seconds",
                "daily",
                "weekly",
                "cron",
                "at"
            ],
            "no after_seconds on update"
        );
        assert_eq!(specs[3].parameters["required"], json!(["id"]));
        assert_eq!(
            specs[1].description,
            "List the active reminders in the current session."
        );
        assert_eq!(
            specs[2].description,
            "Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued."
        );
        assert_eq!(
            specs[3].description,
            "Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; omitted fields keep their stored values. To change a relative delay, create a new reminder."
        );
    }

    #[tokio::test]
    async fn schedule_create_answers_with_the_view_as_exact_json_text_in_dsh_key_order() {
        let t = setup("tool-create", &[]);
        let result = t.call("schedule_create", json!({"prompt": "Review today's tasks", "title": "Daily review", "daily": {"time": "23:00:00", "time_zone": "Asia/Shanghai"}})).await;
        assert_eq!(result.error, None);
        assert_eq!(
            result.output,
            r#"{"id":"schedule-1","kind":"daily","title":"Daily review","prompt":"Review today's tasks","time":"23:00:00.000","timeZone":"Asia/Shanghai","scheduledAt":"2026-10-29T15:00:00.000Z","state":"scheduled","deliveryMode":"host"}"#
        );
        assert_eq!(result.data.as_ref().unwrap()["schedule"], value(&result));
        let after = t
            .call(
                "schedule_create",
                json!({"prompt": "p", "title": "t", "after_seconds": 30}),
            )
            .await;
        assert_eq!(
            after.output,
            r#"{"id":"schedule-2","kind":"after","title":"t","prompt":"p","afterSeconds":30,"scheduledAt":"2026-10-29T12:00:30.000Z","state":"scheduled","deliveryMode":"host"}"#
        );
        let weekly = value(&t.call("schedule_create", json!({"prompt": "p", "title": "t", "weekly": {"time": "09:00:00", "time_zone": "UTC", "weekdays": [5, 1]}})).await);
        assert_eq!(
            keys(&weekly),
            [
                "id",
                "kind",
                "title",
                "prompt",
                "time",
                "timeZone",
                "weekdays",
                "scheduledAt",
                "state",
                "deliveryMode"
            ]
        );
        assert_eq!(weekly["weekdays"], json!([1, 5]));
        let cron = value(&t.call("schedule_create", json!({"prompt": "p", "title": "t", "cron": {"expression": "0,30 * * * *", "time_zone": "UTC"}})).await);
        assert_eq!(
            keys(&cron),
            [
                "id",
                "kind",
                "title",
                "prompt",
                "expression",
                "timeZone",
                "scheduledAt",
                "state",
                "deliveryMode"
            ]
        );
        assert_eq!(cron["expression"], "0-30/30 * * * *");
        let every = value(
            &t.call(
                "schedule_create",
                json!({"prompt": "p", "title": "t", "every_seconds": 60}),
            )
            .await,
        );
        assert_eq!(
            keys(&every),
            [
                "id",
                "kind",
                "title",
                "prompt",
                "everySeconds",
                "scheduledAt",
                "state",
                "deliveryMode"
            ]
        );
        let at = value(
            &t.call(
                "schedule_create",
                json!({"prompt": "p", "title": "t", "at": "2026-10-30T00:00:00+08:00"}),
            )
            .await,
        );
        assert_eq!(
            keys(&at),
            [
                "id",
                "kind",
                "title",
                "prompt",
                "scheduledAt",
                "state",
                "deliveryMode"
            ]
        );
    }

    fn code(code: &str, message: &str) -> Value {
        coded(code, message)
    }

    #[tokio::test]
    async fn schedule_create_refusals_are_values_with_dsh_codes_and_messages_in_dsh_order() {
        let t = setup("tool-refusals", &[]);
        let selector = code(
            "invalid_selector",
            "schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.",
        );
        assert_eq!(
            value(
                &t.call("schedule_create", json!({"prompt": "p", "title": "t"}))
                    .await
            ),
            selector
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_create",
                    json!({"prompt": "p", "title": "t", "after_seconds": 60, "every_seconds": 60})
                )
                .await
            ),
            selector
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_create",
                    json!({"prompt": "p", "title": "t", "after_seconds": 60, "session": "x"})
                )
                .await
            ),
            selector,
            "an unknown key"
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_create",
                    json!({"prompt": " ", "title": " ", "after_seconds": 60})
                )
                .await
            ),
            code("invalid_prompt", "prompt must be non-empty after trimming.")
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_create",
                    json!({"prompt": "p", "title": " ", "after_seconds": 60})
                )
                .await
            ),
            code(
                "invalid_prompt",
                "title is required and must be non-empty after trimming."
            )
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_create",
                    json!({"prompt": "p", "title": "x".repeat(121), "after_seconds": 60})
                )
                .await
            ),
            code("invalid_prompt", "title must be at most 120 characters.")
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_create",
                    json!({"prompt": "p", "title": "t", "after_seconds": 0})
                )
                .await
            ),
            code(
                "invalid_rule",
                "after_seconds must be a positive safe integer."
            )
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_create",
                    json!({"prompt": "p", "title": "t", "every_seconds": 60.5})
                )
                .await
            ),
            code("invalid_rule", "every_seconds must be a safe integer.")
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_create",
                    json!({"prompt": "p", "title": "t", "every_seconds": 59})
                )
                .await
            ),
            code("frequency_too_high", "every_seconds must be at least 60.")
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_create",
                    json!({"prompt": "p", "title": "t", "at": "2026-10-29T11:00:00Z"})
                )
                .await
            ),
            code(
                "not_future",
                "The scheduled time must be strictly in the future."
            )
        );
        assert_eq!(
            value(&t.call("schedule_create", json!({"prompt": "p", "title": "t", "daily": {"time": "09:00:00", "time_zone": "PST"}})).await),
            code("invalid_time_zone", "time_zone must be UTC or a valid IANA Area/Location name.")
        );
        assert_eq!(
            value(&t.call("schedule_create", json!({"prompt": "p", "title": "t", "at": {"date": "2026-03-08", "time": "02:30:00", "time_zone": "America/Los_Angeles"}})).await),
            code("invalid_rule", "The local at time does not exist in the selected time zone.")
        );
    }

    #[tokio::test]
    async fn arguments_that_break_the_schema_are_the_one_error_result() {
        let t = setup("tool-args", &[]);
        let missing = t
            .call("schedule_create", json!({"after_seconds": 60}))
            .await;
        assert_eq!(
            missing.error,
            Some(ToolError { code: "INVALID_ARGS".into(), message: "invalid arguments: missing required property \"prompt\"; missing required property \"title\"".into() })
        );
        assert_eq!(missing.output, "");
        let message = |result: ToolResult| result.error.unwrap().message;
        assert_eq!(
            message(
                t.call(
                    "schedule_create",
                    json!({"prompt": "p", "title": "t", "every_seconds": "60"})
                )
                .await
            ),
            "invalid arguments: \"every_seconds\" must be a number"
        );
        assert_eq!(
            message(t.call("schedule_create", json!({"prompt": "p", "title": "t", "daily": {"time": "09:00:00", "zone": "UTC"}})).await),
            "invalid arguments: missing required property \"daily.time_zone\"; \"daily.zone\" is not a declared property (additionalProperties: false)"
        );
        assert_eq!(
            message(t.call("schedule_create", json!({"prompt": "p", "title": "t", "at": {"date": "2026-10-30", "time": "09:00:00"}})).await),
            "invalid arguments: \"at\" must match exactly one oneOf branch (matched 0)"
        );
        assert_eq!(
            message(t.call("schedule_create", json!({"prompt": "p", "title": "t", "weekly": {"time": "09:00:00", "time_zone": "UTC", "weekdays": [1, "x"]}})).await),
            "invalid arguments: \"weekly.weekdays[1]\" must be an integer"
        );
        assert_eq!(
            message(t.call("schedule_delete", json!({})).await),
            "invalid arguments: missing required property \"id\""
        );
        assert_eq!(
            validate_args(&create_parameters(), &json!("x"), ""),
            ["\"arguments\" must be an object"]
        );
    }

    #[tokio::test]
    async fn a_call_with_no_session_is_internal_error_a_delegated_child_is_refused_by_all_four_tools()
     {
        let t = setup("tool-subagent", &[("session-child", 1)]);
        let internal = code("internal_error", "The schedule operation failed.");
        assert_eq!(
            value(
                &t.call_as(
                    "schedule_create",
                    json!({"prompt": "p", "title": "t", "after_seconds": 60}),
                    None
                )
                .await
            ),
            internal
        );
        assert_eq!(
            value(&t.call_as("schedule_list", json!({}), None).await),
            internal
        );
        let refusal = code(
            "subagent_session",
            "A delegated subagent cannot use reminders.",
        );
        let child = Some("session-child");
        assert_eq!(
            value(
                &t.call_as(
                    "schedule_create",
                    json!({"prompt": "p", "title": "t", "after_seconds": 60}),
                    child
                )
                .await
            ),
            refusal
        );
        assert_eq!(
            value(
                &t.call_as(
                    "schedule_create",
                    json!({"prompt": "p", "title": "t"}),
                    child
                )
                .await
            ),
            refusal,
            "the refusal precedes argument rules"
        );
        assert_eq!(
            value(&t.call_as("schedule_list", json!({}), child).await),
            refusal
        );
        assert_eq!(
            value(
                &t.call_as(
                    "schedule_update",
                    json!({"id": "schedule-1", "title": "x"}),
                    child
                )
                .await
            ),
            refusal
        );
        assert_eq!(
            value(
                &t.call_as("schedule_delete", json!({"id": "schedule-1"}), child)
                    .await
            ),
            refusal
        );
    }

    #[tokio::test]
    async fn an_aborted_call_is_internal_error_and_writes_nothing() {
        let t = setup("tool-abort", &[]);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = t
            .tools
            .call(
                "schedule_create",
                &json!({"prompt": "p", "title": "t", "after_seconds": 60}),
                Some("session-1"),
                Some(cancel),
            )
            .await;
        assert_eq!(
            value(&result),
            code("internal_error", "The schedule operation failed.")
        );
        assert!(t.setup.service.tasks().is_empty());
    }

    #[tokio::test]
    async fn a_failure_that_is_not_an_input_error_is_withheld_behind_internal_error() {
        let t = setup("tool-failure", &[]);
        // The store's directory cannot be created: a file stands where it should be.
        let directory = t.setup.file.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(directory.parent().unwrap()).unwrap();
        std::fs::write(&directory, "not a directory").unwrap();
        let result = t
            .call(
                "schedule_create",
                json!({"prompt": "p", "title": "t", "after_seconds": 60}),
            )
            .await;
        assert_eq!(
            value(&result),
            code("internal_error", "The schedule operation failed.")
        );
        let _ = std::fs::remove_file(&directory);
    }

    #[tokio::test]
    async fn schedule_list_answers_the_sessions_active_views_overdue_when_due() {
        let t = setup("tool-list", &[]);
        t.call(
            "schedule_create",
            json!({"prompt": "p", "title": "a", "after_seconds": 60}),
        )
        .await;
        t.call(
            "schedule_create",
            json!({"prompt": "p", "title": "b", "after_seconds": 600}),
        )
        .await;
        t.call_as(
            "schedule_create",
            json!({"prompt": "p", "title": "other", "after_seconds": 60}),
            Some("session-2"),
        )
        .await;
        t.setup.clock.store(T0 + 120_000, Ordering::SeqCst);
        let list = value(&t.call("schedule_list", json!({})).await);
        let pairs: Vec<(String, String)> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|one| {
                (
                    one["title"].as_str().unwrap().to_owned(),
                    one["state"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            [
                ("a".to_owned(), "overdue".to_owned()),
                ("b".to_owned(), "scheduled".to_owned())
            ]
        );
        assert_eq!(
            value(
                &t.call_as("schedule_list", json!({}), Some("session-3"))
                    .await
            ),
            json!([])
        );
    }

    #[tokio::test]
    async fn schedule_update_argument_rules_then_not_found_and_ended_then_the_view() {
        let t = setup("tool-update", &[]);
        let created = value(
            &t.call(
                "schedule_create",
                json!({"prompt": "p", "title": "t", "every_seconds": 60}),
            )
            .await,
        );
        let id = created["id"].as_str().unwrap().to_owned();
        let at_most_one = code(
            "invalid_selector",
            "schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.",
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_update",
                    json!({"id": id, "every_seconds": 60, "at": "2026-11-01T00:00:00Z"})
                )
                .await
            ),
            at_most_one
        );
        assert_eq!(
            value(
                &t.call("schedule_update", json!({"id": id, "after_seconds": 60}))
                    .await
            ),
            at_most_one,
            "after_seconds is not an update key"
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_update",
                    json!({"id": format!(" {id}"), "title": "x"})
                )
                .await
            ),
            code(
                "invalid_rule",
                "schedule_update id must be non-empty without surrounding whitespace."
            )
        );
        assert_eq!(
            value(&t.call("schedule_update", json!({"id": id})).await),
            code(
                "invalid_selector",
                "schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron."
            )
        );
        assert_eq!(
            value(
                &t.call("schedule_update", json!({"id": id, "title": " "}))
                    .await
            ),
            code(
                "invalid_prompt",
                "title is required and must be non-empty after trimming."
            )
        );
        assert_eq!(
            value(
                &t.call(
                    "schedule_update",
                    json!({"id": id, "title": "x".repeat(121)})
                )
                .await
            ),
            code("invalid_prompt", "title must be at most 120 characters.")
        );
        assert_eq!(
            value(
                &t.call("schedule_update", json!({"id": id, "prompt": " "}))
                    .await
            ),
            code("invalid_prompt", "prompt must be non-empty after trimming.")
        );
        assert_eq!(
            value(
                &t.call("schedule_update", json!({"id": id, "every_seconds": 30}))
                    .await
            ),
            code("frequency_too_high", "every_seconds must be at least 60.")
        );
        assert_eq!(
            t.call("schedule_update", json!({"id": "schedule-x", "title": "x"}))
                .await
                .output,
            r#"{"id":"schedule-x","updated":false,"code":"schedule_not_found"}"#
        );
        assert_eq!(
            t.call_as(
                "schedule_update",
                json!({"id": id, "title": "x"}),
                Some("session-2")
            )
            .await
            .output,
            format!(r#"{{"id":"{id}","updated":false,"code":"schedule_not_found"}}"#)
        );
        let renamed = value(
            &t.call(
                "schedule_update",
                json!({"id": id, "title": "Renamed", "prompt": " new "}),
            )
            .await,
        );
        assert_eq!(
            renamed,
            json!({"id": id, "kind": "every", "title": "Renamed", "prompt": "new", "everySeconds": 60, "scheduledAt": created["scheduledAt"], "state": "scheduled", "deliveryMode": "host"})
        );
        let noop = value(
            &t.call("schedule_update", json!({"id": id, "every_seconds": 60}))
                .await,
        );
        assert_eq!(
            noop["scheduledAt"], created["scheduledAt"],
            "a no-op still answers with the view"
        );
        let moved = value(
            &t.call(
                "schedule_update",
                json!({"id": id, "cron": {"expression": "0 13 * * *", "time_zone": "UTC"}}),
            )
            .await,
        );
        assert_eq!(moved["kind"], "cron");
        assert_eq!(moved["scheduledAt"], "2026-10-29T13:00:00.000Z");
        let task = t.setup.service.tasks().remove(0);
        t.setup
            .service
            .commit_delivery(crate::store::ScheduleTask {
                status: TaskStatus::Inactive,
                ..task
            })
            .unwrap();
        assert_eq!(
            t.call("schedule_update", json!({"id": id, "title": "x"}))
                .await
                .output,
            format!(r#"{{"id":"{id}","updated":false,"code":"schedule_ended"}}"#)
        );
    }

    #[tokio::test]
    async fn schedule_delete_checks_the_id_first_then_deletes_in_any_state() {
        let t = setup("tool-delete", &[]);
        let id_rule = code(
            "invalid_rule",
            "schedule_delete id must be non-empty without surrounding whitespace.",
        );
        assert_eq!(
            value(&t.call_as("schedule_delete", json!({"id": ""}), None).await),
            id_rule,
            "before the missing caller"
        );
        assert_eq!(
            value(
                &t.call("schedule_delete", json!({"id": "schedule-1 "}))
                    .await
            ),
            id_rule
        );
        let created = value(
            &t.call(
                "schedule_create",
                json!({"prompt": "p", "title": "t", "after_seconds": 60}),
            )
            .await,
        );
        let id = created["id"].as_str().unwrap();
        assert_eq!(
            t.call_as("schedule_delete", json!({"id": id}), Some("session-2"))
                .await
                .output,
            format!(r#"{{"id":"{id}","deleted":false,"code":"schedule_not_found"}}"#)
        );
        assert_eq!(
            t.call("schedule_delete", json!({"id": id})).await.output,
            format!(r#"{{"id":"{id}","deleted":true}}"#)
        );
        assert_eq!(value(&t.call("schedule_list", json!({})).await), json!([]));
    }
}
