//! The agent loop: one turn is record the prompt, ask the model, run the tools it asked for, repeat until
//! it answers without asking.
//!
//! Ported from `src/agent/loop.ts`. Every step is on disk before the next starts, so a killed run reads as
//! a partial turn. The loop knows no endpoint, tool or sandbox policy; it asks for all of them through
//! [`AgentRuntime`]. Each round, in order:
//!
//! 1. stop if the caller's token or an interrupt fired (`ended: ["stopped by the caller"]`);
//! 2. record the runtime context (`sandbox:policy`, the effective mode's statement);
//! 3. `prepare` the context, then the `agent/pre-step` hook;
//! 4. note the user positions on the surface, write `model/request`, stream the call, writing each chunk;
//!    a coded failure is offered on `agent/request-error` and retried (after `assemble`, with a
//!    `turn/retry` record) up to `max_overflow_retries` times when a listener answers `Retry`;
//! 5. stop when the round asked for no tool **and** no user message arrived during the call (steering);
//! 6. run each call through the registry and write its `tool` message — every call is answered, even one
//!    that cannot run (`INTERRUPTED`), because a call without an answer breaks every later request.
//!
//! Then `assistant/completed` and `turn/completed` are written, with `ended` naming an abnormal finish or
//! the round limit.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use heddle_tools::{ToolArgs, ToolRegistry, ToolResult};

use crate::ports::{
    ContextPort, HookFailure, ModelError, ModelPort, PortError, SessionPort, TurnHooks,
};
use crate::turns::TurnRegistry;
use crate::upstream::{ContentPart, Role, SessionHandle, TokenUsage, merge_token_usage};

/// The rounds a one-shot turn may take when the caller names no limit.
pub const DEFAULT_MAX_ROUNDS: u32 = 8;

/// How many times one round may be retried after the provider refused it as too long.
pub const DEFAULT_MAX_OVERFLOW_RETRIES: u32 = 1;

/// The event types the loop writes itself (`model/request`, `assistant/chunk` and `message` are written
/// through their own [`SessionPort`] methods).
pub mod events {
    /// A round retried after a recovered failure: `round`, `attempt`, `code`, `estimatedTokens`, `compacted`.
    pub const TURN_RETRY: &str = "turn/retry";
    /// The turn's answer: `text`, `reasoning`, `finishReason`, `rounds`, `denials`, and `ended` when present.
    pub const ASSISTANT_COMPLETED: &str = "assistant/completed";
    /// The turn finished: `rounds`.
    pub const TURN_COMPLETED: &str = "turn/completed";
}

/// Everything a turn runs with. Cheap to clone; a teammate's or a child's turn uses the same runtime.
#[derive(Clone)]
pub struct AgentRuntime {
    /// The model service.
    pub model: Arc<dyn ModelPort>,
    /// The session service and store.
    pub session: Arc<dyn SessionPort>,
    /// The context service.
    pub context: Arc<dyn ContextPort>,
    /// The tool registry, which also answers the workspace root, the policy text and the effective mode.
    pub tools: Arc<ToolRegistry>,
    /// The turn's hook points.
    pub hooks: Arc<dyn TurnHooks>,
    /// The live-turn registry; optional, as in the TypeScript build, where a minimal profile has none.
    pub turns: Option<TurnRegistry>,
}

/// The cap on a turn's model-plus-tools rounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundLimit {
    /// At most this many rounds.
    Rounds(u32),
    /// No cap — the Web UI's rule (TypeScript `Infinity`), DSH's own; contexts are bounded by compaction.
    Unbounded,
}

impl Default for RoundLimit {
    fn default() -> Self {
        Self::Rounds(DEFAULT_MAX_ROUNDS)
    }
}

