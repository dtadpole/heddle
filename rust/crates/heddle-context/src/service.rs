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
use serde_json::Value;

use crate::budget::{
    Budget, BudgetError, BudgetInput, BudgetPolicy, EndpointPolicy, resolve_budget,
};
use crate::compaction::{CompactionEngine, CompactionOutcome, SummarizeError, Summarizer};
use crate::error::ContextError;
use crate::events::{ContextEvent, origin};
use crate::instructions::{
    DEFAULT_PROJECT_MARKERS, FindOptions, INSTRUCTIONS_MAX_BYTES, InstructionBaseline,
    find_instruction_files, render_instruction_baseline,
};
use crate::meter::{Measurement, MeterInput, MeteredMessage, TokenMeter, UsageAnchor};
use crate::pairing::repair_tool_pairing;
use crate::runtime::{RUNTIME_CONTEXT_ORIGIN, RuntimeContextSection, render_runtime_context};
use crate::store::{AppendOptions, ContextStore, LogEvent, SeqRange, SurfaceState};
use crate::types::{ContentPart, Message, Role, ToolSpec, describe_content};

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
        ContextSummary {
            estimated_tokens: self.estimated_tokens,
            threshold_tokens: self.threshold_tokens,
            pruned: self.pruned,
            compacted: self.compacted,
        }
    }

    /// The `heddle context <session> --json` document for this report.
    pub fn view(&self, session_id: &str) -> ContextView {
        ContextView {
            session: session_id.to_string(),
            message_count: self.messages.len(),
            messages: self
                .messages
                .iter()
                .map(|message| ViewMessage {
                    role: message.role,
                    tool_call_id: message.tool_call_id.clone(),
                    text: describe_content(&message.content),
                })
                .collect(),
            estimated_tokens: self.estimated_tokens,
            threshold_tokens: self.threshold_tokens,
            context_window: self.context_window,
            pruned: self.pruned,
            compacted: self.compacted,
            instructions: self.instructions.clone(),
        }
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
        let endpoint_window = match (endpoint, self.dependencies.model.as_ref()) {
            (Some(endpoint), Some(model_access)) => model_access.endpoint_window(endpoint, model),
            _ => None,
        };
        let config_policy = BudgetPolicy {
            threshold_ratio: self.config.threshold_ratio,
            retain_ratio: self.config.retain_ratio,
            threshold_tokens: self.config.threshold_tokens,
            retain_tokens: self.config.retain_tokens,
        };
        resolve_budget(&BudgetInput {
            endpoint,
            endpoint_window,
            config_window: self.config.context_window,
            config_policy,
            policies: &self.config.policies,
        })
    }

    /// Price the surface as it stands, offering the meter the last call's usage when the
    /// `model/request` that made it recorded the generation it was built at.
    pub fn measure(
        &self,
        session: &S::Handle,
        tools: &[ToolSpec],
    ) -> Result<Measurement, ContextError> {
        let events = self.store.read(session)?;
        let state = self.store.surface(session)?;
        let mut kept: Vec<(u64, Message)> = Vec::with_capacity(state.nodes.len());
        for seq in &state.nodes {
            if let Some(message) = self.store.derive_node(session, *seq)? {
                kept.push((*seq, message));
            }
        }
        let nodes: Vec<MeteredMessage<'_>> = kept
            .iter()
            .map(|(seq, message)| MeteredMessage { seq: *seq, message })
            .collect();
        let usage = self.last_usage(&events);
        Ok(self.meter.measure(&MeterInput {
            nodes: &nodes,
            tools,
            usage,
            generation: state.content_generation,
        }))
    }

    /// The provider usage of the last completed call, with the generation of the request that made
    /// it: the anchor is a fact about the log, while the meter only knows how to price.
    fn last_usage(&self, events: &[LogEvent]) -> Option<UsageAnchor> {
        let mut anchor: Option<u64> = None;
        let mut usage: Option<(Option<u64>, Option<u64>)> = None;
        for event in events {
            if event.kind == "model/request" {
                anchor = event.field("generation").and_then(Value::as_u64);
                usage = None;
                continue;
            }
            if event.kind != "assistant/chunk" || anchor.is_none() {
                continue;
            }
            let Some(chunk) = event.field("chunk") else {
                continue;
            };
            if chunk.get("type").and_then(Value::as_str) != Some("done") {
                continue;
            }
            let Some(reported) = chunk.get("usage").and_then(Value::as_object) else {
                continue;
            };
            usage = Some((
                reported.get("inputTokens").and_then(Value::as_u64),
                reported.get("outputTokens").and_then(Value::as_u64),
            ));
        }
        let (input_tokens, output_tokens) = usage?;
        Some(UsageAnchor {
            input_tokens,
            output_tokens,
            generation: anchor?,
        })
    }

    /// Keep the runtime-context snapshot current: append a sourced `context/note` when the rendered
    /// snapshot differs from the retained one, write nothing when it does not, and replace a legacy
    /// `sandbox-policy` note still on the surface with the first snapshot.
    pub fn record_runtime_context(
        &self,
        session: &S::Handle,
        sections: &[RuntimeContextSection],
    ) -> Result<(), ContextError> {
        let snapshot = render_runtime_context(sections);
        let events = self.store.read(session)?;
        let mut retained: Option<(u64, Option<String>)> = None;
        let mut legacy: Option<u64> = None;
        for event in events.iter().rev() {
            if event.kind != "context/note" {
                continue;
            }
            match event.origin() {
                Some(RUNTIME_CONTEXT_ORIGIN) => {
                    retained = Some((event.seq, event.identity().map(str::to_string)));
                    break;
                }
                Some(origin::LEGACY_SANDBOX_POLICY) if legacy.is_none() => {
                    legacy = Some(event.seq);
                }
                _ => {}
            }
        }
        if retained
            .as_ref()
            .and_then(|(_, identity)| identity.as_deref())
            == Some(snapshot.as_str())
        {
            return Ok(());
        }

        let source = if sections.is_empty() {
            serde_json::json!({ "kind": RUNTIME_CONTEXT_ORIGIN })
        } else {
            serde_json::json!({
                "kind": RUNTIME_CONTEXT_ORIGIN,
                "form": "snapshot",
                "sections": sections,
            })
        };
        let message = Message {
            role: Role::User,
            content: vec![ContentPart::Text {
                text: snapshot.clone(),
            }],
            tool_call_id: None,
            source: Some(source),
        };
        let event = ContextEvent::Note {
            message,
            origin: RUNTIME_CONTEXT_ORIGIN.to_string(),
            identity: Some(snapshot),
            files: None,
        };

        // A session written by the old replacing mechanism is migrated: its stale note is
        // replaced rather than left beside the first snapshot.
        let legacy_on_surface = if retained.is_none() {
            match legacy {
                Some(seq) => self
                    .store
                    .surface(session)?
                    .nodes
                    .contains(&seq)
                    .then_some(seq),
                None => None,
            }
        } else {
            None
        };
        if let Some(seq) = legacy_on_surface {
            self.store.append(
                session,
                event.to_value(),
                AppendOptions::replace(
                    SeqRange {
                        start_seq: seq,
                        end_seq: seq,
                    },
                    vec![seq],
                ),
            )?;
        } else {
            self.store
                .append(session, event.to_value(), AppendOptions::append())?;
        }
        Ok(())
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
        let before = self.store.count(session)?;
        let state = self.store.surface(session)?;
        let events = self.store.read(session)?;
        let head_role = state
            .nodes
            .first()
            .and_then(|seq| events.iter().find(|event| event.seq == *seq))
            .and_then(LogEvent::message)
            .filter(|message| !message.content.is_empty())
            .map(|message| message.role);

        let mut system_seq = None;
        if let Some(system) = system.or(self.config.system.as_deref())
            && !system.is_empty()
            && head_role != Some(Role::System)
        {
            system_seq = Some(
                self.store.append(
                    session,
                    ContextEvent::Note {
                        message: Message::text(Role::System, system),
                        origin: origin::SYSTEM_PROMPT.to_string(),
                        identity: None,
                        files: None,
                    }
                    .to_value(),
                    AppendOptions::append(),
                )?,
            );
        }

        let files = if self.config.instructions {
            find_instruction_files(
                cwd,
                &FindOptions {
                    home: &self.dependencies.heddle_home,
                    markers: &DEFAULT_PROJECT_MARKERS,
                },
            )
        } else {
            Vec::new()
        };
        let rendered = if files.is_empty() {
            None
        } else {
            Some(render_instruction_baseline(
                &files,
                self.config.instructions_max_bytes,
            ))
        };

        let mut instructions_seq = None;
        if let Some(rendered) = &rendered {
            match self.current_baseline(&state, &events) {
                None => {
                    instructions_seq = Some(self.store.append(
                        session,
                        instruction_note(rendered),
                        AppendOptions::append(),
                    )?);
                }
                Some((seq, identity)) if identity != rendered.identity => {
                    // A changed baseline replaces the old node rather than piling up beside it.
                    instructions_seq = Some(self.store.append(
                        session,
                        instruction_note(rendered),
                        AppendOptions::replace(
                            SeqRange {
                                start_seq: seq,
                                end_seq: seq,
                            },
                            vec![seq],
                        ),
                    )?);
                }
                Some((seq, _)) => instructions_seq = Some(seq),
            }
        }

        let wrote = self.store.count(session)? != before;
        Ok(BaselineOutcome {
            system_seq,
            instructions_seq,
            instructions: rendered
                .map(|baseline| baseline.included)
                .unwrap_or_default(),
            wrote,
        })
    }

    /// The instruction node currently on the surface, with the digest it was rendered from.
    fn current_baseline(&self, state: &SurfaceState, events: &[LogEvent]) -> Option<(u64, String)> {
        for seq in state.nodes.iter().rev() {
            let Some(event) = events.iter().find(|event| event.seq == *seq) else {
                continue;
            };
            if event.origin() != Some(origin::INSTRUCTIONS) {
                continue;
            }
            return Some((*seq, event.identity().unwrap_or_default().to_string()));
        }
        None
    }

    /// What a caller would send right now. May write the system prompt or the baseline the first
    /// time; otherwise a read.
    pub fn assemble(
        &self,
        session: &S::Handle,
        options: &AssembleOptions<'_>,
    ) -> Result<ContextReport, ContextError> {
        let baseline = self.ensure_context(session, options.cwd, options.system)?;
        self.report(
            session,
            options.tools,
            baseline.instructions,
            None,
            options.endpoint,
            options.model,
        )
    }

    /// The report every caller reads, measuring the surface once more after any rewrite.
    fn report(
        &self,
        session: &S::Handle,
        tools: &[ToolSpec],
        instructions: Vec<PathBuf>,
        outcome: Option<&CompactionOutcome>,
        endpoint: Option<&str>,
        model: Option<&str>,
    ) -> Result<ContextReport, ContextError> {
        let measurement = self.measure(session, tools)?;
        let budget = self.budget(endpoint, model)?;
        Ok(ContextReport {
            // Every request goes through the repair: a log written before the loop closed its
            // calls on unwind otherwise fails every later request with the pairing error.
            messages: repair_tool_pairing(&self.store.derive_messages(session)?).into_owned(),
            estimated_tokens: measurement.total_tokens,
            context_window: budget.context_window,
            threshold_tokens: budget.threshold_tokens,
            pruned: outcome.map(|outcome| outcome.pruned).unwrap_or(0),
            compacted: outcome.map(|outcome| outcome.compacted).unwrap_or(false),
            instructions,
            breakdown: Breakdown {
                system: measurement.system_tokens,
                tools: measurement.tools_tokens,
                messages: measurement.message_tokens,
            },
        })
    }

    /// The whole per-round policy: ensure the context, measure, prune, and summarise if still over
    /// the trigger.
    pub async fn prepare(
        &self,
        session: &S::Handle,
        options: &PrepareOptions<'_>,
    ) -> Result<ContextReport, ContextError> {
        let baseline = self.ensure_context(session, options.cwd, options.system)?;
        let budget = self.budget(Some(options.endpoint), options.model)?;
        let measurement = self.measure(session, options.tools)?;

        // The default summariser is one `ModelAccess::complete` call, the replayed prefix and the
        // configured cap; a caller may pass its own instead.
        let default_summarizer = ModelSummarizer {
            model: self.dependencies.model.clone(),
            endpoint: self
                .config
                .endpoint
                .clone()
                .unwrap_or_else(|| options.endpoint.to_string()),
            model_name: self
                .config
                .model
                .clone()
                .or_else(|| options.model.map(str::to_string)),
            max_output_tokens: Some(self.config.summarize_max_tokens),
        };
        let summarizer: &dyn Summarizer = match options.summarizer {
            Some(summarizer) => summarizer,
            None => &default_summarizer,
        };
        let measure = || self.measure(session, options.tools);
        let outcome = self
            .compaction
            .compact_if_needed(
                self.store.as_ref(),
                session,
                &crate::compaction::CompactOptions {
                    budget,
                    measurement: &measurement,
                    summarizer,
                    measure: &measure,
                    force: options.force,
                },
            )
            .await?;
        self.report(
            session,
            options.tools,
            baseline.instructions,
            Some(&outcome),
            Some(options.endpoint),
            options.model,
        )
    }

    /// The `agent/request-error` listener: one forced reduction for a window overflow, and a retry
    /// only if a replacement actually landed (`replaceGeneration` moved). Either way the decision
    /// is recorded as `compaction/recovery`.
    pub async fn recover_overflow(
        &self,
        session: &S::Handle,
        request: &OverflowRequest<'_>,
    ) -> Result<RecoveryDecision, ContextError> {
        let before = self.store.surface(session)?.replace_generation;
        if request.error_code != crate::types::CONTEXT_WINDOW_EXCEEDED {
            self.store.append(
                session,
                ContextEvent::Recovery {
                    code: request.error_code.to_string(),
                    generation_before: None,
                    generation_after: None,
                    retry: false,
                    reason: Some("not a window overflow".to_string()),
                }
                .to_value(),
                AppendOptions::default(),
            )?;
            return Ok(RecoveryDecision::PassOn);
        }

        self.prepare(
            session,
            &PrepareOptions {
                cwd: request.cwd,
                endpoint: request.endpoint,
                model: request.model,
                tools: request.tools,
                system: None,
                summarizer: None,
                force: true,
            },
        )
        .await?;
        let after = self.store.surface(session)?.replace_generation;
        // The retry is granted only when a replacement actually landed: a retry without one would
        // send the same too-long request and fail the same way.
        let retry = after > before;
        self.store.append(
            session,
            ContextEvent::Recovery {
                code: request.error_code.to_string(),
                generation_before: Some(before),
                generation_after: Some(after),
                retry,
                reason: None,
            }
            .to_value(),
            AppendOptions::default(),
        )?;
        Ok(if retry {
            RecoveryDecision::Retry
        } else {
            RecoveryDecision::PassOn
        })
    }
}

