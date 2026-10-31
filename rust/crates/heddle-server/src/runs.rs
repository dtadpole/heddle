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
        Self::with_clock(Arc::new(crate::token::now_ms))
    }

    /// A registry on the given clock.
    pub fn with_clock(clock: Clock) -> Self {
        RunRegistry {
            inner: Arc::new(Mutex::new(Runs::default())),
            clock,
        }
    }

    /// Mark a turn as started on `session` and register its cancellation. Done before the stream opens, so a
    /// stop that arrives at once still finds it.
    pub fn begin(&self, session: &str) -> TurnGuard {
        let now = (self.clock)();
        let cancel = CancellationToken::new();
        let mut runs = self.inner.lock().expect("the run registry lock");
        runs.next += 1;
        let id = runs.next;
        let was_idle = runs.running.get(session).copied().unwrap_or(0) == 0;
        if was_idle {
            runs.since.insert(session.to_owned(), now);
        }
        *runs.running.entry(session.to_owned()).or_insert(0) += 1;
        runs.controllers
            .entry(session.to_owned())
            .or_default()
            .push((id, cancel.clone()));
        TurnGuard {
            registry: self.clone(),
            session: session.to_owned(),
            id,
            cancel,
        }
    }

    /// How many turns are running on `session`.
    pub fn running(&self, session: &str) -> usize {
        self.inner
            .lock()
            .expect("the run registry lock")
            .running
            .get(session)
            .copied()
            .unwrap_or(0)
    }

    pub fn is_running(&self, session: &str) -> bool {
        self.running(session) > 0
    }

    pub fn running_since(&self, session: &str) -> Option<u64> {
        self.inner
            .lock()
            .expect("the run registry lock")
            .since
            .get(session)
            .copied()
    }

    pub fn completed_at(&self, session: &str) -> Option<u64> {
        self.inner
            .lock()
            .expect("the run registry lock")
            .completed
            .get(session)
            .copied()
    }

    pub fn snapshot(&self, session: &str) -> RunSnapshot {
        let runs = self.inner.lock().expect("the run registry lock");
        RunSnapshot {
            running: runs.running.get(session).copied().unwrap_or(0) > 0,
            running_since: runs.since.get(session).copied(),
            turn_completed_at: runs.completed.get(session).copied(),
        }
    }

    /// Stop: cancel every turn of `session`, forget their handles, and report how many were not already
    /// cancelled. `0` is not an error — the turn may have ended between the click and the request.
    pub fn abort(&self, session: &str) -> usize {
        let mut runs = self.inner.lock().expect("the run registry lock");
        let Some(handles) = runs.controllers.remove(session) else {
            return 0;
        };
        let mut stopped = 0;
        for (_, cancel) in handles {
            if !cancel.is_cancelled() {
                stopped += 1;
            }
            cancel.cancel();
        }
        stopped
    }

    /// Shutdown: stop every session's turns, as [`Self::abort`] stops one session's. A restart must end the
    /// commands its turns started and close their calls as interrupted, as DSH's teardown cancels its agents
    /// (live-testing issue #6: the command ran on orphaned and the log recorded nothing).
    pub fn abort_all(&self) -> usize {
        let sessions: Vec<String> = self
            .inner
            .lock()
            .expect("the run registry lock")
            .controllers
            .keys()
            .cloned()
            .collect();
        sessions.iter().map(|session| self.abort(session)).sum()
    }

    /// Whether any session still has a turn in flight; shutdown waits on it after [`Self::abort_all`].
    pub fn any_running(&self) -> bool {
        self.inner
            .lock()
            .expect("the run registry lock")
            .running
            .values()
            .any(|count| *count > 0)
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
        &self.session
    }

    /// The token the turn runner watches; a stop cancels it.
    pub fn cancellation(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        let now = (self.registry.clock)();
        let mut runs = self.registry.inner.lock().expect("the run registry lock");
        if let Some(handles) = runs.controllers.get_mut(&self.session) {
            handles.retain(|(id, _)| *id != self.id);
            if handles.is_empty() {
                runs.controllers.remove(&self.session);
            }
        }
        let remaining = match runs.running.get_mut(&self.session) {
            Some(count) => {
                *count = count.saturating_sub(1);
                *count
            }
            None => 0,
        };
        if remaining == 0 {
            runs.running.remove(&self.session);
            runs.since.remove(&self.session);
            runs.completed.insert(self.session.clone(), now);
        }
    }
}

/// The number of whole days from 1970-01-01 to the civil date, and the civil date itself.
///
/// Howard Hinnant's `civil_from_days`, so a timestamp can be written without a date-time dependency.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365; // [0, 399]
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100); // [0, 365]
    let month_prime = (5 * day_of_year + 2) / 153; // [0, 11]
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1; // [1, 31]
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (year + i64::from(month <= 2), month as u32, day as u32)
}