/// What one turn is asked to do. Mirror of the TypeScript `RunTurnOptions`.
#[derive(Debug, Clone)]
pub struct RunTurnOptions {
    /// The session the turn is recorded in.
    pub session: SessionHandle,
    /// Which configured endpoint answers.
    pub endpoint: String,
    /// The user's message.
    pub prompt: String,
    /// Files attached to the message, recorded beside its text.
    pub attachments: Vec<ContentPart>,
    /// Who wrote the prompt when it was not a person (an automatic goal round sets this).
    pub source: Option<serde_json::Value>,
    /// A system prompt, written as the surface's first node when the session has none.
    pub system: Option<String>,
    /// The model id, overriding the endpoint's default.
    pub model: Option<String>,
    /// The reasoning level, as an id the model declares.
    pub reasoning_effort: Option<String>,
    /// The cap on rounds; [`DEFAULT_MAX_ROUNDS`] unless named.
    pub max_rounds: RoundLimit,
    /// Cap on generated tokens per model call.
    pub max_output_tokens: Option<u32>,
    /// How many times one round may be retried after an overflow; [`DEFAULT_MAX_OVERFLOW_RETRIES`].
    pub max_overflow_retries: u32,
    /// What the turn is for when it is not an ordinary one (`team`); reaches the model call unchanged.
    pub purpose: Option<String>,
    /// The caller's Stop.
    pub cancel: Option<CancellationToken>,
}

impl RunTurnOptions {
    /// An ordinary turn with every option at its default.
    pub fn new(
        session: SessionHandle,
        endpoint: impl Into<String>,
        prompt: impl Into<String>,
    ) -> Self {
        Self {
            session,
            endpoint: endpoint.into(),
            prompt: prompt.into(),
            attachments: Vec::new(),
            source: None,
            system: None,
            model: None,
            reasoning_effort: None,
            max_rounds: RoundLimit::default(),
            max_output_tokens: None,
            max_overflow_retries: DEFAULT_MAX_OVERFLOW_RETRIES,
            purpose: None,
            cancel: None,
        }
    }
}

/// One tool call the turn made, with its result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolCallRecord {
    /// The tool's name.
    pub name: String,
    /// The arguments as the model wrote them.
    pub arguments: String,
    /// What it answered.
    pub result: ToolResult,
}

/// One call that came back with an error — the sandbox's and the policy's evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Denial {
    /// The tool.
    pub tool: String,
    /// The error code.
    pub code: String,
    /// The sentence.
    pub message: String,
}

/// The last round's context budget, so a caller can report it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSummary {
    /// The request's estimated size.
    pub estimated_tokens: u64,
    /// The reduction trigger.
    pub threshold_tokens: u64,
    /// Tool results rewritten.
    pub pruned: u64,
    /// Whether a summary landed.
    pub compacted: bool,
}

/// What happened in one turn, including what was refused. Serialized in the TypeScript shape.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResult {
    /// The answer's text.
    pub text: String,
    /// The reasoning shown.
    pub reasoning: String,
    /// Every call, in order.
    pub tool_calls: Vec<ToolCallRecord>,
    /// The calls that came back with an error.
    pub denials: Vec<Denial>,
    /// The last round's finish reason; `unknown` when no round finished.
    pub finish_reason: String,
    /// How many events the turn added.
    pub events: usize,
    /// Rounds taken.
    pub rounds: u32,
    /// The last round's context budget.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextSummary>,
    /// Why the turn stopped early, in the loop's words; empty for a turn that simply finished.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ended: Vec<String>,
    /// The tokens the provider reported, summed over rounds; absent when no round reported any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
}