/// The instruction baseline as the note this crate writes.
fn instruction_note(baseline: &InstructionBaseline) -> Value {
    ContextEvent::Note {
        message: Message::text(Role::User, baseline.text.clone()),
        origin: origin::INSTRUCTIONS.to_string(),
        identity: Some(baseline.identity.clone()),
        files: Some(baseline.included.clone()),
    }
    .to_value()
}

/// The default summariser: one non-streaming completion through the injected model layer.
struct ModelSummarizer {
    model: Option<Arc<dyn ModelAccess>>,
    endpoint: String,
    model_name: Option<String>,
    max_output_tokens: Option<u64>,
}

impl Summarizer for ModelSummarizer {
    fn summarize(&self, messages: Vec<Message>) -> BoxFuture<'_, Result<String, SummarizeError>> {
        let model = self.model.clone();
        let request = SummaryRequest {
            endpoint: self.endpoint.clone(),
            model: self.model_name.clone(),
            messages,
            max_output_tokens: self.max_output_tokens,
            purpose: Some("compaction".to_string()),
        };
        Box::pin(async move {
            let Some(model) = model else {
                return Err(SummarizeError(
                    "context: no model is available to summarise with".to_string(),
                ));
            };
            model.complete(request).await
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use futures::executor::block_on;
    use futures::future::BoxFuture;
    use serde_json::json;

    use super::{
        AssembleOptions, BaselineOutcome, ContextConfig, ContextDependencies, ContextReport,
        ContextService, ModelAccess, OverflowRequest, PrepareOptions, RecoveryDecision,
        SummaryRequest,
    };
    use crate::budget::BudgetSource;
    use crate::compaction::SummarizeError;
    use crate::instructions::INSTRUCTIONS_MAX_BYTES;
    use crate::runtime::{CLEARED_RUNTIME_CONTEXT, RUNTIME_CONTEXT_HEADER, RuntimeContextSection};
    use crate::store::ContextStore;
    use crate::testing::MemoryStore;
    use crate::types::{ContentPart, Message, Role};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "heddle-context-service-{}-{}-{name}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).expect("the scratch directory is created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, relative: &str, text: &str) {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("the parent directory is created");
            }
            std::fs::write(path, text).expect("the file is written");
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A model layer that answers with one scripted summary and records what it was asked.
    #[derive(Default)]
    struct ScriptedModel {
        window: Option<u64>,
        summary: String,
        failure: Option<String>,
        calls: Mutex<Vec<SummaryRequest>>,
    }

    impl ModelAccess for ScriptedModel {
        fn endpoint_window(&self, _endpoint: &str, _model: Option<&str>) -> Option<u64> {
            self.window
        }

        fn complete(
            &self,
            request: SummaryRequest,
        ) -> BoxFuture<'_, Result<String, SummarizeError>> {
            self.calls
                .lock()
                .expect("the model lock is not poisoned")
                .push(request);
            let summary = self.summary.clone();
            let failure = self.failure.clone();
            Box::pin(async move {
                match failure {
                    Some(reason) => Err(SummarizeError(reason)),
                    None => Ok(summary),
                }
            })
        }
    }

