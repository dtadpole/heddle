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

use futures::StreamExt;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use heddle_tools::{LogSink, ToolArgs, ToolContext, ToolRegistry, ToolResult, codes};

use crate::ports::{
    ContextPort, HookFailure, ModelError, ModelPort, ModelRequestRecord, PortError, PreStep,
    RequestErrorAction, RequestErrorPayload, SessionPort, TurnHooks,
};
use crate::turns::{LiveTurn, TurnRegistry};
use crate::upstream::{
    Chunk, ContentPart, GenerateRequest, Message, PrepareOptions, Role, RuntimeContextSection,
    SessionHandle, TokenUsage, merge_token_usage,
};

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
    /// Answer input already in the log instead of writing `prompt` as a new message: a background child's
    /// settlement notice that reached a turn which ended before it saw it is in the log once, and the turn that
    /// answers it must not write it again (`answerPending` in the TypeScript build).
    pub answer_pending: bool,
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
            answer_pending: false,
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

/// The last round's context budget, so a caller can report it: the context service's own summary.
pub use heddle_context::ContextSummary;

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

/// One turn, whose live registration and prompt are already durable.
///
/// This is the begin/remainder split the team layer needs: before [`begin_turn`] returns, the turn is in the
/// live-turn registry and the prompt is in the session's own log with its `source` verbatim — so a caller that
/// reads the log immediately after `begin` sees a delivery, and a turn cut off before it is polled can still
/// be found and resumed. The rest of the turn is [`BegunTurn::run`], which settles the registration however it
/// ends (an early return or a drop settles it too).
pub struct BegunTurn {
    runtime: AgentRuntime,
    options: RunTurnOptions,
    /// The live token, a child of the caller's, so a Stop and an interrupt both stop the turn and an
    /// interrupt does not reach the caller.
    cancel: Option<CancellationToken>,
    /// The session's event count before the prompt, so the result counts the turn's own writes.
    started: usize,
    live: Option<LiveTurn>,
}

impl std::fmt::Debug for BegunTurn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BegunTurn")
            .field("session", &self.options.session.id)
            .field("endpoint", &self.options.endpoint)
            .field("live", &self.live.is_some())
            .finish_non_exhaustive()
    }
}

impl BegunTurn {
    /// The token that stops this turn: the caller's Stop combined with the live registration's.
    pub fn token(&self) -> Option<&CancellationToken> {
        self.cancel.as_ref()
    }

    /// The session id this turn belongs to.
    pub fn session(&self) -> &SessionHandle {
        &self.options.session
    }

    /// Run the rest of the turn.
    pub async fn run(self) -> Result<TurnResult, TurnError> {
        let BegunTurn {
            runtime,
            options,
            cancel,
            started,
            live,
        } = self;
        let stopped = cancel.clone();
        let mut progress = TurnProgress::default();
        let result = run_turn_body(&runtime, &options, cancel, started, &mut progress).await;
        if let Err(error) = &result {
            record_unfinished(
                &runtime,
                &options.session,
                error,
                stopped
                    .as_ref()
                    .is_some_and(CancellationToken::is_cancelled),
                &progress,
            );
        }
        if let Some(live) = &live {
            live.settle();
        }
        result
    }
}

/// What a turn has done so far, kept where [`BegunTurn::run`] can read it when the body returns an error.
#[derive(Debug, Default)]
struct TurnProgress {
    text: String,
    reasoning: String,
    rounds: u32,
    denials: usize,
    /// Whether the turn's `assistant/completed` is already in the log.
    completed: bool,
}

/// End a turn that returned an error, durably (#16, #29; `recordUnfinished` in the TypeScript build).
///
/// A turn whose model call failed (a refused connection, a timeout, a provider error) returned before its
/// `assistant/completed` and `turn/completed`: the live stream showed the error, but the log kept only the
/// prompt, so a reload or a second tab saw a message with no answer and no failure. DSH's loop appends
/// `turn/end` with its reason in a `finally`. Here the turn ends the way a stopped turn already does:
/// `assistant/completed` names the reason in `ended`, which the transcript draws as the turn's notice, and
/// `turn/completed` closes it. A failure to write the record is ignored; the caller still gets the turn's error.
///
/// The record keeps what the turn did before it failed: the answer of its earlier rounds, its reasoning, its
/// round and denial counts (developer-five's review). A turn whose completion was already written (only the
/// closing `turn/completed` failed) is not completed twice.
fn record_unfinished(
    runtime: &AgentRuntime,
    session: &SessionHandle,
    error: &TurnError,
    stopped: bool,
    progress: &TurnProgress,
) {
    let message = error.to_string();
    let reason = if stopped {
        "stopped by the caller".to_owned()
    } else {
        format!("failed: {message}")
    };
    let mut completed = serde_json::Map::from_iter([
        ("text".to_owned(), serde_json::json!(progress.text)),
        (
            "reasoning".to_owned(),
            serde_json::json!(progress.reasoning),
        ),
        (
            "finishReason".to_owned(),
            serde_json::json!(if stopped { "aborted" } else { "error" }),
        ),
        ("rounds".to_owned(), serde_json::json!(progress.rounds)),
        ("denials".to_owned(), serde_json::json!(progress.denials)),
        ("ended".to_owned(), serde_json::json!([reason])),
    ]);
    let mut closed =
        serde_json::Map::from_iter([("rounds".to_owned(), serde_json::json!(progress.rounds))]);
    if stopped {
        closed.insert("stopped".to_owned(), serde_json::json!(true));
    } else {
        completed.insert("error".to_owned(), serde_json::json!(message));
        closed.insert("error".to_owned(), serde_json::json!(message));
    }
    if progress.completed
        || runtime
            .session
            .append(session, events::ASSISTANT_COMPLETED, completed)
            .is_ok()
    {
        let _ = runtime
            .session
            .append(session, events::TURN_COMPLETED, closed);
    }
}

/// Begin a turn: register it live and write the prompt, then hand back the rest as [`BegunTurn::run`].
///
/// The ordering is the contract: a caller that reads the target session's log right after this returns sees
/// the prompt, and [`TurnRegistry::is_running`](crate::TurnRegistry::is_running) already answers `true` for the
/// session. A failed prompt write settles the registration rather than leaving the session marked running.
pub fn begin_turn(runtime: &AgentRuntime, options: RunTurnOptions) -> Result<BegunTurn, TurnError> {
    let live = runtime
        .turns
        .as_ref()
        .map(|turns| turns.begin(&options.session.id, options.cancel.as_ref()));
    begin_registered(runtime, options, live)
}

/// [`begin_turn`] with the registration already made: at once by `begin_turn`, or after the session's queue by
/// [`run_turn`].
fn begin_registered(
    runtime: &AgentRuntime,
    options: RunTurnOptions,
    live: Option<crate::turns::LiveTurn>,
) -> Result<BegunTurn, TurnError> {
    let cancel = match (&live, &options.cancel) {
        (Some(live), _) => Some(live.token().clone()),
        (None, Some(caller)) => Some(caller.clone()),
        (None, None) => None,
    };
    // Counted before the prompt, as the turn's own writes: the completed result reports what it added.
    let started = runtime.session.count(&options.session);
    // A steer a stopped turn left in the inbox is DSH's next-step input, and DSH's boundary claims next-step
    // input before the queued prompt, so it is written ahead of this turn's prompt.
    if let Err(error) = runtime.session.claim_pending_input(&options.session) {
        if let Some(live) = &live {
            live.settle();
        }
        return Err(TurnError::Port(error));
    }
    let mut content = vec![ContentPart::text(options.prompt.clone())];
    content.extend(options.attachments.iter().cloned());
    let written = if options.answer_pending {
        Ok(())
    } else {
        runtime
            .session
            .user_content(&options.session, content, options.source.clone())
    };
    if let Err(error) = written {
        if let Some(live) = &live {
            live.settle();
        }
        return Err(TurnError::Port(error));
    }
    Ok(BegunTurn {
        runtime: runtime.clone(),
        options,
        cancel,
        started,
        live,
    })
}

/// Run one turn.
///
/// Registers the turn with the live-turn registry when there is one (its token a child of the caller's),
/// writes the prompt, and settles it however the turn ends. [`begin_turn`] is the same turn, split so the
/// prompt and the registration are durable before its future is polled.
pub async fn run_turn(
    runtime: &AgentRuntime,
    options: RunTurnOptions,
) -> Result<TurnResult, TurnError> {
    // One turn at a time per session (#28): a turn sent to a busy session waits for the running one, as DSH's
    // follow-up does. `begin_turn` keeps registering at once, for a caller that needs the prompt durable before
    // it polls anything and starts turns only on idle sessions.
    let live = match runtime.turns.as_ref() {
        Some(turns) => Some(
            turns
                .begin_queued(&options.session.id, options.cancel.as_ref())
                .await,
        ),
        None => None,
    };
    begin_registered(runtime, options, live)?.run().await
}

