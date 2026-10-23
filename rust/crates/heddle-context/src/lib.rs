//! `heddle-context` — what a model call is actually sent.
//!
//! The context of a request is derived from the **surface**, the positional view of the
//! append-only session log; it is priced by a deterministic **meter** against a **budget**
//! resolved from the routed endpoint's own window, and when it is over the trigger it is reduced
//! cheaply (**pruning** an oversized tool result) before it is reduced expensively
//! (**compaction**: one summary that shadows the oldest balanced span). Nothing is ever erased:
//! every rewrite is a new event whose surface operation shadows what it replaces.
//!
//! Ported from the TypeScript build's `src/context/`, which follows DSH's mechanisms of the same
//! names, and judged through the `heddle` binary (`HEDDLE_BIN`) by
//! `_verifiers_/30-context-management`.
//!
//! | Module | Ports | What it is |
//! |---|---|---|
//! | [`meter`] | `meter.ts` | the token estimate per node, with a provider-usage anchor |
//! | [`budget`] | `budget.ts` | the trigger and the retained tail, from the endpoint's window |
//! | [`prune`] | `prune.ts` | oversized tool results, rewritten as surface replacements |
//! | [`compaction`] | `compaction.ts` | span selection, summarising, and the one replacement |
//! | [`instructions`] | `instructions.ts` | the project's rule files as one baseline in a byte budget |
//! | [`pairing`] | `pairing.ts` | the repair of a log whose tool calls were left unanswered |
//! | [`runtime`] | `service.ts` (part) | the runtime-context snapshot's text |
//! | [`service`] | `service.ts` | the seam the agent loop talks to; the only place that knows all of the above |
//! | [`events`] | (the log vocabulary) | the session events this crate writes |
//! | [`store`] | `PrunableStore` | the port this crate needs from the session store |
//! | [`types`] | `src/llm/types.ts` (part) | the message types, re-exported from `heddle-llm`, and `text_message` |
//!
//! **Status:** every module is implemented and has unit tests beside it. The message types are
//! `heddle-llm`'s; the `ContextStore` adapter for `heddle-session`'s store is the one piece that waits
//! on another crate, and the crate's `INDEX.md` names it.

pub mod budget;
pub mod compaction;
mod error;
pub mod events;
pub mod instructions;
pub mod meter;
pub mod pairing;
pub mod prune;
pub mod runtime;
pub mod service;
pub mod store;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
mod text;
pub mod types;

pub use budget::{
    Budget, BudgetError, BudgetErrorCode, BudgetInput, BudgetPolicy, BudgetSource, EndpointPolicy,
    resolve_budget,
};
pub use compaction::{
    CompactOptions, CompactionEngine, CompactionOutcome, CompactionPlan, SummarizeError, Summarizer,
};
pub use error::ContextError;
pub use events::ContextEvent;
pub use instructions::{InstructionBaseline, InstructionFile};
pub use meter::{Measurement, MeterInput, MeterNode, TokenMeter};
pub use pairing::repair_tool_pairing;
pub use prune::{PruneConfig, PruneOutcome, ToolResultPruner};
pub use runtime::RuntimeContextSection;
pub use service::{
    AssembleOptions, BaselineOutcome, Breakdown, ContextConfig, ContextDependencies, ContextReport,
    ContextService, ContextSummary, ContextView, ModelAccess, OverflowRequest, PrepareOptions,
    RecoveryDecision, SummaryRequest,
};
pub use store::{
    AppendOptions, ContextStore, LogEvent, SeqRange, StoreError, SurfaceNode, SurfaceOp,
    SurfaceState,
};
pub use types::{ContentPart, Message, Role, TokenUsage, ToolSpec};