/// An epoch-millisecond instant as `Date.prototype.toISOString` writes it: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso_time(epoch_ms: u64) -> String {
    let seconds = epoch_ms / 1000;
    let millis = epoch_ms % 1000;
    let days = (seconds / 86_400) as i64;
    let second_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = second_of_day / 3_600;
    let minute = (second_of_day % 3_600) / 60;
    let second = second_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A clock that only moves when a test says so.
    fn stepped_clock(start: u64) -> (Clock, Arc<AtomicU64>) {
        let now = Arc::new(AtomicU64::new(start));
        let handle = Arc::clone(&now);
        let clock: Clock = Arc::new(move || handle.load(Ordering::SeqCst));
        (clock, now)
    }

    #[test]
    fn a_turn_marks_the_session_running_with_a_clock() {
        let (clock, now) = stepped_clock(1_000);
        let registry = RunRegistry::with_clock(clock);
        assert_eq!(registry.running("s"), 0);

        let guard = registry.begin("s");
        assert_eq!(registry.running("s"), 1);
        assert!(registry.is_running("s"));
        assert_eq!(registry.running_since("s"), Some(1_000));
        assert_eq!(registry.completed_at("s"), None);
        assert_eq!(guard.session(), "s");
        assert!(!guard.is_cancelled());
        assert_eq!(
            registry.snapshot("s"),
            RunSnapshot {
                running: true,
                running_since: Some(1_000),
                turn_completed_at: None
            }
        );

        now.store(2_000, Ordering::SeqCst);
        drop(guard);
        assert_eq!(registry.running("s"), 0);
        assert!(!registry.is_running("s"));
        assert_eq!(registry.running_since("s"), None);
        assert_eq!(registry.completed_at("s"), Some(2_000));
    }

    #[test]
    fn a_second_turn_does_not_reset_the_first_clock_and_the_last_drop_completes() {
        let (clock, now) = stepped_clock(100);
        let registry = RunRegistry::with_clock(clock);
        let first = registry.begin("s");
        now.store(200, Ordering::SeqCst);
        let second = registry.begin("s");
        assert_eq!(registry.running("s"), 2);
        // The clock is the first turn's start, not the second's.
        assert_eq!(registry.running_since("s"), Some(100));
        now.store(300, Ordering::SeqCst);
        drop(first);
        assert_eq!(registry.running("s"), 1);
        assert_eq!(registry.running_since("s"), Some(100));
        assert_eq!(registry.completed_at("s"), None);
        now.store(400, Ordering::SeqCst);
        drop(second);
        assert_eq!(registry.running("s"), 0);
        assert_eq!(registry.completed_at("s"), Some(400));
        assert_eq!(registry.running_since("s"), None);
    }

    #[test]
    fn abort_cancels_once_and_reports_what_it_stopped() {
        let (clock, _) = stepped_clock(1);
        let registry = RunRegistry::with_clock(clock);
        let first = registry.begin("s");
        let second = registry.begin("s");
        assert_eq!(registry.abort("s"), 2);
        assert!(first.is_cancelled());
        assert!(second.is_cancelled());
        assert_eq!(registry.abort("s"), 0);
        // A guard whose turn was stopped still cleans up its count when it drops.
        drop(first);
        drop(second);
        assert_eq!(registry.running("s"), 0);
    }

    #[test]
    fn abort_all_stops_every_sessions_turns_and_any_running_follows_the_guards() {
        // Issue #6: a shutdown stops every running turn, then waits for them to settle.
        let (clock, _) = stepped_clock(1);
        let registry = RunRegistry::with_clock(clock);
        assert!(!registry.any_running());
        let one = registry.begin("a");
        let two = registry.begin("b");
        assert!(registry.any_running());
        assert_eq!(registry.abort_all(), 2);
        assert!(one.is_cancelled() && two.is_cancelled());
        assert_eq!(registry.abort_all(), 0, "a second shutdown finds nothing to stop");
        assert!(registry.any_running(), "stopped turns still run until they settle");
        drop(one);
        assert!(registry.any_running());
        drop(two);
        assert!(!registry.any_running());
    }

    #[test]
    fn abort_of_an_unknown_or_idle_session_is_zero() {
        let (clock, _) = stepped_clock(1);
        let registry = RunRegistry::with_clock(clock);
        assert_eq!(registry.abort("nobody"), 0);
        let guard = registry.begin("s");
        assert_eq!(registry.abort("s"), 1);
        assert_eq!(registry.abort("s"), 0);
        drop(guard);
    }

    #[test]
    fn sessions_are_counted_separately() {
        let (clock, _) = stepped_clock(1);
        let registry = RunRegistry::with_clock(clock);
        let one = registry.begin("one");
        let _two = registry.begin("two");
        assert_eq!(registry.running("one"), 1);
        assert_eq!(registry.running("two"), 1);
        assert_eq!(registry.abort("one"), 1);
        assert_eq!(
            registry.running("one"),
            1,
            "a cancelled turn is still in flight"
        );
        assert_eq!(registry.abort("two"), 1);
        drop(one);
    }

    #[test]
    fn iso_time_is_the_javascript_spelling() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_time(1_000), "1970-01-01T00:00:01.000Z");
        // A leap day, and a date before the epoch's first year boundary.
        assert_eq!(iso_time(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
