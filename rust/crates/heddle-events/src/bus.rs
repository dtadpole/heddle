//! The bus, the scopes that own listeners, and the listener handles.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use futures::future::BoxFuture;

use crate::error::{HookError, ParallelError};
use crate::event::{BailEvent, EmitEvent, Event, ParallelEvent, SerialEvent, WaterfallEvent};
use crate::mode::Mode;
use crate::outside::JsonListener;
use crate::waterfall::{Next, WaterfallFn, WaterfallSlot};

/// The future an asynchronous listener returns: owned (`'static`) and `Send`, so a listener may move its
/// payload handle into it and a caller may spawn a dispatch.
pub type HookFuture<T> = BoxFuture<'static, Result<T, HookError>>;

/// An [`on_emit`](Scope::on_emit) listener: synchronous, and it cannot fail.
pub(crate) type EmitFn<P> = Arc<dyn Fn(&P) + Send + Sync>;

/// An [`on_bail`](Scope::on_bail) listener: synchronous, and it may answer.
pub(crate) type BailFn<P> = Arc<dyn Fn(&P) -> Option<Box<dyn Any + Send>> + Send + Sync>;

/// An [`on_parallel`](Scope::on_parallel) listener.
pub(crate) type ParallelFn<P> = Arc<dyn Fn(Arc<P>) -> HookFuture<()> + Send + Sync>;

/// An [`on_serial`](Scope::on_serial) listener.
pub(crate) type SerialFn<P, O> = Arc<dyn Fn(Arc<P>) -> HookFuture<Option<O>> + Send + Sync>;

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

/// A function that attaches an outside listener to one exposed point, by name.
pub(crate) type AttachJson =
    Arc<dyn Fn(&Scope, Arc<dyn JsonListener>, ListenOptions) -> Listener + Send + Sync>;

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
pub(crate) struct Inner {
    state: Mutex<State>,
}

/// Everything one bus owns, behind the one lock.
#[derive(Default)]
struct State {
    /// The listeners, one bucket per hook point, in registration order.
    listeners: HashMap<&'static str, Vec<Registered>>,
    /// Which bucket a listener id belongs to, so [`Listener::dispose`] does not search every bucket.
    owner: HashMap<u64, &'static str>,
    /// The live scopes, by id; a disposed scope is removed with its descendants.
    scopes: HashMap<u64, ScopeRecord>,
    next_scope: u64,
    next_listener: u64,
    /// The points an outside listener may attach to, and how to bridge each one.
    exposed: HashMap<&'static str, Exposed>,
}

/// One live scope. A scope is active for exactly as long as this record exists.
struct ScopeRecord {
    #[allow(dead_code)] // kept for diagnostics: a scope's name is on each listener it registered
    name: Arc<str>,
    #[allow(dead_code)] // the tree is walked from the children; the parent is kept for clarity
    parent: Option<u64>,
    children: Vec<u64>,
}

/// One registered listener, type-erased.
///
/// The concrete type behind `listener` is the mode's `Arc<dyn Fn …>` alias in this module; dispatch
/// downcasts to it, which is also how a bucket keeps listeners of different payload types apart.
struct Registered {
    id: u64,
    scope: u64,
    /// The scope's name, kept with the registration so attribution works even after the scope is gone.
    owner_name: Arc<str>,
    mode: Mode,
    type_id: TypeId,
    options: ListenOptions,
    listener: Arc<dyn Any + Send + Sync>,
}

impl Clone for Registered {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            scope: self.scope,
            owner_name: self.owner_name.clone(),
            mode: self.mode,
            type_id: self.type_id,
            options: self.options,
            listener: self.listener.clone(),
        }
    }
}

/// One exposed point: its mode, and the monomorphized function that attaches a JSON listener to it.
struct Exposed {
    mode: Mode,
    attach: AttachJson,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Create a scope; id `0` means "not active" and is never handed out.
    fn new_scope(&self, name: Arc<str>, parent: Option<u64>) -> u64 {
        let mut state = self.lock();
        if let Some(parent_id) = parent
            && !state.scopes.contains_key(&parent_id)
        {
            return 0;
        }
        state.next_scope += 1;
        let id = state.next_scope;
        state.scopes.insert(
            id,
            ScopeRecord {
                name,
                parent,
                children: Vec::new(),
            },
        );
        if let Some(parent_id) = parent
            && let Some(record) = state.scopes.get_mut(&parent_id)
        {
            record.children.push(id);
        }
        id
    }

    fn is_scope_active(&self, id: u64) -> bool {
        id != 0 && self.lock().scopes.contains_key(&id)
    }

