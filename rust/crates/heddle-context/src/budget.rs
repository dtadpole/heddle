//! The context budget: how large the window is, when to compact, and how much to keep.
//!
//! A port of `src/context/budget.ts`. Its two rules are DSH's:
//!
//! - **The endpoint's own window beats the configured one** — an adapter that declares a window
//!   knows its model; a number in a configuration file is one guess covering every endpoint.
//! - **Retention must sit strictly below the trigger** — a retained tail at least as large as the
//!   threshold could never bring the surface back under it, so such a policy is refused.

use serde::{Deserialize, Serialize};

/// Compact when the estimate reaches this fraction of the window. DSH's default.
pub const THRESHOLD_RATIO: f64 = 0.8;
/// Keep this fraction of the window as recent history, uncompacted. DSH's default.
pub const RETAIN_RATIO: f64 = 0.16;

/// What a caller branches on when a budget cannot be resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BudgetErrorCode {
    /// `NO_CAPACITY`: neither the endpoint nor the configuration gives a window — a configuration
    /// gap a caller may fall back from.
    NoCapacity,
    /// `RETAIN_NOT_BELOW_THRESHOLD`: a policy bug that must not be silently repaired.
    RetainNotBelowThreshold,
}

impl BudgetErrorCode {
    /// The code as the TypeScript build spells it.
    pub fn as_str(self) -> &'static str {
        todo!("BudgetErrorCode::as_str")
    }
}

/// A budget that cannot be resolved, with its code and the TypeScript build's message.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct BudgetError {
    /// What a caller branches on.
    pub code: BudgetErrorCode,
    /// Names the endpoint, or the two numbers that conflict.
    pub message: String,
}

/// The ratios and absolute numbers a caller may override, per plugin or per endpoint.
///
/// An absolute number wins over its ratio when both are set.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BudgetPolicy {
    /// Compact at this fraction of the window.
    pub threshold_ratio: Option<f64>,
    /// Retain this fraction of the window.
    pub retain_ratio: Option<f64>,
    /// An absolute trigger.
    pub threshold_tokens: Option<u64>,
    /// An absolute retained tail.
    pub retain_tokens: Option<u64>,
}

/// A per-endpoint override, matched by endpoint name; it names only what it changes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EndpointPolicy {
    /// The endpoint it applies to.
    pub endpoint: String,
    /// What it changes.
    #[serde(flatten)]
    pub policy: BudgetPolicy,
}

/// Where a budget's window came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetSource {
    /// The routed endpoint (or its model) declared it.
    Endpoint,
    /// The context configuration's `contextWindow`.
    Config,
}

/// The resolved budget for one request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// The window, in tokens.
    pub context_window: u64,
    /// Compact when the measurement reaches this.
    pub threshold_tokens: u64,
    /// Keep a tail priced at least this, verbatim.
    pub retain_tokens: u64,
    /// Where the window came from.
    pub source: BudgetSource,
}

/// What a budget is resolved from.
#[derive(Clone, Copy, Debug, Default)]
pub struct BudgetInput<'a> {
    /// The routed endpoint's name, matched against `policies`.
    pub endpoint: Option<&'a str>,
    /// The endpoint's own window, when its adapter declares one.
    pub endpoint_window: Option<u64>,
    /// The configured window, used when the endpoint declares none.
    pub config_window: Option<u64>,
    /// The configured policy.
    pub config_policy: BudgetPolicy,
    /// Per-endpoint overrides; the first match wins, field by field over `config_policy`.
    pub policies: &'a [EndpointPolicy],
}

/// Resolve the budget for one endpoint.
///
/// The window is the endpoint's, else the configuration's, else [`BudgetErrorCode::NoCapacity`].
/// The first matching per-endpoint entry overrides the configured policy **field by field**; a
/// threshold is `threshold_tokens` or `floor(window × ratio)`, and the same for the tail; a tail at
/// or above the threshold is [`BudgetErrorCode::RetainNotBelowThreshold`].
pub fn resolve_budget(input: &BudgetInput<'_>) -> Result<Budget, BudgetError> {
    let _ = input;
    todo!("resolve_budget")
}
