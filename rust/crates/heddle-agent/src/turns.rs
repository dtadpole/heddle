//! The live-turn registry: which sessions have a turn in flight **right now**, and how to stop one.
//!
//! Ported from `src/agent/turns.ts` and `src/plugins/turns.ts`. Durable logs cannot say "running" — a
//! running turn is a fact about this process — so the team layer (`list_agents`, `interrupt_agent`) and
//! the server's Stop read it here. A turn begun through [`TurnRegistry::begin_queued`] waits for every turn
//! already in flight or queued on its session, so one session runs one turn at a time (#28; DSH's follow-up).
//! [`TurnRegistry::begin`] registers without waiting, so the registry still keeps a set per session: one
//! interruption stops every turn of the subject, and the session is running while at least one remains.

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
    /// Woken whenever a session's last live turn is removed, for [`TurnRegistry::when_idle`].
    idle: tokio::sync::Notify,
    /// Per session, the queue a [`TurnRegistry::begin_queued`] turn waits in. tokio's mutex grants its lock in
    /// request order, so the turns run in the order they arrived.
    queues: Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
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
                drop(sessions);
                self.idle.notify_waiters();
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
    /// The queue place of a [`TurnRegistry::begin_queued`] turn, released when the turn settles.
    place: Mutex<Option<tokio::sync::OwnedMutexGuard<()>>>,
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
            // After the removal, so the next queued turn finds the session idle.
            drop(
                self.place
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take(),
            );
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
            place: Mutex::new(None),
        }
    }

    /// Register a turn of `session_id` once every turn already in flight or queued on it has settled, in
    /// arrival order (#28).
    ///
    /// Measured before: two `POST /api/turn` for one session 300 ms apart both ran, interleaved their writes in
    /// one log, and the first turn's next request carried the second's exchange, which the provider refused.
    /// DSH admits a prompt sent to a busy session as a follow-up (`agent.followup`) and claims it after the
    /// running turn. The wait is first for the turns queued before this one, then for any turn registered
    /// without queueing ([`TurnRegistry::begin`]). A caller cancelled while it waits still gets its turn, which
    /// its cancelled token then stops at once, so the prompt it sent is recorded with the stop.
    pub async fn begin_queued(
        &self,
        session_id: &str,
        caller: Option<&CancellationToken>,
    ) -> LiveTurn {
        let queue = {
            let mut queues = self
                .inner
                .queues
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Arc::clone(queues.entry(session_id.to_owned()).or_default())
        };
        let place = queue.lock_owned().await;
        self.when_idle(session_id).await;
        let live = self.begin(session_id, caller);
        *live
            .place
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(place);
        live
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

    /// Resolve once `session_id` has no turn in flight: at once when it has none now, otherwise when its
    /// last live turn settles.
    ///
    /// A background child's settlement notice needs it (`TurnRegistry.whenIdle` in the TypeScript build): a
    /// notice written into a running turn is answered by that turn only if the turn notices it before ending,
    /// so the deliverer waits here and then checks. The waiter is registered **before** the check, so a turn
    /// that settles between the check and the wait cannot be missed.
    pub async fn when_idle(&self, session_id: &str) {
        loop {
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.is_running(session_id) {
                return;
            }
            notified.await;
        }
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

    #[tokio::test]
    async fn a_queued_turn_waits_for_the_running_one_and_the_queue_keeps_arrival_order() {
        let registry = TurnRegistry::new();
        let running = registry.begin_queued("s", None).await;
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut waiting = Vec::new();
        for name in ["second", "third"] {
            let (registry, order) = (registry.clone(), Arc::clone(&order));
            waiting.push(tokio::spawn(async move {
                let turn = registry.begin_queued("s", None).await;
                order.lock().expect("the order lock").push(name);
                // While this turn runs, no other turn of the session does.
                tokio::task::yield_now().await;
                assert_eq!(
                    registry.inner.sessions.lock().expect("sessions")[0].1.len(),
                    1
                );
                turn.settle();
            }));
            // Let the task reach the queue before the next one is spawned, so arrival order is defined.
            for _ in 0..10 {
                tokio::task::yield_now().await;
            }
        }
        assert!(
            order.lock().expect("the order lock").is_empty(),
            "nothing ran beside the running turn"
        );
        running.settle();
        for task in waiting {
            task.await.expect("the queued turn ran");
        }
        assert_eq!(
            *order.lock().expect("the order lock"),
            vec!["second", "third"]
        );
        assert!(!registry.is_running("s"));
    }

    #[tokio::test]
    async fn a_turn_on_an_idle_session_does_not_wait_and_other_sessions_never_wait() {
        let registry = TurnRegistry::new();
        let a = registry.begin_queued("a", None).await;
        let b = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            registry.begin_queued("b", None),
        )
        .await
        .expect("another session's turn begins at once");
        // A turn registered without queueing is waited for as well.
        let unqueued = registry.begin("c", None);
        let registry2 = registry.clone();
        let c = tokio::spawn(async move { registry2.begin_queued("c", None).await });
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert!(
            !c.is_finished(),
            "the queued turn waits for the unqueued one"
        );
        drop(unqueued);
        let c = c.await.expect("then it begins");
        drop((a, b, c));
        assert!(registry.running().is_empty());
    }

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