    /// Register a listener; `0` when the scope is no longer active.
    fn register<E: Event>(
        &self,
        scope: u64,
        owner_name: Arc<str>,
        mode: Mode,
        options: ListenOptions,
        listener: Arc<dyn Any + Send + Sync>,
    ) -> u64 {
        let mut state = self.lock();
        if !state.scopes.contains_key(&scope) {
            return 0;
        }
        state.next_listener += 1;
        let id = state.next_listener;
        let entry = Registered {
            id,
            scope,
            owner_name,
            mode,
            type_id: TypeId::of::<E>(),
            options,
            listener,
        };
        let bucket = state.listeners.entry(E::NAME).or_default();
        if options.prepend {
            bucket.insert(0, entry);
        } else {
            bucket.push(entry);
        }
        state.owner.insert(id, E::NAME);
        id
    }

    /// The listeners of `E` registered in one mode, in dispatch order.
    fn snapshot<E: Event>(&self, mode: Mode) -> Vec<Registered> {
        let state = self.lock();
        match state.listeners.get(E::NAME) {
            Some(bucket) => bucket
                .iter()
                .filter(|entry| entry.mode == mode && entry.type_id == TypeId::of::<E>())
                .cloned()
                .collect(),
            None => Vec::new(),
        }
    }

    /// The waterfall listeners of `E`, with what attribution needs.
    fn waterfall_slots<E: WaterfallEvent>(&self) -> Vec<WaterfallSlot<E>> {
        let state = self.lock();
        match state.listeners.get(E::NAME) {
            Some(bucket) => bucket
                .iter()
                .filter(|entry| entry.mode == Mode::Waterfall && entry.type_id == TypeId::of::<E>())
                .filter_map(|entry| {
                    let listener = entry.listener.downcast_ref::<WaterfallFn<E>>().cloned()?;
                    Some(WaterfallSlot {
                        name: entry.owner_name.clone(),
                        id: entry.id,
                        once: entry.options.once,
                        listener,
                    })
                })
                .collect(),
            None => Vec::new(),
        }
    }

    fn has_listener(&self, id: u64) -> bool {
        id != 0 && self.lock().owner.contains_key(&id)
    }

    /// Release one listener; `true` it was still registered.
    ///
    /// The entry is dropped **outside** the lock: a listener's closure may own a scope, and dropping that
    /// scope disposes it, which takes the same lock.
    pub(crate) fn remove_listener(&self, id: u64) -> bool {
        if id == 0 {
            return false;
        }
        let mut state = self.lock();
        let Some(point) = state.owner.remove(&id) else {
            return false;
        };
        let removed = state.listeners.get_mut(point).and_then(|bucket| {
            let position = bucket.iter().position(|entry| entry.id == id)?;
            Some(bucket.remove(position))
        });
        if state.listeners.get(point).is_some_and(Vec::is_empty) {
            state.listeners.remove(point);
        }
        drop(state);
        drop(removed);
        true
    }

    /// Release a scope, its listeners and everything below it.
    fn dispose_scope(&self, id: u64) {
        if id == 0 {
            return;
        }
        let mut state = self.lock();
        let mut doomed: Vec<u64> = Vec::new();
        let mut pending = vec![id];
        while let Some(current) = pending.pop() {
            if let Some(record) = state.scopes.remove(&current) {
                doomed.push(current);
                pending.extend(record.children);
            }
        }
        if doomed.is_empty() {
            return;
        }
        let State {
            listeners, owner, ..
        } = &mut *state;
        let mut removed: Vec<Registered> = Vec::new();
        for bucket in listeners.values_mut() {
            let mut index = 0;
            while index < bucket.len() {
                if doomed.contains(&bucket[index].scope) {
                    let entry = bucket.remove(index);
                    owner.remove(&entry.id);
                    removed.push(entry);
                } else {
                    index += 1;
                }
            }
        }
        listeners.retain(|_, bucket| !bucket.is_empty());
        // Dropped after the guard is released: a closure may own a scope, and dropping it takes the lock.
        drop(state);
        drop(removed);
    }

    fn listener_count(&self, name: &str) -> usize {
        self.lock().listeners.get(name).map(Vec::len).unwrap_or(0)
    }

    pub(crate) fn expose(&self, name: &'static str, mode: Mode, attach: AttachJson) {
        self.lock().exposed.insert(name, Exposed { mode, attach });
    }

