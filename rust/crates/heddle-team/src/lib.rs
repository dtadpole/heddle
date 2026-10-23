//! `heddle-team` — durable teams, their policy, state and tool.
//!
//! Ported from the TypeScript build: `src/team/`, `src/plugins/team.ts`, and the `/api/team` branch of
//! `src/server/web.ts`. Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/50-agentic-loop`
//! (check-teams) and `_verifiers_/80-web-ui` (check-team-view).
//!
//! **A team is the Lead's session.** Every teammate is a session of its own, attributed by `parentSession`,
//! `origin: 'subagent'`, `delegationDepth: 1` and `teamId`. Everything the team shares — members, tasks, queued
//! and delivered messages — is a `team/*` event in the Lead's append-only log, folded on demand, so nothing
//! about a team lives only in memory and a restarted process resumes it.
//!
//! | Module | What it is |
//! |---|---|
//! | [`state`] | the pure layer: events, the strict fold, member lifecycle, the compare-and-set board, the mailbox ledger |
//! | [`service`] | spawn, send with target-confirmed delivery, the board with journaling, wait, interrupt, recovery |
//! | [`tool`] | the nine model-facing tools as specs and a dispatcher |
//! | [`policy`] | the collaboration policy, written once per session as a durable note |
//! | [`plugin`] | the `team` profile row: composition, policy upkeep, `team/changed`, boot recovery |
//! | [`api`] | the `GET /api/team` answer |
//! | [`ports`] | the seams to the session store, the agent loop and the live-turn registry |
//! | `testing` | in-memory doubles of the ports (feature `test-doubles`) |
//!
//! The contract landed first; bodies that are not yet ported are `todo!()` (see the crate's `INDEX.md`).

pub mod api;
pub mod error;
pub mod plugin;
pub mod policy;
pub mod ports;
pub mod service;
pub mod state;
pub mod tool;

#[cfg(any(test, feature = "test-doubles"))]
pub mod testing;

pub use error::{TeamError, TeamErrorCode, TeamResult};
pub use plugin::{TeamConfig, TeamPlugin, TeamPluginDeps};
pub use ports::{TeamLive, TeamRunner, TeamStore};
pub use service::{TeamDeps, TeamService};
pub use state::{SessionId, TeamState, fold_team};
pub use tool::{TeamTools, ToolOutcome};
