//! The context service: the seam the agent loop talks to.
//!
//! A port of `ContextService` and `ContextPlugin` in `src/context/service.ts`. It is the only place
//! that knows the surface (through the store), the meter, the budget and the compaction, and the
//! order in [`ContextService::prepare`] is the policy: derive, measure, prune if over the trigger,
//! measure again, and summarise only what pruning could not fix.
//!
//! The TypeScript class is a Cordis service whose plugin registers the overflow listener on
//! `agent/request-error`. Here the listener's logic is [`ContextService::recover_overflow`], a plain
//! method; registering it on the event bus is the composer's job (the `heddle` crate's boot).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::budget::{Budget, BudgetError, EndpointPolicy};
use crate::compaction::{CompactionEngine, SummarizeError, Summarizer};
use crate::error::ContextError;
use crate::instructions::INSTRUCTIONS_MAX_BYTES;
use crate::meter::{Measurement, TokenMeter};
use crate::runtime::RuntimeContextSection;
use crate::store::ContextStore;
use crate::types::{Message, Role, ToolSpec};

/// The configured window when neither the endpoint nor the profile gives one.
pub const DEFAULT_CONTEXT_WINDOW: u64 = 1_048_576;
/// The cap on generated tokens for the summarising call.
pub const DEFAULT_SUMMARIZE_MAX_TOKENS: u64 = 1024;

/// The context row's `config` in a profile, with the plugin schema's defaults.
///
/// Keys are the TypeScript build's (`contextWindow`, `thresholdTokens`, `instructionsMaxBytes`, …);
/// a missing key takes its default, an unknown key is ignored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextConfig {
    /// The system prompt, written as the surface's first node.
    pub system: Option<String>,
    /// The window to budget against when the endpoint declares none; [`DEFAULT_CONTEXT_WINDOW`].
    pub context_window: Option<u64>,
    /// Compact at this fraction of the window; 0.8 when unset.
    pub threshold_ratio: Option<f64>,
    /// Keep this fraction of the window verbatim; 0.16 when unset.
    pub retain_ratio: Option<f64>,
    /// An absolute trigger, which beats the ratio.
    pub threshold_tokens: Option<u64>,
    /// An absolute retained tail, which beats the ratio.
    pub retain_tokens: Option<u64>,
    /// Per-endpoint overrides.
    pub policies: Vec<EndpointPolicy>,
    /// Read `AGENTS.md` and `CLAUDE.md` and keep them on the surface as a baseline; `true`.
    pub instructions: bool,
    /// The largest rendered baseline, in bytes; [`INSTRUCTIONS_MAX_BYTES`].
    pub instructions_max_bytes: usize,
    /// The endpoint a summary is asked of; the turn's when unset.
    pub endpoint: Option<String>,
    /// The model a summary is asked of; the endpoint's when unset.
    pub model: Option<String>,
    /// The cap on the summarising call's output; [`DEFAULT_SUMMARIZE_MAX_TOKENS`].
    pub summarize_max_tokens: u64,
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            system: None,
            context_window: Some(DEFAULT_CONTEXT_WINDOW),
            threshold_ratio: None,
            retain_ratio: None,
            threshold_tokens: None,
            retain_tokens: None,
            policies: Vec::new(),
            instructions: true,
            instructions_max_bytes: INSTRUCTIONS_MAX_BYTES,
            endpoint: None,
            model: None,
            summarize_max_tokens: DEFAULT_SUMMARIZE_MAX_TOKENS,
        }
    }
}

/// The request's estimate split the way the context panel shows it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Breakdown {
    /// System prompts.
    pub system: u64,
    /// Tool schemas.
    pub tools: u64,
    /// Every other message.
    pub messages: u64,
}

/// What one assembly was made of.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextReport {
    /// What the request carries, after the tool-pairing repair.
    pub messages: Vec<Message>,
    /// The measurement of the surface as it now stands.
    pub estimated_tokens: u64,
    /// The budget's window.
    pub context_window: u64,
    /// The budget's trigger.
    pub threshold_tokens: u64,
    /// How many oversized tool results this call rewrote.
    pub pruned: u64,
    /// Whether this call landed a compaction.
    pub compacted: bool,
    /// The instruction files the baseline carried, in order.
    pub instructions: Vec<PathBuf>,
    /// The estimate by section; the loop writes it on `model/request`.
    pub breakdown: Breakdown,
}

impl ContextReport {
    /// The four numbers a turn reports as `context` (`--turn … --json`, `TurnResult.context`).
    pub fn summary(&self) -> ContextSummary {
        todo!("ContextReport::summary")
    }

