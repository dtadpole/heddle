//! The event traits: a name, a payload, and the one mode an event is dispatched in.

/// A named event: the hook point's name and what every listener is handed.
///
/// Implemented by a zero-sized marker type, in the crate that owns the payload. `NAME` is the string a person
/// sees in `heddle hooks` and an outside listener names in its configuration, so it is one of
/// [`points`](crate::points)' constants for every point the catalog lists.
pub trait Event: Send + Sync + 'static {
    /// The hook point's name, `"model/request"` for instance.
    const NAME: &'static str;
    /// What every listener receives.
    type Payload: Send + Sync + 'static;
}

/// An event dispatched with [`EventBus::emit`](crate::EventBus::emit): synchronous observation.
pub trait EmitEvent: Event {}

/// An event dispatched with [`EventBus::parallel`](crate::EventBus::parallel): every listener, concurrently.
pub trait ParallelEvent: Event {}

/// An event dispatched with [`EventBus::serial`](crate::EventBus::serial): awaited in order until one answers.
pub trait SerialEvent: Event {
    /// The answer that stops the dispatch.
    type Output: Send + 'static;
}

/// An event dispatched with [`EventBus::bail`](crate::EventBus::bail): synchronous, in order, until one answers.
pub trait BailEvent: Event {
    /// The answer that stops the dispatch.
    type Output: Send + 'static;
}

/// An event dispatched with [`EventBus::waterfall`](crate::EventBus::waterfall): listeners composed around a
/// default, each deciding whether the rest of the chain runs.
pub trait WaterfallEvent: Event {
    /// What the chain produces — the default's value unless a listener replaced it.
    type Output: Send + 'static;
}