/// Why a turn ended without a result — the TypeScript `throw` out of `runTurn`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TurnError {
    /// The `agent/pre-step` hook ended the round; the message says whether it refused or broke.
    #[error("{0}")]
    Hook(String),
    /// The model call failed and was not recovered.
    #[error(transparent)]
    Model(#[from] ModelError),
    /// A session or context write failed.
    #[error(transparent)]
    Port(#[from] PortError),
}

/// Run one turn.
///
/// Registers the turn with the live-turn registry when there is one (its token a child of the caller's),
/// and settles it however the turn ends.
pub async fn run_turn(
    runtime: &AgentRuntime,
    options: RunTurnOptions,
) -> Result<TurnResult, TurnError> {
    todo!("port runTurn and runTurnBody from src/agent/loop.ts")
}

/// Whether a user message arrived that was not on the surface before — the steering rule.
pub fn has_new_input(before: &BTreeSet<u64>, after: &BTreeSet<u64>) -> bool {
    after.iter().any(|seq| !before.contains(seq))
}

/// The surface positions that hold a user message.
pub fn user_input_seqs(session: &dyn SessionPort, handle: &SessionHandle) -> BTreeSet<u64> {
    session
        .surface(handle)
        .nodes
        .into_iter()
        .filter(|seq| session.node_role(handle, *seq) == Some(Role::User))
        .collect()
}

/// Add one round's reported usage to the turn's total; see [`merge_token_usage`].
pub fn merge_usage(previous: Option<TokenUsage>, next: Option<TokenUsage>) -> Option<TokenUsage> {
    merge_token_usage(previous, next)
}

/// Parse a tool call's argument string.
///
/// Blank is `{}`; a JSON object is itself; any other JSON value is `{"value": <it>}`; text that is not JSON
/// is `{"__unparsed": "<raw>"}`, so the tool refuses it as bad arguments and the model is told what it wrote.
pub fn parse_arguments(raw: &str) -> ToolArgs {
    if raw.trim().is_empty() {
        return ToolArgs::new();
    }
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(object)) => object,
        Ok(value) => ToolArgs::from_iter([("value".to_owned(), value)]),
        Err(_) => ToolArgs::from_iter([(
            "__unparsed".to_owned(),
            serde_json::Value::String(raw.to_owned()),
        )]),
    }
}

/// The text of the `tool` message that answers a call: `error (<code>): <message>` for an error, the output
/// otherwise, and `(the tool produced no output)` for an empty one.
pub fn tool_message_text(result: &ToolResult) -> String {
    match &result.error {
        Some(error) => format!("error ({}): {}", error.code, error.message),
        None if result.output.is_empty() => "(the tool produced no output)".to_owned(),
        None => result.output.clone(),
    }
}

/// Whether a hook's error sentence says it was meant as a refusal: the TypeScript `isHookRefusal`'s
/// message rule, which an outside listener (part 6) can only express in text.
pub fn is_hook_refusal(message: &str) -> bool {
    message.starts_with("refused by hook:")
}

/// The sentence a turn fails with when `agent/pre-step` ended its round.
pub fn pre_step_failure_message(failure: &HookFailure) -> String {
    match failure {
        HookFailure::Refusal(message) => message.clone(),
        HookFailure::Broken(message) if is_hook_refusal(message) => message.clone(),
        HookFailure::Broken(message) => format!("a hook failed at agent/pre-step — {message}"),
    }
}

