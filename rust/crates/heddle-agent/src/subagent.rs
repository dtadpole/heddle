//! Subagent delegation: a parent turn asks for a child agent, the child runs in its **own session**, and
//! its final answer comes back as the parent's tool result.
//!
//! Ported from `src/agent/subagent.ts`, `src/tools/subagent.ts` and `src/plugins/subagent-tool.ts`. The
//! child is a session with `parentSession`, `origin: "subagent"` and `delegationDepth` in its metadata; the
//! parent's transcript sees only the `delegate` call and its result; depth and active limits belong to the
//! runtime, not to the tool's description, so a prompt cannot talk a model past them.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, Weak};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use heddle_tools::Tool;

use crate::ports::PortError;
use crate::turn::AgentRuntime;
use crate::upstream::{CreateSession, SandboxMode, SessionEvent, SessionHandle, SessionMeta};

/// The stable refusal codes, so a caller (and a model) branches on the code rather than the sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SubagentErrorCode {
    /// `SUBAGENT_DEPTH_EXCEEDED`: the chain would go deeper than `maxDepth`.
    SubagentDepthExceeded,
    /// `SUBAGENT_BUSY`: too many children in flight.
    SubagentBusy,
    /// `SUBAGENT_NO_SESSION`: the call has no parent session.
    SubagentNoSession,
    /// `SUBAGENT_EMPTY_PROMPT`: the prompt is blank.
    SubagentEmptyPrompt,
    /// `SUBAGENT_FAILED`: the child ran and produced no answer, or could not run.
    SubagentFailed,
}

impl SubagentErrorCode {
    /// The code as a tool result carries it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SubagentDepthExceeded => "SUBAGENT_DEPTH_EXCEEDED",
            Self::SubagentBusy => "SUBAGENT_BUSY",
            Self::SubagentNoSession => "SUBAGENT_NO_SESSION",
            Self::SubagentEmptyPrompt => "SUBAGENT_EMPTY_PROMPT",
            Self::SubagentFailed => "SUBAGENT_FAILED",
        }
    }
}

/// A delegation refused or failed, with its stable code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SubagentError {
    /// The code.
    pub code: SubagentErrorCode,
    /// The sentence.
    pub message: String,
}

impl SubagentError {
    /// A refusal with this code and sentence.
    pub fn new(code: SubagentErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// The limits the runtime enforces. Unset fields fall back to [`DEFAULT_MAX_DEPTH`] and
/// [`DEFAULT_MAX_ACTIVE`] — the defaults of `delegateSubagent` itself; the configuration row has its own
/// ([`SubagentConfig`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SubagentLimits {
    /// Deepest allowed chain; a root agent is depth 0, its child depth 1.
    pub max_depth: Option<u32>,
    /// How many children may be in flight at once for one tool instance.
    pub max_active: Option<usize>,
}

/// `delegateSubagent`'s default `maxDepth`.
pub const DEFAULT_MAX_DEPTH: u32 = 2;
/// `delegateSubagent`'s default `maxActive`.
pub const DEFAULT_MAX_ACTIVE: usize = 2;

/// The `subagent-tool` configuration row, with its TypeScript defaults (`maxDepth` 2, `maxActive` 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SubagentConfig {
    /// Deepest allowed chain.
    pub max_depth: u32,
    /// How many children may be in flight at once.
    pub max_active: usize,
}

impl Default for SubagentConfig {
    fn default() -> Self {
        Self {
            max_depth: 2,
            max_active: 1,
        }
    }
}

impl From<SubagentConfig> for SubagentLimits {
    fn from(config: SubagentConfig) -> Self {
        Self {
            max_depth: Some(config.max_depth),
            max_active: Some(config.max_active),
        }
    }
}

/// The session store, narrowed to what a delegation needs.
pub trait SubagentStore: Send + Sync {
    /// One session's metadata.
    fn meta(&self, id: &str) -> Option<SessionMeta>;
    /// Create a session.
    fn create(&self, options: CreateSession) -> Result<SessionHandle, PortError>;
    /// A session's whole log.
    fn read(&self, session: &SessionHandle) -> Vec<SessionEvent>;
    /// Copy the parent's recorded access mode to the child, so a narrowed session cannot widen itself by
    /// spawning one; the mode copied, if any.
    fn inherit_recorded_mode(
        &self,
        parent: &SessionHandle,
        child: &SessionHandle,
    ) -> Result<Option<SandboxMode>, PortError>;
}

