//! The continuation a waterfall listener receives.

use std::sync::{Arc, Weak};

use crate::bus::{HookFuture, Inner};
use crate::event::{Event, WaterfallEvent};

/// One waterfall listener as the chain holds it — the function, and what attributing its failure needs.
pub(crate) struct WaterfallSlot<E: WaterfallEvent> {
    /// The name of the scope that registered it; a failure reports this as the listener.
    pub(crate) name: Arc<str>,
    /// The registration id, so a `once` listener can be released before it runs.
    pub(crate) id: u64,
    /// Whether the listener is released after this call.
    pub(crate) once: bool,
    /// The listener itself.
    pub(crate) listener: WaterfallFn<E>,
}

/// A waterfall listener: the payload, the rest of the chain, and the value it produces.
pub(crate) type WaterfallFn<E> = Arc<
    dyn Fn(Arc<<E as Event>::Payload>, Next<E>) -> HookFuture<<E as WaterfallEvent>::Output>
        + Send
        + Sync,
>;

/// The default a waterfall dispatch ends in, called after the last listener.
pub(crate) type WaterfallDefault<E> =
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
    inner: WaterfallDefault<E>,
    bus: Weak<Inner>,
}

impl<E: WaterfallEvent> Next<E> {
    pub(crate) fn new(
        payload: Arc<E::Payload>,
        rest: Arc<[WaterfallSlot<E>]>,
        inner: WaterfallDefault<E>,
        bus: Weak<Inner>,
    ) -> Self {
        Self {
            payload,
            rest,
            index: 0,
            inner,
            bus,
        }
    }

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
        Box::pin(async move {
            let Next {
                payload,
                rest,
                index,
                inner,
                bus,
            } = self;
            if index >= rest.len() {
                return Ok(inner(&payload));
            }
            let slot = &rest[index];
            if slot.once {
                let still_registered = bus
                    .upgrade()
                    .map(|inner| inner.remove_listener(slot.id))
                    .unwrap_or(false);
                if !still_registered {
                    // Already released: by an earlier reentrant dispatch, or with its scope.
                    let next = Next {
                        payload,
                        rest,
                        index: index + 1,
                        inner,
                        bus,
                    };
                    return next.run().await;
                }
            }
            let name = slot.name.clone();
            let listener = slot.listener.clone();
            let next = Next {
                payload: payload.clone(),
                rest: rest.clone(),
                index: index + 1,
                inner,
                bus,
            };
            listener(payload, next)
                .await
                .map_err(|error| error.attributed(E::NAME, &name))
        })
    }
}
