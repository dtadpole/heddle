//! Subagent delegation: a parent turn asks for a child agent, the child runs in its **own session**, and
//! its final answer comes back as the parent's tool result.
//!
//! Ported from `src/agent/subagent.ts`, `src/tools/subagent.ts` and `src/plugins/subagent-tool.ts`. The
//! child is a session with `parentSession`, `origin: "subagent"` and `delegationDepth` in its metadata; the
//! parent's transcript sees only the `delegate` call and its result; depth and active limits belong to the
//! runtime, not to the tool's description, so a prompt cannot talk a model past them.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use heddle_tools::{Tool, ToolArgs, ToolResult, ToolRunContext, ToolSpec, tool_fn};

use crate::ports::PortError;
use crate::turn::{AgentRuntime, RunTurnOptions, run_turn};
use crate::upstream::{
    ContentPart, CreateSession, SandboxMode, SessionEvent, SessionHandle, SessionMeta,
};

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

impl SubagentConfig {
    /// The `subagent-tool` row's configuration: an absent row config (`null`) is every default, and an unknown
    /// key is refused naming itself.
    pub fn from_row(config: &serde_json::Value) -> Result<Self, serde_json::Error> {
        if config.is_null() {
            return Ok(Self::default());
        }
        serde_json::from_value(config.clone())
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
    /// Write a user message into `session` and return its `seq`: a settlement notice written into a parent's
    /// running turn. The default refuses, for a store that only creates and reads children.
    fn user_message(
        &self,
        session: &SessionHandle,
        content: Vec<ContentPart>,
        source: Option<serde_json::Value>,
    ) -> Result<u64, PortError> {
        let _ = (session, content, source);
        Err(PortError("this store cannot write a message".to_owned()))
    }
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

/// A child created and admitted: what both delegation paths start from.
struct OpenedChild {
    parent: SessionHandle,
    child: SessionHandle,
    prompt: String,
    depth: u32,
}

/// The checks and the child session every delegation starts with, blocking or in the background.
///
/// Refused, in this order: no parent session, a blank prompt, a chain beyond `max_depth`, or `in_flight`
/// children already at `max_active`. The child is created in the parent's folder (the process's current
/// directory when unrecorded) with the parent's endpoint, model, reasoning level and agent preset, and inherits the
/// parent's recorded mode. One function, so the two paths cannot drift apart in what they refuse (`openChild`).
fn open_child(
    store: &dyn SubagentStore,
    parent: Option<&SessionHandle>,
    prompt: &str,
    limits: SubagentLimits,
    in_flight: usize,
) -> Result<OpenedChild, SubagentError> {
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

    let parent_meta = store.meta(&parent.id);
    let facts = parent_facts(parent_meta.as_ref());
    let child_depth = facts.depth + 1;
    let max_depth = limits.max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
    if child_depth > max_depth {
        return Err(SubagentError::new(
            SubagentErrorCode::SubagentDepthExceeded,
            format!("subagent depth {child_depth} exceeds maxDepth {max_depth}"),
        ));
    }
    // The limit is on children in flight, enforced here rather than in the tool so no caller bypasses it.
    let max_active = limits.max_active.unwrap_or(DEFAULT_MAX_ACTIVE);
    if in_flight >= max_active {
        return Err(SubagentError::new(
            SubagentErrorCode::SubagentBusy,
            format!("already running {in_flight} subagent(s); maxActive is {max_active}"),
        ));
    }

    let cwd = parent_meta
        .as_ref()
        .and_then(|meta| meta.cwd.clone())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let child = store
        .create(CreateSession {
            cwd: Some(cwd),
            endpoint: facts.endpoint.clone(),
            model: facts.model.clone(),
            reasoning_effort: facts.reasoning_effort.clone(),
            parent_session: Some(parent.id.clone()),
            origin: Some("subagent".to_owned()),
            delegation_depth: Some(child_depth),
            // A child runs under its parent's agent preset (inventory A96), for the same reason it inherits the mode: a
            // session narrowed to a preset's tools cannot widen itself by delegating to a child that has every tool.
            preset: parent_meta.as_ref().and_then(|meta| meta.preset.clone()),
            ..CreateSession::default()
        })
        .map_err(|error| {
            SubagentError::new(SubagentErrorCode::SubagentFailed, error.to_string())
        })?;
    // Delegation inherits the parent's mode, so a narrowed session cannot widen itself by spawning a child.
    store
        .inherit_recorded_mode(parent, &child)
        .map_err(|error| {
            SubagentError::new(SubagentErrorCode::SubagentFailed, error.to_string())
        })?;
    Ok(OpenedChild {
        parent: parent.clone(),
        child,
        prompt: prompt.to_owned(),
        depth: child_depth,
    })
}

/// Delegate one prompt to a child agent and **wait** for its answer.
///
/// The blocking primitive: the model-facing tool no longer uses it (a delegation starts a background child,
/// see [`SubagentService`]), but a caller that needs the answer in hand can still drive one child to
/// completion. The refusals are [`open_child`]'s; the child runs with the caller's `cancel`.
///
/// `active` is the caller's set of parents with a child in flight; the limit counts its entries.
pub async fn delegate_subagent(
    deps: &SubagentDeps,
    parent: Option<&SessionHandle>,
    prompt: &str,
    limits: SubagentLimits,
    cancel: Option<CancellationToken>,
    active: &Mutex<HashSet<String>>,
) -> Result<SubagentResult, SubagentError> {
    let in_flight = active.lock().unwrap().len();
    let opened = open_child(deps.store.as_ref(), parent, prompt, limits, in_flight)?;
    // Counted as in flight while the child runs, and released however the delegation ends.
    let _in_flight = ActiveGuard::enter(active, &opened.parent.id);
    deps.run
        .run(&opened.child, opened.prompt.clone(), cancel)
        .await?;

    let answer = final_assistant_text(&deps.store.read(&opened.child));
    if answer.is_empty() {
        return Err(SubagentError::new(
            SubagentErrorCode::SubagentFailed,
            "the child agent produced no assistant output",
        ));
    }
    Ok(SubagentResult {
        child_session: opened.child.id,
        text: answer,
        depth: opened.depth,
    })
}

/// Counts one parent as having a child in flight until it is dropped, whichever way the delegation ends.
struct ActiveGuard<'a> {
    active: &'a Mutex<HashSet<String>>,
    parent: String,
}

impl<'a> ActiveGuard<'a> {
    /// Register `parent` as having a child in flight.
    fn enter(active: &'a Mutex<HashSet<String>>, parent: &str) -> Self {
        active.lock().unwrap().insert(parent.to_owned());
        Self {
            active,
            parent: parent.to_owned(),
        }
    }
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
            // A child's turn is tagged, so a scripted check can give the child a script of its own.
            options.purpose = Some("subagent".to_owned());
            run_turn(&runtime, options).await.map_err(|error| {
                SubagentError::new(SubagentErrorCode::SubagentFailed, error.to_string())
            })?;
            Ok(())
        })
    }
}