    pub(crate) fn exposed_points(&self) -> Vec<(&'static str, Mode)> {
        let state = self.lock();
        let mut points: Vec<(&'static str, Mode)> = state
            .exposed
            .iter()
            .map(|(name, exposed)| (*name, exposed.mode))
            .collect();
        points.sort_by(|left, right| left.0.cmp(right.0));
        points
    }

    /// The bridge for one exposed point, or the names that are exposed instead.
    pub(crate) fn attacher(&self, name: &str) -> Result<AttachJson, crate::outside::UnknownPoint> {
        let state = self.lock();
        if let Some(exposed) = state.exposed.get(name) {
            return Ok(exposed.attach.clone());
        }
        let mut names: Vec<&str> = state.exposed.keys().copied().collect();
        names.sort_unstable();
        Err(crate::outside::UnknownPoint {
            name: name.to_owned(),
            exposed: names.join(", "),
        })
    }
}

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
        let name: Arc<str> = Arc::from(name.into());
        let id = self.inner.new_scope(name.clone(), None);
        Scope {
            bus: self.clone(),
            id,
            name,
        }
    }

    /// Dispatch an [`EmitEvent`]: every listener, synchronously, in order; nothing is awaited and nothing is
    /// returned. Cordis's `emit` — `session/event`, `heddle/ready`, `approval/request`, `team/changed`.
    pub fn emit<E: EmitEvent>(&self, payload: &E::Payload) {
        for entry in self.inner.snapshot::<E>(Mode::Emit) {
            if entry.options.once && !self.inner.remove_listener(entry.id) {
                continue;
            }
            let Some(listener) = entry.listener.downcast_ref::<EmitFn<E::Payload>>() else {
                continue;
            };
            listener(payload);
        }
    }

    /// Dispatch a [`BailEvent`]: listeners in order, synchronously, until one returns `Some`; that answer.
    pub fn bail<E: BailEvent>(&self, payload: &E::Payload) -> Option<E::Output> {
        for entry in self.inner.snapshot::<E>(Mode::Bail) {
            if entry.options.once && !self.inner.remove_listener(entry.id) {
                continue;
            }
            let Some(listener) = entry.listener.downcast_ref::<BailFn<E::Payload>>() else {
                continue;
            };
            if let Some(answer) = listener(payload) {
                return answer.downcast::<E::Output>().ok().map(|value| *value);
            }
        }
        None
    }

    /// Dispatch a [`ParallelEvent`]: every listener concurrently; resolves when all have settled, with every
    /// failure collected (none is lost because another failed first).
    pub async fn parallel<E: ParallelEvent>(
        &self,
        payload: impl Into<Arc<E::Payload>>,
    ) -> Result<(), ParallelError> {
        let payload = payload.into();
        let mut calls: Vec<HookFuture<()>> = Vec::new();
        for entry in self.inner.snapshot::<E>(Mode::Parallel) {
            if entry.options.once && !self.inner.remove_listener(entry.id) {
                continue;
            }
            let Some(listener) = entry
                .listener
                .downcast_ref::<ParallelFn<E::Payload>>()
                .cloned()
            else {
                continue;
            };
            let payload = payload.clone();
            let owner = entry.owner_name.clone();
            calls.push(Box::pin(async move {
                listener(payload)
                    .await
                    .map_err(|error| error.attributed(E::NAME, &owner))
            }));
        }
        let results = futures::future::join_all(calls).await;
        let errors: Vec<HookError> = results.into_iter().filter_map(Result::err).collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(ParallelError { errors })
        }
    }

    /// Dispatch a [`SerialEvent`]: listeners awaited in order until one answers `Some`; that answer. A failing
    /// listener stops the dispatch with its (attributed) error.
    pub async fn serial<E: SerialEvent>(
        &self,
        payload: impl Into<Arc<E::Payload>>,
    ) -> Result<Option<E::Output>, HookError> {
        let payload = payload.into();
        for entry in self.inner.snapshot::<E>(Mode::Serial) {
            if entry.options.once && !self.inner.remove_listener(entry.id) {
                continue;
            }
            let Some(listener) = entry
                .listener
                .downcast_ref::<SerialFn<E::Payload, E::Output>>()
                .cloned()
            else {
                continue;
            };
            match listener(payload.clone())
                .await
                .map_err(|error| error.attributed(E::NAME, &entry.owner_name))?
            {
                Some(answer) => return Ok(Some(answer)),
                None => continue,
            }
        }
        Ok(None)
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
        let payload = payload.into();
        let rest: Arc<[WaterfallSlot<E>]> = self.inner.waterfall_slots::<E>().into();
        let next = Next::new(payload, rest, Box::new(inner), Arc::downgrade(&self.inner));
        next.run().await
    }

    /// How many listeners are registered for the point named `name`, in every mode — for diagnostics and
    /// tests (a released scope leaves zero behind).
    pub fn listener_count(&self, name: &str) -> usize {
        self.inner.listener_count(name)
    }

    /// The bus's listener table, for the outside-listener bridges.
    pub(crate) fn inner(&self) -> &Inner {
        &self.inner
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
        let name: Arc<str> = Arc::from(name.into());
        let id = self.bus.inner.new_scope(name.clone(), Some(self.id));
        Scope {
            bus: self.bus.clone(),
            id,
            name,
        }
    }

    /// Whether the scope still owns listeners: false once it, or an ancestor, was disposed.
    pub fn is_active(&self) -> bool {
        self.bus.inner.is_scope_active(self.id)
    }

    /// Release every listener of this scope and of its children. The same as dropping it.
    pub fn dispose(self) {
        drop(self)
    }

    /// Register one type-erased listener on this scope.
    fn register<E: Event>(
        &self,
        mode: Mode,
        options: ListenOptions,
        listener: Arc<dyn Any + Send + Sync>,
    ) -> Listener {
        let id = self
            .bus
            .inner
            .register::<E>(self.id, self.name.clone(), mode, options, listener);
        Listener {
            bus: Arc::downgrade(&self.bus.inner),
            id,
        }
    }

    /// Listen for an [`EmitEvent`]. The listener runs synchronously inside `emit`; it must not block.
    pub fn on_emit<E: EmitEvent>(
        &self,
        listener: impl Fn(&E::Payload) + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let function: EmitFn<E::Payload> = Arc::new(listener);
        self.register::<E>(Mode::Emit, options, Arc::new(function))
    }

    /// Listen for a [`BailEvent`]; returning `Some` stops the dispatch with that answer.
    pub fn on_bail<E: BailEvent>(
        &self,
        listener: impl Fn(&E::Payload) -> Option<E::Output> + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let function: BailFn<E::Payload> = Arc::new(move |payload| {
            listener(payload).map(|answer| Box::new(answer) as Box<dyn Any + Send>)
        });
        self.register::<E>(Mode::Bail, options, Arc::new(function))
    }

    /// Listen for a [`ParallelEvent`].
    pub fn on_parallel<E: ParallelEvent>(
        &self,
        listener: impl Fn(Arc<E::Payload>) -> HookFuture<()> + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let function: ParallelFn<E::Payload> = Arc::new(listener);
        self.register::<E>(Mode::Parallel, options, Arc::new(function))
    }

    /// Listen for a [`SerialEvent`]; answering `Some` stops the dispatch with that answer.
    pub fn on_serial<E: SerialEvent>(
        &self,
        listener: impl Fn(Arc<E::Payload>) -> HookFuture<Option<E::Output>> + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let function: SerialFn<E::Payload, E::Output> = Arc::new(listener);
        self.register::<E>(Mode::Serial, options, Arc::new(function))
    }

    /// Listen for a [`WaterfallEvent`] — a hook. See [`EventBus::waterfall`] for what running, and not
    /// running, `next` means.
    pub fn on_waterfall<E: WaterfallEvent>(
        &self,
        listener: impl Fn(Arc<E::Payload>, Next<E>) -> HookFuture<E::Output> + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        let function: WaterfallFn<E> = Arc::new(listener);
        self.register::<E>(Mode::Waterfall, options, Arc::new(function))
    }

    /// A synchronous hook that either **replaces** the value (`Ok(Some(value))`, and the rest of the chain does
    /// not run), **passes** (`Ok(None)`, and the chain continues), or fails. The shape of `tools/pre-execute`
    /// refusals and `model/request` retargeting.
    pub fn on_waterfall_replace<E: WaterfallEvent>(
        &self,
        listener: impl Fn(&E::Payload) -> Result<Option<E::Output>, HookError> + Send + Sync + 'static,
        options: ListenOptions,
    ) -> Listener {
        self.on_waterfall::<E>(
            move |payload: Arc<E::Payload>, next: Next<E>| -> HookFuture<E::Output> {
                match listener(&payload) {
                    Ok(Some(value)) => Box::pin(async move { Ok(value) }),
                    Ok(None) => next.run(),
                    Err(error) => Box::pin(async move { Err(error) }),
                }
            },
            options,
        )
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
        let listener = Arc::new(listener);
        self.on_waterfall::<E>(
            move |payload: Arc<E::Payload>, next: Next<E>| -> HookFuture<E::Output> {
                let listener = listener.clone();
                Box::pin(async move {
                    let value = next.run().await?;
                    listener(&payload, value)
                })
            },
            options,
        )
    }
}

