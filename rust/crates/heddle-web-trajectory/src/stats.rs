//! The session's bottom statistics — what the composer's dock prints — and the context panel's sections.
//!
//! Ported from `projectSessionStats` and `contextBreakdownWithFallback` in `src/server/ledger.ts`. One pass over
//! the session's own events: user messages are the turns, `turn/completed.rounds` are the steps, assistant chunks
//! carry the provider's usage per round. Nothing is estimated or multiplied; a figure no event pair measured stays
//! absent so the page prints a blank instead of an invented number.
//!
//! The server's chat route (`GET /api/sessions/{id}`) puts [`session_stats_view`] in its `stats` field.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::usage::TokenUsage;

/// The three meter sections of a request: system prompts, tool schemas, every other message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ContextBreakdown {
    pub system: u64,
    pub tools: u64,
    pub messages: u64,
}

/// The same three sections measured on the session's current surface (`ctx.context.measure`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MeasuredSurface {
    pub system_tokens: u64,
    pub tools_tokens: u64,
    pub message_tokens: u64,
}

/// Which source the context panel's sections came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BreakdownSource {
    /// Recorded by the most recent request.
    Request,
    /// Measured on the current surface, because no request recorded sections.
    Current,
}

/// The sections the panel prints and where they came from; both absent when neither source has them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BreakdownChoice {
    pub context_breakdown: Option<ContextBreakdown>,
    pub context_breakdown_source: Option<BreakdownSource>,
}

/// The dock's figures. Every optional field is skipped when `None`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    /// User messages.
    pub turns: u64,
    /// The sum of every `turn/completed.rounds`.
    pub steps: u64,
    /// The sum of every chunk's provider usage, bucket by bucket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// Over rounds that reported output tokens and whose both ends were recorded: request to closing frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_ms: Option<u64>,
    /// The output tokens of those same rounds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode_tokens: Option<u64>,
    /// Request to closing frame, over every round with both ends recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_ms: Option<u64>,
    /// Call chunk to result message, over every call whose result was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_ms: Option<u64>,
    /// The **sum** of request-to-first-chunk waits; the page divides by `ttftSteps`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_steps: Option<u64>,
    /// The most recent request's recorded sections.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_breakdown: Option<ContextBreakdown>,
    /// The prompt-side total of the most recent round that reported one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_prompt_tokens: Option<u64>,
}

/// The chat route's `stats`: the dock's figures with the panel's sections chosen and their source stated.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatsView {
    /// `contextBreakdown` here is the chosen one (recorded, else measured).
    #[serde(flatten)]
    pub stats: SessionStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_breakdown_source: Option<BreakdownSource>,
}

/// Fold the dock's figures from a session's events.
pub fn project_session_stats(events: &[Value]) -> SessionStats {
    let _ = events;
    todo!("project_session_stats")
}

/// Prefer the sections the request recorded; else the measured ones when any is non-zero; else nothing.
pub fn context_breakdown_with_fallback(
    recorded: Option<ContextBreakdown>,
    measured: Option<MeasuredSurface>,
) -> BreakdownChoice {
    let _ = (recorded, measured);
    todo!("context_breakdown_with_fallback")
}

/// The chat route's `stats` for a session. `measure` is called **only** when no request recorded sections, and
/// a measurement that fails answers `None`.
pub fn session_stats_view(
    events: &[Value],
    measure: impl FnOnce() -> Option<MeasuredSurface>,
) -> SessionStatsView {
    let _ = (events, measure);
    todo!("session_stats_view")
}