    /// The `heddle context <session> --json` document for this report.
    pub fn view(&self, session_id: &str) -> ContextView {
        let _ = session_id;
        todo!("ContextReport::view")
    }
}

/// What a turn reports about its last context preparation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSummary {
    /// The measurement.
    pub estimated_tokens: u64,
    /// The trigger.
    pub threshold_tokens: u64,
    /// Tool results pruned.
    pub pruned: u64,
    /// Whether a compaction landed.
    pub compacted: bool,
}

/// One message as `heddle context --json` prints it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewMessage {
    /// Who it is from.
    pub role: Role,
    /// On a tool message, the call it answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Its content as `describe_content` renders it.
    pub text: String,
}

/// The `heddle context <session> --json` document, field for field.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextView {
    /// The session id.
    pub session: String,
    /// How many messages the request carries.
    pub message_count: usize,
    /// The messages.
    pub messages: Vec<ViewMessage>,
    /// The measurement.
    pub estimated_tokens: u64,
    /// The trigger.
    pub threshold_tokens: u64,
    /// The window.
    pub context_window: u64,
    /// Tool results pruned by this call.
    pub pruned: u64,
    /// Whether this call compacted.
    pub compacted: bool,
    /// The instruction files carried.
    pub instructions: Vec<PathBuf>,
}

/// What [`ContextService::ensure_context`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BaselineOutcome {
    /// The system-prompt note written now, if one was.
    pub system_seq: Option<u64>,
    /// The baseline node on the surface: written now, replaced now, or already current.
    pub instructions_seq: Option<u64>,
    /// The files the baseline carries.
    pub instructions: Vec<PathBuf>,
    /// Whether anything was appended.
    pub wrote: bool,
}

/// The summarising call, as [`ModelAccess::complete`] receives it.
#[derive(Clone, Debug, PartialEq)]
pub struct SummaryRequest {
    /// The endpoint asked.
    pub endpoint: String,
    /// The model asked, when one is named.
    pub model: Option<String>,
    /// The replayed prefix and the instruction.
    pub messages: Vec<Message>,
    /// The cap on output.
    pub max_output_tokens: Option<u64>,
    /// `compaction`, so a scripted endpoint can hand the call its summary step.
    pub purpose: Option<String>,
}

/// How the service reaches the model layer, injected so the service holds no model of its own.
pub trait ModelAccess: Send + Sync {
    /// The window an endpoint — or one of its models — is served with (`contextWindowFor`).
    fn endpoint_window(&self, endpoint: &str, model: Option<&str>) -> Option<u64>;

    /// One non-streaming completion, returning its text, for the summarising call.
    fn complete(&self, request: SummaryRequest) -> BoxFuture<'_, Result<String, SummarizeError>>;
}

/// What the service is given besides its store and configuration.
#[derive(Clone)]
pub struct ContextDependencies {
    /// The model layer; without it there is no endpoint window and no default summariser.
    pub model: Option<Arc<dyn ModelAccess>>,
    /// The heddle home (`HEDDLE_HOME`, else `~/.heddle`), whose `AGENTS.md` is the user-global file.
    pub heddle_home: PathBuf,
}

/// What [`ContextService::assemble`] is asked.
#[derive(Clone, Copy, Debug)]
pub struct AssembleOptions<'a> {
    /// The session's own folder, which supplies the instruction baseline.
    pub cwd: &'a Path,
    /// The tool schemas the request offers.
    pub tools: &'a [ToolSpec],
    /// A system prompt that overrides the configured one.
    pub system: Option<&'a str>,
    /// The routed endpoint, whose window the budget uses.
    pub endpoint: Option<&'a str>,
    /// The model the request would name.
    pub model: Option<&'a str>,
}

/// What [`ContextService::prepare`] is asked.
#[derive(Clone, Copy)]
pub struct PrepareOptions<'a> {
    /// The session's own folder, which supplies the instruction baseline.
    pub cwd: &'a Path,
    /// The routed endpoint.
    pub endpoint: &'a str,
    /// The model the request would name.
    pub model: Option<&'a str>,
    /// The tool schemas the request offers.
    pub tools: &'a [ToolSpec],
    /// A system prompt that overrides the configured one.
    pub system: Option<&'a str>,
    /// A summariser that overrides the default (one [`ModelAccess::complete`] call).
    pub summarizer: Option<&'a dyn Summarizer>,
    /// Overflow recovery: one maximal balanced reduction, ignoring the trigger and the tail.
    pub force: bool,
}