/// Whether a round's finish reason is worth an `ended` notice: anything but `stop` and `tool_calls`.
pub fn is_abnormal_finish(finish_reason: &str) -> bool {
    finish_reason != "stop" && finish_reason != "tool_calls"
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::ports::ModelRequestRecord;
    use crate::upstream::{Chunk, Message, SurfaceView};

    #[test]
    fn new_input_is_a_position_that_was_not_there_before() {
        let before = BTreeSet::from([1, 4]);
        assert!(!has_new_input(&before, &BTreeSet::from([1, 4])));
        assert!(
            !has_new_input(&before, &BTreeSet::from([1])),
            "a position that left is not new input"
        );
        assert!(has_new_input(&before, &BTreeSet::from([1, 4, 9])));
    }

    #[test]
    fn arguments_parse_to_an_object_whatever_the_model_wrote() {
        assert!(parse_arguments("  ").is_empty());
        assert_eq!(parse_arguments(r#"{"path":"a"}"#)["path"], "a");
        assert_eq!(parse_arguments("[1,2]")["value"], serde_json::json!([1, 2]));
        assert_eq!(parse_arguments(r#"{"path":"#)["__unparsed"], r#"{"path":"#);
    }

    #[test]
    fn a_tool_message_says_error_code_output_or_that_there_was_none() {
        assert_eq!(
            tool_message_text(&ToolResult::refused("SANDBOX", "outside")),
            "error (SANDBOX): outside"
        );
        assert_eq!(
            tool_message_text(&ToolResult::ok("")),
            "(the tool produced no output)"
        );
        assert_eq!(tool_message_text(&ToolResult::ok("first")), "first");
    }

    #[test]
    fn a_broken_hook_is_named_as_a_hook_and_a_refusal_is_reported_as_is() {
        assert_eq!(
            pre_step_failure_message(&HookFailure::Refusal("no".into())),
            "no"
        );
        assert_eq!(
            pre_step_failure_message(&HookFailure::Broken("refused by hook: policy".into())),
            "refused by hook: policy"
        );
        assert_eq!(
            pre_step_failure_message(&HookFailure::Broken("typo".into())),
            "a hook failed at agent/pre-step — typo"
        );
    }

    #[test]
    fn only_an_abnormal_finish_is_a_stop_reason() {
        assert!(!is_abnormal_finish("stop"));
        assert!(!is_abnormal_finish("tool_calls"));
        assert!(is_abnormal_finish("max_output_tokens"));
    }

    #[test]
    fn the_default_round_limit_is_eight() {
        let session = SessionHandle {
            id: "s".into(),
            dir: "/s".into(),
            transcript: "/s/t".into(),
            meta: "/s/m".into(),
        };
        let options = RunTurnOptions::new(session, "scripted", "hi");
        assert_eq!(options.max_rounds, RoundLimit::Rounds(8));
        assert_eq!(options.max_overflow_retries, 1);
    }

    struct Surface;
    impl SessionPort for Surface {
        fn count(&self, _: &SessionHandle) -> usize {
            0
        }
        fn user_content(
            &self,
            _: &SessionHandle,
            _: Vec<ContentPart>,
            _: Option<serde_json::Value>,
        ) -> Result<(), PortError> {
            Ok(())
        }
        fn surface(&self, _: &SessionHandle) -> SurfaceView {
            SurfaceView {
                nodes: vec![1, 2, 3, 5],
                ..SurfaceView::default()
            }
        }
        fn node_role(&self, _: &SessionHandle, seq: u64) -> Option<Role> {
            match seq {
                1 => Some(Role::System),
                2 | 5 => Some(Role::User),
                3 => Some(Role::Assistant),
                _ => None,
            }
        }
        fn folder(&self, _: &SessionHandle) -> Option<PathBuf> {
            None
        }
        fn model_request(
            &self,
            _: &SessionHandle,
            _: &ModelRequestRecord,
        ) -> Result<(), PortError> {
            Ok(())
        }
        fn assistant_chunk(&self, _: &SessionHandle, _: &Chunk) -> Result<(), PortError> {
            Ok(())
        }
        fn message(&self, _: &SessionHandle, _: Message) -> Result<(), PortError> {
            Ok(())
        }
        fn append(
            &self,
            _: &SessionHandle,
            _: &str,
            _: serde_json::Map<String, serde_json::Value>,
        ) -> Result<(), PortError> {
            Ok(())
        }
    }

    #[test]
    fn user_input_positions_are_the_user_messages_on_the_surface() {
        let handle = SessionHandle {
            id: "s".into(),
            dir: "/s".into(),
            transcript: "/s/t".into(),
            meta: "/s/m".into(),
        };
        assert_eq!(user_input_seqs(&Surface, &handle), BTreeSet::from([2, 5]));
    }
}
