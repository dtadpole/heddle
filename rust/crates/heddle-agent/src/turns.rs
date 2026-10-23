//! The live-turn registry: which sessions have a turn in flight **right now**, and how to stop one.
//!
//! Ported from `src/agent/turns.ts` and `src/plugins/turns.ts`. Durable logs cannot say "running" — a
//! running turn is a fact about this process — so the team layer (`list_agents`, `interrupt_agent`) and
//! the server's Stop read it here. A session may have several turns in flight (the server allows it), so
//! the registry keeps a set per session: one interruption stops every turn of the subject, and the session
//! is running while at least one remains.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

/// One session's live turns: each turn's key and token.
type LiveTurns = Vec<(u64, CancellationToken)>;

#[derive(Default)]
struct Inner {
    /// Per session, in the order sessions first began a turn.
    sessions: Mutex<Vec<(String, LiveTurns)>>,
    next: AtomicU64,
}

impl Inner {
    fn remove(&self, session_id: &str, key: u64) {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(index) = sessions.iter().position(|(id, _)| id == session_id) {
            sessions[index].1.retain(|(existing, _)| *existing != key);
            if sessions[index].1.is_empty() {
                sessions.remove(index);
            }
        }
    }
}

/// The live-turn registry. Cheap to clone; clones share one table.
#[derive(Clone, Default)]
pub struct TurnRegistry {
    inner: Arc<Inner>,
}

/// One registered turn. Settled when dropped, so an early return or a panic cannot leave a session
/// reading as running.
pub struct LiveTurn {
    inner: Arc<Inner>,
    session_id: String,
    key: u64,
    token: CancellationToken,
    settled: AtomicBool,
}

impl LiveTurn {
    /// Cancelled when the session is interrupted, or when the caller's own token (if one was given to
    /// [`TurnRegistry::begin`]) is cancelled — both are honoured, neither replaces the other.
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }

    /// Mark this turn finished; safe to call twice.
    pub fn settle(&self) {
        if !self.settled.swap(true, Ordering::SeqCst) {
            self.inner.remove(&self.session_id, self.key);
        }
    }
}

impl Drop for LiveTurn {
    fn drop(&mut self) {
        self.settle();
    }
}

impl TurnRegistry {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a turn of `session_id`.
    ///
    /// The returned token is a child of `caller` when one is given, which is the Rust form of the
    /// TypeScript `AbortSignal.any([caller, live])`: a person's Stop and an interrupt both stop the turn,
    /// and an interrupt does not cancel the caller's own token.
    pub fn begin(&self, session_id: &str, caller: Option<&CancellationToken>) -> LiveTurn {
        let token = caller.map_or_else(CancellationToken::new, CancellationToken::child_token);
        let key = self.inner.next.fetch_add(1, Ordering::SeqCst);
        {
            let mut sessions = self
                .inner
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match sessions.iter_mut().find(|(id, _)| id == session_id) {
                Some((_, turns)) => turns.push((key, token.clone())),
                None => sessions.push((session_id.to_owned(), vec![(key, token.clone())])),
            }
        }
        LiveTurn {
            inner: Arc::clone(&self.inner),
            session_id: session_id.to_owned(),
            key,
            token,
            settled: AtomicBool::new(false),
        }
    }

    /// Whether `session_id` has a turn in flight.
    pub fn is_running(&self, session_id: &str) -> bool {
        let sessions = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions
            .iter()
            .any(|(id, turns)| id == session_id && !turns.is_empty())
    }

    /// Every session with a turn in flight, in the order each first began one.
    pub fn running(&self) -> Vec<String> {
        let sessions = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions.iter().map(|(id, _)| id.clone()).collect()
    }

    /// Stop every turn in flight for one session; whether there was one to stop. `reason` is logged.
    pub fn abort(&self, session_id: &str, reason: Option<&str>) -> bool {
        let tokens: Vec<CancellationToken> = {
            let sessions = self
                .inner
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match sessions.iter().find(|(id, _)| id == session_id) {
                Some((_, turns)) if !turns.is_empty() => {
                    turns.iter().map(|(_, token)| token.clone()).collect()
                }
                _ => return false,
            }
        };
        tracing::info!(target: "heddle_agent", session = session_id, reason = reason.unwrap_or("interrupted"), "turn interrupted");
        for token in tokens {
            token.cancel();
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_runs_while_any_of_its_turns_is_live() {
        let registry = TurnRegistry::new();
        let first = registry.begin("s", None);
        let second = registry.begin("s", None);
        assert!(registry.is_running("s"));
        first.settle();
        assert!(registry.is_running("s"), "one turn remains");
        drop(second);
        assert!(
            !registry.is_running("s"),
            "dropping the last turn settles it"
        );
        assert!(registry.running().is_empty());
    }

    #[test]
    fn settling_twice_is_harmless() {
        let registry = TurnRegistry::new();
        let turn = registry.begin("s", None);
        let other = registry.begin("s", None);
        turn.settle();
        turn.settle();
        assert!(
            registry.is_running("s"),
            "the second settle did not remove the other turn"
        );
        drop(other);
    }

    #[test]
    fn an_interrupt_stops_every_turn_of_the_session_and_only_that_session() {
        let registry = TurnRegistry::new();
        let a1 = registry.begin("a", None);
        let a2 = registry.begin("a", None);
        let b = registry.begin("b", None);
        assert!(registry.abort("a", Some("lead asked")));
        assert!(a1.token().is_cancelled() && a2.token().is_cancelled());
        assert!(!b.token().is_cancelled());
        assert!(!registry.abort("nobody", None), "nothing to stop");
    }

    #[test]
    fn the_caller_stop_reaches_the_turn_but_an_interrupt_does_not_reach_the_caller() {
        let registry = TurnRegistry::new();
        let caller = CancellationToken::new();
        let turn = registry.begin("s", Some(&caller));
        registry.abort("s", None);
        assert!(turn.token().is_cancelled());
        assert!(!caller.is_cancelled());

        let caller = CancellationToken::new();
        let turn = registry.begin("t", Some(&caller));
        caller.cancel();
        assert!(turn.token().is_cancelled());
    }

    #[test]
    fn running_sessions_are_listed_in_the_order_they_began() {
        let registry = TurnRegistry::new();
        let _b = registry.begin("b", None);
        let _a = registry.begin("a", None);
        let _b2 = registry.begin("b", None);
        assert_eq!(registry.running(), ["b", "a"]);
    }
}
