//! The continuation a waterfall listener receives.

use std::sync::Arc;

use crate::bus::HookFuture;
use crate::event::{Event, WaterfallEvent};

/// One waterfall listener as the chain holds it: the name of the scope that registered it, and the function.
pub(crate) type WaterfallSlot<E> = (
    Arc<str>,
    Arc<
        dyn Fn(Arc<<E as Event>::Payload>, Next<E>) -> HookFuture<<E as WaterfallEvent>::Output>
            + Send
            + Sync,
    >,
);

/// The default a waterfall dispatch ends in, called after the last listener.
pub(crate) type Inner<E> =
    Box<dyn FnOnce(&<E as Event>::Payload) -> <E as WaterfallEvent>::Output + Send>;

/// The rest of a waterfall chain, handed to each listener — Cordis's `next`.
///
/// [`run`](Next::run) calls the next listener with the same payload, or the dispatch's default after the last
/// one. It consumes the continuation, so the rest of the chain runs at most once; dropping it without running
/// it is how a listener replaces the value or refuses the step.
pub struct Next<E: WaterfallEvent> {
    payload: Arc<E::Payload>,
    rest: Arc<[WaterfallSlot<E>]>,
    index: usize,
    inner: Inner<E>,
}

impl<E: WaterfallEvent> Next<E> {
    /// The payload the chain was dispatched with — the same one every listener receives.
    pub fn payload(&self) -> &E::Payload {
        &self.payload
    }

    /// The hook point's name.
    pub fn point(&self) -> &'static str {
        E::NAME
    }

    /// Run the rest of the chain and return what it produced. An error from a later listener comes back
    /// already attributed to that listener.
    pub fn run(self) -> HookFuture<E::Output> {
        let _ = (self.rest, self.index, self.inner);
        todo!("heddle-events: Next::run")
    }
}