    fn dependencies(home: &Path, model: Option<Arc<dyn ModelAccess>>) -> ContextDependencies {
        ContextDependencies {
            model,
            heddle_home: home.to_path_buf(),
        }
    }

    fn build_service(
        config: ContextConfig,
        dependencies: ContextDependencies,
    ) -> (Arc<MemoryStore>, ContextService<MemoryStore>) {
        let store = Arc::new(MemoryStore::new());
        let service = ContextService::new(store.clone(), config, dependencies);
        (store, service)
    }

    fn text_of(message: &Message) -> String {
        message
            .content
            .iter()
            .map(|part| match part {
                ContentPart::Text { text } => text.clone(),
                _ => String::new(),
            })
            .collect()
    }

    fn surface_texts(store: &MemoryStore, session: &crate::testing::MemorySession) -> Vec<String> {
        store
            .derive_messages(session)
            .expect("the messages derive")
            .iter()
            .map(text_of)
            .collect()
    }

    #[test]
    fn the_endpoint_window_beats_the_configured_one_and_the_configuration_beats_the_default() {
        let scratch = Scratch::new("budget");
        let model = Arc::new(ScriptedModel {
            window: Some(900),
            ..ScriptedModel::default()
        });
        let (_, service) = build_service(
            ContextConfig {
                context_window: Some(5000),
                ..ContextConfig::default()
            },
            dependencies(scratch.path(), Some(model.clone())),
        );
        let budget = service
            .budget(Some("scripted"), None)
            .expect("the budget resolves");
        assert_eq!(budget.context_window, 900);
        assert_eq!(budget.threshold_tokens, 720);
        assert_eq!(budget.retain_tokens, 144);
        assert_eq!(budget.source, BudgetSource::Endpoint);

        // No declared window anywhere falls to the configured one.
        let (_, service) = build_service(
            ContextConfig {
                context_window: Some(5000),
                ..ContextConfig::default()
            },
            dependencies(scratch.path(), None),
        );
        let budget = service
            .budget(Some("scripted"), None)
            .expect("the budget resolves");
        assert_eq!(budget.context_window, 5000);
        assert_eq!(budget.threshold_tokens, 4000);
        assert_eq!(budget.source, BudgetSource::Config);

        // Neither declares a window: a configuration gap a caller may fall back from.
        let (_, service) = build_service(
            ContextConfig {
                context_window: None,
                ..ContextConfig::default()
            },
            dependencies(scratch.path(), None),
        );
        let error = service
            .budget(Some("scripted"), None)
            .expect_err("no window is a refusal");
        assert_eq!(error.code, crate::budget::BudgetErrorCode::NoCapacity);
    }