impl Drop for Scope {
    /// Release every listener of this scope and of its children.
    fn drop(&mut self) {
        self.bus.inner.dispose_scope(self.id);
    }
}

/// A handle on one registered listener — Cordis's disposer.
///
/// Dropping the handle does **not** release the listener (it lives as long as its scope); call
/// [`dispose`](Listener::dispose) to release it early.
#[derive(Clone, Debug)]
pub struct Listener {
    bus: Weak<Inner>,
    id: u64,
}

impl Listener {
    /// Release the listener; `true` if it was still registered.
    pub fn dispose(&self) -> bool {
        self.bus
            .upgrade()
            .map(|inner| inner.remove_listener(self.id))
            .unwrap_or(false)
    }

    /// Whether the listener is still registered.
    pub fn is_active(&self) -> bool {
        self.bus
            .upgrade()
            .map(|inner| inner.has_listener(self.id))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::error::HookErrorKind;

    struct Logged;
    impl Event for Logged {
        const NAME: &'static str = "test/emit";
        type Payload = String;
    }
    impl EmitEvent for Logged {}

    struct Gated;
    impl Event for Gated {
        const NAME: &'static str = "test/bail";
        type Payload = u32;
    }
    impl BailEvent for Gated {
        type Output = u32;
    }

    struct Fanned;
    impl Event for Fanned {
        const NAME: &'static str = "test/parallel";
        type Payload = u32;
    }
    impl ParallelEvent for Fanned {}

    struct Picked;
    impl Event for Picked {
        const NAME: &'static str = "test/serial";
        type Payload = u32;
    }
    impl SerialEvent for Picked {
        type Output = u32;
    }

    struct Rewritten;
    impl Event for Rewritten {
        const NAME: &'static str = "test/waterfall";
        type Payload = String;
    }
    impl WaterfallEvent for Rewritten {
        type Output = String;
    }

    fn counter() -> Arc<AtomicUsize> {
        Arc::new(AtomicUsize::new(0))
    }

    #[test]
    fn emit_runs_in_registration_order_and_a_prepended_listener_runs_first() {
        let bus = EventBus::new();
        let scope = bus.scope("order");
        let seen: Arc<Mutex<Vec<&'static str>>> = Arc::default();
        for name in ["first-appended", "second-appended"] {
            let seen = seen.clone();
            scope.on_emit::<Logged>(
                move |_payload| seen.lock().unwrap().push(name),
                ListenOptions::APPEND,
            );
        }
        let seen_by_prepended = seen.clone();
        scope.on_emit::<Logged>(
            move |_payload| seen_by_prepended.lock().unwrap().push("prepended"),
            ListenOptions::PREPEND,
        );
        bus.emit::<Logged>(&"a message".to_string());
        assert_eq!(
            *seen.lock().unwrap(),
            ["prepended", "first-appended", "second-appended"]
        );
    }

    #[test]
    fn an_emit_listener_receives_the_payload_and_every_listener_runs() {
        let bus = EventBus::new();
        let scope = bus.scope("payload");
        let seen = Arc::new(Mutex::new(String::new()));
        let seen_once = seen.clone();
        scope.on_emit::<Logged>(
            move |payload| *seen_once.lock().unwrap() = payload.clone(),
            ListenOptions::APPEND,
        );
        bus.emit::<Logged>(&"the payload".to_string());
        assert_eq!(*seen.lock().unwrap(), "the payload");
    }

    #[test]
    fn a_once_listener_runs_once_and_is_then_gone() {
        let bus = EventBus::new();
        let scope = bus.scope("once");
        let calls = counter();
        let calls_in_listener = calls.clone();
        scope.on_emit::<Logged>(
            move |_payload| {
                calls_in_listener.fetch_add(1, Ordering::SeqCst);
            },
            ListenOptions::ONCE,
        );
        bus.emit::<Logged>(&"one".to_string());
        bus.emit::<Logged>(&"two".to_string());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(bus.listener_count(Logged::NAME), 0);
    }

    #[test]
    fn a_listener_added_during_a_dispatch_runs_from_the_next_one() {
        let bus = EventBus::new();
        let root = bus.scope("snapshot");
        let late_scope = bus.scope("late-owner");
        let late_calls = counter();
        let late_calls_for_assert = late_calls.clone();
        let late_bus = late_scope;
        root.on_emit::<Logged>(
            move |_payload| {
                let calls = late_calls.clone();
                late_bus.on_emit::<Logged>(
                    move |_payload| {
                        calls.fetch_add(1, Ordering::SeqCst);
                    },
                    ListenOptions::APPEND,
                );
            },
            ListenOptions::APPEND,
        );
        bus.emit::<Logged>(&"first".to_string());
        assert_eq!(late_calls_for_assert.load(Ordering::SeqCst), 0);
        bus.emit::<Logged>(&"second".to_string());
        assert_eq!(late_calls_for_assert.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_a_scope_releases_its_listeners_and_its_childrens() {
        let bus = EventBus::new();
        let root = bus.scope("root");
        let child = root.child("child");
        assert!(root.is_active());
        assert!(child.is_active());
        root.on_emit::<Logged>(|_payload| {}, ListenOptions::APPEND);
        child.on_emit::<Logged>(|_payload| {}, ListenOptions::APPEND);
        assert_eq!(bus.listener_count(Logged::NAME), 2);
        drop(root);
        assert_eq!(bus.listener_count(Logged::NAME), 0);
        assert!(!child.is_active());
        let calls = counter();
        let calls_in_child = calls.clone();
        child.on_emit::<Logged>(
            move |_payload| {
                calls_in_child.fetch_add(1, Ordering::SeqCst);
            },
            ListenOptions::APPEND,
        );
        bus.emit::<Logged>(&"after".to_string());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_child_may_be_released_alone_and_its_parent_keeps_its_own_listeners() {
        let bus = EventBus::new();
        let parent = bus.scope("parent");
        let child = parent.child("child");
        parent.on_emit::<Logged>(|_payload| {}, ListenOptions::APPEND);
        child.on_emit::<Logged>(|_payload| {}, ListenOptions::APPEND);
        child.dispose();
        assert_eq!(bus.listener_count(Logged::NAME), 1);
        assert!(parent.is_active());
    }

    #[test]
    fn a_listener_handle_can_release_its_listener_early() {
        let bus = EventBus::new();
        let scope = bus.scope("handles");
        let handle = scope.on_emit::<Logged>(|_payload| {}, ListenOptions::APPEND);
        assert!(handle.is_active());
        assert_eq!(bus.listener_count(Logged::NAME), 1);
        assert!(handle.dispose());
        assert!(!handle.is_active());
        assert_eq!(bus.listener_count(Logged::NAME), 0);
        assert!(!handle.dispose());
        assert!(scope.is_active(), "the scope keeps its other listeners");
    }

    #[test]
    fn bail_stops_at_the_first_answer_and_later_listeners_do_not_run() {
        let bus = EventBus::new();
        let scope = bus.scope("gate");
        let calls = counter();
        let first = calls.clone();
        scope.on_bail::<Gated>(
            move |_payload| {
                first.fetch_add(1, Ordering::SeqCst);
                None
            },
            ListenOptions::APPEND,
        );
        let second = calls.clone();
        scope.on_bail::<Gated>(
            move |payload| {
                second.fetch_add(1, Ordering::SeqCst);
                (*payload == 1).then_some(7)
            },
            ListenOptions::APPEND,
        );
        let later = calls.clone();
        scope.on_bail::<Gated>(
            move |_payload| {
                later.fetch_add(1, Ordering::SeqCst);
                Some(9)
            },
            ListenOptions::APPEND,
        );
        assert_eq!(bus.bail::<Gated>(&1), Some(7));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(bus.bail::<Gated>(&2), Some(9));
        assert_eq!(calls.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn parallel_runs_every_listener_and_collects_every_failure() {
        let bus = EventBus::new();
        let scope = bus.scope("fanout");
        let ran = counter();
        let ran_ok = ran.clone();
        scope.on_parallel::<Fanned>(
            move |_payload| {
                ran_ok.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(()) })
            },
            ListenOptions::APPEND,
        );
        let ran_failed = ran.clone();
        scope.on_parallel::<Fanned>(
            move |_payload| {
                ran_failed.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Err(HookError::fail("broken fanout")) })
            },
            ListenOptions::APPEND,
        );
        let ran_refused = ran.clone();
        scope.on_parallel::<Fanned>(
            move |_payload| {
                ran_refused.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Err(HookError::refuse("not here")) })
            },
            ListenOptions::APPEND,
        );
        let error = bus.parallel::<Fanned>(1u32).await.unwrap_err();
        assert_eq!(ran.load(Ordering::SeqCst), 3, "every listener ran");
        assert_eq!(error.errors.len(), 2, "every failure is collected");
        assert_eq!(error.errors[0].kind(), HookErrorKind::Failed);
        assert_eq!(error.errors[0].listener(), Some("fanout"));
        assert_eq!(error.errors[0].point(), Some(Fanned::NAME));
        assert_eq!(error.errors[1].kind(), HookErrorKind::Refused);
        assert!(error.to_string().contains("2 listener(s) failed"));
    }