/// One turn's body, after [`begin_turn`] wrote the prompt.
async fn run_turn_body(
    runtime: &AgentRuntime,
    options: &RunTurnOptions,
    cancel: Option<CancellationToken>,
    started: usize,
    progress: &mut TurnProgress,
) -> Result<TurnResult, TurnError> {
    let session = &options.session;
    let max_rounds = match options.max_rounds {
        RoundLimit::Rounds(rounds) => rounds,
        RoundLimit::Unbounded => u32::MAX,
    };
    let sandbox = runtime.tools.sandbox();
    let folder = runtime.session.folder(session);
    // The session's folder is where its tools run: the shell's directory, the base of a relative path and the
    // `workspace-write` boundary (DSH's rule), so a turn in workspace B acts in B and not in the directory the
    // server was launched from. A root the operator named still applies to every session (`root_for`).
    let cwd = sandbox.root_for(folder.as_deref());
    let rooted = sandbox
        .rooted_at(&cwd)
        .unwrap_or_else(|| Arc::clone(sandbox));
    // Instructions belong to the conversation, even when the operator pinned the tools' root elsewhere.
    let instruction_cwd = folder.unwrap_or_else(|| sandbox.workspace_root().to_path_buf());

    let tools = runtime.tools.describe();
    let mut denials: Vec<Denial> = Vec::new();
    let mut tool_calls: Vec<ToolCallRecord> = Vec::new();
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut finish_reason = "unknown".to_owned();
    let mut usage: Option<TokenUsage> = None;
    let mut rounds = 0u32;
    let mut last_context: Option<ContextSummary> = None;
    let mut ended: Vec<String> = Vec::new();
    let stopped = || cancel.as_ref().is_some_and(CancellationToken::is_cancelled);

    for round in 0..max_rounds {
        // A stopped turn ends at the next boundary: a round between model calls has no connection to break.
        if stopped() {
            ended.push("stopped by the caller".to_owned());
            break;
        }
        // The step boundary: the previous round's tool results are on disk, so a steer that arrived during
        // them is written now, after them. A stop is checked first, so a stopped turn leaves its steer pending.
        runtime.session.claim_pending_input(session)?;
        rounds += 1;
        progress.rounds = rounds;

        // Keep the runtime-context snapshot current before the round measures what the person has said, so
        // the harness's own snapshot is never mistaken for a steered message.
        let mode = runtime.tools.effective_mode(Some(session));
        let sections = [RuntimeContextSection {
            name: "sandbox:policy".to_owned(),
            text: rooted.policy_statement(mode),
        }];
        runtime.context.record_runtime_context(session, &sections)?;
        // The harness's per-step notes, beside the snapshot: the clock reading (DSH's time context).
        runtime.hooks.record_step_context(session, rounds)?;

        let mut report = runtime
            .context
            .prepare(
                session,
                PrepareOptions {
                    cwd: instruction_cwd.clone(),
                    endpoint: options.endpoint.clone(),
                    model: options.model.clone(),
                    tools: tools.clone(),
                    system: options.system.clone(),
                },
            )
            .await?;

        last_context = Some(ContextSummary {
            estimated_tokens: report.estimated_tokens,
            threshold_tokens: report.threshold_tokens,
            pruned: report.pruned,
            compacted: report.compacted,
        });

        // A listener that ends the round takes it down; the sentence says the failure came from a hook.
        let mut prepared = match runtime.hooks.pre_step(PreStep {
            messages: report.messages.clone(),
            tools: tools.clone(),
            round: rounds,
        }) {
            Ok(prepared) => prepared,
            Err(failure) => return Err(TurnError::Hook(pre_step_failure_message(&failure))),
        };

        // `(id, name, arguments)` for each complete tool call the round asked for.
        let mut calls: Vec<(String, String, String)> = Vec::new();
        let mut round_text = String::new();
        let mut attempt: u32 = 0;
        // The steering window is the model call itself: `prepare` appends to the surface, and counting that
        // would make every turn take an extra round.
        let mut input_before;
        loop {
            input_before = user_input_seqs(runtime.session.as_ref(), session);

            let asked = GenerateRequest {
                endpoint: options.endpoint.clone(),
                model: options.model.clone(),
                messages: prepared.messages.clone(),
                // Empty means none: every adapter then sends no `tools` field, the TypeScript build's rule.
                tools: prepared.tools.clone(),
                max_output_tokens: options.max_output_tokens.map(u64::from),
                reasoning_effort: options.reasoning_effort.clone(),
                session_id: Some(session.id.clone()),
                round: Some(round),
                purpose: options.purpose.clone(),
                ..GenerateRequest::default()
            };
            // The record names the request this step sends, not the one the turn started with (issue #14): the
            // server's running-turn rule on the `model/request` waterfall moves a step to the session's current
            // endpoint, model and level, and a record written from the turn's options logged a step that went to
            // the new model under the old one. DSH's request header names what was actually used. The request is
            // resolved once: the record (route and counts) and the call both take that answer, and the call goes out
            // through `stream_resolved`, which does not run the waterfall again.
            let request = runtime.model.resolve(asked).map_err(TurnError::Model)?;
            runtime.session.model_request(
                session,
                &ModelRequestRecord {
                    endpoint: request.endpoint.clone(),
                    model: request.model.clone(),
                    reasoning_effort: request.reasoning_effort.clone(),
                    messages: request.messages.len(),
                    tools: request.tools.iter().map(|tool| tool.name.clone()).collect(),
                    estimated_tokens: report.estimated_tokens,
                    threshold_tokens: report.threshold_tokens,
                    pruned: report.pruned,
                    compacted: report.compacted,
                    breakdown: report.breakdown,
                    generation: runtime.session.surface(session).content_generation,
                },
            )?;

            let mut stream = runtime.model.stream_resolved(request, cancel.clone());
            let mut failure: Option<ModelError> = None;
            while let Some(item) = stream.next().await {
                match item {
                    Ok(chunk) => {
                        // Recorded as it arrives: an interrupted turn shows the half of the answer that came.
                        runtime.session.assistant_chunk(session, &chunk)?;
                        match &chunk {
                            Chunk::TextDelta { text: delta } => {
                                round_text.push_str(delta);
                                // The round's partial answer is the turn's answer so far (the last non-empty
                                // round), should the stream fail before the round ends; a round with no text
                                // yet leaves the previous answer.
                                progress.text.clone_from(&round_text);
                            }
                            Chunk::ReasoningDelta { text: delta } => {
                                reasoning.push_str(delta);
                                progress.reasoning.push_str(delta);
                            }
                            Chunk::ToolCall(call) => calls.push((
                                call.id.clone(),
                                call.name.clone(),
                                call.arguments.clone(),
                            )),
                            Chunk::ToolCallDelta { .. } => {}
                            Chunk::Done {
                                finish_reason: finished,
                                usage: reported,
                            } => {
                                finish_reason.clone_from(finished);
                                usage = merge_usage(usage, *reported);
                                // Only an abnormal finish is a stop reason worth a notice: `stop` ends the
                                // answer normally and `tool_calls` asks for the next round by design.
                                if is_abnormal_finish(finished) {
                                    ended.push(format!("round {}: {finished}", round + 1));
                                }
                            }
                        }
                    }
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }

            // The recovery path: a provider that refused the call as too long gets one more chance, and
            // only because something durable changed in between — a compaction landing is what makes a
            // retry different from a repeat.
            let Some(error) = failure else { break };
            let Some(code) = error.code.clone() else {
                return Err(TurnError::Model(error));
            };
            if attempt >= options.max_overflow_retries {
                return Err(TurnError::Model(error));
            }
            let action = runtime
                .hooks
                .request_error(&RequestErrorPayload {
                    code,
                    message: error.message.clone(),
                    session: session.clone(),
                    endpoint: options.endpoint.clone(),
                    model: options.model.clone(),
                    cwd: instruction_cwd.clone(),
                    tools: tools.clone(),
                })
                .await;
            if action != Some(RequestErrorAction::Retry) {
                return Err(TurnError::Model(error));
            }
            let generation_before = runtime.session.surface(session).replace_generation;
            let retried = runtime.context.assemble(
                session,
                PrepareOptions {
                    cwd: instruction_cwd.clone(),
                    endpoint: options.endpoint.clone(),
                    model: options.model.clone(),
                    tools: tools.clone(),
                    system: options.system.clone(),
                },
            )?;
            report = retried;
            prepared = PreStep {
                messages: report.messages.clone(),
                tools: tools.clone(),
                round: rounds,
            };
            last_context = Some(ContextSummary {
                estimated_tokens: report.estimated_tokens,
                threshold_tokens: report.threshold_tokens,
                pruned: report.pruned,
                compacted: runtime.session.surface(session).replace_generation > generation_before,
            });
            runtime.session.append(
                session,
                events::TURN_RETRY,
                serde_json::Map::from_iter([
                    ("round".to_owned(), serde_json::json!(round)),
                    ("attempt".to_owned(), serde_json::json!(attempt + 1)),
                    ("code".to_owned(), serde_json::json!(failure_code(&error))),
                    (
                        "estimatedTokens".to_owned(),
                        serde_json::json!(report.estimated_tokens),
                    ),
                    ("compacted".to_owned(), serde_json::json!(report.compacted)),
                ]),
            )?;
            attempt += 1;
        }

        // The turn's answer is its last non-empty round, DSH's rule for what a run hands back (`dsh-subagent`
        // `finalAssistantOutput`: "the last non-empty assistant message"). Adding every round's text fused the remark a
        // model makes before a tool call to its answer in the API's answer, the CLI's printed answer and a child's
        // closing message (live-testing issue #9). The log keeps every round's own message.
        if !round_text.is_empty() {
            text.clone_from(&round_text);
        }
        progress.text.clone_from(&text);

        // A message that arrived while the model was answering is answered by this turn (steering): one that
        // waits in the inbox (a steer) or one written straight to the log (a teammate's mail). DSH takes
        // another step when the turn would end with next-step input pending.
        if calls.is_empty()
            && !has_new_input(
                &input_before,
                &user_input_seqs(runtime.session.as_ref(), session),
            )
            && !runtime.session.has_pending_input(session)
        {
            break;
        }

        // The step's calls run as DSH's loop runs them (`dsh-agent-loop` `runGroup`): a call whose tool is
        // parallel-safe (`Tool::concurrency_safe`, DSH's `isConcurrencySafe`) joins the consecutive safe calls around
        // it in a pool of `tools.maxParallelToolCalls`; any other call runs alone, a barrier between groups. Results
        // commit in model order after each group (`buffered` keeps it), so a call that finishes first is still
        // answered in its place, and the step boundary where steered input is claimed stays after the whole step.
        //
        // Every call the model asked for is answered in the log, even one that cannot run: a call without an
        // answer breaks every later request. A call a stop overtook before it started is answered as interrupted.
        let limit = runtime.tools.max_parallel_tool_calls().max(1);
        let safe = |name: &str| limit > 1 && runtime.tools.is_concurrency_safe(name);
        let run_call = |name: String, arguments: String| {
            let args = parse_arguments(&arguments);
            let context = ToolContext {
                cwd: cwd.clone(),
                session: Some(session.clone()),
                cancel: cancel.clone(),
                log: turn_log(),
            };
            let stopped = &stopped;
            let tools = &runtime.tools;
            async move {
                if stopped() {
                    return ToolResult::refused(
                        codes::INTERRUPTED,
                        "the turn was stopped before this call ran",
                    );
                }
                // A call that escapes the registry (a failing `tools/pre-execute` listener) is still answered,
                // as the TypeScript catch answers it: the stop's sentence when the turn was stopped, else the
                // failure's own.
                match tools.try_call(&name, args, context).await {
                    Ok(result) => result,
                    Err(failure) => ToolResult::refused(
                        codes::INTERRUPTED,
                        if stopped() {
                            "the turn was stopped while this call ran".to_owned()
                        } else {
                            failure.message
                        },
                    ),
                }
            }
        };
        let calls: Vec<(String, String, String)> = calls.into_iter().collect();
        let mut first = 0;
        while first < calls.len() {
            let mut end = first + 1;
            if safe(&calls[first].1) {
                while end < calls.len() && safe(&calls[end].1) {
                    end += 1;
                }
            }
            let group = &calls[first..end];
            // The futures are made first, so the stream holds owned futures rather than a closure over the group's
            // borrows (which a `Send` turn future cannot carry); `buffered` still starts them lazily, in order.
            let pending: Vec<_> = group
                .iter()
                .map(|(_, name, arguments)| run_call(name.clone(), arguments.clone()))
                .collect();
            let results: Vec<ToolResult> = futures::stream::iter(pending)
                .buffered(limit)
                .collect()
                .await;
            for ((id, name, arguments), result) in group.iter().cloned().zip(results) {
                tool_calls.push(ToolCallRecord {
                    name: name.clone(),
                    arguments,
                    result: result.clone(),
                });
                if let Some(error) = &result.error {
                    denials.push(Denial {
                        tool: name,
                        code: error.code.clone(),
                        message: error.message.clone(),
                    });
                    progress.denials = denials.len();
                }
                let mut answer = Message::new(
                    Role::Tool,
                    vec![ContentPart::text(tool_message_text(&result))],
                );
                answer.tool_call_id = Some(id);
                runtime.session.message(session, answer)?;
            }
            first = end;
        }
    }

    // The tools ran; if a stop arrived while they did, the next model call would be wasted.
    if stopped() && !ended.iter().any(|reason| reason == "stopped by the caller") {
        ended.push("stopped by the caller".to_owned());
    }
    if rounds >= max_rounds {
        ended.push(format!("stopped after the round limit of {max_rounds}"));
    }

    let mut completed = serde_json::Map::from_iter([
        ("text".to_owned(), serde_json::json!(text)),
        ("reasoning".to_owned(), serde_json::json!(reasoning)),
        ("finishReason".to_owned(), serde_json::json!(finish_reason)),
        ("rounds".to_owned(), serde_json::json!(rounds)),
        ("denials".to_owned(), serde_json::json!(denials.len())),
    ]);
    if !ended.is_empty() {
        completed.insert("ended".to_owned(), serde_json::json!(ended));
    }
    runtime
        .session
        .append(session, events::ASSISTANT_COMPLETED, completed)?;
    progress.completed = true;
    runtime.session.append(
        session,
        events::TURN_COMPLETED,
        serde_json::Map::from_iter([("rounds".to_owned(), serde_json::json!(rounds))]),
    )?;

    let events = runtime.session.count(session);
    Ok(TurnResult {
        text,
        reasoning,
        tool_calls,
        denials,
        finish_reason,
        events: events.saturating_sub(started),
        rounds,
        context: last_context,
        ended,
        usage,
    })
}

/// The code a refused round is recorded under; the hook payload already carries it.
fn failure_code(error: &ModelError) -> String {
    error.code.clone().unwrap_or_default()
}

/// The loop's log line for a tool call, through the crate's tracing target.
fn turn_log() -> LogSink {
    Arc::new(|message: &str| tracing::info!(target: "heddle_agent", "turn: {message}"))
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
pub(crate) mod tests {
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

    // ---- The loop, judged with doubles: a scripted model, a recording session and a flat context. ----

    use std::collections::{BTreeMap, VecDeque};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use crate::upstream::ContextReport;
    use futures::future::BoxFuture;
    use futures::stream::{self, BoxStream};
    use heddle_tools::{
        ApprovalDecision, ConfinedArgv, DefaultModes, NoToolHooks, SandboxDenial, SandboxGate,
        SandboxOutcome, SandboxUnavailable, Tool, ToolGates, ToolResult, ToolSpec, tool_fn,
    };
    use tokio_util::sync::CancellationToken;

    #[derive(Clone)]
    struct Recorded {
        kind: String,
        fields: serde_json::Map<String, serde_json::Value>,
    }

    struct SessionState {
        events: Vec<Recorded>,
        messages: Vec<Message>,
        nodes: Vec<u64>,
        roles: BTreeMap<u64, Role>,
        next_seq: u64,
        content_generation: u64,
        replace_generation: u64,
    }

    /// A session double: every write is an event, the surface is the nodes written so far, and the messages
    /// it recorded are what the context double derives a request from.
    struct RecordingSession {
        state: Mutex<SessionState>,
        sources: Mutex<Vec<Option<serde_json::Value>>>,
        fail_user_content: AtomicBool,
        /// The folder the session was opened in, `None` for a record with none.
        folder: Mutex<Option<PathBuf>>,
    }

    impl RecordingSession {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                sources: Mutex::new(Vec::new()),
                fail_user_content: AtomicBool::new(false),
                folder: Mutex::new(None),
                state: Mutex::new(SessionState {
                    events: Vec::new(),
                    messages: Vec::new(),
                    nodes: Vec::new(),
                    roles: BTreeMap::new(),
                    next_seq: 1,
                    content_generation: 0,
                    replace_generation: 0,
                }),
            })
        }

        fn push_message(&self, role: Role, text: &str) -> u64 {
            let mut state = self.state.lock().unwrap();
            let seq = state.next_seq;
            state.next_seq += 1;
            state.nodes.push(seq);
            state.roles.insert(seq, role);
            state
                .messages
                .push(Message::new(role, vec![ContentPart::text(text)]));
            state.content_generation += 1;
            state.events.push(Recorded {
                kind: "message".into(),
                fields: serde_json::Map::from_iter([(
                    "message".to_owned(),
                    serde_json::json!({ "role": role, "content": [{ "type": "text", "text": text }] }),
                )]),
            });
            seq
        }

        fn push_user(&self, text: &str) {
            self.push_message(Role::User, text);
        }

        fn sources(&self) -> Vec<Option<serde_json::Value>> {
            self.sources.lock().unwrap().clone()
        }

        fn open_in(&self, folder: &str) {
            *self.folder.lock().unwrap() = Some(PathBuf::from(folder));
        }

        fn fail_user_content(&self, fail: bool) {
            self.fail_user_content.store(fail, Ordering::SeqCst);
        }

        fn messages(&self) -> Vec<Message> {
            self.state.lock().unwrap().messages.clone()
        }

        fn kinds(&self) -> Vec<String> {
            self.state
                .lock()
                .unwrap()
                .events
                .iter()
                .map(|event| event.kind.clone())
                .collect()
        }

        fn event(&self, kind: &str) -> Option<Recorded> {
            self.state
                .lock()
                .unwrap()
                .events
                .iter()
                .find(|event| event.kind == kind)
                .cloned()
        }

        fn bump_replace_generation(&self) {
            self.state.lock().unwrap().replace_generation += 1;
        }
    }

    impl SessionPort for RecordingSession {
        fn count(&self, _: &SessionHandle) -> usize {
            self.state.lock().unwrap().events.len()
        }

        fn user_content(
            &self,
            _: &SessionHandle,
            content: Vec<ContentPart>,
            source: Option<serde_json::Value>,
        ) -> Result<(), PortError> {
            if self.fail_user_content.load(Ordering::SeqCst) {
                return Err(PortError("the session store refused the write".into()));
            }
            self.sources.lock().unwrap().push(source);
            let text = content
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            self.push_message(Role::User, &text);
            Ok(())
        }

        fn surface(&self, _: &SessionHandle) -> SurfaceView {
            let state = self.state.lock().unwrap();
            SurfaceView {
                nodes: state.nodes.clone(),
                content_generation: state.content_generation,
                replace_generation: state.replace_generation,
            }
        }

        fn node_role(&self, _: &SessionHandle, seq: u64) -> Option<Role> {
            self.state.lock().unwrap().roles.get(&seq).copied()
        }

        fn folder(&self, _: &SessionHandle) -> Option<PathBuf> {
            self.folder.lock().unwrap().clone()
        }

        fn model_request(
            &self,
            _: &SessionHandle,
            record: &ModelRequestRecord,
        ) -> Result<(), PortError> {
            let fields = serde_json::to_value(record)
                .ok()
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            self.state.lock().unwrap().events.push(Recorded {
                kind: "model/request".into(),
                fields,
            });
            Ok(())
        }

        fn assistant_chunk(&self, _: &SessionHandle, chunk: &Chunk) -> Result<(), PortError> {
            let fields = serde_json::Map::from_iter([(
                "chunk".to_owned(),
                serde_json::to_value(chunk).unwrap(),
            )]);
            self.state.lock().unwrap().events.push(Recorded {
                kind: "assistant/chunk".into(),
                fields,
            });
            Ok(())
        }

        fn message(&self, _: &SessionHandle, message: Message) -> Result<(), PortError> {
            let text = message
                .content
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            let mut state = self.state.lock().unwrap();
            let seq = state.next_seq;
            state.next_seq += 1;
            state.nodes.push(seq);
            state.roles.insert(seq, message.role);
            let role = message.role;
            state.messages.push(message);
            state.content_generation += 1;
            state.events.push(Recorded {
                kind: "message".into(),
                fields: serde_json::Map::from_iter([(
                    "message".to_owned(),
                    serde_json::json!({ "role": role, "content": [{ "type": "text", "text": text }] }),
                )]),
            });
            Ok(())
        }

        fn append(
            &self,
            _: &SessionHandle,
            kind: &str,
            fields: serde_json::Map<String, serde_json::Value>,
        ) -> Result<(), PortError> {
            self.state.lock().unwrap().events.push(Recorded {
                kind: kind.to_owned(),
                fields,
            });
            Ok(())
        }
    }

    /// One scripted model answer.
    enum Step {
        Chunks(Vec<Chunk>),
        Fail(ModelError),
        /// Some chunks, then a failure mid-stream.
        ChunksThenFail(Vec<Chunk>, ModelError),
    }

    /// A model double: one scripted step per call, and every request kept for the assertions.
    struct ScriptedModel {
        steps: Mutex<VecDeque<Step>>,
        requests: Mutex<Vec<GenerateRequest>>,
        on_stream: Option<Arc<dyn Fn() + Send + Sync>>,
        /// `(endpoint, model, level)` a selection policy moves every call to, as the server's running-turn rule
        /// does on the `model/request` waterfall; `None` sends each request as it was built.
        moves_to: Option<(String, String, String)>,
        /// How many times the loop resolved a request, and how many resolved requests it streamed.
        resolves: std::sync::atomic::AtomicUsize,
        resolved_streams: std::sync::atomic::AtomicUsize,
    }

    impl ScriptedModel {
        fn new(steps: Vec<Step>) -> Arc<Self> {
            Arc::new(Self {
                steps: Mutex::new(steps.into()),
                requests: Mutex::new(Vec::new()),
                on_stream: None,
                moves_to: None,
                resolves: Default::default(),
                resolved_streams: Default::default(),
            })
        }

        fn moving_to(steps: Vec<Step>, endpoint: &str, model: &str, level: &str) -> Arc<Self> {
            Arc::new(Self {
                steps: Mutex::new(steps.into()),
                requests: Mutex::new(Vec::new()),
                on_stream: None,
                moves_to: Some((endpoint.into(), model.into(), level.into())),
                resolves: Default::default(),
                resolved_streams: Default::default(),
            })
        }

        fn with_stream_hook(self: &Arc<Self>, hook: Arc<dyn Fn() + Send + Sync>) -> Arc<Self> {
            Arc::new(Self {
                steps: Mutex::new(std::mem::take(&mut *self.steps.lock().unwrap())),
                requests: Mutex::new(Vec::new()),
                on_stream: Some(hook),
                moves_to: None,
                resolves: Default::default(),
                resolved_streams: Default::default(),
            })
        }

        fn requests(&self) -> Vec<GenerateRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl ModelPort for ScriptedModel {
        fn stream(
            &self,
            request: GenerateRequest,
            _cancel: Option<CancellationToken>,
        ) -> BoxStream<'static, Result<Chunk, ModelError>> {
            self.requests.lock().unwrap().push(request);
            if let Some(hook) = &self.on_stream {
                hook();
            }
            let step = self.steps.lock().unwrap().pop_front();
            let items: Vec<Result<Chunk, ModelError>> = match step {
                Some(Step::Chunks(chunks)) => chunks.into_iter().map(Ok).collect(),
                Some(Step::Fail(error)) => vec![Err(error)],
                Some(Step::ChunksThenFail(chunks, error)) => chunks
                    .into_iter()
                    .map(Ok)
                    .chain(std::iter::once(Err(error)))
                    .collect(),
                None => vec![Ok(Chunk::Done {
                    finish_reason: "stop".into(),
                    usage: None,
                })],
            };
            Box::pin(stream::iter(items))
        }

        fn resolve(&self, mut request: GenerateRequest) -> Result<GenerateRequest, ModelError> {
            self.resolves
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some((endpoint, model, level)) = &self.moves_to {
                request.endpoint.clone_from(endpoint);
                request.model = Some(model.clone());
                request.reasoning_effort = Some(level.clone());
            }
            Ok(request)
        }

        fn stream_resolved(
            &self,
            request: GenerateRequest,
            cancel: Option<CancellationToken>,
        ) -> BoxStream<'static, Result<Chunk, ModelError>> {
            self.resolved_streams
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.stream(request, cancel)
        }

        fn default_endpoint(&self) -> Option<String> {
            Some("scripted".into())
        }
    }

    /// A context double: the request is the messages the session recorded, so the loop's writes reach it.
    struct SurfaceContext {
        session: Arc<RecordingSession>,
    }

    impl SurfaceContext {
        fn report(&self) -> ContextReport {
            let messages = self.session.messages();
            ContextReport {
                estimated_tokens: messages.len() as u64 * 10,
                context_window: 1_000,
                threshold_tokens: 800,
                messages,
                pruned: 0,
                compacted: false,
                instructions: Vec::new(),
                breakdown: Default::default(),
            }
        }
    }

    impl ContextPort for SurfaceContext {
        fn record_runtime_context(
            &self,
            _: &SessionHandle,
            sections: &[RuntimeContextSection],
        ) -> Result<(), PortError> {
            self.session.append(
                &session_handle(),
                "runtime/context",
                serde_json::Map::from_iter([(
                    "sections".to_owned(),
                    serde_json::to_value(sections).unwrap(),
                )]),
            )
        }

        fn prepare<'a>(
            &'a self,
            _: &'a SessionHandle,
            _: PrepareOptions,
        ) -> BoxFuture<'a, Result<ContextReport, PortError>> {
            let report = self.report();
            Box::pin(async move { Ok(report) })
        }

        fn assemble(
            &self,
            _: &SessionHandle,
            _: PrepareOptions,
        ) -> Result<ContextReport, PortError> {
            // A retry is granted because a compaction landed: the double records one and says so.
            self.session.bump_replace_generation();
            let mut report = self.report();
            report.compacted = true;
            Ok(report)
        }
    }

    fn session_handle() -> SessionHandle {
        SessionHandle {
            id: "s".into(),
            dir: "/s".into(),
            transcript: "/s/t".into(),
            meta: "/s/m".into(),
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
        ) -> BoxFuture<'a, Result<crate::upstream::SandboxMode, heddle_tools::EscalationError>>
        {
            Box::pin(async move { Ok(request.effective_mode) })
        }
    }

    struct FlatSandbox;

    impl SandboxGate for FlatSandbox {
        fn workspace_root(&self) -> &std::path::Path {
            std::path::Path::new("/w")
        }
        fn default_mode(&self) -> crate::upstream::SandboxMode {
            crate::upstream::SandboxMode::WorkspaceWrite
        }
        fn escalation_targets(&self) -> Vec<crate::upstream::SandboxMode> {
            Vec::new()
        }
        fn policy(&self, mode: crate::upstream::SandboxMode) -> serde_json::Value {
            serde_json::json!({ "mode": mode })
        }
        fn policy_statement(&self, mode: crate::upstream::SandboxMode) -> String {
            format!("sandbox: {mode}")
        }
        fn assert_writable(
            &self,
            path: &str,
            _: crate::upstream::SandboxMode,
        ) -> Result<PathBuf, SandboxDenial> {
            Ok(PathBuf::from(path))
        }
        fn assert_readable(
            &self,
            path: &str,
            _: crate::upstream::SandboxMode,
        ) -> Result<PathBuf, SandboxDenial> {
            Ok(PathBuf::from(path))
        }
        fn confine(
            &self,
            _: &[String],
            mode: crate::upstream::SandboxMode,
        ) -> Result<ConfinedArgv, SandboxUnavailable> {
            Err(SandboxUnavailable { mode, detail: None })
        }
        fn classify_outcome(&self, _: i32, _: &str, _: Option<&ConfinedArgv>) -> SandboxOutcome {
            SandboxOutcome::Exited
        }
    }

    pub(crate) fn registry_with(tools: Vec<Arc<dyn Tool>>) -> Arc<ToolRegistry> {
        let registry = ToolRegistry::new(ToolGates {
            approvals: Arc::new(AllowAll),
            sandbox: Arc::new(FlatSandbox),
            modes: Arc::new(DefaultModes),
            hooks: Arc::new(NoToolHooks),
        });
        for tool in tools {
            registry.register(tool).unwrap();
        }
        Arc::new(registry)
    }

    fn answering_tool(name: &str, answer: &'static str) -> Arc<dyn Tool> {
        tool_fn(
            ToolSpec {
                name: name.into(),
                description: format!("the {name} tool"),
                parameters: serde_json::json!({}),
            },
            move |_args, _ctx| Box::pin(async move { Ok(ToolResult::ok(answer)) }),
        )
    }

    fn failing_tool(name: &str) -> Arc<dyn Tool> {
        tool_fn(
            ToolSpec {
                name: name.into(),
                description: format!("the {name} tool"),
                parameters: serde_json::json!({}),
            },
            |_args, _ctx| {
                Box::pin(async move { Err(heddle_tools::ToolFailure::Failed("boom".into())) })
            },
        )
    }

    fn stopping_tool(name: &str, token: CancellationToken) -> Arc<dyn Tool> {
        tool_fn(
            ToolSpec {
                name: name.into(),
                description: format!("the {name} tool"),
                parameters: serde_json::json!({}),
            },
            move |_args, _ctx| {
                let token = token.clone();
                Box::pin(async move {
                    token.cancel();
                    Ok(ToolResult::ok("stopped it"))
                })
            },
        )
    }

    fn runtime(
        model: Arc<ScriptedModel>,
        session: Arc<RecordingSession>,
        tools: Arc<ToolRegistry>,
        hooks: Arc<dyn TurnHooks>,
    ) -> AgentRuntime {
        AgentRuntime {
            model,
            session: Arc::clone(&session) as Arc<dyn SessionPort>,
            context: Arc::new(SurfaceContext {
                session: Arc::clone(&session),
            }),
            tools,
            hooks,
            turns: None,
        }
    }

    type Stamps = Arc<Mutex<Vec<(String, std::time::Instant, std::time::Instant)>>>;

    /// A tool that sleeps `ms` and stamps when it ran; parallel-safe or not as asked.
    fn sleepy_tool(name: &str, safe: bool, stamps: Stamps) -> Arc<dyn Tool> {
        let tool = tool_fn(
            ToolSpec {
                name: name.into(),
                description: "sleeps and stamps".into(),
                parameters: serde_json::json!({}),
            },
            move |args, _ctx| {
                let stamps = Arc::clone(&stamps);
                Box::pin(async move {
                    let tag = args
                        .get("tag")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    let ms = args
                        .get("ms")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                    let start = std::time::Instant::now();
                    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                    stamps
                        .lock()
                        .unwrap()
                        .push((tag.clone(), start, std::time::Instant::now()));
                    Ok(ToolResult::ok(format!("ran {tag}")))
                })
            },
        );
        if safe {
            heddle_tools::parallel_safe(tool)
        } else {
            tool
        }
    }

    fn registry_with_limit(tools: Vec<Arc<dyn Tool>>, limit: usize) -> Arc<ToolRegistry> {
        let registry = ToolRegistry::from_config(
            ToolGates {
                approvals: Arc::new(AllowAll),
                sandbox: Arc::new(FlatSandbox),
                modes: Arc::new(DefaultModes),
                hooks: Arc::new(NoToolHooks),
            },
            &heddle_tools::ToolsConfig {
                include_builtins: false,
                max_parallel_tool_calls: limit,
                ..heddle_tools::ToolsConfig::default()
            },
        );
        for tool in tools {
            registry.register(tool).unwrap();
        }
        Arc::new(registry)
    }

    /// One step asking for `calls` (tool, tag, ms), then an answer; the stamps and the tool messages' call ids.
    async fn parallel_step(calls: &[(&str, &str, u64)], limit: usize) -> (Stamps, Vec<String>) {
        let stamps: Stamps = Arc::default();
        let mut chunks: Vec<Chunk> = calls
            .iter()
            .enumerate()
            .map(|(index, (tool, tag, ms))| {
                call_chunk(
                    &format!("c{index}"),
                    tool,
                    serde_json::json!({ "tag": tag, "ms": ms }),
                )
            })
            .collect();
        chunks.push(done("tool_calls"));
        let model = ScriptedModel::new(vec![
            Step::Chunks(chunks),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "done".into(),
                },
                done("stop"),
            ]),
        ]);
        let session = RecordingSession::new();
        let registry = registry_with_limit(
            vec![
                sleepy_tool("sleepy_read", true, Arc::clone(&stamps)),
                sleepy_tool("sleepy_write", false, Arc::clone(&stamps)),
            ],
            limit,
        );
        let runtime = runtime(
            model,
            Arc::clone(&session),
            registry,
            Arc::new(crate::ports::NoTurnHooks),
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "done");
        let ids = session
            .state
            .lock()
            .unwrap()
            .messages
            .iter()
            .filter(|message| message.role == Role::Tool)
            .filter_map(|message| message.tool_call_id.clone())
            .collect();
        (stamps, ids)
    }

    fn stamp(stamps: &Stamps, tag: &str) -> (std::time::Instant, std::time::Instant) {
        let stamps = stamps.lock().unwrap();
        let found = stamps.iter().find(|(name, _, _)| name == tag).unwrap();
        (found.1, found.2)
    }

    fn call_chunk(id: &str, name: &str, arguments: serde_json::Value) -> Chunk {
        Chunk::ToolCall(crate::upstream::ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: arguments.to_string(),
        })
    }

    fn done(finish_reason: &str) -> Chunk {
        Chunk::Done {
            finish_reason: finish_reason.into(),
            usage: None,
        }
    }

    /// R-developer-eight-10: a turn handed its tools the sandbox's root — the directory the server was launched
    /// in — as their folder, so a session of workspace B ran its shell elsewhere. DSH runs a session's tools in
    /// the session's own directory.
    #[tokio::test]
    async fn a_turns_tools_run_in_the_sessions_folder() {
        let session = RecordingSession::new();
        session.open_in("/workspaces/b");
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                call_chunk("c1", "where", serde_json::json!({})),
                done("tool_calls"),
            ]),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "done".into(),
                },
                done("stop"),
            ]),
        ]);
        let seen: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
        let record = Arc::clone(&seen);
        let probe = tool_fn(
            ToolSpec {
                name: "where".into(),
                description: "the folder a call runs in".into(),
                parameters: serde_json::json!({}),
            },
            move |_args, context| {
                *record.lock().unwrap() = Some(context.cwd.clone());
                Box::pin(async move { Ok(ToolResult::ok("noted")) })
            },
        );
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(vec![probe]),
            Arc::new(crate::ports::NoTurnHooks),
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "where am I"),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "done");
        assert_eq!(
            seen.lock().unwrap().clone(),
            Some(PathBuf::from("/workspaces/b")),
            "the tool ran in the session's folder, not the sandbox's root (/w)"
        );
    }

    #[tokio::test]
    async fn a_multi_round_task_runs_each_round_and_feeds_the_results_back() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                call_chunk("c1", "shout", serde_json::json!({ "text": "hi" })),
                done("tool_calls"),
            ]),
            Step::Chunks(vec![
                call_chunk(
                    "c2",
                    "read_file",
                    serde_json::json!({ "path": "shout.txt" }),
                ),
                done("tool_calls"),
            ]),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "finished the task".into(),
                },
                done("stop"),
            ]),
        ]);
        let tools = registry_with(vec![
            answering_tool("shout", "wrote shout.txt"),
            answering_tool("read_file", "the shout"),
        ]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            tools,
            Arc::new(crate::ports::NoTurnHooks),
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "do it"),
        )
        .await
        .unwrap();
        assert_eq!(result.rounds, 3);
        assert_eq!(result.text, "finished the task");
        assert_eq!(result.tool_calls.len(), 2);
        assert_eq!(model.requests().len(), 3);
        // The last request carried the conversation and both tool results.
        let last = model.requests().pop().unwrap();
        assert!(last.messages.len() >= 3, "{}", last.messages.len());
        assert!(
            last.messages.iter().any(|message| {
                message.content.iter().any(
                    |part| matches!(part, ContentPart::Text { text } if text == "wrote shout.txt"),
                )
            }),
            "the tool result reached the next request"
        );
        assert!(result.events > 0);
        let completed = session.event(events::ASSISTANT_COMPLETED).unwrap();
        assert_eq!(completed.fields["text"], "finished the task");
        assert_eq!(completed.fields["rounds"], 3);
    }

    #[tokio::test]
    async fn the_answer_is_the_last_non_empty_round_not_every_round_fused() {
        // Live-testing issue #9: "I'll read both files." and the answer arrived as one run-on text in the API's
        // answer, the CLI's printed answer and a child's closing message. DSH hands back the last non-empty
        // assistant message (dsh-subagent finalAssistantOutput).
        for (last, expected) in [
            ("It says hello.", "It says hello."),
            ("", "I'll read the note."),
        ] {
            let session = RecordingSession::new();
            let model = ScriptedModel::new(vec![
                Step::Chunks(vec![
                    Chunk::TextDelta {
                        text: "I'll read the note.".into(),
                    },
                    call_chunk("c1", "read_file", serde_json::json!({ "path": "note.txt" })),
                    done("tool_calls"),
                ]),
                Step::Chunks(vec![Chunk::TextDelta { text: last.into() }, done("stop")]),
            ]);
            let runtime = runtime(
                Arc::clone(&model),
                Arc::clone(&session),
                registry_with(vec![answering_tool("read_file", "hello")]),
                Arc::new(crate::ports::NoTurnHooks),
            );
            let result = run_turn(
                &runtime,
                RunTurnOptions::new(session_handle(), "scripted", "read the note"),
            )
            .await
            .unwrap();
            assert_eq!(result.rounds, 2);
            assert_eq!(result.text, expected, "last round {last:?}");
        }
    }

    #[tokio::test]
    async fn the_round_limit_ends_the_turn_and_says_so() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                call_chunk("c1", "list_dir", serde_json::json!({})),
                done("tool_calls"),
            ]),
            Step::Chunks(vec![
                call_chunk("c2", "list_dir", serde_json::json!({})),
                done("tool_calls"),
            ]),
            Step::Chunks(vec![
                call_chunk("c3", "list_dir", serde_json::json!({})),
                done("tool_calls"),
            ]),
        ]);
        let tools = registry_with(vec![answering_tool("list_dir", "a")]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            tools,
            Arc::new(crate::ports::NoTurnHooks),
        );
        let mut options = RunTurnOptions::new(session_handle(), "scripted", "keep going");
        options.max_rounds = RoundLimit::Rounds(2);
        let result = run_turn(&runtime, options).await.unwrap();
        assert_eq!(result.rounds, 2);
        assert_eq!(model.requests().len(), 2, "the limit was respected");
        assert!(
            result
                .ended
                .iter()
                .any(|reason| reason.contains("round limit of 2")),
            "{:?}",
            result.ended
        );
        let completed = session.event(events::ASSISTANT_COMPLETED).unwrap();
        assert!(completed.fields.contains_key("ended"));
    }

    #[tokio::test]
    async fn the_model_request_record_names_what_the_step_was_sent() {
        // Issue #14: a selection policy moved the call to the session's current model, and the record still named
        // the model the turn started with, so the log read as if a mid-turn switch had been ignored.
        let session = RecordingSession::new();
        let model = ScriptedModel::moving_to(
            vec![Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "done".into(),
                },
                done("stop"),
            ])],
            "other",
            "model-two",
            "low",
        );
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            Arc::new(crate::ports::NoTurnHooks),
        );
        let mut options = RunTurnOptions::new(session_handle(), "scripted", "answer");
        options.model = Some("model-one".into());
        options.reasoning_effort = Some("high".into());
        run_turn(&runtime, options).await.unwrap();
        let sent = model.requests();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            (
                sent[0].endpoint.as_str(),
                sent[0].model.as_deref(),
                sent[0].reasoning_effort.as_deref()
            ),
            ("other", Some("model-two"), Some("low")),
            "the call carried the resolved selection"
        );
        let record = session.event("model/request").unwrap();
        assert_eq!(record.fields["endpoint"], "other");
        assert_eq!(record.fields["model"], "model-two");
        assert_eq!(record.fields["reasoningEffort"], "low");
    }

    #[tokio::test]
    async fn each_round_resolves_its_request_once_and_streams_that_request() {
        // Issue #14: the request hooks run once per call; the loop streams the very request it recorded.
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                call_chunk("c1", "list_dir", serde_json::json!({})),
                done("tool_calls"),
            ]),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "done".into(),
                },
                done("stop"),
            ]),
        ]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(vec![answering_tool("list_dir", "a")]),
            Arc::new(crate::ports::NoTurnHooks),
        );
        run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "list, then answer"),
        )
        .await
        .unwrap();
        let ordering = std::sync::atomic::Ordering::SeqCst;
        assert_eq!(
            model.resolves.load(ordering),
            2,
            "one resolution per model call"
        );
        assert_eq!(
            model.resolved_streams.load(ordering),
            2,
            "each call streamed its resolved request"
        );
        assert_eq!(model.requests().len(), 2);
    }

    #[tokio::test]
    async fn a_failing_tool_is_answered_and_the_turn_continues() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                call_chunk("c1", "fails", serde_json::json!({})),
                done("tool_calls"),
            ]),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "it was handled".into(),
                },
                done("stop"),
            ]),
        ]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(vec![failing_tool("fails")]),
            Arc::new(crate::ports::NoTurnHooks),
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap();
        assert_eq!(result.denials.len(), 1);
        assert_eq!(result.denials[0].code, "TOOL_FAILED");
        assert_eq!(result.text, "it was handled");
        let requests = model.requests();
        assert_eq!(requests.len(), 2, "the loop asked again with the answer");
        assert!(requests[1].messages.iter().any(|message| {
            message.content.iter().any(|part| matches!(part, ContentPart::Text { text } if text == "error (TOOL_FAILED): boom"))
        }));
    }

    #[tokio::test]
    async fn an_unknown_tool_is_refused_and_the_model_is_told() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                call_chunk("c1", "absent", serde_json::json!({})),
                done("tool_calls"),
            ]),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "understood".into(),
                },
                done("stop"),
            ]),
        ]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            Arc::new(crate::ports::NoTurnHooks),
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap();
        assert_eq!(result.denials[0].code, "UNKNOWN_TOOL");
        assert!(result.denials[0].message.contains("absent"));
    }

    #[tokio::test]
    async fn a_stop_before_a_round_ends_it_without_a_model_call() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![]);
        let token = CancellationToken::new();
        token.cancel();
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            Arc::new(crate::ports::NoTurnHooks),
        );
        let mut options = RunTurnOptions::new(session_handle(), "scripted", "go");
        options.cancel = Some(token);
        let result = run_turn(&runtime, options).await.unwrap();
        assert_eq!(result.rounds, 0);
        assert!(model.requests().is_empty());
        assert_eq!(result.ended, ["stopped by the caller"]);
        let completed = session.event(events::ASSISTANT_COMPLETED).unwrap();
        assert_eq!(
            completed.fields["ended"],
            serde_json::json!(["stopped by the caller"])
        );
    }

    #[tokio::test]
    async fn a_stop_during_a_tool_leaves_every_call_answered() {
        let session = RecordingSession::new();
        let token = CancellationToken::new();
        let model = ScriptedModel::new(vec![Step::Chunks(vec![
            call_chunk("c1", "stop", serde_json::json!({})),
            call_chunk("c2", "read_file", serde_json::json!({})),
            done("tool_calls"),
        ])]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(vec![
                stopping_tool("stop", token.clone()),
                answering_tool("read_file", "should not run"),
            ]),
            Arc::new(crate::ports::NoTurnHooks),
        );
        let mut options = RunTurnOptions::new(session_handle(), "scripted", "go");
        options.cancel = Some(token);
        let result = run_turn(&runtime, options).await.unwrap();
        let tool_results = result
            .tool_calls
            .iter()
            .map(|call| call.result.error.as_ref().map(|error| error.code.clone()))
            .collect::<Vec<_>>();
        assert_eq!(tool_results, [None, Some("INTERRUPTED".to_owned())]);
        assert!(result.ended.contains(&"stopped by the caller".to_owned()));
    }

    #[tokio::test]
    async fn a_message_that_arrives_while_the_model_answers_takes_another_round() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "first".into(),
                },
                done("stop"),
            ]),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: " second".into(),
                },
                done("stop"),
            ]),
        ]);
        let steered = Arc::clone(&session);
        let hook: Arc<dyn Fn() + Send + Sync> = {
            let flag = Arc::new(AtomicBool::new(false));
            Arc::new(move || {
                if !flag.swap(true, Ordering::SeqCst) {
                    steered.push_user("one more thing");
                }
            })
        };
        let model = model.with_stream_hook(hook);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            Arc::new(crate::ports::NoTurnHooks),
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap();
        assert_eq!(
            result.rounds, 2,
            "the steered message was answered by this turn"
        );
        assert_eq!(model.requests().len(), 2);
        // The answer is the last non-empty round, the reply to the steered message (DSH's finalAssistantOutput;
        // issue #9), not both rounds fused.
        assert_eq!(result.text, " second");
    }

    /// Hooks that grant one retry after a failure, the way a compaction listener does.
    struct RetryOnce {
        granted: AtomicBool,
    }

    impl RetryOnce {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                granted: AtomicBool::new(false),
            })
        }
    }

    impl TurnHooks for RetryOnce {
        fn request_error<'a>(
            &'a self,
            _payload: &'a RequestErrorPayload,
        ) -> BoxFuture<'a, Option<RequestErrorAction>> {
            let grant = !self.granted.swap(true, Ordering::SeqCst);
            Box::pin(async move { grant.then_some(RequestErrorAction::Retry) })
        }
    }

    #[tokio::test]
    async fn an_overflow_is_retried_once_when_a_hook_grants_it_and_is_recorded() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Fail(ModelError {
                code: Some("CONTEXT_WINDOW_EXCEEDED".into()),
                message: "too long".into(),
            }),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "after the retry".into(),
                },
                done("stop"),
            ]),
        ]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            RetryOnce::new() as Arc<dyn TurnHooks>,
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "after the retry");
        assert_eq!(model.requests().len(), 2);
        let retry = session.event(events::TURN_RETRY).unwrap();
        assert_eq!(retry.fields["code"], "CONTEXT_WINDOW_EXCEEDED");
        assert_eq!(retry.fields["attempt"], 1);
        assert_eq!(
            retry.fields["compacted"],
            serde_json::json!(true),
            "a compaction landed"
        );
        assert!(result.context.unwrap().compacted);
    }

    #[tokio::test]
    async fn two_parallel_safe_calls_run_together_and_commit_in_model_order() {
        let (stamps, ids) = parallel_step(
            &[("sleepy_read", "slow", 300), ("sleepy_read", "quick", 40)],
            10,
        )
        .await;
        let (slow_start, slow_end) = stamp(&stamps, "slow");
        let (quick_start, quick_end) = stamp(&stamps, "quick");
        assert!(
            quick_start < slow_end,
            "the second started before the first ended"
        );
        assert!(quick_end < slow_end, "and finished first");
        let _ = slow_start;
        assert_eq!(ids, ["c0", "c1"], "yet each is answered in its place");
    }

    #[tokio::test]
    async fn a_parallel_cap_of_one_runs_the_same_calls_one_after_the_other() {
        let (stamps, ids) = parallel_step(
            &[("sleepy_read", "first", 120), ("sleepy_read", "second", 40)],
            1,
        )
        .await;
        assert!(
            stamp(&stamps, "second").0 >= stamp(&stamps, "first").1,
            "serial"
        );
        assert_eq!(ids, ["c0", "c1"]);
    }

    #[tokio::test]
    async fn an_exclusive_call_is_a_barrier_between_parallel_groups() {
        let (stamps, ids) = parallel_step(
            &[
                ("sleepy_read", "before", 120),
                ("sleepy_write", "write", 60),
                ("sleepy_read", "after", 40),
            ],
            10,
        )
        .await;
        assert!(
            stamp(&stamps, "write").0 >= stamp(&stamps, "before").1,
            "the write waited for the read before it"
        );
        assert!(
            stamp(&stamps, "after").0 >= stamp(&stamps, "write").1,
            "the read after it waited for the write"
        );
        assert_eq!(ids, ["c0", "c1", "c2"]);
    }

    #[tokio::test]
    async fn an_uncoded_model_failure_is_not_retried() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![Step::Fail(ModelError {
            code: None,
            message: "the provider broke".into(),
        })]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            RetryOnce::new() as Arc<dyn TurnHooks>,
        );
        let error = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, TurnError::Model(_)));
        assert_eq!(model.requests().len(), 1);
        assert!(
            !session
                .kinds()
                .iter()
                .any(|kind| kind == events::TURN_RETRY)
        );
    }

    #[tokio::test]
    async fn a_failed_turn_is_ended_in_the_log_with_its_error() {
        // Before #16 the log kept only the prompt: a reload or a second tab saw no answer and no failure.
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![Step::Fail(ModelError {
            code: None,
            message: "the provider broke".into(),
        })]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            RetryOnce::new() as Arc<dyn TurnHooks>,
        );
        run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap_err();
        let completed = session
            .event(events::ASSISTANT_COMPLETED)
            .expect("the failed turn is ended in the log");
        assert_eq!(
            completed.fields["ended"],
            serde_json::json!(["failed: the provider broke"])
        );
        assert_eq!(completed.fields["error"], "the provider broke");
        let closed = session.event(events::TURN_COMPLETED).expect("and closed");
        assert_eq!(closed.fields["error"], "the provider broke");
    }

    #[tokio::test]
    async fn a_turn_that_fails_after_a_round_keeps_that_rounds_progress_in_its_record() {
        // developer-five's review of #16: the record used to say text "", rounds 0, whatever the turn had done.
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "looking ".into(),
                },
                call_chunk("c1", "nope", serde_json::json!({})),
                done("tool_calls"),
            ]),
            Step::Fail(ModelError {
                code: None,
                message: "the provider broke".into(),
            }),
        ]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            RetryOnce::new() as Arc<dyn TurnHooks>,
        );
        run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap_err();
        let completed = session
            .event(events::ASSISTANT_COMPLETED)
            .expect("the failed turn is ended in the log");
        assert_eq!(completed.fields["text"], "looking ");
        assert_eq!(completed.fields["rounds"], 2);
        assert_eq!(completed.fields["denials"], 1, "the unknown tool's refusal");
        assert_eq!(
            completed.fields["ended"],
            serde_json::json!(["failed: the provider broke"])
        );
        assert_eq!(
            session
                .kinds()
                .iter()
                .filter(|kind| *kind == events::ASSISTANT_COMPLETED)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn a_stream_that_fails_after_text_keeps_that_partial_text_in_the_record() {
        // developer-five's re-review: the round's text was copied into the progress only when its stream finished.
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![Step::ChunksThenFail(
            vec![Chunk::TextDelta {
                text: "partial ".into(),
            }],
            ModelError {
                code: None,
                message: "the stream broke".into(),
            },
        )]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            RetryOnce::new() as Arc<dyn TurnHooks>,
        );
        run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap_err();
        let completed = session
            .event(events::ASSISTANT_COMPLETED)
            .expect("the failed turn is ended in the log");
        assert_eq!(completed.fields["text"], "partial ");
        assert_eq!(
            completed.fields["ended"],
            serde_json::json!(["failed: the stream broke"])
        );
    }

    #[tokio::test]
    async fn a_stream_cut_by_a_stop_after_text_keeps_that_text_in_the_unfinished_record() {
        // developer-five's third review: the stop must cut a stream that has already streamed text, so the turn
        // reaches record_unfinished (a stream that ends normally after a stop is the ordinary completion).
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![Step::ChunksThenFail(
            vec![Chunk::TextDelta {
                text: "partial ".into(),
            }],
            ModelError {
                code: None,
                message: "the stream was cancelled".into(),
            },
        )]);
        let token = CancellationToken::new();
        let stop = token.clone();
        let model = model.with_stream_hook(Arc::new(move || stop.cancel()));
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            Arc::new(crate::ports::NoTurnHooks),
        );
        let mut options = RunTurnOptions::new(session_handle(), "scripted", "go");
        options.cancel = Some(token);
        run_turn(&runtime, options).await.unwrap_err();
        let completed = session
            .event(events::ASSISTANT_COMPLETED)
            .expect("the stopped turn is ended in the log");
        assert_eq!(completed.fields["text"], "partial ");
        assert_eq!(completed.fields["finishReason"], "aborted");
        assert_eq!(
            completed.fields["ended"],
            serde_json::json!(["stopped by the caller"])
        );
    }

    #[tokio::test]
    async fn a_second_round_cut_after_text_records_that_text_as_the_answer() {
        // The record follows the last-non-empty-round rule (#9): the cut round's partial text replaces the first
        // round's remark; a cut round with no text would keep it (a_turn_that_fails_after_a_round_...).
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "looking ".into(),
                },
                call_chunk("c1", "nope", serde_json::json!({})),
                done("tool_calls"),
            ]),
            Step::ChunksThenFail(
                vec![Chunk::TextDelta {
                    text: "the answer is".into(),
                }],
                ModelError {
                    code: None,
                    message: "the stream broke".into(),
                },
            ),
        ]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            RetryOnce::new() as Arc<dyn TurnHooks>,
        );
        run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap_err();
        let completed = session
            .event(events::ASSISTANT_COMPLETED)
            .expect("the failed turn is ended in the log");
        assert_eq!(completed.fields["text"], "the answer is");
        assert_eq!(completed.fields["rounds"], 2);
        assert_eq!(completed.fields["finishReason"], "error");
    }

    #[tokio::test]
    async fn usage_is_summed_over_the_rounds() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                call_chunk("c1", "read_file", serde_json::json!({})),
                Chunk::Done {
                    finish_reason: "tool_calls".into(),
                    usage: Some(TokenUsage {
                        input_tokens: Some(10),
                        output_tokens: Some(2),
                        ..TokenUsage::default()
                    }),
                },
            ]),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "done".into(),
                },
                Chunk::Done {
                    finish_reason: "stop".into(),
                    usage: Some(TokenUsage {
                        input_tokens: Some(5),
                        cache_read_tokens: Some(7),
                        ..TokenUsage::default()
                    }),
                },
            ]),
        ]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(vec![answering_tool("read_file", "x")]),
            Arc::new(crate::ports::NoTurnHooks),
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap();
        let usage = result.usage.unwrap();
        assert_eq!(usage.input_tokens, Some(15));
        assert_eq!(usage.output_tokens, Some(2));
        assert_eq!(usage.cache_read_tokens, Some(7));
        assert_eq!(usage.cache_write_tokens, None);
    }

    #[tokio::test]
    async fn the_live_turn_is_registered_while_it_runs_and_settled_after() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![Step::Chunks(vec![done("stop")])]);
        let turns = TurnRegistry::new();
        let seen = Arc::new(AtomicBool::new(false));
        let probe = Arc::clone(&seen);
        let registry = turns.clone();
        let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            probe.store(registry.is_running("s"), Ordering::SeqCst);
        });
        let model = model.with_stream_hook(hook);
        let runtime = AgentRuntime {
            model,
            session: Arc::clone(&session) as Arc<dyn SessionPort>,
            context: Arc::new(SurfaceContext {
                session: Arc::clone(&session),
            }),
            tools: registry_with(Vec::new()),
            hooks: Arc::new(crate::ports::NoTurnHooks),
            turns: Some(turns.clone()),
        };
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap();
        assert_eq!(result.rounds, 1);
        assert!(
            seen.load(Ordering::SeqCst),
            "the turn was live while the model ran"
        );
        assert!(!turns.is_running("s"), "and settled after it ended");
    }

    #[tokio::test]
    async fn an_interrupt_stops_the_running_turn() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![Step::Chunks(vec![done("stop")])]);
        let turns = TurnRegistry::new();
        let registry = turns.clone();
        let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            registry.abort("s", Some("lead asked"));
        });
        let model = model.with_stream_hook(hook);
        let runtime = AgentRuntime {
            model,
            session: Arc::clone(&session) as Arc<dyn SessionPort>,
            context: Arc::new(SurfaceContext {
                session: Arc::clone(&session),
            }),
            tools: registry_with(Vec::new()),
            hooks: Arc::new(crate::ports::NoTurnHooks),
            turns: Some(turns),
        };
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap();
        assert!(result.ended.contains(&"stopped by the caller".to_owned()));
    }

    #[tokio::test]
    async fn a_hook_that_refuses_the_pre_step_fails_the_turn_and_says_which_hook() {
        struct Refusing;
        impl TurnHooks for Refusing {
            fn pre_step(&self, _: PreStep) -> Result<PreStep, HookFailure> {
                Err(HookFailure::Refusal("the policy refused this round".into()))
            }
        }
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![]);
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            registry_with(Vec::new()),
            Arc::new(Refusing),
        );
        let error = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "the policy refused this round");
        assert!(
            model.requests().is_empty(),
            "the round never reached the model"
        );
    }

    // ---- The loop and the delegate tool together: the parent side of the subagent claim. ----

    use crate::subagent::{
        SubagentDeps, SubagentError, SubagentLimits, SubagentRun, SubagentStore, subagent_tools,
    };
    use crate::upstream::{CreateSession, SessionEvent, SessionMeta};

    /// A store holding one parent and the child `create` makes, with the child's own log.
    struct DelegationStore {
        parent: SessionMeta,
        child: SessionHandle,
        child_events: Mutex<Vec<SessionEvent>>,
    }

    impl DelegationStore {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                parent: SessionMeta {
                    id: "s".into(),
                    cwd: Some("/w".into()),
                    endpoint: Some("scripted".into()),
                    ..SessionMeta::default()
                },
                child: SessionHandle {
                    id: "child".into(),
                    dir: "/child".into(),
                    transcript: "/child/t".into(),
                    meta: "/child/m".into(),
                },
                child_events: Mutex::new(Vec::new()),
            })
        }
    }

    impl SubagentStore for DelegationStore {
        fn meta(&self, id: &str) -> Option<SessionMeta> {
            (id == self.parent.id).then(|| self.parent.clone())
        }
        fn create(&self, _: CreateSession) -> Result<SessionHandle, PortError> {
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
            _: &SessionHandle,
            _: &SessionHandle,
        ) -> Result<Option<crate::upstream::SandboxMode>, PortError> {
            Ok(None)
        }
    }

    /// Runs the child by writing its answer into the child's log.
    struct AnsweringChild {
        store: Arc<DelegationStore>,
    }

    impl SubagentRun for AnsweringChild {
        fn run<'a>(
            &'a self,
            _child: &'a SessionHandle,
            prompt: String,
            _cancel: Option<CancellationToken>,
        ) -> BoxFuture<'a, Result<(), SubagentError>> {
            Box::pin(async move {
                let mut events = self.store.child_events.lock().unwrap();
                events.push(session_event(1, "model/request", serde_json::json!({})));
                events.push(session_event(
                    2,
                    "assistant/chunk",
                    serde_json::json!({
                        "chunk": { "type": "text-delta", "text": format!("child answer to {prompt}") }
                    }),
                ));
                Ok(())
            })
        }
    }

    fn session_event(seq: u64, kind: &str, fields: serde_json::Value) -> SessionEvent {
        SessionEvent {
            seq,
            at: "t".into(),
            kind: kind.into(),
            fields: fields.as_object().cloned().unwrap_or_default(),
        }
    }

    /// Records each settlement notice instead of handing it to a parent turn.
    #[derive(Default)]
    struct RecordedNotices {
        seen: Mutex<Vec<(String, crate::SettlementNotice)>>,
    }

    impl crate::SubagentDeliver for RecordedNotices {
        fn deliver<'a>(
            &'a self,
            parent: &'a SessionHandle,
            notice: crate::SettlementNotice,
        ) -> BoxFuture<'a, Result<(), SubagentError>> {
            Box::pin(async move {
                self.seen.lock().unwrap().push((parent.id.clone(), notice));
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn a_delegate_call_in_a_turn_returns_the_start_line_at_once_and_the_child_reports_by_notice()
     {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                call_chunk(
                    "c1",
                    "delegate",
                    serde_json::json!({ "prompt": "child task" }),
                ),
                done("tool_calls"),
            ]),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "parent done".into(),
                },
                done("stop"),
            ]),
        ]);
        let store = DelegationStore::new();
        let deps = SubagentDeps {
            store: Arc::clone(&store) as Arc<dyn SubagentStore>,
            run: Arc::new(AnsweringChild {
                store: Arc::clone(&store),
            }),
        };
        let notices = Arc::new(RecordedNotices::default());
        let service = crate::SubagentService::new(
            deps,
            Arc::clone(&notices) as Arc<dyn crate::SubagentDeliver>,
            SubagentLimits::default(),
        );
        let tools = registry_with(subagent_tools(Arc::clone(&service)));
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            tools,
            Arc::new(crate::ports::NoTurnHooks),
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "delegate it"),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "parent done");
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].name, "delegate");
        assert_eq!(
            result.tool_calls[0].result.output, "started subagent child",
            "the result is DSH's start line, not the child's answer"
        );
        assert_eq!(model.requests().len(), 2, "the parent continued at once");
        // The delegation is one tool message in the parent's own log, and the child's log stays its own.
        let tool_messages = session
            .messages()
            .into_iter()
            .filter(|message| message.role == Role::Tool)
            .count();
        assert_eq!(tool_messages, 1);

        assert_eq!(service.settle(&session_handle().id).await, 1);
        let seen = notices.seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "the child reported back once");
        assert_eq!(seen[0].0, session_handle().id, "to its parent");
        assert_eq!(
            seen[0].1.texts,
            vec![
                "Background subagent child finished. It cannot receive follow-up messages."
                    .to_owned(),
                "Its closing message:".to_owned(),
                "child answer to child task".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn begin_turn_makes_the_prompt_and_the_live_turn_durable_before_it_returns() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![Step::Chunks(vec![done("stop")])]);
        let turns = TurnRegistry::new();
        let runtime = AgentRuntime {
            model,
            session: Arc::clone(&session) as Arc<dyn SessionPort>,
            context: Arc::new(SurfaceContext {
                session: Arc::clone(&session),
            }),
            tools: registry_with(Vec::new()),
            hooks: Arc::new(crate::ports::NoTurnHooks),
            turns: Some(turns.clone()),
        };
        let mut options = RunTurnOptions::new(session_handle(), "scripted", "hello");
        options.source = Some(serde_json::json!({ "kind": "team", "member": "one" }));
        let begun = begin_turn(&runtime, options).unwrap();

        // Before the remainder is polled: the live registry knows the session and the prompt is durable.
        assert!(turns.is_running("s"));
        let user_messages = session
            .messages()
            .into_iter()
            .filter(|message| message.role == Role::User)
            .collect::<Vec<_>>();
        assert_eq!(user_messages.len(), 1);
        assert!(
            user_messages[0]
                .content
                .iter()
                .any(|part| matches!(part, ContentPart::Text { text } if text == "hello"))
        );
        assert_eq!(
            session.sources(),
            [Some(serde_json::json!({ "kind": "team", "member": "one" }))],
            "the source is recorded verbatim with the prompt"
        );

        let result = begun.run().await.unwrap();
        assert_eq!(result.rounds, 1);
        assert_eq!(result.text, "");
        assert!(
            !turns.is_running("s"),
            "the finished turn settles its registration"
        );
    }

    #[tokio::test]
    async fn begin_turn_settles_the_registration_when_the_prompt_cannot_be_written() {
        let session = RecordingSession::new();
        session.fail_user_content(true);
        let turns = TurnRegistry::new();
        let runtime = AgentRuntime {
            model: ScriptedModel::new(vec![]),
            session: Arc::clone(&session) as Arc<dyn SessionPort>,
            context: Arc::new(SurfaceContext {
                session: Arc::clone(&session),
            }),
            tools: registry_with(Vec::new()),
            hooks: Arc::new(crate::ports::NoTurnHooks),
            turns: Some(turns.clone()),
        };
        let error = begin_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .unwrap_err();
        assert!(matches!(error, TurnError::Port(_)));
        assert!(
            !turns.is_running("s"),
            "a failed prompt write must not leave the session marked running"
        );
    }

    #[tokio::test]
    async fn a_begun_turn_that_is_dropped_settles_its_registration() {
        let session = RecordingSession::new();
        let turns = TurnRegistry::new();
        let runtime = AgentRuntime {
            model: ScriptedModel::new(vec![]),
            session: Arc::clone(&session) as Arc<dyn SessionPort>,
            context: Arc::new(SurfaceContext {
                session: Arc::clone(&session),
            }),
            tools: registry_with(Vec::new()),
            hooks: Arc::new(crate::ports::NoTurnHooks),
            turns: Some(turns.clone()),
        };
        let begun = begin_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .unwrap();
        assert!(turns.is_running("s"));
        drop(begun);
        assert!(!turns.is_running("s"));
    }

    #[tokio::test]
    async fn a_turn_through_the_real_model_service_runs_a_scripted_task_to_its_answer() {
        let (service, _scripted) = crate::adapters::tests::scripted_service(
            "turn",
            serde_json::json!([
                { "toolCall": { "name": "read_file", "arguments": { "path": "one.txt" } } },
                { "text": "finished the task" }
            ]),
        );
        let session = RecordingSession::new();
        let runtime = AgentRuntime {
            model: Arc::new(crate::adapters::LlmModel::new(service)),
            session: Arc::clone(&session) as Arc<dyn SessionPort>,
            context: Arc::new(SurfaceContext {
                session: Arc::clone(&session),
            }),
            tools: registry_with(vec![answering_tool("read_file", "first")]),
            hooks: Arc::new(crate::ports::NoTurnHooks),
            turns: None,
        };
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "write then read"),
        )
        .await
        .unwrap();
        assert_eq!(result.rounds, 2);
        assert_eq!(result.text, "finished the task");
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].name, "read_file");
        assert_eq!(result.tool_calls[0].result.output, "first");
        assert_eq!(result.finish_reason, "stop");
        let tool_answers = session
            .messages()
            .into_iter()
            .filter(|message| message.role == Role::Tool)
            .collect::<Vec<_>>();
        assert_eq!(tool_answers.len(), 1);
        assert_eq!(
            tool_answers[0].tool_call_id.as_deref(),
            Some("call-read_file")
        );
        let requests = session
            .kinds()
            .into_iter()
            .filter(|kind| kind == "model/request")
            .count();
        assert_eq!(requests, 2, "one model/request per round");
        let completed = session.event(events::ASSISTANT_COMPLETED).unwrap();
        assert_eq!(completed.fields["text"], "finished the task");
    }

    #[tokio::test]
    async fn a_turn_recorded_through_the_real_session_store_writes_what_the_loop_verifier_reads() {
        let (sessions, _sessions_dir) = crate::adapters::tests::sessions_at("verifier");
        let handle = sessions
            .store()
            .create(heddle_session::CreateOptions::default())
            .unwrap();
        let (service, _scripted) = crate::adapters::tests::scripted_service(
            "verifier",
            serde_json::json!([
                { "toolCall": { "name": "write_file", "arguments": { "path": "one.txt", "content": "first" } } },
                { "toolCall": { "name": "read_file", "arguments": { "path": "one.txt" } } },
                { "text": "finished the task" }
            ]),
        );
        let runtime = AgentRuntime {
            model: Arc::new(crate::adapters::LlmModel::new(service)),
            session: Arc::new(crate::adapters::Sessions::new(Arc::clone(&sessions))),
            context: Arc::new(crate::adapters::tests::SessionMessages {
                sessions: Arc::clone(&sessions),
            }),
            tools: registry_with(vec![
                answering_tool("write_file", "wrote 5 bytes to one.txt"),
                answering_tool("read_file", "first"),
            ]),
            hooks: Arc::new(crate::ports::NoTurnHooks),
            turns: Some(TurnRegistry::new()),
        };
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(handle.clone(), "scripted", "write a file then read it"),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "finished the task");
        assert_eq!(result.rounds, 3);

        // What `_verifiers_/50-agentic-loop/check.mjs` reads from the transcript.
        let events = sessions.events(&handle).unwrap();
        let of = |kind: &str| events.iter().filter(|event| event.kind == kind).count();
        assert!(of("model/request") >= 3, "one model/request per round");
        let tool_texts: Vec<String> = events
            .iter()
            .filter(|event| event.kind == "message" && event.fields["message"]["role"] == "tool")
            .map(|event| {
                event.fields["message"]["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<String>()
            })
            .collect();
        assert_eq!(tool_texts.len(), 2, "both tool calls produced a result");
        assert!(
            tool_texts.join("\n").contains("first"),
            "the read came back with what the write wrote"
        );
        let last_request = events
            .iter()
            .rev()
            .find(|event| event.kind == "model/request")
            .unwrap();
        assert!(
            last_request.fields["messages"].as_u64().unwrap() >= 5,
            "the later request carried the conversation and the tool results: {}",
            last_request.fields["messages"]
        );
        assert!(last_request.fields["estimatedTokens"].as_u64().is_some());
        let completed = events
            .iter()
            .find(|event| event.kind == "assistant/completed")
            .expect("the turn was recorded as finished");
        assert_eq!(completed.fields["text"], "finished the task");
        assert_eq!(of("turn/completed"), 1);
        let first_user = events
            .iter()
            .find(|event| event.kind == "message" && event.fields["message"]["role"] == "user")
            .unwrap();
        assert_eq!(
            first_user.fields["message"]["content"][0]["text"],
            "write a file then read it"
        );
    }

    /// A tool that queues a steer in the session's inbox while it runs, and optionally stops the turn: exactly
    /// "a steer sent during a tool call" (R-developer-two-5), through the real store and the real port.
    fn steering_tool(
        sessions: Arc<heddle_session::SessionService>,
        handle: SessionHandle,
        text: &'static str,
        stop: Option<CancellationToken>,
    ) -> Arc<dyn Tool> {
        tool_fn(
            ToolSpec {
                name: "slow_tool".into(),
                description: "stands for a long bash call".into(),
                parameters: serde_json::json!({}),
            },
            move |_args, _ctx| {
                let sessions = Arc::clone(&sessions);
                let handle = handle.clone();
                let stop = stop.clone();
                Box::pin(async move {
                    heddle_session::inbox::queue_steer(
                        sessions.store(),
                        &handle,
                        vec![ContentPart::text(text)],
                        None,
                    )
                    .unwrap();
                    if let Some(stop) = stop {
                        stop.cancel();
                    }
                    Ok(ToolResult::ok("tool finished"))
                })
            },
        )
    }

    fn real_runtime(
        sessions: &Arc<heddle_session::SessionService>,
        steps: serde_json::Value,
        tools: Vec<Arc<dyn Tool>>,
    ) -> (AgentRuntime, crate::adapters::tests::ScratchDir) {
        let (models, scripted) = crate::adapters::tests::scripted_service("steer", steps);
        let runtime = AgentRuntime {
            model: Arc::new(crate::adapters::LlmModel::new(models)),
            session: Arc::new(crate::adapters::Sessions::new(Arc::clone(sessions))),
            context: Arc::new(crate::adapters::tests::SessionMessages {
                sessions: Arc::clone(sessions),
            }),
            tools: registry_with(tools),
            hooks: Arc::new(crate::ports::NoTurnHooks),
            turns: Some(TurnRegistry::new()),
        };
        (runtime, scripted)
    }

    /// The log's messages in order, as `role:text`.
    fn message_order(
        sessions: &heddle_session::SessionService,
        handle: &SessionHandle,
    ) -> Vec<String> {
        sessions
            .events(handle)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "message")
            .map(|event| {
                let message = &event.fields["message"];
                let text: String = message["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect();
                format!("{}:{text}", message["role"].as_str().unwrap())
            })
            .collect()
    }

    #[tokio::test]
    async fn a_steer_sent_during_a_tool_call_is_written_after_its_result_and_answered_by_the_same_turn()
     {
        let (sessions, _sessions_dir) = crate::adapters::tests::sessions_at("steer-order");
        let handle = sessions
            .store()
            .create(heddle_session::CreateOptions::default())
            .unwrap();
        let (runtime, _scripted) = real_runtime(
            &sessions,
            serde_json::json!([
                { "toolCall": { "name": "slow_tool", "arguments": {} } },
                { "text": "answered after the steer" }
            ]),
            vec![steering_tool(
                Arc::clone(&sessions),
                handle.clone(),
                "steered during the tool",
                None,
            )],
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(handle.clone(), "scripted", "run the slow tool"),
        )
        .await
        .unwrap();
        assert_eq!(
            message_order(&sessions, &handle),
            [
                "user:run the slow tool",
                "tool:tool finished",
                "user:steered during the tool"
            ],
            "the steer follows the call's result, never between the call and its answer"
        );
        let events = sessions.events(&handle).unwrap();
        let steer_seq = events
            .iter()
            .find(|event| {
                event.kind == "message"
                    && event.fields["message"]["role"] == "user"
                    && event.fields["message"]["content"][0]["text"] == "steered during the tool"
            })
            .unwrap()
            .seq;
        let requests: Vec<u64> = events
            .iter()
            .filter(|event| event.kind == "model/request")
            .map(|event| event.seq)
            .collect();
        assert!(
            requests.len() == 2 && requests[1] > steer_seq,
            "the next model call is asked after the steer is written"
        );
        assert_eq!(result.text, "answered after the steer");
        assert!(
            heddle_session::inbox::pending_inbox(sessions.store(), &handle)
                .unwrap()
                .next_step
                .is_empty(),
            "nothing is left pending"
        );
    }

    #[tokio::test]
    async fn a_stop_during_a_tool_call_keeps_the_steer_pending_and_the_next_turn_writes_it_before_its_prompt()
     {
        let (sessions, _sessions_dir) = crate::adapters::tests::sessions_at("steer-stop");
        let handle = sessions
            .store()
            .create(heddle_session::CreateOptions::default())
            .unwrap();
        let stop = CancellationToken::new();
        let (runtime, _scripted) = real_runtime(
            &sessions,
            serde_json::json!([
                { "toolCall": { "name": "slow_tool", "arguments": {} } },
                { "text": "never asked" }
            ]),
            vec![steering_tool(
                Arc::clone(&sessions),
                handle.clone(),
                "steered then stopped",
                Some(stop.clone()),
            )],
        );
        let mut options = RunTurnOptions::new(handle.clone(), "scripted", "run then stop");
        options.cancel = Some(stop);
        let stopped = run_turn(&runtime, options).await.unwrap();
        assert!(stopped.ended.contains(&"stopped by the caller".to_owned()));
        assert!(
            !message_order(&sessions, &handle).contains(&"user:steered then stopped".to_owned()),
            "the stopped turn did not write the steer"
        );
        let pending = heddle_session::inbox::pending_inbox(sessions.store(), &handle)
            .unwrap()
            .next_step;
        assert_eq!(
            pending.len(),
            1,
            "the steer is still pending after the stop, as DSH keeps it"
        );
        assert_eq!(
            heddle_session::text_of(&pending[0].content),
            "steered then stopped"
        );

        // The next turn, with a script that answers at once (rounds count from step 0 again).
        let (next_runtime, _next_scripted) = real_runtime(
            &sessions,
            serde_json::json!([{ "text": "both answered" }]),
            Vec::new(),
        );
        let next = run_turn(
            &next_runtime,
            RunTurnOptions::new(handle.clone(), "scripted", "the next prompt"),
        )
        .await
        .unwrap();
        assert_eq!(next.text, "both answered");
        assert_eq!(
            message_order(&sessions, &handle),
            [
                "user:run then stop",
                "tool:tool finished",
                "user:steered then stopped",
                "user:the next prompt"
            ],
            "the kept steer is written after the stopped call's result and before the next prompt"
        );
        assert!(
            heddle_session::inbox::pending_inbox(sessions.store(), &handle)
                .unwrap()
                .next_step
                .is_empty(),
            "nothing is left pending"
        );
    }

    struct BrokenToolHook;

    impl heddle_tools::ToolHooks for BrokenToolHook {
        fn pre_execute(
            &self,
            _: &heddle_tools::ToolCall<'_>,
        ) -> Result<heddle_tools::PreExecute, heddle_tools::ToolHookError> {
            Err(heddle_tools::ToolHookError::new(
                "a hook failed at tools/pre-execute (policy) — typo",
            ))
        }
    }

    #[tokio::test]
    async fn a_failing_pre_execute_listener_is_answered_as_interrupted_and_the_turn_goes_on() {
        let session = RecordingSession::new();
        let model = ScriptedModel::new(vec![
            Step::Chunks(vec![
                call_chunk("c1", "read_file", serde_json::json!({})),
                done("tool_calls"),
            ]),
            Step::Chunks(vec![
                Chunk::TextDelta {
                    text: "carried on".into(),
                },
                done("stop"),
            ]),
        ]);
        let tools = ToolRegistry::new(ToolGates {
            approvals: Arc::new(AllowAll),
            sandbox: Arc::new(FlatSandbox),
            modes: Arc::new(DefaultModes),
            hooks: Arc::new(BrokenToolHook),
        });
        tools
            .register(answering_tool("read_file", "never"))
            .unwrap();
        let runtime = runtime(
            Arc::clone(&model),
            Arc::clone(&session),
            Arc::new(tools),
            Arc::new(crate::ports::NoTurnHooks),
        );
        let result = run_turn(
            &runtime,
            RunTurnOptions::new(session_handle(), "scripted", "go"),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "carried on");
        assert_eq!(result.denials.len(), 1);
        assert_eq!(result.denials[0].code, "INTERRUPTED");
        assert!(result.denials[0].message.contains("tools/pre-execute"));
    }
}
