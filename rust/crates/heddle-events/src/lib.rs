//! `heddle-events` — the event bus and the named hook points, with Cordis's `emit`, `parallel`, `serial`,
//! `bail` and `waterfall` dispatch modes.
//!
//! Ported from the TypeScript build, where the bus is Cordis's `EventsService`
//! (`@deepseek-ai/cordis/src/events.ts`) and the named events are declared beside the code that emits
//! them: `src/events.ts`, `src/llm/service.ts`, `src/llm/types.ts`, `src/tools/service.ts`,
//! `src/agent/loop.ts`, `src/approvals/service.ts` and `src/plugins/team.ts`. The catalog `heddle hooks`
//! prints is in `src/cli.ts`. Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/60-hooks`.
//!
//! # The shape
//!
//! - **An event is a marker type.** It implements [`Event`] (its hook-point name and payload) and exactly one
//!   mode trait — [`EmitEvent`], [`ParallelEvent`], [`SerialEvent`], [`BailEvent`] or [`WaterfallEvent`] —
//!   so dispatching an event in the wrong mode does not compile. The marker lives in the crate that owns the
//!   payload type (`heddle-llm` owns `model/request`, `heddle-tools` owns `tools/pre-execute`); this crate
//!   owns only the names ([`points`]) and the lifecycle events whose payloads are plain values.
//! - **The bus is shared.** [`EventBus`] is a cheap clone over one listener table; every crate holds one.
//! - **A listener belongs to a scope.** [`Scope`] is Cordis's fiber: a plugin registers through its scope,
//!   and dropping (or disposing) the scope releases every listener it registered, and its children's — the
//!   claim "a listener is released with the fiber that registered it".
//! - **A hook is a waterfall listener.** It gets the payload and a [`Next`]; returning without running `next`
//!   replaces the value for the rest of the chain (or refuses the step), running it and changing what it
//!   returns rewrites the result. A listener fails with a [`HookError`], which is either a deliberate
//!   refusal or a broken hook, and the bus names the point and the listener on it.
//! - **An outside listener is a process** ([`outside`]): it declares the points it listens on, receives each
//!   dispatch as JSON and answers `next`, `replace`, `merge`, `refuse` or an error — the part-4 protocol
//!   applied to hooks.
//! - **The feature crates' hook ports reach the bus through [`bridge`]**: the catalog's points as JSON, a
//!   blocking dispatch for a synchronous port, and one function per port method.
//!
//! # Example
//!
//! ```no_run
//! use std::sync::Arc;
//!
//! use heddle_events::{Event, EventBus, HookError, HookFuture, ListenOptions, Next, WaterfallEvent};
//!
//! /// The payload; in the real tree this is `heddle-llm`'s request type.
//! struct Request {
//!     endpoint: String,
//! }
//!
//! /// The marker for `model/request`.
//! struct ModelRequest;
//! impl Event for ModelRequest {
//!     const NAME: &'static str = heddle_events::points::MODEL_REQUEST;
//!     type Payload = Request;
//! }
//! impl WaterfallEvent for ModelRequest {
//!     type Output = Request;
//! }
//!
//! # async fn demo() -> Result<(), HookError> {
//! let bus = EventBus::new();
//! let plugin = bus.scope("retarget-hook");
//! // A waterfall listener that does not run `next` has replaced the value for every listener after it.
//! plugin.on_waterfall::<ModelRequest>(
//!     |_request: Arc<Request>, _next: Next<ModelRequest>| -> HookFuture<Request> {
//!         Box::pin(async move { Ok(Request { endpoint: "scripted".into() }) })
//!     },
//!     ListenOptions::default(),
//! );
//! let sent = bus
//!     .waterfall::<ModelRequest>(Request { endpoint: "double".into() }, |request| Request {
//!         endpoint: request.endpoint.clone(),
//!     })
//!     .await?;
//! assert_eq!(sent.endpoint, "scripted");
//! drop(plugin); // the listener is released with the scope that registered it
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]

pub mod bridge;
mod bus;
pub mod command;
mod error;
mod event;
mod mode;
pub mod outside;
pub mod points;
pub mod ports;
mod waterfall;

pub use bus::{EventBus, HookFuture, ListenOptions, Listener, Scope};
pub use error::{HookError, HookErrorKind, ParallelError, REFUSAL_PREFIX};
pub use event::{BailEvent, EmitEvent, Event, ParallelEvent, SerialEvent, WaterfallEvent};
pub use mode::Mode;
pub use waterfall::Next;