/// A model call the provider refused, as the loop offers it on `agent/request-error`.
#[derive(Clone, Copy, Debug)]
pub struct OverflowRequest<'a> {
    /// The failure's normalised code; only [`crate::types::CONTEXT_WINDOW_EXCEEDED`] is recovered.
    pub error_code: &'a str,
    /// The session's own folder.
    pub cwd: &'a Path,
    /// The routed endpoint.
    pub endpoint: &'a str,
    /// The model named.
    pub model: Option<&'a str>,
    /// The tool schemas the request offered.
    pub tools: &'a [ToolSpec],
}

/// What the overflow listener answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryDecision {
    /// A replacement landed: the loop re-derives the request (with `assemble`) and retries once.
    Retry,
    /// Nothing was reduced, or the failure was not an overflow: pass to the next listener.
    PassOn,
}

/// The context service for one store.
pub struct ContextService<S: ContextStore> {
    store: Arc<S>,
    meter: TokenMeter,
    compaction: CompactionEngine,
    config: ContextConfig,
    dependencies: ContextDependencies,
}

impl<S: ContextStore> ContextService<S> {
    /// A service over `store` with the default pruner and compaction engine.
    pub fn new(store: Arc<S>, config: ContextConfig, dependencies: ContextDependencies) -> Self {
        Self {
            store,
            meter: TokenMeter,
            compaction: CompactionEngine::default(),
            config,
            dependencies,
        }
    }

    /// The store it reads and appends to.
    pub fn store(&self) -> &Arc<S> {
        &self.store
    }

    /// Its configuration.
    pub fn config(&self) -> &ContextConfig {
        &self.config
    }

    /// Its meter.
    pub fn meter(&self) -> &TokenMeter {
        &self.meter
    }

    /// Its compaction engine.
    pub fn compaction(&self) -> &CompactionEngine {
        &self.compaction
    }

    /// The budget for one endpoint, from its own window when it declares one.
    pub fn budget(
        &self,
        endpoint: Option<&str>,
        model: Option<&str>,
    ) -> Result<Budget, BudgetError> {
        let _ = (endpoint, model, &self.dependencies);
        todo!("ContextService::budget")
    }

    /// Price the surface as it stands, offering the meter the last call's usage when the
    /// `model/request` that made it recorded the generation it was built at.
    pub fn measure(
        &self,
        session: &S::Handle,
        tools: &[ToolSpec],
    ) -> Result<Measurement, ContextError> {
        let _ = (session, tools);
        todo!("ContextService::measure")
    }

    /// Keep the runtime-context snapshot current: append a sourced `context/note` when the rendered
    /// snapshot differs from the retained one, write nothing when it does not, and replace a legacy
    /// `sandbox-policy` note still on the surface with the first snapshot.
    pub fn record_runtime_context(
        &self,
        session: &S::Handle,
        sections: &[RuntimeContextSection],
    ) -> Result<(), ContextError> {
        let _ = (session, sections);
        todo!("ContextService::record_runtime_context")
    }

    /// Make sure the surface says what this run means it to say, once: the system prompt as its
    /// first node, and the instruction baseline from `cwd` — appended the first time, replaced when
    /// its digest changes, left alone otherwise. Both are `context/note` events.
    pub fn ensure_context(
        &self,
        session: &S::Handle,
        cwd: &Path,
        system: Option<&str>,
    ) -> Result<BaselineOutcome, ContextError> {
        let _ = (session, cwd, system);
        todo!("ContextService::ensure_context")
    }

    /// What a caller would send right now. May write the system prompt or the baseline the first
    /// time; otherwise a read.
    pub fn assemble(
        &self,
        session: &S::Handle,
        options: &AssembleOptions<'_>,
    ) -> Result<ContextReport, ContextError> {
        let _ = (session, options);
        todo!("ContextService::assemble")
    }

    /// The whole per-round policy: ensure the context, measure, prune, and summarise if still over
    /// the trigger.
    pub async fn prepare(
        &self,
        session: &S::Handle,
        options: &PrepareOptions<'_>,
    ) -> Result<ContextReport, ContextError> {
        let _ = (session, options);
        todo!("ContextService::prepare")
    }

    /// The `agent/request-error` listener: one forced reduction for a window overflow, and a retry
    /// only if a replacement actually landed (`replaceGeneration` moved). Either way the decision
    /// is recorded as `compaction/recovery`.
    pub async fn recover_overflow(
        &self,
        session: &S::Handle,
        request: &OverflowRequest<'_>,
    ) -> Result<RecoveryDecision, ContextError> {
        let _ = (session, request);
        todo!("ContextService::recover_overflow")
    }
}
