//! Durable tool-result pruning.
//!
//! A port of `src/context/prune.ts`, modelled on DSH's `dsh-compaction-tool-result-pruner`. Pruning
//! is a **surface rewrite**, not an edit made while assembling a request: a pruned result is a new
//! `message` event whose surface operation shadows the original, immediately preceded by a log-only
//! `compaction/prune` event carrying the original's shadow price. The original stays in the log, so
//! a transcript still shows what the tool returned.
//!
//! The rules that look improvable and must not be improved:
//!
//! - **One snapshot, walked in surface order, with a per-result budget.** No ranking, no
//!   "worst first", no sum across results.
//! - **Non-text blocks are never dropped or reordered.**
//! - **The shadow price is logged before the replacement it prices.**
//! - **A result that cannot shrink is not replaced**, so a second pass appends nothing.
//!
//! Lengths are UTF-16 code units, as in the TypeScript build. Where a head or tail boundary would
//! fall inside a surrogate pair, the Rust build keeps the whole character out of the kept part
//! (a JavaScript string can hold a lone surrogate; a Rust `String` cannot) and counts it as removed.

use crate::store::{ContextStore, StoreError};
use crate::types::Message;

/// A tool result longer than this is pruned, in characters.
pub const PRUNE_THRESHOLD_CHARS: usize = 8192;
/// How many characters of a pruned result's start are kept.
pub const PRUNE_HEAD_CHARS: usize = 4096;
/// How many characters of a pruned result's end are kept.
pub const PRUNE_TAIL_CHARS: usize = 1024;
/// What replaces a pruned result's middle, with `N` standing for the count removed.
///
/// Its template length is what the head/tail budget is validated against.
pub const PRUNE_MARKER: &str = "\n… [pruned, N characters removed] …\n";

/// The three character budgets that decide when a result is pruned and how.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PruneConfig {
    /// A result whose text is longer than this is pruned.
    pub threshold_chars: usize,
    /// How much of the start is kept.
    pub head_chars: usize,
    /// How much of the end is kept.
    pub tail_chars: usize,
}

impl Default for PruneConfig {
    /// DSH's numbers: 8192, 4096 and 1024.
    fn default() -> Self {
        Self {
            threshold_chars: PRUNE_THRESHOLD_CHARS,
            head_chars: PRUNE_HEAD_CHARS,
            tail_chars: PRUNE_TAIL_CHARS,
        }
    }
}

/// A text after [`prune_text`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrunedText {
    /// The text, or `head + marker + tail`.
    pub text: String,
    /// Whether it was cut.
    pub pruned: bool,
}

/// Cut a text longer than the threshold to head, marker and tail.
///
/// A text exactly at the threshold is untouched; the marker names the characters removed.
pub fn prune_text(text: &str, config: &PruneConfig) -> PrunedText {
    let _ = (text, config);
    todo!("prune_text")
}

/// A pruning budget whose head, marker and tail do not fit inside its trigger.
///
/// Such a replacement would still be over the threshold and the next pass would prune it forever.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "ToolResultPruner: headChars ({head_chars}) + marker ({marker_chars}) + tailChars ({tail_chars}) = {emitted} must be at most thresholdChars ({threshold_chars})"
)]
pub struct PruneConfigError {
    /// The configured head.
    pub head_chars: usize,
    /// The marker template's length.
    pub marker_chars: usize,
    /// The configured tail.
    pub tail_chars: usize,
    /// Their sum.
    pub emitted: usize,
    /// The configured trigger.
    pub threshold_chars: usize,
}

/// How a pruned result's shadow price is computed; [`crate::meter::estimate_message`] by default.
pub type Estimator = fn(&Message) -> u64;

/// What one pruning pass did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PruneOutcome {
    /// How many tool results were replaced.
    pub pruned: u64,
    /// How many characters the replacements removed, in total.
    pub chars_removed: u64,
}

/// Rewrites every over-budget tool result on a session's surface as a durable replacement.
#[derive(Clone, Copy, Debug)]
pub struct ToolResultPruner {
    config: PruneConfig,
    estimate: Estimator,
}

impl ToolResultPruner {
    /// A pruner with this budget and the meter's estimate, refusing a budget that cannot work.
    pub fn new(config: PruneConfig) -> Result<Self, PruneConfigError> {
        let _ = config;
        todo!("ToolResultPruner::new")
    }

    /// A pruner with this budget and its own shadow-price estimator.
    pub fn with_estimator(
        config: PruneConfig,
        estimate: Estimator,
    ) -> Result<Self, PruneConfigError> {
        let _ = (config, estimate);
        todo!("ToolResultPruner::with_estimator")
    }

    /// The budget in force.
    pub fn config(&self) -> &PruneConfig {
        &self.config
    }

    /// Rewrite every over-budget tool result as a surface replacement.
    ///
    /// For each `tool` node over the threshold: append `compaction/prune` (`shadowedRange`,
    /// `shadowedSeqs`, `shadowedTokenCount` — the estimator's price of the **original**), then a
    /// `message` whose content differs only in its pruned text parts, replacing that one node and
    /// citing it in `sourceEventSeqs`. A node whose parts are each under the threshold is left alone.
    pub fn prune_session<S: ContextStore>(
        &self,
        store: &S,
        session: &S::Handle,
    ) -> Result<PruneOutcome, StoreError> {
        let _ = (store, session, self.estimate);
        todo!("ToolResultPruner::prune_session")
    }
}

impl Default for ToolResultPruner {
    /// DSH's budget, which always fits, with the meter's estimate.
    fn default() -> Self {
        todo!("ToolResultPruner::default")
    }
}
