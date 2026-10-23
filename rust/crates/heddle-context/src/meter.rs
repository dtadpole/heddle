//! Token metering: what a request costs, and which number to believe.
//!
//! A port of `src/context/meter.ts`, itself a port of DSH's `dsh-token-meter` estimate:
//!
//! - **The estimate is deterministic and deliberately low** — four characters per token plus fixed
//!   per-block and per-role overhead. Deterministic is what lets it be a budget trigger; a lower
//!   bound is what makes a provider number below it meaningless.
//! - **Provider usage is a cross-check, never a correction downwards.** It is adopted only for the
//!   same envelope (the surface's content generation is unchanged) and only when it is no lower
//!   than the estimate.
//! - **Route pricing and the heuristic are two fields.** Nothing is route-priced yet, so they agree.
//!
//! Characters are JavaScript characters — UTF-16 code units — so an estimate equals the
//! TypeScript build's for the same request.

use serde::Serialize;

use crate::types::{ContentPart, Message, ToolSpec};

/// Four characters per token, the density DSH's fixed estimate assumes.
pub const CHARS_PER_TOKEN: u64 = 4;
/// Fixed cost of one content block: JSON framing and the type tag.
pub const BLOCK_OVERHEAD: u64 = 4;
/// Fixed cost of one message's role framing.
pub const ROLE_OVERHEAD: u64 = 4;

/// Price one content part.
///
/// Text and reasoning cost `ceil(len / 4) + 4`. A tool call is priced with **two** ceilings, one
/// over the name and one over the arguments, because the halves are framed separately on the wire.
/// Any other block is priced by its JSON serialisation, the honest floor.
pub fn estimate_part(part: &ContentPart) -> u64 {
    let _ = part;
    todo!("estimate_part")
}

/// Price a message's content, block by block, including per-block overhead.
pub fn estimate_content(parts: &[ContentPart]) -> u64 {
    let _ = parts;
    todo!("estimate_content")
}

/// Price one model-visible message.
///
/// A system message pays no per-block framing — an adapter renders the prompt as one string — and
/// an empty one prices zero; every other message is its content plus [`ROLE_OVERHEAD`].
pub fn estimate_message(message: &Message) -> u64 {
    let _ = message;
    todo!("estimate_message")
}

/// Price the tool schemas a request carries: one JSON serialisation plus one block of framing.
/// No tools prices zero.
pub fn estimate_tools(tools: &[ToolSpec]) -> u64 {
    let _ = tools;
    todo!("estimate_tools")
}

/// One priced surface node.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterNode {
    /// The session event this node derives from.
    pub seq: u64,
    /// The price actually used, which is route-priced where a route prices.
    pub tokens: u64,
    /// The fixed-heuristic price, kept even when `tokens` disagrees with it.
    pub heuristic_tokens: u64,
}

/// Where a measurement's total came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BaselineKind {
    /// The provider's usage for the same envelope, at or above the estimate.
    Usage,
    /// The deterministic estimate.
    Estimated,
    /// Nothing to price: no nodes and no tools.
    None,
}

/// The baseline a total rests on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Baseline {
    /// Where it came from.
    pub kind: BaselineKind,
    /// Its value.
    pub tokens: u64,
}

/// One coherent snapshot of a surface's cost.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    /// The number to budget against: the adopted baseline, never below the estimate.
    pub total_tokens: u64,
    /// Where `total_tokens` came from.
    pub baseline: Baseline,
    /// The surface in order, each node priced.
    pub nodes: Vec<MeterNode>,
    /// The part of the estimate that is system prompts.
    pub system_tokens: u64,
    /// The part of the estimate that is the tool schemas.
    pub tools_tokens: u64,
    /// The part of the estimate that is every other message.
    pub message_tokens: u64,
}

/// A provider's usage for the last call, with the surface generation its request was built at.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UsageAnchor {
    /// Input tokens the provider reported.
    pub input_tokens: Option<u64>,
    /// Output tokens the provider reported.
    pub output_tokens: Option<u64>,
    /// The `generation` the `model/request` event recorded.
    pub generation: u64,
}

/// One surface node to price: its seq and the message it derives to.
#[derive(Clone, Copy, Debug)]
pub struct MeteredMessage<'a> {
    /// The node's seq.
    pub seq: u64,
    /// Its message.
    pub message: &'a Message,
}

/// What to measure: the surface, its tools, and any usage for the same envelope.
#[derive(Clone, Copy, Debug)]
pub struct MeterInput<'a> {
    /// The surface in order; nodes that derive to no message are left out by the caller.
    pub nodes: &'a [MeteredMessage<'a>],
    /// The tool schemas the request offers.
    pub tools: &'a [ToolSpec],
    /// The last call's usage, when there is one.
    pub usage: Option<UsageAnchor>,
    /// The surface's current content generation.
    pub generation: u64,
}

/// The meter. A plain value: `measure` is a pure function of its input.
#[derive(Clone, Copy, Debug, Default)]
pub struct TokenMeter;

impl TokenMeter {
    /// Measure one surface, choosing the baseline the total rests on.
    pub fn measure(&self, input: &MeterInput<'_>) -> Measurement {
        let _ = input;
        todo!("TokenMeter::measure")
    }
}
