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

use heddle_tools::{Tool, ToolArgs, ToolResult, ToolRunContext, ToolSpec, tool_fn};

use crate::ports::PortError;
use crate::turn::{AgentRuntime, RunTurnOptions, run_turn};
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
    let Some(parent) = parent else {
        return Err(SubagentError::new(
            SubagentErrorCode::SubagentNoSession,
            "a delegation needs a parent session",
        ));
    };
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(SubagentError::new(
            SubagentErrorCode::SubagentEmptyPrompt,
            "a delegation needs a prompt",
        ));
    }

    let parent_meta = deps.store.meta(&parent.id);
    let facts = parent_facts(parent_meta.as_ref());
    let child_depth = facts.depth + 1;
    let max_depth = limits.max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
    if child_depth > max_depth {
        return Err(SubagentError::new(
            SubagentErrorCode::SubagentDepthExceeded,
            format!("subagent depth {child_depth} exceeds maxDepth {max_depth}"),
        ));
    }
    // The limit is on children in flight for this tool instance, so a future parallel executor cannot
    // bypass it by running several calls at once.
    let max_active = limits.max_active.unwrap_or(DEFAULT_MAX_ACTIVE);
    let inflight = active.lock().unwrap().len();
    if inflight >= max_active {
        return Err(SubagentError::new(
            SubagentErrorCode::SubagentBusy,
            format!("already running {inflight} subagent(s); maxActive is {max_active}"),
        ));
    }

    let cwd = parent_meta
        .as_ref()
        .and_then(|meta| meta.cwd.clone())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let child = deps
        .store
        .create(CreateSession {
            cwd: Some(cwd),
            endpoint: facts.endpoint.clone(),
            model: facts.model.clone(),
            reasoning_effort: facts.reasoning_effort.clone(),
            parent_session: Some(parent.id.clone()),
            origin: Some("subagent".to_owned()),
            delegation_depth: Some(child_depth),
            ..CreateSession::default()
        })
        .map_err(|error| {
            SubagentError::new(SubagentErrorCode::SubagentFailed, error.to_string())
        })?;
    // Delegation inherits the parent's mode, so a narrowed session cannot widen itself by spawning a child.
    deps.store
        .inherit_recorded_mode(parent, &child)
        .map_err(|error| {
            SubagentError::new(SubagentErrorCode::SubagentFailed, error.to_string())
        })?;

    let _in_flight = ActiveGuard {
        active,
        parent: parent.id.clone(),
    };
    deps.run.run(&child, prompt.to_owned(), cancel).await?;

    let answer = final_assistant_text(&deps.store.read(&child));
    if answer.is_empty() {
        return Err(SubagentError::new(
            SubagentErrorCode::SubagentFailed,
            "the child agent produced no assistant output",
        ));
    }
    Ok(SubagentResult {
        child_session: child.id,
        text: answer,
        depth: child_depth,
    })
}

/// Counts one parent as having a child in flight until it is dropped, whichever way the delegation ends.
struct ActiveGuard<'a> {
    active: &'a Mutex<HashSet<String>>,
    parent: String,
}

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        self.active.lock().unwrap().remove(&self.parent);
    }
}

/// The production [`SubagentRun`]: one child turn through [`run_turn`](crate::run_turn).
///
/// Holds the runtime weakly, because the runtime's registry holds the `delegate` tool that holds this.
/// Follows `src/plugins/subagent-tool.ts`, which the TypeScript profile loads: the child's reasoning level
/// is not forwarded (the unused `subagentRunner` export would forward it).
///
/// The child's endpoint is the model's default one: [`SessionPort`](crate::ports::SessionPort) exposes no
/// session metadata, so the record the store holds cannot be read here. The child's model is therefore the
/// endpoint's own default too, which is what a session created without an override runs with.
pub fn subagent_runner(runtime: Weak<AgentRuntime>) -> Arc<dyn SubagentRun> {
    Arc::new(RuntimeRunner { runtime })
}

struct RuntimeRunner {
    runtime: Weak<AgentRuntime>,
}

