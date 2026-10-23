//! The named hook points: their names, the catalog `heddle hooks` prints, and the lifecycle events whose
//! payloads are plain values.
//!
//! A point's **marker type** lives with its payload type — `heddle-llm` declares `model/request` and
//! `model/stream`, `heddle-tools` the two `tools/*` points, `heddle-agent` the two `agent/*` points,
//! `heddle-session` `session/event`, `heddle-sandbox` `approval/request`, `heddle-team` `team/changed`'s use —
//! and uses the name constant from here, so the catalog and the code cannot drift apart silently.

use serde::{Deserialize, Serialize};

use crate::event::{EmitEvent, Event};
use crate::mode::Mode;

/// Waterfall before a round's request is built; may replace the messages or the tools; failing refuses the
/// round. TypeScript: `src/agent/loop.ts`.
pub const AGENT_PRE_STEP: &str = "agent/pre-step";
/// Waterfall after a model call failed; a listener that reduced the conversation answers retry.
/// TypeScript: `src/agent/loop.ts`, listened on by `src/context/service.ts`.
pub const AGENT_REQUEST_ERROR: &str = "agent/request-error";
/// Waterfall over a request before an adapter is chosen; may replace the request. TypeScript: `src/llm/service.ts`.
pub const MODEL_REQUEST: &str = "model/request";
/// Waterfall around the adapter's stream; may yield its own chunks. TypeScript: `src/llm/service.ts`.
pub const MODEL_STREAM: &str = "model/stream";
/// Waterfall before a tool runs; may refuse it. TypeScript: `src/tools/service.ts`.
pub const TOOLS_PRE_EXECUTE: &str = "tools/pre-execute";
/// Waterfall after a tool ran; may replace its result. TypeScript: `src/tools/service.ts`.
pub const TOOLS_POST_EXECUTE: &str = "tools/post-execute";
/// Emit after an event reached a session's file. TypeScript: `src/llm/types.ts`, emitted by `src/plugins/session.ts`.
pub const SESSION_EVENT: &str = "session/event";
/// Emit when a question waits for a person. TypeScript: `src/approvals/service.ts`.
pub const APPROVAL_REQUEST: &str = "approval/request";
/// Emit when a team's durable state changed; the payload is the lead session's id. TypeScript: `src/plugins/team.ts`.
pub const TEAM_CHANGED: &str = "team/changed";
/// Emit when the application finished loading; the payload is the run's target. TypeScript: `src/events.ts`.
pub const HEDDLE_READY: &str = "heddle/ready";
/// Emit when the composed tree is wrong in a way only visible once every plugin loaded. TypeScript: `src/events.ts`.
pub const HEDDLE_CONFIG_PROBLEM: &str = "heddle/config-problem";

/// One row of the catalog: what `heddle hooks --json` prints for a point, in this key order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct PointInfo {
    /// The point's name.
    pub name: &'static str,
    /// How it is dispatched.
    pub mode: Mode,
    /// One line on when it fires and what a listener may do.
    pub what: &'static str,
}

/// The hook points this build emits, in the order and with the words of the TypeScript `heddle hooks`
/// (`src/cli.ts`). `60-hooks` requires `model/request`, `model/stream`, `tools/pre-execute`,
/// `tools/post-execute` and `agent/pre-step`, and at least four waterfalls.
pub const HOOK_POINTS: &[PointInfo] = &[
    PointInfo {
        name: AGENT_PRE_STEP,
        mode: Mode::Waterfall,
        what: "before a round request is built; may replace messages or tools",
    },
    PointInfo {
        name: MODEL_REQUEST,
        mode: Mode::Waterfall,
        what: "before an adapter is chosen; may replace the request",
    },
    PointInfo {
        name: MODEL_STREAM,
        mode: Mode::Waterfall,
        what: "around the adapter stream; may yield its own chunks",
    },
    PointInfo {
        name: TOOLS_PRE_EXECUTE,
        mode: Mode::Waterfall,
        what: "before a tool runs; may refuse it",
    },
    PointInfo {
        name: TOOLS_POST_EXECUTE,
        mode: Mode::Waterfall,
        what: "after a tool runs; may replace the result",
    },
    PointInfo {
        name: SESSION_EVENT,
        mode: Mode::Emit,
        what: "after an event reaches the session file",
    },
];