/// A [`SubagentRun`] bound to the agent runtime once it exists.
///
/// The `subagent-tool` row registers `delegate` while the tree boots, but a child turn runs on the
/// [`AgentRuntime`], which is composed from the booted rows afterwards — the TypeScript plugin reaches the agent
/// service lazily for the same reason. The row hands this runner to the tool, and the boot calls [`Self::bind`]
/// once the runtime exists. A delegation before then is refused as `SUBAGENT_FAILED`, naming why.
#[derive(Default)]
pub struct LateSubagentRunner {
    runtime: std::sync::OnceLock<Weak<AgentRuntime>>,
}

impl LateSubagentRunner {
    /// A runner with no runtime yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind the runtime child turns run on. `false` when one was bound already; the first binding stays.
    pub fn bind(&self, runtime: &Arc<AgentRuntime>) -> bool {
        self.runtime.set(Arc::downgrade(runtime)).is_ok()
    }
}

impl SubagentRun for LateSubagentRunner {
    fn run<'a>(
        &'a self,
        child: &'a SessionHandle,
        prompt: String,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'a, Result<(), SubagentError>> {
        Box::pin(async move {
            let Some(runtime) = self.runtime.get() else {
                return Err(SubagentError::new(
                    SubagentErrorCode::SubagentFailed,
                    "the agent runtime is not composed yet",
                ));
            };
            RuntimeRunner {
                runtime: runtime.clone(),
            }
            .run(child, prompt, cancel)
            .await
        })
    }
}

/// The whole `subagent-tool` row: its configuration read, and its `delegate` tool registered into `registry`
/// over a [`SubagentService`] built from the session store, `runner` (bind it to the runtime after boot) and
/// `deliver`. Returns the service, which a one-shot host settles before it prints its answer.
///
/// Fails, naming the reason, when the configuration has an unknown key or a tool of the same name cannot be
/// registered.
pub fn register_subagent_row(
    registry: &heddle_tools::ToolRegistry,
    config: &serde_json::Value,
    store: Arc<dyn SubagentStore>,
    runner: Arc<LateSubagentRunner>,
    deliver: Arc<dyn SubagentDeliver>,
) -> Result<Arc<SubagentService>, String> {
    let config =
        SubagentConfig::from_row(config).map_err(|error| format!("subagent-tool: {error}"))?;
    let deps = SubagentDeps { store, run: runner };
    let service = SubagentService::new(deps, deliver, config.into());
    for tool in subagent_tools(Arc::clone(&service)) {
        registry
            .register(tool)
            .map_err(|error| format!("subagent-tool: {error}"))?;
    }
    Ok(service)
}

/// How a background child's run ended, in DSH's settlement vocabulary (`dsh-subagent` stop reasons).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentStopReason {
    /// The child's turn ended normally.
    Completed,
    /// The child was stopped.
    Aborted,
    /// The child's turn failed.
    Error,
}

/// The opening line of a settlement notice, DSH's `settlementSummary` word for word.
///
/// A delegate child is one-shot: it takes no follow-up message (heddle's continuable child is the teammate), so
/// a completed child is worded as DSH words a child that cannot receive more.
pub fn settlement_summary(child_id: &str, stop: SubagentStopReason) -> String {
    let subject = format!("Background subagent {child_id}");
    match stop {
        SubagentStopReason::Completed => {
            format!("{subject} finished. It cannot receive follow-up messages.")
        }
        SubagentStopReason::Aborted => format!("{subject} was stopped before it finished."),
        SubagentStopReason::Error => format!("{subject} failed before it finished."),
    }
}

