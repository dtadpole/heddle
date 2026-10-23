//! `heddle-agent` — the agentic loop, turns and subagents.
//!
//! Ported from the TypeScript build: `src/agent/loop.ts`, `src/agent/turns.ts`, `src/agent/subagent.ts`,
//! `src/tools/subagent.ts`, `src/plugins/turns.ts`, `src/plugins/subagent-tool.ts`.
//! Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/50-agentic-loop`.
//!
//! The public API is the contract other crates build against; every body is ported, with its unit tests
//! beside it, and the port plan in `INDEX.md` records what each step covers.
//!
//! | Module | What it is |
//! |---|---|
//! | [`turn`] | [`run_turn`], its options and result, and the loop's pure rules |
//! | [`turns`] | [`TurnRegistry`]: which sessions have a turn in flight, and how to stop one |
//! | [`subagent`] | delegation to a child agent in its own session, and the `delegate` tool |
//! | [`ports`] | what a turn asks of the model, session, context and hook services |
//! | [`command`] | the `--turn` command, in the owning crate (D-043) |
//! | [`adapters`] | the turn's ports over the real crates: [`LlmModel`] over `heddle-llm`'s `ModelService` |
//! | [`upstream`] | `heddle-llm`'s own model types, and provisional mirrors of `heddle-session`/`heddle-context` types |

pub mod adapters;
pub mod command;
pub mod ports;
pub mod subagent;
pub mod turn;
pub mod turns;
pub mod upstream;

pub use adapters::LlmModel;
pub use ports::{
    ChainedTurnHooks, ContextPort, HookFailure, ModelError, ModelPort, ModelRequestRecord,
    NoTurnHooks, PortError, PreStep, RequestErrorAction, RequestErrorPayload, SessionPort,
    TurnHooks,
};
pub use subagent::{
    LateSubagentRunner, ParentFacts, SubagentConfig, SubagentDeps, SubagentError,
    SubagentErrorCode, SubagentLimits, SubagentResult, SubagentRun, SubagentStore,
    delegate_subagent, final_assistant_text, parent_facts, register_subagent_row, subagent_runner,
    subagent_tools,
};
pub use turn::{
    AgentRuntime, BegunTurn, ContextSummary, Denial, RoundLimit, RunTurnOptions, ToolCallRecord,
    TurnError, TurnResult, begin_turn, has_new_input, merge_usage, parse_arguments, run_turn,
};
pub use turns::{LiveTurn, TurnRegistry};
