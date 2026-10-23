//! Compaction: condensing the oldest part of a surface into one checkpoint.
//!
//! A port of `src/context/compaction.ts`, modelled on DSH's `dsh-compaction-basic`. What makes it
//! safe to run on a conversation somebody is having:
//!
//! - **The log is never rewritten.** A compaction appends `compaction/start`, `compaction/summary`,
//!   one `context/note` replacement whose surface operation shadows the span, `compaction/end` and
//!   `compaction/measured`; the shadowed events stay readable.
//! - **The cut is balanced.** No span separates an answered tool call from its result; the cut walks
//!   backwards until the pairing balances. The system prompt is never shadowed.
//! - **A summary that does not shrink is refused** and recorded as `compaction/failed`, and the
//!   surface is left exactly as it was.
//! - **The summariser replays the real prefix**: the system node, the span, then the instruction.
//! - **Pruning comes first**, and if it clears the pressure nothing is summarised.
//!
//! Unlike the TypeScript class, the engine does not hold the store: each call is given it, so one
//! engine serves every session and a test hands it a double.

use futures::future::BoxFuture;
use serde::Serialize;

use crate::budget::Budget;
use crate::error::ContextError;
use crate::meter::Measurement;
use crate::prune::ToolResultPruner;
use crate::store::{ContextStore, SurfaceNode};
use crate::types::Message;

/// What the summariser is asked: the final user message of the auxiliary call.
pub const COMPACTION_INSTRUCTION: &str = "Summarise the conversation above so it can continue without the original messages. \
Keep every decision, constraint, file path, command and result that still matters. \
Keep unresolved questions and what was tried. Drop greetings and repetition. \
Write it as a briefing to yourself, not as a reply to the user.";

/// Opens a checkpoint's text, so a reader can tell it from something a person said.
pub const SUMMARY_OPEN_TAG: &str = "<compacted-summary>";
/// Closes a checkpoint's text.
pub const SUMMARY_CLOSE_TAG: &str = "</compacted-summary>";

/// The span one compaction will shadow, chosen before anything is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionPlan {
    /// The seq at the span's first position.
    pub from_seq: u64,
    /// The seq at the span's last position.
    pub through_seq: u64,
    /// Every seq in the span, in surface order — not necessarily ascending.
    pub shadowed_seqs: Vec<u64>,
    /// What is kept verbatim, newest last.
    pub retained_seqs: Vec<u64>,
    /// The span's price, which the checkpoint has to beat.
    pub shadowed_tokens: u64,
}

/// What a compaction did, in numbers a caller can report.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionOutcome {
    /// Whether a replacement landed.
    pub compacted: bool,
    /// Why not, when it did not and there was a reason to give.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// How many oversized tool results were rewritten before a summary was considered.
    pub pruned: u64,
    /// The measurement the decision was taken on.
    pub before: u64,
    /// The measurement afterwards.
    pub after: u64,
    /// The span, when one was chosen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<CompactionPlan>,
    /// The `compaction/failed` event, when the summary was refused.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_seq: Option<u64>,
    /// The `compaction/summary` event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_seq: Option<u64>,
    /// The replacement `context/note`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_seq: Option<u64>,
}

/// A summariser that could not answer; recorded as a refusal, never raised.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SummarizeError(pub String);

/// One model call that returns the summary text for the replayed prefix.
///
/// Passed in rather than reached for, so the engine has no model of its own and a test compacts
/// without spending anything. A closure `Fn(Vec<Message>) -> impl Future<Output = Result<String,
/// SummarizeError>>` is a summariser.
pub trait Summarizer: Send + Sync {
    /// Summarise `messages`: the system node, the span, and [`COMPACTION_INSTRUCTION`].
    fn summarize(&self, messages: Vec<Message>) -> BoxFuture<'_, Result<String, SummarizeError>>;
}