/// A settled child's report to its parent: the user-role message DSH's runtime delivers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettlementNotice {
    /// The message's text blocks, in order.
    pub texts: Vec<String>,
    /// The summary line, also carried in the source.
    pub summary: String,
    /// The child that settled.
    pub sender_session_id: String,
}

impl SettlementNotice {
    /// The message's `source`: `{ kind: 'subagent-settled', form: 'notice', summary, senderSessionId }`.
    pub fn source(&self) -> serde_json::Value {
        serde_json::json!({
            "kind": "subagent-settled",
            "form": "notice",
            "summary": self.summary,
            "senderSessionId": self.sender_session_id,
        })
    }

    /// The text blocks as content parts.
    pub fn parts(&self) -> Vec<ContentPart> {
        self.texts.iter().cloned().map(ContentPart::text).collect()
    }
}

/// The settlement notice, shaped as DSH's `createSettlementMessage`: the summary line, then
/// `Its closing message:` and the child's closing text, or `It left no closing message.` when it has none, then
/// any diagnostic.
pub fn settlement_notice(
    child_id: &str,
    stop: SubagentStopReason,
    closing_text: &str,
    diagnostic: Option<&str>,
) -> SettlementNotice {
    let summary = settlement_summary(child_id, stop);
    let closing = closing_text.trim();
    let mut texts = vec![summary.clone()];
    if closing.is_empty() {
        texts.push("It left no closing message.".to_owned());
    } else {
        texts.push("Its closing message:".to_owned());
        texts.push(closing.to_owned());
    }
    if let Some(diagnostic) = diagnostic.filter(|text| !text.is_empty()) {
        texts.push(diagnostic.to_owned());
    }
    SettlementNotice {
        texts,
        summary,
        sender_session_id: child_id.to_owned(),
    }
}

/// Hands a settled child's notice to its parent. Production uses [`subagent_deliverer`]; a test passes a
/// recorder.
pub trait SubagentDeliver: Send + Sync {
    /// Deliver `notice` to `parent`. Resolves once the parent has it **and** has answered it, so a host that
    /// waits for its children (a one-shot CLI) also waits for the turn the notice started.
    fn deliver<'a>(
        &'a self,
        parent: &'a SessionHandle,
        notice: SettlementNotice,
    ) -> BoxFuture<'a, Result<(), SubagentError>>;
}

/// What [`SubagentService::start`] hands back at once: the child's id and depth, never its answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedSubagent {
    /// The child's session id.
    pub child_session: String,
    /// Its delegation depth.
    pub depth: u32,
}

#[derive(Default)]
struct ServiceState {
    /// Children in flight, by id; the active limit counts these.
    in_flight: HashSet<String>,
    /// Per session, how many of its children are still running or still being reported.
    pending: HashMap<String, usize>,
    /// Per parent session, notices delivered.
    delivered: HashMap<String, usize>,
}

/// Background delegation, DSH's managed activation: [`start`](Self::start) creates the child and returns at
/// once, the child runs its turn on its own task, and when it settles its parent receives a settlement notice
/// through [`SubagentDeliver`].
///
/// [`settle`](Self::settle) answers the question a headless host asks before it prints an answer — is any child
/// of this session still working, or any notice still being answered? — the analogue of DSH's `waitForChildren`
/// loop (`SubagentService` in the TypeScript build).
pub struct SubagentService {
    deps: SubagentDeps,
    deliver: Arc<dyn SubagentDeliver>,
    limits: SubagentLimits,
    state: Mutex<ServiceState>,
    changed: tokio::sync::Notify,
}