    #[test]
    fn a_per_endpoint_policy_reaches_the_resolved_budget() {
        let scratch = Scratch::new("policy");
        let (_, service) = build_service(
            ContextConfig {
                context_window: Some(5000),
                threshold_ratio: Some(0.9),
                policies: vec![crate::budget::EndpointPolicy {
                    endpoint: "small".to_string(),
                    policy: crate::budget::BudgetPolicy {
                        threshold_ratio: Some(0.5),
                        ..crate::budget::BudgetPolicy::default()
                    },
                }],
                ..ContextConfig::default()
            },
            dependencies(scratch.path(), None),
        );
        let budget = service
            .budget(Some("small"), None)
            .expect("the budget resolves");
        assert_eq!(budget.threshold_tokens, 2500);
        assert_eq!(budget.retain_tokens, 800);
    }

    #[test]
    fn the_first_assembly_writes_the_prompt_and_the_baseline_once_and_an_edit_replaces_the_baseline()
     {
        let scratch = Scratch::new("baseline");
        let home = scratch.path().join("home");
        std::fs::create_dir_all(&home).expect("the home directory");
        scratch.write("project/AGENTS.md", "# rules\n\nThe safe word is ALPHA.\n");
        scratch.write("project/sub/AGENTS.md", "narrow rules\n");
        let (store, service) = build_service(
            ContextConfig {
                system: Some("be brief".to_string()),
                instructions_max_bytes: 100_000,
                ..ContextConfig::default()
            },
            dependencies(&home, None),
        );
        let session = store.open("s");

        let outcome = service
            .ensure_context(&session, &scratch.path().join("project"), None)
            .expect("the context is ensured");
        assert!(outcome.wrote);
        assert!(outcome.system_seq.is_some());
        assert!(outcome.instructions_seq.is_some());
        assert_eq!(outcome.instructions.len(), 1, "only the project's own file");
        let texts = surface_texts(&store, &session);
        assert_eq!(texts[0], "be brief");
        assert!(texts[1].contains("<system-reminder>"));
        assert!(texts[1].contains("ALPHA"));

        // A second call writes nothing: the prompt and the digest are both current.
        let before = store.count(&session).expect("the count");
        let outcome = service
            .ensure_context(&session, &scratch.path().join("project"), None)
            .expect("the context is ensured again");
        assert!(!outcome.wrote);
        assert_eq!(
            store.count(&session).expect("the count"),
            before,
            "no event was appended"
        );
        assert!(
            outcome.system_seq.is_none(),
            "the prompt is already the head"
        );

        // An edited file replaces the baseline rather than piling up beside it.
        scratch.write("project/AGENTS.md", "# rules\n\nThe safe word is BETA.\n");
        let outcome = service
            .ensure_context(&session, &scratch.path().join("project"), None)
            .expect("the edited context is ensured");
        assert!(outcome.wrote);
        let texts = surface_texts(&store, &session);
        assert_eq!(texts.len(), 2, "one prompt and one baseline");
        assert!(texts[1].contains("BETA"));
        assert!(!texts[1].contains("ALPHA"));
        let events = store.read(&session).expect("the log reads");
        assert_eq!(
            events
                .iter()
                .filter(|event| event.origin() == Some("instructions"))
                .count(),
            2,
            "the log keeps the baseline it replaced"
        );
        assert!(events.iter().any(|event| event.origin() == Some("instructions")
            && matches!(event.field("surfaceOp"), Some(value) if value.get("op").and_then(serde_json::Value::as_str) == Some("replace"))));
    }