/// Run one child turn. Production uses [`subagent_runner`]; a test passes a recorder.
pub trait SubagentRun: Send + Sync {
    /// Run `prompt` as one turn of `child`.
    fn run<'a>(
        &'a self,
        child: &'a SessionHandle,
        prompt: String,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'a, Result<(), SubagentError>>;
}

/// What a delegation needs, injected so the decision is testable without a model.
#[derive(Clone)]
pub struct SubagentDeps {
    /// The session store.
    pub store: Arc<dyn SubagentStore>,
    /// How a child turn runs.
    pub run: Arc<dyn SubagentRun>,
}

/// What a completed delegation reports back to the parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentResult {
    /// The child's session id.
    pub child_session: String,
    /// Its final answer.
    pub text: String,
    /// Its delegation depth.
    pub depth: u32,
}

/// A parent's depth and selection, read from its record.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParentFacts {
    /// Its delegation depth; 0 when unrecorded.
    pub depth: u32,
    /// Its endpoint.
    pub endpoint: Option<String>,
    /// Its model.
    pub model: Option<String>,
    /// Its reasoning level.
    pub reasoning_effort: Option<String>,
}

/// Read a parent's [`ParentFacts`] from its metadata.
pub fn parent_facts(meta: Option<&SessionMeta>) -> ParentFacts {
    meta.map_or_else(ParentFacts::default, |meta| ParentFacts {
        depth: meta.delegation_depth.unwrap_or(0),
        endpoint: meta.endpoint.clone(),
        model: meta.model.clone(),
        reasoning_effort: meta.reasoning_effort.clone(),
    })
}

/// The child's final answer: the assistant output of its **last round**, trimmed.
///
/// A round begins at `model/request` (the text resets), a `user` message resets it too, `assistant/chunk`
/// text deltas add to it, and a settled `assistant/completed` replaces it with its `text`.
pub fn final_assistant_text(events: &[SessionEvent]) -> String {
    let mut text = String::new();
    for event in events {
        match event.kind.as_str() {
            "model/request" => text.clear(),
            "message" => {
                let role = event
                    .fields
                    .get("message")
                    .and_then(|message| message.get("role"))
                    .and_then(|role| role.as_str());
                if role == Some("user") {
                    text.clear();
                }
            }
            "assistant/completed" => {
                if let Some(completed) = event.fields.get("text").and_then(|value| value.as_str()) {
                    completed.clone_into(&mut text);
                }
            }
            "assistant/chunk" => {
                let chunk = event.fields.get("chunk");
                let kind = chunk
                    .and_then(|chunk| chunk.get("type"))
                    .and_then(|kind| kind.as_str());
                let delta = chunk
                    .and_then(|chunk| chunk.get("text"))
                    .and_then(|delta| delta.as_str());
                if let (Some("text-delta"), Some(delta)) = (kind, delta) {
                    text.push_str(delta);
                }
            }
            _ => {}
        }
    }
    text.trim().to_owned()
}

/// Delegate one prompt to a child agent and wait for its answer.
///
/// Refused, in this order: no parent session, a blank prompt, a chain beyond `max_depth`, or `active`
/// already holding `max_active` parents. The child is created in the parent's folder (the process's
/// current directory when unrecorded) with the parent's endpoint, model and reasoning level, inherits the
/// parent's recorded mode, and runs with the parent's `cancel`, so a stopped parent leaves no child behind.
///
/// `active` is the tool instance's set of parents with a child in flight; the limit counts its entries,
/// which is the TypeScript build's rule.
pub async fn delegate_subagent(
    deps: &SubagentDeps,
    parent: Option<&SessionHandle>,
    prompt: &str,
    limits: SubagentLimits,
    cancel: Option<CancellationToken>,
    active: &Mutex<HashSet<String>>,
) -> Result<SubagentResult, SubagentError> {
    todo!("port delegateSubagent")
}

/// The production [`SubagentRun`]: one bounded child turn through [`run_turn`](crate::run_turn), with the
/// child's recorded endpoint (or the model's default) and model.
///
/// Holds the runtime weakly, because the runtime's registry holds the `delegate` tool that holds this.
/// Follows `src/plugins/subagent-tool.ts`, which the TypeScript profile loads: the child's reasoning level
/// is not forwarded (the unused `subagentRunner` export would forward it).
pub fn subagent_runner(runtime: Weak<AgentRuntime>) -> Arc<dyn SubagentRun> {
    todo!("port the subagent-tool plugin's run")
}