impl SubagentService {
    /// A service with nothing in flight.
    pub fn new(
        deps: SubagentDeps,
        deliver: Arc<dyn SubagentDeliver>,
        limits: SubagentLimits,
    ) -> Arc<Self> {
        Arc::new(Self {
            deps,
            deliver,
            limits,
            state: Mutex::new(ServiceState::default()),
            changed: tokio::sync::Notify::new(),
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ServiceState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Children of every parent currently in flight.
    pub fn running(&self) -> usize {
        self.state().in_flight.len()
    }

    /// Start one child and return at once.
    ///
    /// The refusals are [`open_child`]'s and come back before anything runs. The child's turn takes `cancel`, so
    /// a parent that is stopped stops its children too, as DSH's session stop cancels its descendants. Must be
    /// called inside a Tokio runtime: the child runs on a spawned task.
    pub fn start(
        self: &Arc<Self>,
        parent: Option<&SessionHandle>,
        prompt: &str,
        cancel: Option<CancellationToken>,
    ) -> Result<StartedSubagent, SubagentError> {
        let in_flight = self.state().in_flight.len();
        let opened = open_child(
            self.deps.store.as_ref(),
            parent,
            prompt,
            self.limits,
            in_flight,
        )?;
        {
            let mut state = self.state();
            state.in_flight.insert(opened.child.id.clone());
            *state.pending.entry(opened.parent.id.clone()).or_default() += 1;
        }
        let started = StartedSubagent {
            child_session: opened.child.id.clone(),
            depth: opened.depth,
        };
        let service = Arc::clone(self);
        tokio::spawn(async move { service.run_in_background(opened, cancel).await });
        Ok(started)
    }

    /// Wait until no child of `session_id` is running and every notice it was sent has been answered; the
    /// number of notices delivered to it so far. Work started while waiting (a notice's turn starting another
    /// child) is waited for too.
    pub async fn settle(&self, session_id: &str) -> usize {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let state = self.state();
                if state.pending.get(session_id).copied().unwrap_or(0) == 0 {
                    return state.delivered.get(session_id).copied().unwrap_or(0);
                }
            }
            notified.await;
        }
    }

    async fn run_in_background(
        self: Arc<Self>,
        opened: OpenedChild,
        cancel: Option<CancellationToken>,
    ) {
        // Released however this ends, so a panicking child cannot leave its parent waiting for ever.
        let _pending = PendingGuard {
            service: Arc::clone(&self),
            session: opened.parent.id.clone(),
        };
        let outcome = self
            .deps
            .run
            .run(&opened.child, opened.prompt.clone(), cancel.clone())
            .await;
        let cancelled = cancel.as_ref().is_some_and(CancellationToken::is_cancelled);
        let (stop, diagnostic) = match outcome {
            Ok(()) => {
                // A child settles only after its own children have, so its closing text is final (DSH closes
                // admission after owned descendants finish).
                self.settle(&opened.child.id).await;
                let stop = if cancelled {
                    SubagentStopReason::Aborted
                } else {
                    SubagentStopReason::Completed
                };
                (stop, None)
            }
            Err(error) => {
                let stop = if cancelled {
                    SubagentStopReason::Aborted
                } else {
                    SubagentStopReason::Error
                };
                (stop, Some(error.message))
            }
        };
        self.state().in_flight.remove(&opened.child.id);
        let closing = final_assistant_text(&self.deps.store.read(&opened.child));
        let notice = settlement_notice(&opened.child.id, stop, &closing, diagnostic.as_deref());
        let delivered = self.deliver.deliver(&opened.parent, notice).await.is_ok();
        if delivered {
            *self
                .state()
                .delivered
                .entry(opened.parent.id.clone())
                .or_default() += 1;
        }
    }
}

impl std::fmt::Debug for SubagentService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SubagentService")
            .field("running", &self.running())
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

/// Counts one child of `session` as pending until dropped, then wakes whoever is settling.
struct PendingGuard {
    service: Arc<SubagentService>,
    session: String,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        {
            let mut state = self.service.state();
            if let Some(count) = state.pending.get_mut(&self.session) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    state.pending.remove(&self.session);
                }
            }
        }
        self.service.changed.notify_waiters();
    }
}

/// Did the session's model see the event at `seq`? True once a model request follows it.
fn answered_after(events: &[SessionEvent], seq: u64) -> bool {
    events
        .iter()
        .any(|event| event.seq > seq && event.kind == "model/request")
}

/// The production [`SubagentDeliver`]: a notice reaches its parent the way team mail reaches a member.
///
/// Written into a **running** turn, which notices new input between rounds (DSH's steering), or, when the parent
/// is idle, as the prompt of a new parent turn tagged `subagent-notice`. The loop's last look for new input comes
/// just before it ends, so a notice written in that window would sit unanswered; the deliverer waits for the
/// parent to go idle ([`TurnRegistry::when_idle`](crate::TurnRegistry::when_idle)), checks, and answers it with a
/// turn of its own (`answer_pending`) if the ending turn missed it. Deliveries to one parent run one at a time.
/// Holds the runtime weakly, as [`subagent_runner`] does.
pub fn subagent_deliverer(
    runtime: Weak<AgentRuntime>,
    store: Arc<dyn SubagentStore>,
) -> Arc<dyn SubagentDeliver> {
    Arc::new(RuntimeDeliverer {
        runtime,
        store,
        lanes: Mutex::new(HashMap::new()),
    })
}

struct RuntimeDeliverer {
    runtime: Weak<AgentRuntime>,
    store: Arc<dyn SubagentStore>,
    /// One lane per parent, so two notices to one parent are delivered in turn.
    lanes: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl SubagentDeliver for RuntimeDeliverer {
    fn deliver<'a>(
        &'a self,
        parent: &'a SessionHandle,
        notice: SettlementNotice,
    ) -> BoxFuture<'a, Result<(), SubagentError>> {
        Box::pin(async move {
            let lane = {
                let mut lanes = self
                    .lanes
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                Arc::clone(lanes.entry(parent.id.clone()).or_default())
            };
            let _turn = lane.lock().await;
            let runtime = self.runtime.upgrade().ok_or_else(|| {
                SubagentError::new(
                    SubagentErrorCode::SubagentFailed,
                    "the agent runtime is gone",
                )
            })?;
            let running = runtime
                .turns
                .as_ref()
                .is_some_and(|turns| turns.is_running(&parent.id));
            if running {
                let seq = self
                    .store
                    .user_message(parent, notice.parts(), Some(notice.source()))
                    .map_err(|error| {
                        SubagentError::new(SubagentErrorCode::SubagentFailed, error.to_string())
                    })?;
                if let Some(turns) = &runtime.turns {
                    turns.when_idle(&parent.id).await;
                }
                if answered_after(&self.store.read(parent), seq) {
                    return Ok(());
                }
                return self.wake(&runtime, parent, &notice, true).await;
            }
            self.wake(&runtime, parent, &notice, false).await
        })
    }
}

