//! The bus, the scopes that own listeners, and the listener handles.

use std::sync::{Arc, Weak};

use futures::future::BoxFuture;

use crate::error::{HookError, ParallelError};
use crate::event::{BailEvent, EmitEvent, ParallelEvent, SerialEvent, WaterfallEvent};
use crate::waterfall::Next;

/// The future an asynchronous listener returns: owned (`'static`) and `Send`, so a listener may move its
/// payload handle into it and a caller may spawn a dispatch.
pub type HookFuture<T> = BoxFuture<'static, Result<T, HookError>>;

/// How a listener is registered — Cordis's `EventOptions`, without `global` (Heddle filters no contexts).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ListenOptions {
    /// Run before the listeners already registered for the same event. In a waterfall the first listener is
    /// the outermost, so a prepended hook sees the call before every other hook.
    pub prepend: bool,
    /// Release the listener after its first call (Cordis's `once`).
    pub once: bool,
}

impl ListenOptions {
    /// Appended, kept: the default.
    pub const APPEND: Self = Self {
        prepend: false,
        once: false,
    };
    /// Prepended, kept.
    pub const PREPEND: Self = Self {
        prepend: true,
        once: false,
    };
    /// Appended, released after its first call.
    pub const ONCE: Self = Self {
        prepend: false,
        once: true,
    };
}

/// The event bus every crate emits into and listens on.
///
/// A cheap clone: every clone is the same listener table. Dispatch takes a **snapshot** of the listeners at
/// its start, as Cordis does — a listener added or released while a dispatch runs takes effect from the next
/// dispatch. Listeners run in registration order (a prepended listener first); in a waterfall the first
/// listener is the outermost.
///
/// `Send + Sync`; dispatch never holds the table's lock while a listener runs, so a listener may register,
/// release or dispatch.
#[derive(Clone, Default)]
pub struct EventBus {
    inner: Arc<Inner>,
}

/// The listener table and the scope tree. Private: its layout is the implementation's.
#[derive(Default)]
pub(crate) struct Inner {}

impl EventBus {
    /// An empty bus.
    pub fn new() -> Self {
        Self::default()
    }

    /// A new top-level scope named `name` — the owner a plugin registers its listeners through.
    ///
    /// The name is what a [`HookError`] reports as the listener, so a plugin's scope carries the plugin's
    /// name (the configuration row's `id` or `name`).
    pub fn scope(&self, name: impl Into<String>) -> Scope {
        let _ = (&self.inner, name.into());
        todo!("heddle-events: Scope creation")
    }

    /// Dispatch an [`EmitEvent`]: every listener, synchronously, in order; nothing is awaited and nothing is
    /// returned. Cordis's `emit` — `session/event`, `heddle/ready`, `approval/request`, `team/changed`.
    pub fn emit<E: EmitEvent>(&self, payload: &E::Payload) {
        let _ = payload;
        todo!("heddle-events: emit")
    }

    /// Dispatch a [`BailEvent`]: listeners in order, synchronously, until one returns `Some`; that answer.
    pub fn bail<E: BailEvent>(&self, payload: &E::Payload) -> Option<E::Output> {
        let _ = payload;
        todo!("heddle-events: bail")
    }

    /// Dispatch a [`ParallelEvent`]: every listener concurrently; resolves when all have settled, with every
    /// failure collected (none is lost because another failed first).
    pub async fn parallel<E: ParallelEvent>(
        &self,
        payload: impl Into<Arc<E::Payload>>,
    ) -> Result<(), ParallelError> {
        let _ = payload.into();
        todo!("heddle-events: parallel")
    }

    /// Dispatch a [`SerialEvent`]: listeners awaited in order until one answers `Some`; that answer. A failing
    /// listener stops the dispatch with its (attributed) error.
    pub async fn serial<E: SerialEvent>(
        &self,
        payload: impl Into<Arc<E::Payload>>,
    ) -> Result<Option<E::Output>, HookError> {
        let _ = payload.into();
        todo!("heddle-events: serial")
    }

    /// Dispatch a [`WaterfallEvent`]: the listeners composed around `inner`, the default behaviour.
    ///
    /// The first listener is called with the payload and a [`Next`] for the rest; running `next` calls the
    /// next listener with the **same** payload, and after the last listener it calls `inner`. A listener that
    /// returns without running `next` decides the value alone: the listeners after it and `inner` never run.
    /// With no listeners the result is `inner(&payload)`.
    ///
    /// A listener's error ends the dispatch, attributed to the point and the failing listener's scope.
    pub async fn waterfall<E: WaterfallEvent>(
        &self,
        payload: impl Into<Arc<E::Payload>>,
        inner: impl FnOnce(&E::Payload) -> E::Output + Send + 'static,
    ) -> Result<E::Output, HookError> {
        let _ = (payload.into(), inner);
        todo!("heddle-events: waterfall")
    }

    /// How many listeners are registered for the point named `name`, in every mode — for diagnostics and
    /// tests (a released scope leaves zero behind).
    pub fn listener_count(&self, name: &str) -> usize {
        let _ = name;
        todo!("heddle-events: listener_count")
    }
}