    #[tokio::test]
    async fn a_parallel_listener_that_succeeds_leaves_no_error() {
        let bus = EventBus::new();
        let scope = bus.scope("quiet");
        scope.on_parallel::<Fanned>(|_payload| Box::pin(async { Ok(()) }), ListenOptions::APPEND);
        assert_eq!(bus.parallel::<Fanned>(1u32).await, Ok(()));
    }

    #[tokio::test]
    async fn serial_stops_at_the_first_answer_and_a_failure_stops_it_with_its_error() {
        let bus = EventBus::new();
        let scope = bus.scope("pick");
        scope.on_serial::<Picked>(
            |_payload| Box::pin(async { Ok(None) }),
            ListenOptions::APPEND,
        );
        scope.on_serial::<Picked>(
            |payload| Box::pin(async move { Ok((*payload == 1).then_some(7)) }),
            ListenOptions::APPEND,
        );
        let calls = counter();
        let later = calls.clone();
        scope.on_serial::<Picked>(
            move |_payload| {
                later.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Some(9)) })
            },
            ListenOptions::APPEND,
        );
        assert_eq!(bus.serial::<Picked>(1u32).await, Ok(Some(7)));
        assert_eq!(calls.load(Ordering::SeqCst), 0, "the answer stopped it");
        assert_eq!(bus.serial::<Picked>(2u32).await, Ok(Some(9)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_serial_failure_is_attributed_and_stops_the_dispatch() {
        let bus = EventBus::new();
        let scope = bus.scope("serial-policy");
        scope.on_serial::<Picked>(
            |_payload| Box::pin(async { Err(HookError::fail("broke")) }),
            ListenOptions::APPEND,
        );
        let calls = counter();
        let later = calls.clone();
        scope.on_serial::<Picked>(
            move |_payload| {
                later.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Some(1)) })
            },
            ListenOptions::APPEND,
        );
        let error = bus.serial::<Picked>(1u32).await.unwrap_err();
        assert_eq!(error.listener(), Some("serial-policy"));
        assert_eq!(error.point(), Some(Picked::NAME));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_waterfall_with_no_listeners_is_its_default() {
        let bus = EventBus::new();
        let value = bus
            .waterfall::<Rewritten>("plain".to_string(), |payload| payload.clone())
            .await
            .unwrap();
        assert_eq!(value, "plain");
    }

    #[tokio::test]
    async fn a_waterfall_listener_that_skips_next_decides_alone() {
        let bus = EventBus::new();
        let scope = bus.scope("retarget");
        scope.on_waterfall::<Rewritten>(
            |payload: Arc<String>, next: Next<Rewritten>| {
                assert_eq!(next.payload(), &*payload);
                assert_eq!(next.point(), Rewritten::NAME);
                Box::pin(async { Ok("from the hook".to_string()) })
            },
            ListenOptions::APPEND,
        );
        let ran_default = counter();
        let ran_default_in_inner = ran_default.clone();
        let value = bus
            .waterfall::<Rewritten>("configured".to_string(), move |_payload| {
                ran_default_in_inner.fetch_add(1, Ordering::SeqCst);
                "from the default".to_string()
            })
            .await
            .unwrap();
        assert_eq!(value, "from the hook");
        assert_eq!(
            ran_default.load(Ordering::SeqCst),
            0,
            "the default did not run"
        );
    }

    #[tokio::test]
    async fn a_waterfall_listener_that_runs_next_can_rewrite_the_result_and_is_outermost_first() {
        let bus = EventBus::new();
        let scope = bus.scope("compose");
        scope.on_waterfall::<Rewritten>(
            |_payload: Arc<String>, next: Next<Rewritten>| {
                Box::pin(async move { Ok(format!("outer[{}]", next.run().await?)) })
            },
            ListenOptions::APPEND,
        );
        scope.on_waterfall::<Rewritten>(
            |_payload: Arc<String>, next: Next<Rewritten>| {
                Box::pin(async move { Ok(format!("inner[{}]", next.run().await?)) })
            },
            ListenOptions::APPEND,
        );
        let value = bus
            .waterfall::<Rewritten>("base".to_string(), |payload| format!("default:{payload}"))
            .await
            .unwrap();
        assert_eq!(value, "outer[inner[default:base]]");
    }

    #[tokio::test]
    async fn a_prepended_waterfall_listener_is_the_new_outermost() {
        let bus = EventBus::new();
        let scope = bus.scope("prepend");
        scope.on_waterfall::<Rewritten>(
            |_payload: Arc<String>, next: Next<Rewritten>| {
                Box::pin(async move { Ok(format!("appended[{}]", next.run().await?)) })
            },
            ListenOptions::APPEND,
        );
        scope.on_waterfall::<Rewritten>(
            |_payload: Arc<String>, next: Next<Rewritten>| {
                Box::pin(async move { Ok(format!("prepended[{}]", next.run().await?)) })
            },
            ListenOptions::PREPEND,
        );
        let value = bus
            .waterfall::<Rewritten>("base".to_string(), |payload| payload.clone())
            .await
            .unwrap();
        assert_eq!(value, "prepended[appended[base]]");
    }

    #[tokio::test]
    async fn a_refusing_waterfall_listener_stops_the_dispatch_and_is_attributed() {
        let bus = EventBus::new();
        let scope = bus.scope("policy");
        scope.on_waterfall::<Rewritten>(
            |_payload: Arc<String>, _next: Next<Rewritten>| {
                Box::pin(async { Err(HookError::refuse("this hook refuses")) })
            },
            ListenOptions::APPEND,
        );
        let ran = counter();
        let ran_in_inner = ran.clone();
        let error = bus
            .waterfall::<Rewritten>("base".to_string(), move |payload| {
                ran_in_inner.fetch_add(1, Ordering::SeqCst);
                payload.clone()
            })
            .await
            .unwrap_err();
        assert!(error.is_refusal());
        assert_eq!(error.listener(), Some("policy"));
        assert_eq!(error.point(), Some(Rewritten::NAME));
        assert_eq!(error.to_string(), "refused by hook: this hook refuses");
        assert_eq!(ran.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_failing_waterfall_listener_is_attributed_to_its_scope() {
        let bus = EventBus::new();
        let scope = bus.scope("broken-hook");
        scope.on_waterfall::<Rewritten>(
            |_payload: Arc<String>, _next: Next<Rewritten>| {
                Box::pin(async { Err(HookError::fail("this hook is broken")) })
            },
            ListenOptions::APPEND,
        );
        let error = bus
            .waterfall::<Rewritten>("base".to_string(), |payload| payload.clone())
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "a hook failed at test/waterfall (broken-hook) — this hook is broken"
        );
    }

    #[tokio::test]
    async fn a_later_listeners_error_passes_through_an_outer_one_still_attributed_to_the_later() {
        let bus = EventBus::new();
        let scope = bus.scope("outer");
        scope.on_waterfall::<Rewritten>(
            |_payload: Arc<String>, next: Next<Rewritten>| Box::pin(next.run()),
            ListenOptions::APPEND,
        );
        let inner_scope = bus.scope("inner");
        inner_scope.on_waterfall::<Rewritten>(
            |_payload: Arc<String>, _next: Next<Rewritten>| {
                Box::pin(async { Err(HookError::fail("the inner one broke")) })
            },
            ListenOptions::APPEND,
        );
        let error = bus
            .waterfall::<Rewritten>("base".to_string(), |payload| payload.clone())
            .await
            .unwrap_err();
        assert_eq!(error.listener(), Some("inner"));
    }

    #[tokio::test]
    async fn the_replace_helper_passes_or_replaces_without_running_the_rest() {
        let bus = EventBus::new();
        let scope = bus.scope("replace");
        let replace = Arc::new(AtomicUsize::new(0));
        let decide = replace.clone();
        scope.on_waterfall_replace::<Rewritten>(
            move |payload| {
                if payload == "replace me" {
                    Ok(Some("replaced".to_string()))
                } else {
                    let _ = decide.fetch_add(1, Ordering::SeqCst);
                    Ok(None)
                }
            },
            ListenOptions::APPEND,
        );
        let value = bus
            .waterfall::<Rewritten>("replace me".to_string(), |payload| payload.clone())
            .await
            .unwrap();
        assert_eq!(value, "replaced");
        let passthrough = bus
            .waterfall::<Rewritten>("keep me".to_string(), |payload| payload.clone())
            .await
            .unwrap();
        assert_eq!(passthrough, "keep me");
        assert_eq!(replace.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_map_helper_runs_the_rest_first_and_then_rewrites_its_result() {
        let bus = EventBus::new();
        let scope = bus.scope("redact");
        scope.on_waterfall_map::<Rewritten>(
            |_payload, output| Ok(format!("redacted:{output}")),
            ListenOptions::APPEND,
        );
        let value = bus
            .waterfall::<Rewritten>("secret".to_string(), |payload| payload.clone())
            .await
            .unwrap();
        assert_eq!(value, "redacted:secret");
    }

    #[tokio::test]
    async fn a_once_waterfall_listener_does_not_run_on_a_second_dispatch() {
        let bus = EventBus::new();
        let scope = bus.scope("once-hook");
        let calls = counter();
        let calls_in_listener = calls.clone();
        scope.on_waterfall::<Rewritten>(
            move |_payload: Arc<String>, _next: Next<Rewritten>| {
                calls_in_listener.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok("once".to_string()) })
            },
            ListenOptions::ONCE,
        );
        assert_eq!(
            bus.waterfall::<Rewritten>("a".to_string(), |payload| payload.clone())
                .await
                .unwrap(),
            "once"
        );
        assert_eq!(
            bus.waterfall::<Rewritten>("b".to_string(), |payload| format!("default:{payload}"))
                .await
                .unwrap(),
            "default:b"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(bus.listener_count(Rewritten::NAME), 0);
    }

    #[test]
    fn a_point_only_counts_listeners_of_its_own_mode() {
        let bus = EventBus::new();
        let scope = bus.scope("counts");
        scope.on_emit::<Logged>(|_payload| {}, ListenOptions::APPEND);
        scope.on_bail::<Gated>(|_payload| None, ListenOptions::APPEND);
        scope.on_parallel::<Fanned>(|_payload| Box::pin(async { Ok(()) }), ListenOptions::APPEND);
        assert_eq!(bus.listener_count(Logged::NAME), 1);
        assert_eq!(bus.listener_count(Gated::NAME), 1);
        assert_eq!(bus.listener_count(Fanned::NAME), 1);
        assert_eq!(bus.listener_count("test/absent"), 0);
    }

    #[tokio::test]
    async fn a_waterfall_error_from_a_once_listener_is_attributed_before_it_is_released() {
        let bus = EventBus::new();
        let scope = bus.scope("once-broken");
        scope.on_waterfall::<Rewritten>(
            |_payload: Arc<String>, _next: Next<Rewritten>| {
                Box::pin(async { Err(HookError::fail("once and broken")) })
            },
            ListenOptions::ONCE,
        );
        let error = bus
            .waterfall::<Rewritten>("a".to_string(), |payload| payload.clone())
            .await
            .unwrap_err();
        assert_eq!(error.listener(), Some("once-broken"));
        assert_eq!(bus.listener_count(Rewritten::NAME), 0);
    }
}