/// The catalog as `heddle hooks --json` prints it: `JSON.stringify(points, null, 2)` and a newline.
pub fn hook_points_json() -> String {
    let mut text = serde_json::to_string_pretty(HOOK_POINTS).expect("the catalog is plain data");
    text.push('\n');
    text
}

/// The catalog as `heddle hooks` prints it without `--json`: a count line, then one padded row per point.
pub fn hook_points_text() -> String {
    let mut text = format!("heddle: {} hook point(s)\n", HOOK_POINTS.len());
    for point in HOOK_POINTS {
        text.push_str(&format!(
            "  {:<20} {:<10} {}\n",
            point.name,
            point.mode.as_str(),
            point.what
        ));
    }
    text
}

/// `heddle/ready`: the application finished loading. The payload is the run's target.
pub struct Ready;
impl Event for Ready {
    const NAME: &'static str = HEDDLE_READY;
    type Payload = String;
}
impl EmitEvent for Ready {}

/// The payload of `heddle/config-problem`: which plugin reported, and what it could not find.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigProblemPayload {
    /// The reporting plugin's name.
    pub plugin: String,
    /// One sentence per problem.
    pub problems: Vec<String>,
}

/// `heddle/config-problem`: the composed tree names something nothing provided. The command line listens
/// and fails the run, so a typo in a profile is not a log line nobody reads.
pub struct ConfigProblem;
impl Event for ConfigProblem {
    const NAME: &'static str = HEDDLE_CONFIG_PROBLEM;
    type Payload = ConfigProblemPayload;
}
impl EmitEvent for ConfigProblem {}

/// `team/changed`: a team's durable state changed. The payload is the lead session's id.
pub struct TeamChanged;
impl Event for TeamChanged {
    const NAME: &'static str = TEAM_CHANGED;
    type Payload = String;
}
impl EmitEvent for TeamChanged {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_holds_every_point_the_hooks_verifier_requires() {
        let names: Vec<&str> = HOOK_POINTS.iter().map(|point| point.name).collect();
        for wanted in [
            MODEL_REQUEST,
            MODEL_STREAM,
            TOOLS_PRE_EXECUTE,
            TOOLS_POST_EXECUTE,
            AGENT_PRE_STEP,
        ] {
            assert!(
                names.contains(&wanted),
                "{wanted} is a hook point; saw {names:?}"
            );
        }
        let waterfalls = HOOK_POINTS
            .iter()
            .filter(|point| point.mode == Mode::Waterfall)
            .count();
        assert!(
            waterfalls >= 4,
            "the rewriting points are waterfalls; saw {waterfalls}"
        );
    }

    #[test]
    fn the_json_catalog_has_the_typescript_shape() {
        let parsed: serde_json::Value = serde_json::from_str(&hook_points_json()).unwrap();
        let first = &parsed[0];
        assert_eq!(first["name"], "agent/pre-step");
        assert_eq!(first["mode"], "waterfall");
        assert_eq!(
            first["what"],
            "before a round request is built; may replace messages or tools"
        );
        assert!(hook_points_json().starts_with(
            "[\n  {\n    \"name\": \"agent/pre-step\",\n    \"mode\": \"waterfall\","
        ));
        assert!(hook_points_json().ends_with("}\n]\n"));
    }

    #[test]
    fn the_text_catalog_pads_like_the_typescript_command() {
        let text = hook_points_text();
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("heddle: 6 hook point(s)"));
        assert_eq!(
            lines.next(),
            Some(
                "  agent/pre-step       waterfall  before a round request is built; may replace messages or tools"
            )
        );
        assert_eq!(
            lines.last(),
            Some("  session/event        emit       after an event reaches the session file")
        );
    }
}
