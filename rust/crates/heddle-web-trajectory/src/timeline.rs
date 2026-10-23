//! The timeline's domain and its spans, derived from the ledger's own timings.
//!
//! Ported from `projectTimeline` in `src/server/ledger.ts`. The rules, each because the alternative lies:
//!
//! - **The domain is the recorded span**, earliest start to latest end (or latest start, for running work);
//!   nothing is padded. A zero-width domain is widened to one millisecond.
//! - **A record with no timing contributes no span** — it stays in the ledger, off the axis.
//! - **A running record extends the domain and marks its span running**, never given a duration.
//! - **One span per turn**, carrying the turn index; its kinds are ordered by significance
//!   (`tool, assistant, reasoning, compaction, context, user, system`), and its width is at least `0.02` of the
//!   axis so it can be aimed at.

use serde::{Deserialize, Serialize};

use crate::ledger::{Ledger, LedgerKind};
use crate::rows::LedgerLane;

/// One turn on the axis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSpan {
    pub turn: u32,
    /// A position from 0 to 1 along the domain.
    pub start: f64,
    /// At least `start + 0.02`.
    pub end: f64,
    /// The kinds the span covers, de-duplicated, most significant first.
    pub kinds: Vec<LedgerKind>,
    /// The lanes those kinds belong to, de-duplicated in the same order.
    pub lanes: Vec<LedgerLane>,
    /// How many timed records the span covers.
    pub records: usize,
    /// Whether anything in the span was still running when the events ended.
    pub running: bool,
}

/// The axis and its spans.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub spans: Vec<TimelineSpan>,
    /// The domain's width in milliseconds; `0` when nothing is timed.
    pub duration_ms: u64,
    /// The domain's start as `Date#toISOString` writes it; absent when nothing is timed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starts_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<String>,
}

/// Project a ledger onto a time axis.
pub fn project_timeline(ledger: &Ledger) -> Timeline {
    let _ = ledger;
    todo!("project_timeline")
}