    #[test]
    fn an_assembly_reports_the_request_the_budget_and_the_breakdown() {
        let scratch = Scratch::new("report");
        let home = scratch.path().join("home");
        std::fs::create_dir_all(&home).expect("the home directory");
        scratch.write("project/AGENTS.md", "rules\n");
        let (store, service) = build_service(
            ContextConfig {
                system: Some("be brief".to_string()),
                context_window: Some(10_000),
                instructions_max_bytes: 100_000,
                ..ContextConfig::default()
            },
            dependencies(&home, None),
        );
        let session = store.open("s");
        let tools = [crate::types::ToolSpec {
            name: "read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({"type": "object"}),
        }];
        let report: ContextReport = service
            .assemble(
                &session,
                &AssembleOptions {
                    cwd: &scratch.path().join("project"),
                    tools: &tools,
                    system: None,
                    endpoint: Some("local"),
                    model: None,
                },
            )
            .expect("the assembly succeeds");
        assert_eq!(report.context_window, 10_000);
        assert_eq!(report.threshold_tokens, 8000);
        assert_eq!(report.messages.len(), 2, "the prompt and the baseline");
        assert_eq!(report.messages[0].role, Role::System);
        assert!(report.estimated_tokens > 0);
        assert_eq!(
            report.breakdown.system + report.breakdown.tools + report.breakdown.messages,
            report.estimated_tokens
        );
        assert!(report.breakdown.tools > 0);
        assert_eq!(report.instructions.len(), 1);

        // The prompt and the baseline are the first two nodes; a person's message follows them.
        store.message(&session, Message::text(Role::User, "hello"));
        let report = service
            .assemble(
                &session,
                &AssembleOptions {
                    cwd: &scratch.path().join("project"),
                    tools: &tools,
                    system: None,
                    endpoint: Some("local"),
                    model: None,
                },
            )
            .expect("the second assembly succeeds");
        assert_eq!(report.messages[2].role, Role::User);
        assert_eq!(report.messages.len(), 3);

        let summary = report.summary();
        assert_eq!(summary.estimated_tokens, report.estimated_tokens);
        assert_eq!(summary.threshold_tokens, report.threshold_tokens);
        assert_eq!(summary.pruned, 0);
        assert!(!summary.compacted);

        let view = report.view("session-1");
        assert_eq!(view.session, "session-1");
        assert_eq!(view.message_count, 3);
        assert_eq!(view.messages[0].text, "be brief");
        assert!(view.messages[1].text.contains("<system-reminder>"));
        assert_eq!(view.instructions.len(), 1);
        assert_eq!(view.context_window, 10_000);
    }