impl RuntimeDeliverer {
    async fn wake(
        &self,
        runtime: &Arc<AgentRuntime>,
        parent: &SessionHandle,
        notice: &SettlementNotice,
        answer_pending: bool,
    ) -> Result<(), SubagentError> {
        let meta = self.store.meta(&parent.id);
        let endpoint = meta
            .as_ref()
            .and_then(|meta| meta.endpoint.clone())
            .or_else(|| runtime.model.default_endpoint())
            .ok_or_else(|| {
                SubagentError::new(
                    SubagentErrorCode::SubagentFailed,
                    "no endpoint is configured for the parent's turn",
                )
            })?;
        let mut texts = notice.texts.iter().cloned();
        let first = texts.next().unwrap_or_else(|| notice.summary.clone());
        let mut options = RunTurnOptions::new(parent.clone(), endpoint, first);
        options.attachments = texts.map(ContentPart::text).collect();
        options.source = Some(notice.source());
        // A turn a notice started, distinguishable by a backend that cares, as a teammate's turn is (`team`).
        options.purpose = Some("subagent-notice".to_owned());
        options.model = meta.and_then(|meta| meta.model);
        options.answer_pending = answer_pending;
        run_turn(runtime, options)
            .await
            .map(|_| ())
            .map_err(|error| {
                SubagentError::new(SubagentErrorCode::SubagentFailed, error.to_string())
            })
    }
}