/// The owner of a set of listeners — Cordis's fiber.
///
/// Every listener is registered through a scope, and **dropping the scope releases every listener it
/// registered**, and every listener of its child scopes; [`dispose`](Scope::dispose) does the same
/// explicitly. A plugin keeps its scope for as long as it is loaded, and the boot drops it to unload the
/// plugin. Not `Clone`: a scope has one owner.
///
/// Registering on a scope that is no longer active (a child whose parent was disposed) registers nothing; the
/// returned [`Listener`] reports [`is_active`](Listener::is_active) `false`.
pub struct Scope {
    bus: EventBus,
    id: u64,
    name: Arc<str>,
}

impl Scope {
    /// The scope's name — what a failure reports as the listener.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The bus this scope registers on, for dispatching from inside a plugin.
    pub fn bus(&self) -> &EventBus {
        &self.bus
    }

    /// A child scope, released with this one or on its own.
    pub fn child(&self, name: impl Into<String>) -> Scope {
        let _ = (self.id, name.into());
        todo!("heddle-events: child scopes")
    }

    /// Whether the scope still owns listeners: false once it, or an ancestor, was disposed.
    pub fn is_active(&self) -> bool {
        todo!("heddle-events: scope state")
    }

    /// Release every listener of this scope and of its children. The same as dropping it.
    pub fn dispose(self) {
        drop(self)
    }

    /// Listen for an [`EmitEvent`]. The listener runs synchronously inside `emit`; it must not block.
    pub fn on_emit<E: EmitEvent>(
        &self,
        listener: impl Fn(&E::Payload) + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let _ = (listener, options);
        todo!("heddle-events: on_emit")
    }

    /// Listen for a [`BailEvent`]; returning `Some` stops the dispatch with that answer.
    pub fn on_bail<E: BailEvent>(
        &self,
        listener: impl Fn(&E::Payload) -> Option<E::Output> + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let _ = (listener, options);
        todo!("heddle-events: on_bail")
    }

    /// Listen for a [`ParallelEvent`].
    pub fn on_parallel<E: ParallelEvent>(
        &self,
        listener: impl Fn(Arc<E::Payload>) -> HookFuture<()> + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let _ = (listener, options);
        todo!("heddle-events: on_parallel")
    }

    /// Listen for a [`SerialEvent`]; answering `Some` stops the dispatch with that answer.
    pub fn on_serial<E: SerialEvent>(
        &self,
        listener: impl Fn(Arc<E::Payload>) -> HookFuture<Option<E::Output>> + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let _ = (listener, options);
        todo!("heddle-events: on_serial")
    }

    /// Listen for a [`WaterfallEvent`] — a hook. See [`EventBus::waterfall`] for what running, and not
    /// running, `next` means.
    pub fn on_waterfall<E: WaterfallEvent>(
        &self,
        listener: impl Fn(Arc<E::Payload>, Next<E>) -> HookFuture<E::Output> + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let _ = (listener, options);
        todo!("heddle-events: on_waterfall")
    }

    /// A synchronous hook that either **replaces** the value (`Ok(Some(value))`, and the rest of the chain does
    /// not run), **passes** (`Ok(None)`, and the chain continues), or fails. The shape of `tools/pre-execute`
    /// refusals and `model/request` retargeting.
    pub fn on_waterfall_replace<E: WaterfallEvent>(
        &self,
        listener: impl Fn(&E::Payload) -> Result<Option<E::Output>, HookError> + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let _ = (listener, options);
        todo!("heddle-events: on_waterfall_replace")
    }

    /// A synchronous hook that runs the rest of the chain first and then **rewrites** its result. The shape of
    /// a `tools/post-execute` redaction or the server's `model/request` selection rule.
    pub fn on_waterfall_map<E: WaterfallEvent>(
        &self,
        listener: impl Fn(&E::Payload, E::Output) -> Result<E::Output, HookError>
        + Send
        + Sync
        + 'static,
        options: ListenOptions,
    ) -> Listener {
        let _ = (listener, options);
        todo!("heddle-events: on_waterfall_map")
    }
}

impl Drop for Scope {
    /// Release every listener of this scope and of its children.
    fn drop(&mut self) {
        // Released by the implementation; nothing to release while registration is unimplemented.
    }
}

/// A handle on one registered listener — Cordis's disposer.
///
/// Dropping the handle does **not** release the listener (it lives as long as its scope); call
/// [`dispose`](Listener::dispose) to release it early.
#[derive(Clone)]
pub struct Listener {
    bus: Weak<Inner>,
    id: u64,
}

impl Listener {
    /// Release the listener; `true` if it was still registered.
    pub fn dispose(&self) -> bool {
        let _ = (&self.bus, self.id);
        todo!("heddle-events: Listener::dispose")
    }

    /// Whether the listener is still registered.
    pub fn is_active(&self) -> bool {
        todo!("heddle-events: Listener::is_active")
    }
}