    #[test]
    fn a_runtime_context_snapshot_is_appended_on_change_written_once_when_unchanged_and_cleared_by_an_empty_one()
     {
        let scratch = Scratch::new("runtime");
        let (store, service) =
            build_service(ContextConfig::default(), dependencies(scratch.path(), None));
        let session = store.open("s");
        let policy = |mode: &str| {
            vec![RuntimeContextSection {
                name: "sandbox:policy".to_string(),
                text: format!("Current heddle file policy: {mode}."),
            }]
        };

        service
            .record_runtime_context(&session, &policy("workspace-write"))
            .expect("the first snapshot is recorded");
        let events = store.read(&session).expect("the log reads");
        assert_eq!(events.len(), 1);
        let note = &events[0];
        assert_eq!(note.kind, "context/note");
        assert_eq!(note.origin(), Some("runtime-context"));
        assert_eq!(
            note.identity(),
            Some(
                format!("{RUNTIME_CONTEXT_HEADER}\n\nCurrent heddle file policy: workspace-write.")
                    .as_str()
            )
        );
        let message = note.message().expect("the message parses");
        assert_eq!(message.role, Role::User);
        let source = message.source.expect("the source is recorded");
        assert_eq!(source["kind"], json!("runtime-context"));
        assert_eq!(source["form"], json!("snapshot"));
        assert_eq!(source["sections"][0]["name"], json!("sandbox:policy"));

        // Unchanged: no event, so a steady request reuses the retained snapshot.
        service
            .record_runtime_context(&session, &policy("workspace-write"))
            .expect("the unchanged snapshot writes nothing");
        assert_eq!(store.count(&session).expect("the count"), 1);

        // Changed: appended rather than replaced, so history keeps what each step saw.
        service
            .record_runtime_context(&session, &policy("read-only"))
            .expect("the changed snapshot is recorded");
        service
            .record_runtime_context(&session, &policy("workspace-write"))
            .expect("the revert is its own snapshot");
        let texts = surface_texts(&store, &session);
        assert_eq!(texts.len(), 3);
        assert!(texts[0].contains("workspace-write"));
        assert!(texts[1].contains("read-only"));
        assert!(texts[2].contains("workspace-write"));

        // An empty snapshot clears the previous one with DSH's sentence.
        service
            .record_runtime_context(&session, &[])
            .expect("the cleared snapshot is recorded");
        assert!(surface_texts(&store, &session).contains(&CLEARED_RUNTIME_CONTEXT.to_string()));
    }

    #[test]
    fn a_session_written_by_the_replacing_mechanism_is_migrated_rather_than_left_stale() {
        let scratch = Scratch::new("legacy");
        let (store, service) =
            build_service(ContextConfig::default(), dependencies(scratch.path(), None));
        let session = store.open("s");
        let stale = store
            .append(
                &session,
                json!({
                    "type": "context/note",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": "Current heddle file policy: read-only. The old replacing note."}],
                    },
                    "origin": "sandbox-policy",
                }),
                crate::store::AppendOptions::default(),
            )
            .expect("the stale note appends");

        service
            .record_runtime_context(
                &session,
                &[RuntimeContextSection {
                    name: "sandbox:policy".to_string(),
                    text: "Current heddle file policy: workspace-write.".to_string(),
                }],
            )
            .expect("the first snapshot is recorded");

