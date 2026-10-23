//! The live stream: one hub every session event is published into, and the SSE framing.
//!
//! In the TypeScript server every `session/event` the store emits is written to each `/api/events`
//! subscriber, and a running `/api/turn` relays the events of its own session on its response. Here the
//! binary bridges the event bus into one [`EventHub`] (`hub.publish_session_event(..)` from the bus's
//! `session/event` listener, `hub.publish_approval_request(..)` from `approval/request`), and both routes
//! subscribe to it.
//!
//! Delivery is per subscriber and **unbounded**, as `response.write` is: a slow reader is never skipped, and a
//! subscriber whose reader has gone is dropped on the next publish.
//!
//! The wire format is the TypeScript one: a stream opens with `: heddle stream open\n\n`, and a frame is
//! `event: <name>\ndata: <one-line JSON>\n\n`.

use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use axum::response::Response;
use futures::Stream;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

/// The comment a stream opens with.
pub const STREAM_OPEN: &str = ": heddle stream open\n\n";

/// The frame names the server writes.
pub mod names {
    /// A session event, `{session, event}` — on `/api/events` and on a turn's own response.
    pub const SESSION: &str = "session";
    /// An approval question, pushed to `/api/events` subscribers.
    pub const APPROVAL: &str = "approval";
    /// A turn's normal end, on its own response.
    pub const DONE: &str = "done";
    /// A turn that was stopped, on its own response.
    pub const CANCELLED: &str = "cancelled";
    /// A turn that failed, on its own response.
    pub const ERROR: &str = "error";
}

/// One SSE frame: a name and its data, already serialized to one line of JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: String,
    pub data: String,
}

impl SseFrame {
    /// A frame whose data is `data` serialized compactly.
    pub fn new(event: impl Into<String>, data: &impl Serialize) -> Self {
        todo!()
    }

    /// A `session` frame for the bus payload `{session, event}`, keys in that order.
    pub fn session(session: &str, event: &Value) -> Self {
        todo!()
    }

    /// An `approval` frame for one approval request, as the approval service emitted it.
    pub fn approval(request: &Value) -> Self {
        todo!()
    }

    /// `event: <name>\ndata: <data>\n\n`.
    pub fn encode(&self) -> String {
        todo!()
    }

    /// The session a `session` frame belongs to, read from its data; `None` for any other frame.
    pub fn session_id(&self) -> Option<String> {
        todo!()
    }
}

/// The hub. Cloning shares it.
#[derive(Clone, Default)]
pub struct EventHub {
    inner: Arc<Mutex<HubInner>>,
}

#[derive(Default)]
struct HubInner {
    next: u64,
    subscribers: Vec<(u64, mpsc::UnboundedSender<SseFrame>)>,
    closed: bool,
}

impl EventHub {
    pub fn new() -> Self {
        todo!()
    }

    /// Deliver one frame to every live subscriber, dropping those whose reader has gone.
    pub fn publish(&self, frame: SseFrame) {
        todo!()
    }

    /// Publish the bus's `session/event` payload.
    pub fn publish_session_event(&self, session: &str, event: &Value) {
        todo!()
    }

    /// Publish the bus's `approval/request` payload.
    pub fn publish_approval_request(&self, request: &Value) {
        todo!()
    }

    /// A new subscription that receives every frame published after this call.
    pub fn subscribe(&self) -> Subscription {
        todo!()
    }

    /// How many subscribers are live.
    pub fn subscriber_count(&self) -> usize {
        todo!()
    }

    /// End every subscription, and refuse new ones (they end at once). This is what lets a server stop
    /// rather than wait forever on streams that are open by design.
    pub fn close(&self) {
        todo!()
    }
}

/// One subscriber's frames, in publish order. Ends when the hub closes.
pub struct Subscription {
    receiver: mpsc::UnboundedReceiver<SseFrame>,
}

impl Subscription {
    /// The next frame, or `None` once the hub has closed.
    pub async fn next_frame(&mut self) -> Option<SseFrame> {
        todo!()
    }

    /// Only the `session` frames of one session — what a running turn relays on its own response.
    pub fn for_session(self, session: impl Into<String>) -> SessionFrames {
        todo!()
    }
}

impl Stream for Subscription {
    type Item = SseFrame;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        todo!()
    }
}

/// A subscription narrowed to one session's `session` frames.
pub struct SessionFrames {
    inner: Subscription,
    session: String,
}

impl Stream for SessionFrames {
    type Item = SseFrame;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        todo!()
    }
}

/// An SSE response over a stream of frames: `200`, `content-type: text/event-stream`,
/// `cache-control: no-store`, `connection: keep-alive`, `x-accel-buffering: no`; the body opens with
/// [`STREAM_OPEN`] and writes each frame as it arrives, unbuffered.
pub fn sse_response<S>(frames: S) -> Response
where
    S: Stream<Item = SseFrame> + Send + 'static,
{
    todo!()
}