/// The model-facing `delegate` tool: one call, one child agent, its final answer as the result
/// (`child <id> (depth <n>) answered:\n<text>`, with `data: { childSession, depth, text }`); a refusal is a
/// result with the [`SubagentErrorCode`] as its code.
pub fn subagent_tools(deps: SubagentDeps, limits: SubagentLimits) -> Vec<Arc<dyn Tool>> {
    todo!("port subagentTools")
}

/// The output of a successful `delegate` call.
pub fn delegate_output(result: &SubagentResult) -> String {
    format!(
        "child {} (depth {}) answered:\n{}",
        result.child_session, result.depth, result.text
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(seq: u64, kind: &str, fields: serde_json::Value) -> SessionEvent {
        SessionEvent {
            seq,
            at: "t".into(),
            kind: kind.into(),
            fields: fields.as_object().cloned().unwrap_or_default(),
        }
    }

    #[test]
    fn the_final_answer_is_the_last_round_and_a_completion_replaces_its_deltas() {
        let events = [
            event(
                1,
                "message",
                serde_json::json!({ "message": { "role": "user" } }),
            ),
            event(2, "model/request", serde_json::json!({})),
            event(
                3,
                "assistant/chunk",
                serde_json::json!({ "chunk": { "type": "text-delta", "text": "first round" } }),
            ),
            event(4, "model/request", serde_json::json!({})),
            event(
                5,
                "assistant/chunk",
                serde_json::json!({ "chunk": { "type": "text-delta", "text": "child " } }),
            ),
            event(
                6,
                "assistant/chunk",
                serde_json::json!({ "chunk": { "type": "reasoning-delta", "text": "hmm" } }),
            ),
            event(
                7,
                "assistant/chunk",
                serde_json::json!({ "chunk": { "type": "text-delta", "text": "answer " } }),
            ),
        ];
        assert_eq!(final_assistant_text(&events), "child answer");
        let mut settled = events.to_vec();
        settled.push(event(
            8,
            "assistant/completed",
            serde_json::json!({ "text": "  settled  " }),
        ));
        assert_eq!(final_assistant_text(&settled), "settled");
    }

    #[test]
    fn a_user_message_after_an_answer_clears_it() {
        let events = [
            event(
                1,
                "assistant/chunk",
                serde_json::json!({ "chunk": { "type": "text-delta", "text": "old" } }),
            ),
            event(
                2,
                "message",
                serde_json::json!({ "message": { "role": "user" } }),
            ),
        ];
        assert_eq!(final_assistant_text(&events), "");
    }

    #[test]
    fn parent_facts_default_to_depth_zero_and_carry_the_selection() {
        assert_eq!(parent_facts(None), ParentFacts::default());
        let meta = SessionMeta {
            id: "p".into(),
            endpoint: Some("scripted".into()),
            model: Some("m".into()),
            delegation_depth: Some(1),
            ..SessionMeta::default()
        };
        let facts = parent_facts(Some(&meta));
        assert_eq!(facts.depth, 1);
        assert_eq!(facts.endpoint.as_deref(), Some("scripted"));
        assert_eq!(facts.reasoning_effort, None);
    }

    #[test]
    fn the_configuration_row_defaults_to_one_child_at_a_time() {
        let config: SubagentConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(
            config,
            SubagentConfig {
                max_depth: 2,
                max_active: 1
            }
        );
        assert_eq!(SubagentLimits::from(config).max_active, Some(1));
    }

    #[test]
    fn codes_are_spelled_as_the_typescript_build_spells_them() {
        assert_eq!(
            SubagentErrorCode::SubagentDepthExceeded.as_str(),
            "SUBAGENT_DEPTH_EXCEEDED"
        );
        assert_eq!(
            serde_json::to_string(&SubagentErrorCode::SubagentBusy).unwrap(),
            "\"SUBAGENT_BUSY\""
        );
    }

    #[test]
    fn a_delegation_result_names_the_child_and_its_depth() {
        let result = SubagentResult {
            child_session: "c1".into(),
            text: "child answer".into(),
            depth: 1,
        };
        assert_eq!(
            delegate_output(&result),
            "child c1 (depth 1) answered:\nchild answer"
        );
    }
}
