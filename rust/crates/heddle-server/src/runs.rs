//! Which sessions have a turn in flight — the `running`, `runningSince`, `completedAt` and `controllers`
//! maps of `src/server/web.ts`, as one registry.
//!
//! - **A count, not a flag**: two turns on one session are possible, and a flag would clear the mark of a
//!   session that is still running. The steer route asks it before it accepts a message.
//! - **A clock per turn start**: `running_since` is set when the count goes 0 → 1 and cleared when it returns
//!   to 0, so a new turn starts a fresh clock and a second concurrent turn does not reset the first.
//! - **A completion time**: set when the count returns to 0, so a page that missed the end can decide
//!   against it.
//! - **A cancellation per turn**: a stop cancels every turn of the session that is not already cancelled,
//!   reports how many it cancelled, and forgets them; a second stop finds none.
//!
//! [`TurnGuard`] is what a turn holds: dropping it is the TypeScript `finally`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

/// Milliseconds since the Unix epoch, read from an injectable clock so the rules are testable.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The registry. Cloning shares it.
#[derive(Clone)]
pub struct RunRegistry {
    inner: Arc<Mutex<Runs>>,
    clock: Clock,
}

#[derive(Default)]
struct Runs {
    next: u64,
    running: HashMap<String, usize>,
    since: HashMap<String, u64>,
    completed: HashMap<String, u64>,
    controllers: HashMap<String, Vec<(u64, CancellationToken)>>,
}

/// One session's run state as `/api/sessions` reports it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunSnapshot {
    pub running: bool,
    /// When the running turn began, epoch milliseconds.
    pub running_since: Option<u64>,
    /// When the last turn completed, epoch milliseconds.
    pub turn_completed_at: Option<u64>,
}

impl Default for RunRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl RunRegistry {
    /// A registry on the system clock.
    pub fn new() -> Self {
        todo!()
    }

    /// A registry on the given clock.
    pub fn with_clock(clock: Clock) -> Self {
        todo!()
    }

    /// Mark a turn as started on `session` and register its cancellation. Done before the stream opens, so a
    /// stop that arrives at once still finds it.
    pub fn begin(&self, session: &str) -> TurnGuard {
        todo!()
    }

    /// How many turns are running on `session`.
    pub fn running(&self, session: &str) -> usize {
        todo!()
    }

    pub fn is_running(&self, session: &str) -> bool {
        todo!()
    }

    pub fn running_since(&self, session: &str) -> Option<u64> {
        todo!()
    }

    pub fn completed_at(&self, session: &str) -> Option<u64> {
        todo!()
    }

    pub fn snapshot(&self, session: &str) -> RunSnapshot {
        todo!()
    }

    /// Stop: cancel every turn of `session`, forget their handles, and report how many were not already
    /// cancelled. `0` is not an error — the turn may have ended between the click and the request.
    pub fn abort(&self, session: &str) -> usize {
        todo!()
    }
}

/// A running turn's hold on the registry. Dropping it removes its handle, decrements the count, and on the
/// last turn clears the clock and records the completion time.
pub struct TurnGuard {
    registry: RunRegistry,
    session: String,
    id: u64,
    cancel: CancellationToken,
}

impl TurnGuard {
    pub fn session(&self) -> &str {
        todo!()
    }

    /// The token the turn runner watches; a stop cancels it.
    pub fn cancellation(&self) -> CancellationToken {
        todo!()
    }

    pub fn is_cancelled(&self) -> bool {
        todo!()
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        // Ported with the rest of the registry; until then a guard leaves the registry as it found it.
    }
}

/// An epoch-millisecond instant as `Date.prototype.toISOString` writes it: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso_time(epoch_ms: u64) -> String {
    todo!()
}
