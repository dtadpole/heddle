//! Configuration schemas for the built-in rows that had none (issues #125 and #123): `context`, `goal`,
//! `subagent-tool`, `schedule`, `jobs` and `team`.
//!
//! Each schema is the row's TypeScript `Config` (Schemastery) written as this crate's JSON Schema subset, so
//! a settings write and `config --validate` refuse what the component would refuse when it starts. That is
//! DSH's rule: the settings service "validates edits against the full plugin Config before delegating
//! persistence". Without a schema the Rust settings service persisted a wrongly typed value, and the next
//! boot failed the row and left everything that depends on it pending, so the server never listened (#125).
//!
//! Where the Rust component is stricter than the TypeScript schema, the stricter rule is written, because a
//! value the schema lets through and the component then refuses is the failure this module exists to
//! prevent:
//! - fields the component reads as unsigned integers are `integer` with `minimum: 0`;
//! - `subagent-tool` refuses unknown keys.
//!
//! Schemastery's `step(1)` is `integer`, and its `min` and `max` are `minimum` and `maximum`.

use serde_json::{Value, json};

use crate::Schema;

fn schema(value: Value) -> Option<Schema> {
    Schema::from_json(value).ok()
}

/// A whole number of at least 0: what a Rust `u64` or `usize` field accepts.
fn count() -> Value {
    json!({ "type": "integer", "minimum": 0 })
}

/// `src/context/service.ts` `Config`, against heddle-context's `ContextConfig`.
pub fn context_schema() -> Option<Schema> {
    let policy = json!({
        "type": "object",
        "required": ["endpoint"],
        "properties": {
            "endpoint": { "type": "string" },
            "thresholdRatio": { "type": "number" },
            "retainRatio": { "type": "number" },
            "thresholdTokens": count(),
            "retainTokens": count(),
        }
    });
    schema(json!({
        "type": "object",
        "properties": {
            "system": { "type": "string" },
            "contextWindow": { "type": "integer", "minimum": 0, "default": 1_048_576 },
            "thresholdRatio": { "type": "number" },
            "retainRatio": { "type": "number" },
            "thresholdTokens": count(),
            "retainTokens": count(),
            "policies": { "type": "array", "items": policy, "default": [] },
            "instructions": { "type": "boolean", "default": true },
            "instructionsMaxBytes": count(),
            "endpoint": { "type": "string" },
            "model": { "type": "string" },
            "summarizeMaxTokens": count(),
        }
    }))
}

/// `src/goal/service.ts` `Config`, against heddle-goal's `GoalConfig`.
pub fn goal_schema() -> Option<Schema> {
    schema(json!({
        "type": "object",
        "properties": {
            "defaultMaxGoalRounds": { "type": "integer", "minimum": 0, "default": 100 },
        }
    }))
}

/// `src/plugins/subagent-tool.ts` `Config`, against heddle-agent's `SubagentConfig`, which refuses unknown keys.
pub fn subagent_tool_schema() -> Option<Schema> {
    schema(json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "maxDepth": { "type": "integer", "minimum": 0, "default": 2 },
            "maxActive": { "type": "integer", "minimum": 0, "default": 1 },
        }
    }))
}

/// `src/plugins/schedule.ts` `Config`.
pub fn schedule_schema() -> Option<Schema> {
    schema(json!({
        "type": "object",
        "properties": {
            "file": { "type": "string" },
            "deliveryHistoryDays": { "type": "integer", "minimum": 1, "maximum": 3650, "default": 30 },
            "deliveryHistoryRecords": { "type": "integer", "minimum": 1, "maximum": 10_000, "default": 200 },
            "autoStart": { "type": "boolean", "default": false },
            "maxRounds": { "type": "number" },
        }
    }))
}

/// `src/plugins/jobs.ts` `Config`, against heddle-jobs' `start_row` checks.
pub fn jobs_schema() -> Option<Schema> {
    schema(json!({
        "type": "object",
        "properties": {
            "maxConcurrentJobsPerOwner": { "type": "integer", "minimum": 1, "default": 10 },
            "retainBytes": { "type": "integer", "minimum": 1, "default": 262_144 },
            "settledRetainBytes": { "type": "integer", "minimum": 1, "default": 16_384 },
            "pumpPollMs": { "type": "integer", "minimum": 1, "default": 150 },
            "waitTimeoutMs": { "type": "number", "minimum": 1, "default": 30_000 },
            "maxWaitTimeoutMs": { "type": "number", "minimum": 1, "default": 600_000 },
            "completionDelivery": { "type": "string", "enum": ["wakeup", "quiet"], "default": "wakeup" },
            "maxConsecutiveWakes": { "type": "integer", "minimum": 1 },
            "killGraceMs": { "type": "number", "minimum": 0, "default": 3_000 },
            "maxRounds": { "type": "number" },
            "promoteOnTimeout": { "type": "boolean", "default": true },
        }
    }))
}

/// `src/plugins/team.ts` `Config`, against heddle-team's `TeamConfig`.
pub fn team_schema() -> Option<Schema> {
    schema(json!({
        "type": "object",
        "properties": {
            "maxMembers": { "type": "integer", "minimum": 0, "default": 8 },
            "maxTasks": { "type": "integer", "minimum": 0, "default": 256 },
            "maxPendingMessagesPerMember": { "type": "integer", "minimum": 0, "default": 64 },
            "maxMessageBytes": { "type": "integer", "minimum": 0, "default": 65_536 },
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn problems(schema: Option<Schema>, value: Value) -> Vec<String> {
        schema
            .expect("the schema reads")
            .check(&value)
            .iter()
            .map(ToString::to_string)
            .collect()
    }

    #[test]
    fn every_schema_reads_and_accepts_the_shipped_configuration() {
        for (schema, shipped) in [
            (context_schema(), json!({ "contextWindow": 1_048_576 })),
            (goal_schema(), json!({ "defaultMaxGoalRounds": 256 })),
            (
                subagent_tool_schema(),
                json!({ "maxDepth": 2, "maxActive": 1 }),
            ),
            (schedule_schema(), json!({})),
            (jobs_schema(), json!({})),
            (
                team_schema(),
                json!({ "maxMembers": 8, "maxTasks": 256, "maxPendingMessagesPerMember": 64, "maxMessageBytes": 65_536 }),
            ),
        ] {
            assert_eq!(problems(schema, shipped), Vec::<String>::new());
        }
    }

    #[test]
    fn what_the_component_would_refuse_at_boot_is_refused_here() {
        assert_eq!(
            problems(context_schema(), json!({ "contextWindow": "huge" })),
            vec![
                "contextWindow is not a number, which means the value in the layer could not be read as one"
            ]
        );
        assert_eq!(
            problems(jobs_schema(), json!({ "maxConcurrentJobsPerOwner": 0 })),
            vec!["maxConcurrentJobsPerOwner must be at least 1"]
        );
        assert_eq!(
            problems(jobs_schema(), json!({ "completionDelivery": "loud" })),
            vec!["completionDelivery is not one of the allowed values"]
        );
        assert_eq!(
            problems(subagent_tool_schema(), json!({ "maxDepht": 3 })),
            vec!["maxDepht is not an allowed field"]
        );
        assert_eq!(
            problems(team_schema(), json!({ "maxMembers": 2.5 }))
                .first()
                .map(|problem| problem.starts_with("maxMembers ")),
            Some(true),
            "a fraction where a whole number belongs is refused"
        );
        assert_eq!(
            problems(schedule_schema(), json!({ "deliveryHistoryDays": 5000 })),
            vec!["deliveryHistoryDays must be at most 3650"]
        );
    }
}