impl SubagentRun for RuntimeRunner {
    fn run<'a>(
        &'a self,
        child: &'a SessionHandle,
        prompt: String,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'a, Result<(), SubagentError>> {
        Box::pin(async move {
            let runtime = self.runtime.upgrade().ok_or_else(|| {
                SubagentError::new(
                    SubagentErrorCode::SubagentFailed,
                    "the agent runtime is gone",
                )
            })?;
            let endpoint = runtime.model.default_endpoint().ok_or_else(|| {
                SubagentError::new(
                    SubagentErrorCode::SubagentFailed,
                    "no endpoint is configured for a subagent run",
                )
            })?;
            let mut options = RunTurnOptions::new(child.clone(), endpoint, prompt);
            options.cancel = cancel;
            run_turn(&runtime, options).await.map_err(|error| {
                SubagentError::new(SubagentErrorCode::SubagentFailed, error.to_string())
            })?;
            Ok(())
        })
    }
}

/// The model-facing `delegate` tool: one call, one child agent, its final answer as the result
/// (`child <id> (depth <n>) answered:\n<text>`, with `data: { childSession, depth, text }`); a refusal is a
/// result with the [`SubagentErrorCode`] as its code.
pub fn subagent_tools(deps: SubagentDeps, limits: SubagentLimits) -> Vec<Arc<dyn Tool>> {
    // One in-flight set per tool instance, shared by every call it makes.
    let active = Arc::new(Mutex::new(HashSet::new()));
    let spec = ToolSpec {
        name: "delegate".to_owned(),
        description: "Delegate one task to a child agent that works in its own session and returns its final answer. Use it for a scoped piece of work that benefits from a fresh context; the child sees only the prompt you give it, not this conversation.".to_owned(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The complete task for the child agent; it has no access to this conversation."
                }
            },
            "required": ["prompt"],
            "additionalProperties": false,
        }),
    };
    let tool = tool_fn(spec, move |args: ToolArgs, context: ToolRunContext| {
        let deps = deps.clone();
        let active = Arc::clone(&active);
        Box::pin(async move {
            let prompt = args
                .get("prompt")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            match delegate_subagent(
                &deps,
                context.session.as_ref(),
                prompt,
                limits,
                context.cancel.clone(),
                &active,
            )
            .await
            {
                Ok(result) => {
                    let data = serde_json::Map::from_iter([
                        (
                            "childSession".to_owned(),
                            serde_json::json!(result.child_session),
                        ),
                        ("depth".to_owned(), serde_json::json!(result.depth)),
                        ("text".to_owned(), serde_json::json!(result.text)),
                    ]);
                    Ok(ToolResult::ok(delegate_output(&result)).with_data(data))
                }
                Err(error) => Ok(ToolResult::refused(error.code.as_str(), error.message)),
            }
        })
    });
    vec![tool]
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

    // ---- Delegation, judged with a fake store and a recorder instead of a model and a disk. ----

    use std::collections::HashSet;

    use futures::future::BoxFuture;
    use heddle_tools::{
        ApprovalDecision, ConfinedArgv, DefaultModes, NoToolHooks, SandboxDenial, SandboxGate,
        SandboxOutcome, SandboxUnavailable, ToolContext, ToolGates, ToolRegistry, ToolRunContext,
    };

    use crate::ports::{ContextPort, ModelError, ModelPort, SessionPort};
    use crate::upstream::{
        Chunk, ContentPart, ContextReport, GenerateRequest, Message, PrepareOptions, Role,
        SandboxMode, SurfaceView,
    };

    /// A store holding one parent and the child `create` always makes, with the child's log beside it.
    struct FakeStore {
        parent: SessionMeta,
        child: SessionHandle,
        created: Mutex<Vec<CreateSession>>,
        inherited: Mutex<Vec<(String, String)>>,
        child_events: Mutex<Vec<SessionEvent>>,
        answer: Option<String>,
    }

    impl FakeStore {
        fn with(depth: u32, answer: Option<&str>) -> Arc<Self> {
            Arc::new(Self {
                parent: SessionMeta {
                    id: "p".into(),
                    cwd: Some("/parent".into()),
                    endpoint: Some("scripted".into()),
                    model: Some("m".into()),
                    delegation_depth: Some(depth),
                    ..SessionMeta::default()
                },
                child: SessionHandle {
                    id: "child".into(),
                    dir: "/child".into(),
                    transcript: "/child/t".into(),
                    meta: "/child/m".into(),
                },
                created: Mutex::new(Vec::new()),
                inherited: Mutex::new(Vec::new()),
                child_events: Mutex::new(Vec::new()),
                answer: answer.map(str::to_owned),
            })
        }

        fn created(&self) -> Vec<CreateSession> {
            self.created.lock().unwrap().clone()
        }

        fn inherited(&self) -> Vec<(String, String)> {
            self.inherited.lock().unwrap().clone()
        }
    }

    impl SubagentStore for FakeStore {
        fn meta(&self, id: &str) -> Option<SessionMeta> {
            (id == self.parent.id).then(|| self.parent.clone())
        }
        fn create(&self, options: CreateSession) -> Result<SessionHandle, PortError> {
            self.created.lock().unwrap().push(options);
            Ok(self.child.clone())
        }
        fn read(&self, session: &SessionHandle) -> Vec<SessionEvent> {
            if session.id == self.child.id {
                self.child_events.lock().unwrap().clone()
            } else {
                Vec::new()
            }
        }
        fn inherit_recorded_mode(
            &self,
            parent: &SessionHandle,
            child: &SessionHandle,
        ) -> Result<Option<SandboxMode>, PortError> {
            self.inherited
                .lock()
                .unwrap()
                .push((parent.id.clone(), child.id.clone()));
            Ok(Some(SandboxMode::ReadOnly))
        }
    }

    /// Runs the child turn by writing the child's log, so `final_assistant_text` sees the answer.
    struct Recorder {
        store: Arc<FakeStore>,
        seen: Mutex<Vec<(String, String, bool)>>,
        fail: bool,
    }

    impl Recorder {
        fn new(store: Arc<FakeStore>) -> Arc<Self> {
            Arc::new(Self {
                store,
                seen: Mutex::new(Vec::new()),
                fail: false,
            })
        }

        fn failing(store: Arc<FakeStore>) -> Arc<Self> {
            Arc::new(Self {
                store,
                seen: Mutex::new(Vec::new()),
                fail: true,
            })
        }

        fn seen(&self) -> Vec<(String, String, bool)> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl SubagentRun for Recorder {
        fn run<'a>(
            &'a self,
            child: &'a SessionHandle,
            prompt: String,
            cancel: Option<CancellationToken>,
        ) -> BoxFuture<'a, Result<(), SubagentError>> {
            Box::pin(async move {
                self.seen
                    .lock()
                    .unwrap()
                    .push((child.id.clone(), prompt, cancel.is_some()));
                if self.fail {
                    return Err(SubagentError::new(
                        SubagentErrorCode::SubagentFailed,
                        "the child broke",
                    ));
                }
                if let Some(answer) = self.store.answer.clone() {
                    let mut events = self.store.child_events.lock().unwrap();
                    events.push(event(1, "model/request", serde_json::json!({})));
                    events.push(event(
                        2,
                        "assistant/chunk",
                        serde_json::json!({ "chunk": { "type": "text-delta", "text": answer } }),
                    ));
                }
                Ok(())
            })
        }
    }

    fn parent_handle() -> SessionHandle {
        SessionHandle {
            id: "p".into(),
            dir: "/p".into(),
            transcript: "/p/t".into(),
            meta: "/p/m".into(),
        }
    }

    fn deps(store: &Arc<FakeStore>, run: Arc<dyn SubagentRun>) -> SubagentDeps {
        SubagentDeps {
            store: Arc::clone(store) as Arc<dyn SubagentStore>,
            run,
        }
    }

    #[tokio::test]
    async fn a_delegation_is_refused_in_the_documented_order() {
        let store = FakeStore::with(0, Some("ok"));
        let first_deps = deps(&store, Recorder::new(Arc::clone(&store)));
        let active = Mutex::new(HashSet::new());
        let parent = parent_handle();

        let no_parent = delegate_subagent(
            &first_deps,
            None,
            "do it",
            SubagentLimits::default(),
            None,
            &active,
        )
        .await
        .unwrap_err();
        assert_eq!(no_parent.code, SubagentErrorCode::SubagentNoSession);

        let blank = delegate_subagent(
            &first_deps,
            Some(&parent),
            "   ",
            SubagentLimits::default(),
            None,
            &active,
        )
        .await
        .unwrap_err();
        assert_eq!(blank.code, SubagentErrorCode::SubagentEmptyPrompt);

        let deep_store = FakeStore::with(2, Some("ok"));
        let deep_deps = deps(&deep_store, Recorder::new(Arc::clone(&deep_store)));
        let deep = delegate_subagent(
            &deep_deps,
            Some(&parent),
            "do it",
            SubagentLimits {
                max_depth: Some(2),
                max_active: None,
            },
            None,
            &active,
        )
        .await
        .unwrap_err();
        assert_eq!(deep.code, SubagentErrorCode::SubagentDepthExceeded);
        assert!(deep.message.contains("maxDepth 2"));

        active.lock().unwrap().insert("p".into());
        let busy = delegate_subagent(
            &first_deps,
            Some(&parent),
            "do it",
            SubagentLimits {
                max_depth: None,
                max_active: Some(1),
            },
            None,
            &active,
        )
        .await
        .unwrap_err();
        assert_eq!(busy.code, SubagentErrorCode::SubagentBusy);
        assert!(
            store.created().is_empty(),
            "no child was made for any refusal"
        );
    }

    #[tokio::test]
    async fn a_delegation_creates_the_child_session_and_returns_its_last_round() {
        let store = FakeStore::with(0, Some("child answer"));
        let recorder = Recorder::new(Arc::clone(&store));
        let deps = deps(&store, Arc::clone(&recorder) as Arc<dyn SubagentRun>);
        let active = Mutex::new(HashSet::new());
        let result = delegate_subagent(
            &deps,
            Some(&parent_handle()),
            "  do it  ",
            SubagentLimits::default(),
            None,
            &active,
        )
        .await
        .unwrap();

        assert_eq!(result.child_session, "child");
        assert_eq!(result.text, "child answer");
        assert_eq!(result.depth, 1);

        let created = store.created();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].parent_session.as_deref(), Some("p"));
        assert_eq!(created[0].origin.as_deref(), Some("subagent"));
        assert_eq!(created[0].delegation_depth, Some(1));
        assert_eq!(created[0].cwd, Some(std::path::PathBuf::from("/parent")));
        assert_eq!(created[0].endpoint.as_deref(), Some("scripted"));
        assert_eq!(created[0].model.as_deref(), Some("m"));
        assert_eq!(
            store.inherited(),
            [("p".to_owned(), "child".to_owned())],
            "the parent's recorded mode is copied to the child"
        );
        assert_eq!(
            recorder.seen(),
            [("child".to_owned(), "do it".to_owned(), false)],
            "the child got the trimmed prompt and the parent's stop"
        );
        assert!(
            active.lock().unwrap().is_empty(),
            "the in-flight entry was released"
        );
    }

    #[tokio::test]
    async fn an_empty_answer_is_subagent_failed() {
        let store = FakeStore::with(0, None);
        let deps = deps(&store, Recorder::new(Arc::clone(&store)));
        let active = Mutex::new(HashSet::new());
        let error = delegate_subagent(
            &deps,
            Some(&parent_handle()),
            "do it",
            SubagentLimits::default(),
            None,
            &active,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, SubagentErrorCode::SubagentFailed);
        assert!(error.message.contains("no assistant output"));
        assert!(active.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_parent_stop_reaches_the_child_and_a_failure_releases_the_slot() {
        let store = FakeStore::with(0, Some("ok"));
        let recorder = Recorder::failing(Arc::clone(&store));
        let deps = deps(&store, Arc::clone(&recorder) as Arc<dyn SubagentRun>);
        let active = Mutex::new(HashSet::new());
        let token = CancellationToken::new();
        let error = delegate_subagent(
            &deps,
            Some(&parent_handle()),
            "do it",
            SubagentLimits::default(),
            Some(token.clone()),
            &active,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, SubagentErrorCode::SubagentFailed);
        assert!(recorder.seen()[0].2, "the stop reached the child");
        assert!(
            active.lock().unwrap().is_empty(),
            "a failed delegation does not leave the parent marked busy"
        );
    }

    fn delegate_call(
        deps: SubagentDeps,
        limits: SubagentLimits,
        args: serde_json::Value,
        parent: Option<SessionHandle>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = heddle_tools::ToolResult>>> {
        let tools = subagent_tools(deps, limits);
        let tool = tools.into_iter().next().unwrap();
        let mut context = ToolContext::new("/w");
        if let Some(parent) = parent {
            context = context.with_session(parent);
        }
        let context = ToolRunContext::new(context, SandboxMode::WorkspaceWrite);
        let args = args.as_object().cloned().unwrap_or_default();
        Box::pin(async move { tool.run(args, context).await.unwrap() })
    }

    #[tokio::test]
    async fn the_delegate_tool_names_the_child_and_carries_the_data() {
        let store = FakeStore::with(0, Some("child answer"));
        let deps = deps(&store, Recorder::new(Arc::clone(&store)));
        let result = delegate_call(
            deps,
            SubagentLimits::default(),
            serde_json::json!({ "prompt": "do it" }),
            Some(parent_handle()),
        )
        .await;
        assert_eq!(
            result.output,
            "child child (depth 1) answered:\nchild answer"
        );
        let data = result
            .data
            .expect("the result carries the delegation facts");
        assert_eq!(data["childSession"], "child");
        assert_eq!(data["depth"], 1);
        assert_eq!(data["text"], "child answer");
    }

    #[tokio::test]
    async fn the_delegate_tool_reports_a_refusal_by_its_code() {
        let store = FakeStore::with(0, Some("ok"));
        let deps = deps(&store, Recorder::new(Arc::clone(&store)));
        let result = delegate_call(
            deps,
            SubagentLimits::default(),
            serde_json::json!({ "prompt": "  " }),
            Some(parent_handle()),
        )
        .await;
        assert_eq!(result.error.as_ref().unwrap().code, "SUBAGENT_EMPTY_PROMPT");
    }

    #[tokio::test]
    async fn the_delegate_tool_refuses_a_call_with_no_session() {
        let store = FakeStore::with(0, Some("ok"));
        let deps = deps(&store, Recorder::new(Arc::clone(&store)));
        let result = delegate_call(
            deps,
            SubagentLimits::default(),
            serde_json::json!({ "prompt": "do it" }),
            None,
        )
        .await;
        assert_eq!(result.error.unwrap().code, "SUBAGENT_NO_SESSION");
    }

    // ---- The production runner. ----

    struct NoEndpoint;

    impl ModelPort for NoEndpoint {
        fn stream(
            &self,
            _: GenerateRequest,
            _: Option<CancellationToken>,
        ) -> futures::stream::BoxStream<'static, Result<Chunk, ModelError>> {
            Box::pin(futures::stream::empty())
        }

        fn default_endpoint(&self) -> Option<String> {
            None
        }
    }

    /// Nothing below is reached: the runner fails on the missing endpoint before any of it is asked for.
    struct Unused;

    impl SessionPort for Unused {
        fn count(&self, _: &SessionHandle) -> usize {
            unreachable!("the runner never reaches the session")
        }
        fn user_content(
            &self,
            _: &SessionHandle,
            _: Vec<ContentPart>,
            _: Option<serde_json::Value>,
        ) -> Result<(), PortError> {
            unreachable!()
        }
        fn surface(&self, _: &SessionHandle) -> SurfaceView {
            unreachable!()
        }
        fn node_role(&self, _: &SessionHandle, _: u64) -> Option<Role> {
            unreachable!()
        }
        fn folder(&self, _: &SessionHandle) -> Option<std::path::PathBuf> {
            unreachable!()
        }
        fn model_request(
            &self,
            _: &SessionHandle,
            _: &crate::ports::ModelRequestRecord,
        ) -> Result<(), PortError> {
            unreachable!()
        }
        fn assistant_chunk(&self, _: &SessionHandle, _: &Chunk) -> Result<(), PortError> {
            unreachable!()
        }
        fn message(&self, _: &SessionHandle, _: Message) -> Result<(), PortError> {
            unreachable!()
        }
        fn append(
            &self,
            _: &SessionHandle,
            _: &str,
            _: serde_json::Map<String, serde_json::Value>,
        ) -> Result<(), PortError> {
            unreachable!()
        }
    }

    impl ContextPort for Unused {
        fn record_runtime_context(
            &self,
            _: &SessionHandle,
            _: &[crate::upstream::RuntimeContextSection],
        ) -> Result<(), PortError> {
            unreachable!()
        }
        fn prepare<'a>(
            &'a self,
            _: &'a SessionHandle,
            _: PrepareOptions,
        ) -> BoxFuture<'a, Result<ContextReport, PortError>> {
            unreachable!()
        }
        fn assemble(
            &self,
            _: &SessionHandle,
            _: PrepareOptions,
        ) -> Result<ContextReport, PortError> {
            unreachable!()
        }
    }

    struct AllowAll;
    impl heddle_tools::ApprovalGate for AllowAll {
        fn check(&self, _: &str) -> ApprovalDecision {
            ApprovalDecision {
                allowed: true,
                mode: heddle_tools::ApprovalMode::Allow,
                reason: None,
            }
        }
        fn escalate<'a>(
            &'a self,
            request: heddle_tools::EscalationRequest,
        ) -> BoxFuture<'a, Result<SandboxMode, heddle_tools::EscalationError>> {
            Box::pin(async move { Ok(request.effective_mode) })
        }
    }

    struct FlatSandbox;
    impl SandboxGate for FlatSandbox {
        fn workspace_root(&self) -> &std::path::Path {
            std::path::Path::new("/w")
        }
        fn default_mode(&self) -> SandboxMode {
            SandboxMode::WorkspaceWrite
        }
        fn escalation_targets(&self) -> Vec<SandboxMode> {
            Vec::new()
        }
        fn policy(&self, mode: SandboxMode) -> serde_json::Value {
            serde_json::json!({ "mode": mode })
        }
        fn policy_statement(&self, mode: SandboxMode) -> String {
            format!("sandbox: {mode}")
        }
        fn assert_writable(
            &self,
            path: &str,
            _: SandboxMode,
        ) -> Result<std::path::PathBuf, SandboxDenial> {
            Ok(std::path::PathBuf::from(path))
        }
        fn assert_readable(
            &self,
            path: &str,
            _: SandboxMode,
        ) -> Result<std::path::PathBuf, SandboxDenial> {
            Ok(std::path::PathBuf::from(path))
        }
        fn confine(
            &self,
            _: &[String],
            mode: SandboxMode,
        ) -> Result<ConfinedArgv, SandboxUnavailable> {
            Err(SandboxUnavailable { mode, detail: None })
        }
        fn classify_outcome(&self, _: i32, _: &str, _: Option<&ConfinedArgv>) -> SandboxOutcome {
            SandboxOutcome::Exited
        }
    }

    #[tokio::test]
    async fn the_runner_refuses_a_runtime_with_no_endpoint() {
        let runtime = Arc::new(crate::turn::AgentRuntime {
            model: Arc::new(NoEndpoint),
            session: Arc::new(Unused),
            context: Arc::new(Unused),
            tools: Arc::new(ToolRegistry::new(ToolGates {
                approvals: Arc::new(AllowAll),
                sandbox: Arc::new(FlatSandbox),
                modes: Arc::new(DefaultModes),
                hooks: Arc::new(NoToolHooks),
            })),
            hooks: Arc::new(crate::ports::NoTurnHooks),
            turns: None,
        });
        let runner = subagent_runner(Arc::downgrade(&runtime));
        let error = runner
            .run(&parent_handle(), "do it".into(), None)
            .await
            .unwrap_err();
        assert_eq!(error.code, SubagentErrorCode::SubagentFailed);
        assert!(error.message.contains("no endpoint"), "{}", error.message);
    }
}