/// The model-facing `delegate` tool, modelled on DSH's `dsh-tool-subagent`: one call starts one child agent in
/// the background and returns **at once** with `started subagent <id>` (DSH's start result word for word, with
/// `data: { childSession, depth, kind: 'activation' }`); the child's closing message reaches the parent later as
/// a settlement notice. A refusal is a result with the [`SubagentErrorCode`] as its code.
pub fn subagent_tools(service: Arc<SubagentService>) -> Vec<Arc<dyn Tool>> {
    let spec = ToolSpec {
        name: "delegate".to_owned(),
        description: "Start one task in a child agent that works in its own session. Returns at once with the child id; the child’s final answer arrives later in this conversation as a notice. Use it for a scoped piece of work that benefits from a fresh context; the child sees only the prompt you give it, not this conversation.".to_owned(),
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
        let service = Arc::clone(&service);
        Box::pin(async move {
            let prompt = args
                .get("prompt")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            match service.start(context.session.as_ref(), prompt, context.cancel.clone()) {
                Ok(started) => {
                    let data = serde_json::Map::from_iter([
                        (
                            "childSession".to_owned(),
                            serde_json::json!(started.child_session),
                        ),
                        ("depth".to_owned(), serde_json::json!(started.depth)),
                        ("kind".to_owned(), serde_json::json!("activation")),
                    ]);
                    Ok(
                        ToolResult::ok(format!("started subagent {}", started.child_session))
                            .with_data(data),
                    )
                }
                Err(error) => Ok(ToolResult::refused(error.code.as_str(), error.message)),
            }
        })
    });
    // Returns at once with the child's id, so two delegates of one step start together (DSH's subagent spawn).
    vec![heddle_tools::parallel_safe(tool)]
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
    fn the_settlement_notice_is_dsh_s_words_for_each_ending() {
        let done = settlement_notice("c1", SubagentStopReason::Completed, "  the answer  ", None);
        assert_eq!(
            done.texts,
            vec![
                "Background subagent c1 finished. It cannot receive follow-up messages.".to_owned(),
                "Its closing message:".to_owned(),
                "the answer".to_owned(),
            ]
        );
        assert_eq!(
            done.source(),
            serde_json::json!({
                "kind": "subagent-settled",
                "form": "notice",
                "summary": "Background subagent c1 finished. It cannot receive follow-up messages.",
                "senderSessionId": "c1",
            })
        );
        assert_eq!(
            settlement_notice("c2", SubagentStopReason::Completed, "", None).texts[1],
            "It left no closing message."
        );
        assert_eq!(
            settlement_summary("c3", SubagentStopReason::Error),
            "Background subagent c3 failed before it finished."
        );
        assert_eq!(
            settlement_summary("c4", SubagentStopReason::Aborted),
            "Background subagent c4 was stopped before it finished."
        );
        let failed = settlement_notice(
            "c5",
            SubagentStopReason::Error,
            "",
            Some("the model went away"),
        );
        assert_eq!(
            failed.texts.last().unwrap(),
            "the model went away",
            "a diagnostic closes the notice"
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

    /// Writes the child's answer into its log through the real store, as a child turn would.
    struct StoreAnswer {
        sessions: Arc<heddle_session::SessionService>,
    }

    impl SubagentRun for StoreAnswer {
        fn run<'a>(
            &'a self,
            child: &'a SessionHandle,
            _prompt: String,
            _cancel: Option<CancellationToken>,
        ) -> BoxFuture<'a, Result<(), SubagentError>> {
            Box::pin(async move {
                let failed = |error: heddle_session::SessionError| {
                    SubagentError::new(SubagentErrorCode::SubagentFailed, error.to_string())
                };
                let store = self.sessions.store();
                store
                    .assistant_chunk(
                        child,
                        &Chunk::TextDelta {
                            text: "child answer".into(),
                        },
                    )
                    .map_err(failed)?;
                store
                    .assistant_chunk(
                        child,
                        &Chunk::Done {
                            finish_reason: "stop".into(),
                            usage: None,
                        },
                    )
                    .map_err(failed)?;
                Ok(())
            })
        }
    }

    /// Inventory A96 (test/presets.test.ts): a delegated child runs under its parent's preset, through the real store.
    #[tokio::test]
    async fn a_delegated_child_runs_under_its_parents_preset() {
        let (sessions, _sessions_dir) = crate::adapters::tests::sessions_at("child-preset");
        let parent = sessions
            .store()
            .create(heddle_session::CreateOptions {
                preset: Some("reader".into()),
                ..heddle_session::CreateOptions::default()
            })
            .unwrap();
        let deps = SubagentDeps {
            store: Arc::new(crate::adapters::SessionSubagents::new(Arc::clone(
                &sessions,
            ))),
            run: Arc::new(StoreAnswer {
                sessions: Arc::clone(&sessions),
            }),
        };
        let active = Mutex::new(HashSet::new());
        let result = delegate_subagent(
            &deps,
            Some(&parent),
            "look at it",
            SubagentLimits {
                max_depth: Some(2),
                max_active: Some(2),
            },
            None,
            &active,
        )
        .await
        .unwrap();
        assert_eq!(result.text, "child answer");
        assert_eq!(
            sessions
                .meta(&result.child_session)
                .and_then(|meta| meta.preset().map(str::to_owned))
                .as_deref(),
            Some("reader")
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

    /// Records each settlement notice instead of handing it to a parent turn.
    #[derive(Default)]
    struct Notices {
        seen: Mutex<Vec<(String, SettlementNotice)>>,
    }

    impl Notices {
        fn seen(&self) -> Vec<(String, SettlementNotice)> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl SubagentDeliver for Notices {
        fn deliver<'a>(
            &'a self,
            parent: &'a SessionHandle,
            notice: SettlementNotice,
        ) -> BoxFuture<'a, Result<(), SubagentError>> {
            Box::pin(async move {
                self.seen.lock().unwrap().push((parent.id.clone(), notice));
                Ok(())
            })
        }
    }

    fn service_with(
        deps: SubagentDeps,
        limits: SubagentLimits,
    ) -> (Arc<SubagentService>, Arc<Notices>) {
        let notices = Arc::new(Notices::default());
        let service = SubagentService::new(
            deps,
            Arc::clone(&notices) as Arc<dyn SubagentDeliver>,
            limits,
        );
        (service, notices)
    }

    fn delegate_call(
        service: &Arc<SubagentService>,
        args: serde_json::Value,
        parent: Option<SessionHandle>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = heddle_tools::ToolResult>>> {
        let tools = subagent_tools(Arc::clone(service));
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
    async fn the_delegate_tool_answers_the_start_line_and_the_child_reports_by_notice() {
        let store = FakeStore::with(0, Some("child answer"));
        let (service, notices) = service_with(
            deps(&store, Recorder::new(Arc::clone(&store))),
            SubagentLimits::default(),
        );
        let result = delegate_call(
            &service,
            serde_json::json!({ "prompt": "do it" }),
            Some(parent_handle()),
        )
        .await;
        assert_eq!(result.output, "started subagent child", "DSH's start line");
        let data = result
            .data
            .expect("the result carries the delegation facts");
        assert_eq!(data["childSession"], "child");
        assert_eq!(data["depth"], 1);
        assert_eq!(data["kind"], "activation");
        assert!(data.get("text").is_none(), "never the child's answer");

        assert_eq!(service.settle("p").await, 1);
        let seen = notices.seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "p");
        assert_eq!(seen[0].1.texts[2], "child answer");
    }

    /// A child that waits for the test to let it finish, so "returns before the child has answered" is proven by
    /// construction rather than by timing.
    struct GatedChild {
        store: Arc<FakeStore>,
        gate: tokio::sync::Semaphore,
        fail: Option<&'static str>,
    }

    impl GatedChild {
        fn new(store: Arc<FakeStore>, fail: Option<&'static str>) -> Arc<Self> {
            Arc::new(Self {
                store,
                gate: tokio::sync::Semaphore::new(0),
                fail,
            })
        }

        fn release(&self) {
            self.gate.add_permits(1);
        }
    }

    impl SubagentRun for GatedChild {
        fn run<'a>(
            &'a self,
            _child: &'a SessionHandle,
            _prompt: String,
            _cancel: Option<CancellationToken>,
        ) -> BoxFuture<'a, Result<(), SubagentError>> {
            Box::pin(async move {
                let _permit = self.gate.acquire().await;
                if let Some(message) = self.fail {
                    return Err(SubagentError::new(
                        SubagentErrorCode::SubagentFailed,
                        message,
                    ));
                }
                if let Some(answer) = self.store.answer.clone() {
                    self.store.child_events.lock().unwrap().push(event(
                        2,
                        "assistant/completed",
                        serde_json::json!({ "text": answer }),
                    ));
                }
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn a_background_start_returns_before_the_child_has_answered_and_settle_waits_for_its_notice()
     {
        let store = FakeStore::with(0, Some("the answer"));
        let child = GatedChild::new(Arc::clone(&store), None);
        let (service, notices) = service_with(
            deps(&store, Arc::clone(&child) as Arc<dyn SubagentRun>),
            SubagentLimits::default(),
        );
        let started = service.start(Some(&parent_handle()), "work", None).unwrap();
        assert_eq!(
            started,
            StartedSubagent {
                child_session: "child".into(),
                depth: 1
            }
        );
        assert_eq!(
            service.running(),
            1,
            "the child is still in flight when start returns"
        );
        tokio::task::yield_now().await;
        assert!(
            notices.seen().is_empty(),
            "nothing is reported before the child settles"
        );
        let created = store.created();
        assert_eq!(
            created[0].parent_session.as_deref(),
            Some("p"),
            "the child names its parent"
        );
        assert_eq!(created[0].origin.as_deref(), Some("subagent"));

        child.release();
        assert_eq!(
            service.settle("p").await,
            1,
            "settle waits for the child and its notice"
        );
        assert_eq!(service.running(), 0);
        assert_eq!(
            notices.seen()[0].1.texts,
            vec![
                "Background subagent child finished. It cannot receive follow-up messages."
                    .to_owned(),
                "Its closing message:".to_owned(),
                "the answer".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn a_background_start_refuses_synchronously_and_counts_children_in_flight() {
        let store = FakeStore::with(0, Some("ok"));
        let child = GatedChild::new(Arc::clone(&store), None);
        let (service, _) = service_with(
            deps(&store, Arc::clone(&child) as Arc<dyn SubagentRun>),
            SubagentLimits {
                max_depth: Some(2),
                max_active: Some(1),
            },
        );
        let refused = |result: Result<StartedSubagent, SubagentError>| result.unwrap_err().code;
        assert_eq!(
            refused(service.start(None, "x", None)),
            SubagentErrorCode::SubagentNoSession
        );
        assert_eq!(
            refused(service.start(Some(&parent_handle()), "  ", None)),
            SubagentErrorCode::SubagentEmptyPrompt
        );
        service
            .start(Some(&parent_handle()), "first", None)
            .unwrap();
        assert_eq!(
            refused(service.start(Some(&parent_handle()), "second", None)),
            SubagentErrorCode::SubagentBusy,
            "the first child is still in flight"
        );
        child.release();
        service.settle("p").await;
        service
            .start(Some(&parent_handle()), "third", None)
            .unwrap();
        child.release();
        service.settle("p").await;
    }

    #[tokio::test]
    async fn a_failed_child_is_reported_with_its_diagnostic_rather_than_lost() {
        let store = FakeStore::with(0, None);
        let child = GatedChild::new(Arc::clone(&store), Some("the model went away"));
        let (service, notices) = service_with(
            deps(&store, Arc::clone(&child) as Arc<dyn SubagentRun>),
            SubagentLimits::default(),
        );
        service.start(Some(&parent_handle()), "work", None).unwrap();
        child.release();
        service.settle("p").await;
        assert_eq!(
            notices.seen()[0].1.texts,
            vec![
                "Background subagent child failed before it finished.".to_owned(),
                "It left no closing message.".to_owned(),
                "the model went away".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn the_turn_registry_resolves_when_idle_at_the_settle_that_empties_a_session() {
        let registry = crate::TurnRegistry::new();
        registry.when_idle("s1").await;
        let first = registry.begin("s1", None);
        let second = registry.begin("s1", None);
        let waiting = {
            let registry = registry.clone();
            tokio::spawn(async move { registry.when_idle("s1").await })
        };
        first.settle();
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(), "one turn is still in flight");
        second.settle();
        waiting.await.unwrap();
    }

    #[tokio::test]
    async fn the_delegate_tool_reports_a_refusal_by_its_code() {
        let store = FakeStore::with(0, Some("ok"));
        let (service, _) = service_with(
            deps(&store, Recorder::new(Arc::clone(&store))),
            SubagentLimits::default(),
        );
        let result = delegate_call(
            &service,
            serde_json::json!({ "prompt": "  " }),
            Some(parent_handle()),
        )
        .await;
        assert_eq!(result.error.as_ref().unwrap().code, "SUBAGENT_EMPTY_PROMPT");
    }

    #[tokio::test]
    async fn the_delegate_tool_refuses_a_call_with_no_session() {
        let store = FakeStore::with(0, Some("ok"));
        let (service, _) = service_with(
            deps(&store, Recorder::new(Arc::clone(&store))),
            SubagentLimits::default(),
        );
        let result = delegate_call(&service, serde_json::json!({ "prompt": "do it" }), None).await;
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
            presets: None,
        });
        let runner = subagent_runner(Arc::downgrade(&runtime));
        let error = runner
            .run(&parent_handle(), "do it".into(), None)
            .await
            .unwrap_err();
        assert_eq!(error.code, SubagentErrorCode::SubagentFailed);
        assert!(error.message.contains("no endpoint"), "{}", error.message);
    }

    /// A child run that delegates again through the same tool instance, as the scripted double makes the child
    /// replay the parent's script — the case `50-agentic-loop`'s check-subagents relies on the limit to refuse.
    struct DelegatingChild {
        store: Arc<FakeStore>,
        nested: Mutex<Option<SubagentError>>,
        active: Arc<Mutex<HashSet<String>>>,
    }

    impl SubagentRun for DelegatingChild {
        fn run<'a>(
            &'a self,
            child: &'a SessionHandle,
            _prompt: String,
            _cancel: Option<CancellationToken>,
        ) -> BoxFuture<'a, Result<(), SubagentError>> {
            Box::pin(async move {
                // While the parent's delegation is in flight, the child asks for its own.
                let deps = SubagentDeps {
                    store: Arc::clone(&self.store) as Arc<dyn SubagentStore>,
                    run: Recorder::new(Arc::clone(&self.store)),
                };
                let nested = delegate_subagent(
                    &deps,
                    Some(child),
                    "child task",
                    SubagentConfig::default().into(),
                    None,
                    &self.active,
                )
                .await
                .unwrap_err();
                *self.nested.lock().unwrap() = Some(nested);
                let mut events = self.store.child_events.lock().unwrap();
                events.push(event(1, "model/request", serde_json::json!({})));
                events.push(event(
                    2,
                    "assistant/chunk",
                    serde_json::json!({ "chunk": { "type": "text-delta", "text": "child answer" } }),
                ));
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn a_child_that_delegates_while_its_parents_delegation_runs_is_refused_as_busy() {
        let store = FakeStore::with(0, None);
        let active = Arc::new(Mutex::new(HashSet::new()));
        let child_run = Arc::new(DelegatingChild {
            store: Arc::clone(&store),
            nested: Mutex::new(None),
            active: Arc::clone(&active),
        });
        let deps = SubagentDeps {
            store: Arc::clone(&store) as Arc<dyn SubagentStore>,
            run: Arc::clone(&child_run) as Arc<dyn SubagentRun>,
        };
        let result = delegate_subagent(
            &deps,
            Some(&parent_handle()),
            "do it",
            SubagentConfig::default().into(),
            None,
            &active,
        )
        .await
        .unwrap();
        assert_eq!(result.text, "child answer");
        let nested = child_run.nested.lock().unwrap().clone().unwrap();
        assert_eq!(nested.code, SubagentErrorCode::SubagentBusy, "{nested:?}");
        assert_eq!(
            nested.message,
            "already running 1 subagent(s); maxActive is 1"
        );
        assert_eq!(
            store.created().len(),
            1,
            "exactly one child session was made"
        );
        assert!(
            active.lock().unwrap().is_empty(),
            "released after the delegation"
        );
    }

    #[test]
    fn the_rows_configuration_defaults_when_absent_and_refuses_an_unknown_key() {
        assert_eq!(
            SubagentConfig::from_row(&serde_json::Value::Null).unwrap(),
            SubagentConfig::default()
        );
        let config = SubagentConfig::from_row(&serde_json::json!({ "maxDepth": 3 })).unwrap();
        assert_eq!(config.max_depth, 3);
        assert_eq!(config.max_active, SubagentConfig::default().max_active);
        let error = SubagentConfig::from_row(&serde_json::json!({ "maxDeep": 3 })).unwrap_err();
        assert!(error.to_string().contains("maxDeep"), "{error}");
    }

    #[tokio::test]
    async fn a_late_runner_refuses_until_bound_and_the_row_registers_delegate() {
        let runner = Arc::new(LateSubagentRunner::new());
        let failure = runner
            .run(&parent_handle(), "go".into(), None)
            .await
            .unwrap_err();
        assert_eq!(failure.code, SubagentErrorCode::SubagentFailed);
        assert_eq!(failure.message, "the agent runtime is not composed yet");

        let registry = crate::turn::tests::registry_with(Vec::new());
        let store = FakeStore::with(0, Some("answer"));
        register_subagent_row(
            &registry,
            &serde_json::Value::Null,
            Arc::clone(&store) as Arc<dyn SubagentStore>,
            Arc::clone(&runner),
            Arc::new(Notices::default()),
        )
        .unwrap();
        assert!(registry.has("delegate"));
        assert!(
            registry.is_concurrency_safe("delegate"),
            "two delegates of one step start together"
        );
        let error = register_subagent_row(
            &registry,
            &serde_json::json!({ "bogus": true }),
            store as Arc<dyn SubagentStore>,
            runner,
            Arc::new(Notices::default()),
        )
        .unwrap_err();
        assert!(error.starts_with("subagent-tool: "), "{error}");
    }

    #[tokio::test]
    async fn a_late_runner_once_bound_runs_children_on_that_runtime_and_keeps_the_first_binding() {
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
            presets: None,
        });
        let runner = LateSubagentRunner::new();
        assert!(runner.bind(&runtime));
        assert!(!runner.bind(&runtime), "the first binding stays");
        // The child now reaches the runtime, whose own refusal replaces "not composed yet".
        let error = runner
            .run(&parent_handle(), "do it".into(), None)
            .await
            .unwrap_err();
        assert!(error.message.contains("no endpoint"), "{}", error.message);
    }
}