        let surface = store.surface(&session).expect("the surface folds");
        assert_eq!(surface.nodes.len(), 1, "the stale note is shadowed");
        let events = store.read(&session).expect("the log reads");
        let snapshot = events.last().expect("the snapshot is the newest event");
        assert_eq!(snapshot.field("sourceEventSeqs"), Some(&json!([stale])));
        assert_eq!(
            snapshot
                .field("surfaceOp")
                .and_then(|value| value.get("op"))
                .and_then(serde_json::Value::as_str),
            Some("replace")
        );
        assert!(
            !surface_texts(&store, &session)
                .iter()
                .any(|text| text.contains("old replacing note"))
        );
    }

    #[test]
    fn a_restarted_service_recognises_the_retained_snapshot_from_the_log() {
        let scratch = Scratch::new("restart");
        let (store, service) =
            build_service(ContextConfig::default(), dependencies(scratch.path(), None));
        let session = store.open("s");
        let sections = [RuntimeContextSection {
            name: "sandbox:policy".to_string(),
            text: "Current heddle file policy: workspace-write.".to_string(),
        }];
        service
            .record_runtime_context(&session, &sections)
            .expect("the snapshot is recorded");
        let before = store.count(&session).expect("the count");

        let restarted = ContextService::new(
            store.clone(),
            ContextConfig::default(),
            dependencies(scratch.path(), None),
        );
        restarted
            .record_runtime_context(&session, &sections)
            .expect("the unchanged snapshot writes nothing");
        assert_eq!(store.count(&session).expect("the count"), before);
    }

    #[test]
    fn a_provider_usage_anchors_the_measurement_only_for_the_generation_that_made_it() {
        let scratch = Scratch::new("usage");
        let (store, service) =
            build_service(ContextConfig::default(), dependencies(scratch.path(), None));
        let session = store.open("s");
        store.message(&session, Message::text(Role::User, "hello"));
        // A stream is open, so the `done` chunk closes it without adding a node: the generation
        // the request recorded is still the surface's generation when it is measured.
        store.assistant_chunk(&session, json!({"type": "text-delta", "text": "hi"}));
        let generation = store
            .surface(&session)
            .expect("the surface folds")
            .content_generation;
        store
            .append(
                &session,
                json!({"type": "model/request", "endpoint": "local", "generation": generation}),
                crate::store::AppendOptions::default(),
            )
            .expect("the request appends");
        store.assistant_chunk(
            &session,
            json!({"type": "done", "finishReason": "stop", "usage": {"inputTokens": 1000, "outputTokens": 500}}),
        );

        let measurement = service
            .measure(&session, &[])
            .expect("the surface measures");
        assert_eq!(measurement.baseline.kind, crate::meter::BaselineKind::Usage);
        assert_eq!(measurement.total_tokens, 1500);

        // One more appended message moves the surface past the anchor, so the number stops
        // applying.
        store.message(&session, Message::text(Role::User, "and again"));
        let measurement = service
            .measure(&session, &[])
            .expect("the surface measures");
        assert_eq!(
            measurement.baseline.kind,
            crate::meter::BaselineKind::Estimated
        );
    }

    #[test]
    fn a_preparation_over_the_trigger_compacts_and_uses_the_injected_model() {
        let scratch = Scratch::new("prepare");
        let model = Arc::new(ScriptedModel {
            summary: "the briefing".to_string(),
            ..ScriptedModel::default()
        });
        let (store, service) = build_service(
            ContextConfig {
                context_window: Some(900),
                instructions: false,
                ..ContextConfig::default()
            },
            dependencies(scratch.path(), Some(model.clone())),
        );
        let session = store.open("s");
        store.message(&session, Message::text(Role::System, "be brief"));
        // Two substantial turns: small enough to leave a span the checkpoint can shrink.
        store.message(&session, Message::text(Role::User, "u".repeat(1500)));
        store.message(&session, Message::text(Role::Assistant, "a".repeat(1500)));
        store.message(&session, Message::text(Role::User, "q".repeat(1500)));

        let report = block_on(service.prepare(
            &session,
            &PrepareOptions {
                cwd: scratch.path(),
                endpoint: "local",
                model: None,
                tools: &[],
                system: None,
                summarizer: None,
                force: false,
            },
        ))
        .expect("the preparation succeeds");
        assert!(report.compacted, "the run compacted");
        assert_eq!(report.threshold_tokens, 720);
        let texts = surface_texts(&store, &session);
        assert!(
            texts
                .iter()
                .filter(|text| text.contains("<compacted-summary>"))
                .count()
                <= 1
        );
        let calls = model.calls.lock().expect("the model lock is not poisoned");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].endpoint, "local");
        assert_eq!(calls[0].purpose.as_deref(), Some("compaction"));
        assert_eq!(calls[0].max_output_tokens, Some(1024));
        assert!(
            calls[0]
                .messages
                .last()
                .map(|message| text_of(message).starts_with("Summarise the conversation above"))
                .unwrap_or(false),
            "the summariser is asked the compaction instruction"
        );
    }

    #[test]
    fn an_overflow_gets_one_forced_reduction_and_a_retry_only_when_a_replacement_landed() {
        let scratch = Scratch::new("recovery");
        let model = Arc::new(ScriptedModel {
            summary: "the briefing".to_string(),
            ..ScriptedModel::default()
        });
        let (store, service) = build_service(
            ContextConfig {
                context_window: Some(900),
                instructions: false,
                ..ContextConfig::default()
            },
            dependencies(scratch.path(), Some(model)),
        );
        let session = store.open("s");
        store.message(&session, Message::text(Role::System, "be brief"));
        store.message(&session, Message::text(Role::User, "u".repeat(1500)));
        store.message(&session, Message::text(Role::Assistant, "a".repeat(1500)));

        let decision = block_on(service.recover_overflow(
            &session,
            &OverflowRequest {
                error_code: crate::types::CONTEXT_WINDOW_EXCEEDED,
                cwd: scratch.path(),
                endpoint: "local",
                model: None,
                tools: &[],
            },
        ))
        .expect("the recovery runs");
        assert_eq!(decision, RecoveryDecision::Retry);
        let events = store.read(&session).expect("the log reads");
        let recovery = events
            .iter()
            .find(|event| event.kind == "compaction/recovery")
            .expect("the decision is recorded");
        assert_eq!(recovery.field("retry"), Some(&json!(true)));
        assert_eq!(
            recovery.field("code"),
            Some(&json!(crate::types::CONTEXT_WINDOW_EXCEEDED))
        );

        // A failure that is not an overflow is passed on, with the reason recorded.
        let decision = block_on(service.recover_overflow(
            &session,
            &OverflowRequest {
                error_code: "SOMETHING_ELSE",
                cwd: scratch.path(),
                endpoint: "local",
                model: None,
                tools: &[],
            },
        ))
        .expect("the recovery runs");
        assert_eq!(decision, RecoveryDecision::PassOn);
        let events = store.read(&session).expect("the log reads");
        let last = events.last().expect("the decision is the newest event");
        assert_eq!(last.field("retry"), Some(&json!(false)));
        assert_eq!(last.field("reason"), Some(&json!("not a window overflow")));
    }

    #[test]
    fn an_overflow_with_nothing_safe_to_reduce_is_passed_on() {
        let scratch = Scratch::new("nothing");
        let model = Arc::new(ScriptedModel {
            summary: "the briefing".to_string(),
            ..ScriptedModel::default()
        });
        let (store, service) = build_service(
            ContextConfig {
                context_window: Some(900),
                instructions: false,
                ..ContextConfig::default()
            },
            dependencies(scratch.path(), Some(model)),
        );
        let session = store.open("s");
        store.message(&session, Message::text(Role::System, "be brief"));
        store.message(&session, Message::text(Role::User, "only this"));

        let decision = block_on(service.recover_overflow(
            &session,
            &OverflowRequest {
                error_code: crate::types::CONTEXT_WINDOW_EXCEEDED,
                cwd: scratch.path(),
                endpoint: "local",
                model: None,
                tools: &[],
            },
        ))
        .expect("the recovery runs");
        assert_eq!(decision, RecoveryDecision::PassOn);
        let events = store.read(&session).expect("the log reads");
        assert!(
            events
                .iter()
                .any(|event| event.kind == "compaction/recovery")
        );
    }

    #[test]
    fn the_configuration_defaults_are_the_typescript_builds() {
        let config = ContextConfig::default();
        assert_eq!(config.context_window, Some(super::DEFAULT_CONTEXT_WINDOW));
        assert!(config.instructions);
        assert_eq!(config.instructions_max_bytes, INSTRUCTIONS_MAX_BYTES);
        assert_eq!(
            config.summarize_max_tokens,
            super::DEFAULT_SUMMARIZE_MAX_TOKENS
        );
        assert!(config.system.is_none());
        assert!(config.policies.is_empty());
        // A configuration document that names one key takes the default for the rest.
        let parsed: ContextConfig =
            serde_json::from_value(json!({"contextWindow": 4096})).expect("the config parses");
        assert_eq!(parsed.context_window, Some(4096));
        assert!(parsed.instructions);
        assert_eq!(parsed.instructions_max_bytes, INSTRUCTIONS_MAX_BYTES);
    }

    #[test]
    fn a_baseline_outcome_names_what_was_written() {
        let scratch = Scratch::new("outcome");
        let (store, service) = build_service(
            ContextConfig {
                system: Some("be brief".to_string()),
                ..ContextConfig::default()
            },
            dependencies(scratch.path(), None),
        );
        let session = store.open("s");
        let BaselineOutcome {
            system_seq,
            instructions_seq,
            wrote,
            ..
        } = service
            .ensure_context(&session, scratch.path(), None)
            .expect("the context is ensured");
        assert!(system_seq.is_some());
        assert!(
            instructions_seq.is_none(),
            "there is no instruction file here"
        );
        assert!(wrote);
    }

    #[test]
    fn a_preparation_that_clears_the_pressure_by_pruning_pays_for_no_summary() {
        let scratch = Scratch::new("prepare-prune");
        let model = Arc::new(ScriptedModel {
            summary: "the briefing".to_string(),
            ..ScriptedModel::default()
        });
        let (store, service) = build_service(
            ContextConfig {
                context_window: Some(3000),
                instructions: false,
                ..ContextConfig::default()
            },
            dependencies(scratch.path(), Some(model.clone())),
        );
        let session = store.open("s");
        store.message(&session, Message::text(Role::System, "be brief"));
        store.message(&session, Message::text(Role::User, "do the thing"));
        store.message(
            &session,
            Message {
                role: Role::Tool,
                content: vec![ContentPart::Text {
                    text: "x".repeat(30_000),
                }],
                tool_call_id: Some("call-1".to_string()),
                source: None,
            },
        );

        let report = block_on(service.prepare(
            &session,
            &PrepareOptions {
                cwd: scratch.path(),
                endpoint: "local",
                model: None,
                tools: &[],
                system: None,
                summarizer: None,
                force: false,
            },
        ))
        .expect("the preparation succeeds");
        assert_eq!(report.pruned, 1, "the oversized result was rewritten");
        assert!(!report.compacted, "and no summary was paid for");
        assert!(
            model
                .calls
                .lock()
                .expect("the model lock is not poisoned")
                .is_empty(),
            "the summariser was never asked"
        );
        let texts = surface_texts(&store, &session);
        assert!(
            texts.iter().any(|text| text.contains("pruned")),
            "the model is sent the marker instead of the body"
        );
    }

    #[test]
    fn an_overflow_with_no_summariser_to_ask_reduces_nothing_and_passes_on() {
        let scratch = Scratch::new("no-model");
        let (store, service) = build_service(
            ContextConfig {
                context_window: Some(900),
                instructions: false,
                ..ContextConfig::default()
            },
            // No model layer at all: the default summariser refuses rather than guessing.
            dependencies(scratch.path(), None),
        );
        let session = store.open("s");
        store.message(&session, Message::text(Role::System, "be brief"));
        store.message(&session, Message::text(Role::User, "u".repeat(1500)));
        store.message(&session, Message::text(Role::Assistant, "a".repeat(1500)));

        let decision = block_on(service.recover_overflow(
            &session,
            &OverflowRequest {
                error_code: crate::types::CONTEXT_WINDOW_EXCEEDED,
                cwd: scratch.path(),
                endpoint: "local",
                model: None,
                tools: &[],
            },
        ))
        .expect("the recovery runs");
        assert_eq!(decision, RecoveryDecision::PassOn);
        let events = store.read(&session).expect("the log reads");
        assert!(
            events.iter().any(|event| event.kind == "compaction/failed"),
            "the refusal is recorded rather than swallowed"
        );
        let recovery = events.last().expect("the decision is the newest event");
        assert_eq!(recovery.kind, "compaction/recovery");
        assert_eq!(recovery.field("retry"), Some(&json!(false)));
        assert_eq!(
            recovery.field("generationBefore"),
            recovery.field("generationAfter"),
            "nothing landed, so the generations agree"
        );
    }
}