impl<F, Fut> Summarizer for F
where
    F: Fn(Vec<Message>) -> Fut + Send + Sync,
    Fut: Future<Output = Result<String, SummarizeError>> + Send + 'static,
{
    fn summarize(&self, messages: Vec<Message>) -> BoxFuture<'_, Result<String, SummarizeError>> {
        Box::pin(self(messages))
    }
}

/// Take a fresh measurement of the session — after a prune, and after a replacement.
pub type MeasureFn<'a> = dyn Fn() -> Result<Measurement, ContextError> + Send + Sync + 'a;

/// What a compaction needs from whoever calls it.
#[derive(Clone, Copy)]
pub struct CompactOptions<'a> {
    /// The budget for the routed endpoint.
    pub budget: Budget,
    /// The measurement the decision is taken on.
    pub measurement: &'a Measurement,
    /// The model call that writes the summary.
    pub summarizer: &'a dyn Summarizer,
    /// A fresh measurement on demand.
    pub measure: &'a MeasureFn<'a>,
    /// Overflow recovery: ignore the trigger and the retained tail and take one maximal balanced
    /// reduction. Read by [`CompactionEngine::compact_if_needed`] only.
    pub force: bool,
}

/// Wrap a summary the way the model should read it: one user message,
/// `<compacted-summary>\n{trimmed}\n</compacted-summary>`.
pub fn frame_summary(summary: &str) -> Message {
    let _ = summary;
    todo!("frame_summary")
}

/// Whether cutting the surface before `index` keeps every **answered** tool call paired.
///
/// A call the surface never answers is ignored rather than counted as open, or one stopped call
/// would make the whole conversation un-compactable.
pub fn tool_pairing_balanced_before(nodes: &[SurfaceNode], index: usize) -> bool {
    let _ = (nodes, index);
    todo!("tool_pairing_balanced_before")
}

/// The compaction engine: prune, choose a span, summarise it, shadow it.
#[derive(Clone, Copy, Debug, Default)]
pub struct CompactionEngine {
    pruner: ToolResultPruner,
}

impl CompactionEngine {
    /// An engine that prunes with `pruner` before it summarises.
    pub fn new(pruner: ToolResultPruner) -> Self {
        Self { pruner }
    }

    /// The pruner it runs first.
    pub fn pruner(&self) -> &ToolResultPruner {
        &self.pruner
    }

    /// Choose the span to shadow, or `None` when there is nothing safe to take.
    ///
    /// Start at the first node that is not the system prompt, keep a tail priced at
    /// `retain_tokens` (the budget's when `None`) verbatim, and walk the cut backwards until no tool
    /// call is separated from its result. Fails with [`ContextError::SurfaceMismatch`] when the
    /// measurement is of a different surface than the store's.
    pub fn plan<S: ContextStore>(
        &self,
        store: &S,
        session: &S::Handle,
        budget: &Budget,
        measurement: &Measurement,
        retain_tokens: Option<u64>,
    ) -> Result<Option<CompactionPlan>, ContextError> {
        let _ = (store, session, budget, measurement, retain_tokens);
        todo!("CompactionEngine::plan")
    }

    /// Summarise a planned span and shadow it, or record why it was not shadowed.
    ///
    /// A failed or empty summary, or a checkpoint whose estimate is not below the span's price, is
    /// recorded as `compaction/failed` with `refused: true` and leaves the surface untouched.
    pub async fn compact<S: ContextStore>(
        &self,
        store: &S,
        session: &S::Handle,
        plan: &CompactionPlan,
        options: &CompactOptions<'_>,
    ) -> Result<CompactionOutcome, ContextError> {
        let _ = (store, session, plan, options);
        todo!("CompactionEngine::compact")
    }

    /// The whole per-round policy: prune first, then summarise only if still over the trigger.
    ///
    /// With `force`, the trigger and the retained tail are both ignored.
    pub async fn compact_if_needed<S: ContextStore>(
        &self,
        store: &S,
        session: &S::Handle,
        options: &CompactOptions<'_>,
    ) -> Result<CompactionOutcome, ContextError> {
        let _ = (store, session, options);
        todo!("CompactionEngine::compact_if_needed")
    }
}
