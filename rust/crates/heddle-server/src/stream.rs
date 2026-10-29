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

use axum::body::Body;
use axum::response::Response;
use futures::{Stream, StreamExt};
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
    /// The opening item of `/api/events`, sent once after the subscriber is registered.
    pub const READY: &str = "ready";
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
        SseFrame {
            event: event.into(),
            data: serde_json::to_string(data).expect("a serializable frame payload"),
        }
    }

    /// A `session` frame for the bus payload `{session, event}`, keys in that order.
    pub fn session(session: &str, event: &Value) -> Self {
        // Built as a string because `JSON.stringify({session, event})` writes `session` first, and a
        // `serde_json::Map` is ordered by key by default.
        SseFrame {
            event: names::SESSION.to_owned(),
            data: format!(
                "{{\"session\":{},\"event\":{}}}",
                serde_json::to_string(session).expect("a string serializes"),
                serde_json::to_string(event).expect("an event serializes")
            ),
        }
    }

    /// The opening `ready` frame of `/api/events`: DSH's `{ type: 'ready', clientId, host: { home } }` item, keys
    /// in that order (a struct, so the order holds whatever map `serde_json` is built with). `src/server/stream.ts`
    /// writes the same bytes.
    pub fn ready(client_id: &str, home: &str) -> Self {
        SseFrame::new(
            names::READY,
            &ReadyData {
                kind: "ready",
                client_id,
                host: ReadyHost { home },
            },
        )
    }

    /// An `approval` frame for one approval request, as the approval service emitted it.
    pub fn approval(request: &Value) -> Self {
        SseFrame {
            event: names::APPROVAL.to_owned(),
            data: serde_json::to_string(request).expect("an approval request serializes"),
        }
    }

    /// `event: <name>\ndata: <data>\n\n`.
    pub fn encode(&self) -> String {
        format!("event: {}\ndata: {}\n\n", self.event, self.data)
    }

    /// The session a `session` frame belongs to, read from its data; `None` for any other frame.
    pub fn session_id(&self) -> Option<String> {
        if self.event != names::SESSION {
            return None;
        }
        let value: Value = serde_json::from_str(&self.data).ok()?;
        value.get("session")?.as_str().map(str::to_owned)
    }
}

/// The data of the opening `ready` frame.
#[derive(Serialize)]
struct ReadyData<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "clientId")]
    client_id: &'a str,
    host: ReadyHost<'a>,
}

/// The Host facts the opening frame carries.
#[derive(Serialize)]
struct ReadyHost<'a> {
    home: &'a str,
}

/// A client id for one stream: 16 random bytes, hex — the shape `src/server/stream.ts` mints. One per
/// connection, so a reconnect is a new id.
pub fn new_client_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system entropy source");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The Host's home folder as the opening frame names it: `$HOME`, which is what Node's `os.homedir()` reads
/// on the platforms heddle runs on; empty when it is unset.
pub fn host_home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// The frames of `/api/events`: the opening `ready` frame, then every frame the subscription carries.
///
/// The subscription is passed in already registered with the hub, so every frame published after a client
/// reads `ready` is queued for it: a baseline read that starts on `ready` cannot race an increment, which is
/// the ordering DSH's `$events` source guarantees.
pub fn events_frames(subscription: Subscription, client_id: &str, home: &str) -> impl Stream<Item = SseFrame> + Send + 'static {
    futures::stream::once(std::future::ready(SseFrame::ready(client_id, home))).chain(subscription)
}

/// The listener a binary registers on its event bus's `session/event` channel: it captures the hub the
/// server streams from and publishes every payload into it. The bus's own signature is the binary's, so
/// this is a plain function of `(session, event)` rather than a trait this crate would have to guess.
pub fn session_event_forwarder(hub: EventHub) -> impl Fn(&str, &Value) + Send + Sync + 'static {
    move |session, event| hub.publish_session_event(session, event)
}

/// The listener a binary registers on its `approval/request` channel, publishing each question to the
/// `/api/events` subscribers.
pub fn approval_request_forwarder(hub: EventHub) -> impl Fn(&Value) + Send + Sync + 'static {
    move |request| hub.publish_approval_request(request)
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
        Self::default()
    }

    /// Deliver one frame to every live subscriber, dropping those whose reader has gone.
    pub fn publish(&self, frame: SseFrame) {
        let mut inner = self.inner.lock().expect("the event hub lock");
        if inner.closed {
            return;
        }
        inner
            .subscribers
            .retain(|(_, sender)| sender.send(frame.clone()).is_ok());
    }

    /// Publish the bus's `session/event` payload.
    pub fn publish_session_event(&self, session: &str, event: &Value) {
        self.publish(SseFrame::session(session, event));
    }

    /// Publish the bus's `approval/request` payload.
    pub fn publish_approval_request(&self, request: &Value) {
        self.publish(SseFrame::approval(request));
    }

    /// A new subscription that receives every frame published after this call.
    pub fn subscribe(&self) -> Subscription {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut inner = self.inner.lock().expect("the event hub lock");
        if inner.closed {
            // A subscription to a closed hub ends at once, rather than waiting on a sender nobody holds.
            drop(sender);
        } else {
            inner.next += 1;
            let id = inner.next;
            inner.subscribers.push((id, sender));
        }
        Subscription { receiver }
    }

    /// How many subscribers are live.
    pub fn subscriber_count(&self) -> usize {
        self.inner
            .lock()
            .expect("the event hub lock")
            .subscribers
            .len()
    }

    /// End every subscription, and refuse new ones (they end at once). This is what lets a server stop
    /// rather than wait forever on streams that are open by design.
    pub fn close(&self) {
        let mut inner = self.inner.lock().expect("the event hub lock");
        inner.closed = true;
        inner.subscribers.clear();
    }
}

/// One subscriber's frames, in publish order. Ends when the hub closes.
pub struct Subscription {
    receiver: mpsc::UnboundedReceiver<SseFrame>,
}

impl Subscription {
    /// The next frame, or `None` once the hub has closed.
    pub async fn next_frame(&mut self) -> Option<SseFrame> {
        self.receiver.recv().await
    }

    /// Only the `session` frames of one session — what a running turn relays on its own response.
    pub fn for_session(self, session: impl Into<String>) -> SessionFrames {
        SessionFrames {
            inner: self,
            session: session.into(),
        }
    }
}

impl Stream for Subscription {
    type Item = SseFrame;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(cx)
    }
}

/// A subscription narrowed to one session's `session` frames.
pub struct SessionFrames {
    inner: Subscription,
    session: String,
}

impl Stream for SessionFrames {
    type Item = SseFrame;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match self.inner.receiver.poll_recv(cx) {
                Poll::Ready(Some(frame)) => {
                    if frame.session_id().as_deref() == Some(self.session.as_str()) {
                        return Poll::Ready(Some(frame));
                    }
                }
                Poll::Ready(None) => return Poll::Ready(None),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// An SSE response over a stream of frames: `200`, `content-type: text/event-stream`,
/// `cache-control: no-store`, `connection: keep-alive`, `x-accel-buffering: no`; the body opens with
/// [`STREAM_OPEN`] and writes each frame as it arrives, unbuffered.
pub fn sse_response<S>(frames: S) -> Response
where
    S: Stream<Item = SseFrame> + Send + 'static,
{
    let body = futures::stream::once(async { Ok::<_, std::io::Error>(STREAM_OPEN.to_owned()) })
        .chain(frames.map(|frame| Ok::<_, std::io::Error>(frame.encode())));
    Response::builder()
        .status(200)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-store")
        .header("connection", "keep-alive")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(body))
        .expect("a response builder with static headers")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ready_frame_writes_the_typescript_bytes() {
        // src/server/stream.ts writes exactly this for readyFrame('abc123', '/home/owner').
        assert_eq!(
            SseFrame::ready("abc123", "/home/owner").encode(),
            "event: ready\ndata: {\"type\":\"ready\",\"clientId\":\"abc123\",\"host\":{\"home\":\"/home/owner\"}}\n\n"
        );
    }

    #[test]
    fn every_stream_gets_its_own_client_id_in_hex() {
        let ids: std::collections::HashSet<String> = (0..64).map(|_| new_client_id()).collect();
        assert_eq!(ids.len(), 64, "no two streams share an id");
        for id in &ids {
            assert_eq!(id.len(), 32, "{id}");
            assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{id}");
        }
    }

    #[tokio::test]
    async fn the_events_frames_open_with_ready_and_keep_what_was_published_after_subscribing() {
        let hub = EventHub::new();
        let subscription = hub.subscribe();
        // Published after the subscriber registered but before anything was read: it must not be lost.
        hub.publish_session_event("session-1", &serde_json::json!({"type": "message"}));
        let mut frames = Box::pin(events_frames(subscription, "abc", "/h"));
        let first = frames.next().await.expect("the ready frame");
        assert_eq!(first.event, names::READY);
        assert_eq!(first, SseFrame::ready("abc", "/h"));
        let second = frames.next().await.expect("the published frame");
        assert_eq!(second.event, names::SESSION);
        assert_eq!(second.session_id().as_deref(), Some("session-1"));
    }

    #[test]
    fn a_session_frame_serializes_keys_in_the_typescript_order() {
        let frame = SseFrame::session("session-1", &serde_json::json!({"type": "user/message"}));
        assert_eq!(frame.event, "session");
        assert_eq!(
            frame.data,
            "{\"session\":\"session-1\",\"event\":{\"type\":\"user/message\"}}"
        );
        assert_eq!(frame.session_id().as_deref(), Some("session-1"));
    }

    #[test]
    fn encode_is_the_sse_wire_format() {
        let frame = SseFrame::new("done", &serde_json::json!({"text": "x"}));
        assert_eq!(frame.encode(), "event: done\ndata: {\"text\":\"x\"}\n\n");
    }

    #[test]
    fn only_a_session_frame_names_a_session() {
        assert_eq!(
            SseFrame::approval(&serde_json::json!({"id": "approval-1"})).session_id(),
            None
        );
        assert_eq!(
            SseFrame::new("done", &serde_json::json!({})).session_id(),
            None
        );
        assert_eq!(
            SseFrame {
                event: "session".into(),
                data: "not json".into()
            }
            .session_id(),
            None
        );
    }

    #[tokio::test]
    async fn every_subscriber_gets_every_frame_in_order() {
        let hub = EventHub::new();
        let mut one = hub.subscribe();
        let mut two = hub.subscribe();
        assert_eq!(hub.subscriber_count(), 2);

        hub.publish_session_event("session-1", &serde_json::json!({"n": 1}));
        hub.publish_session_event("session-2", &serde_json::json!({"n": 2}));
        hub.publish_approval_request(&serde_json::json!({"id": "approval-1"}));

        for subscription in [&mut one, &mut two] {
            let first = subscription.next_frame().await.unwrap();
            assert_eq!(first.session_id().as_deref(), Some("session-1"));
            let second = subscription.next_frame().await.unwrap();
            assert_eq!(second.session_id().as_deref(), Some("session-2"));
            let third = subscription.next_frame().await.unwrap();
            assert_eq!(third.event, "approval");
        }
    }

    #[tokio::test]
    async fn a_gone_subscriber_is_dropped_on_the_next_publish() {
        let hub = EventHub::new();
        let subscriber = hub.subscribe();
        assert_eq!(hub.subscriber_count(), 1);
        drop(subscriber);
        hub.publish_session_event("s", &serde_json::json!({}));
        assert_eq!(hub.subscriber_count(), 0);
    }

    #[tokio::test]
    async fn closing_ends_every_subscription_and_refuses_new_ones() {
        let hub = EventHub::new();
        let mut subscriber = hub.subscribe();
        hub.close();
        assert_eq!(subscriber.next_frame().await, None);
        assert_eq!(hub.subscriber_count(), 0);

        let mut late = hub.subscribe();
        assert_eq!(late.next_frame().await, None);
        hub.publish_session_event("s", &serde_json::json!({}));
    }

    #[tokio::test]
    async fn for_session_relays_only_its_own_session() {
        let hub = EventHub::new();
        let frames = hub.subscribe().for_session("session-1");
        hub.publish_session_event("session-2", &serde_json::json!({"n": 1}));
        hub.publish_session_event("session-1", &serde_json::json!({"n": 2}));
        hub.publish_approval_request(&serde_json::json!({"id": "a"}));

        let mut frames = std::pin::pin!(frames);
        let frame = frames.next().await.unwrap();
        assert_eq!(frame.session_id().as_deref(), Some("session-1"));
        assert_eq!(
            frame.data,
            "{\"session\":\"session-1\",\"event\":{\"n\":2}}"
        );
    }

    #[tokio::test]
    async fn the_bus_forwarders_publish_into_the_server_hub() {
        let hub = EventHub::new();
        let mut frames = hub.subscribe();
        let forward_session = session_event_forwarder(hub.clone());
        let forward_approval = approval_request_forwarder(hub.clone());
        forward_session("session-1", &serde_json::json!({"type": "user/message"}));
        forward_approval(&serde_json::json!({"id": "approval-1"}));

        let first = frames.next_frame().await.unwrap();
        assert_eq!(first.session_id().as_deref(), Some("session-1"));
        let second = frames.next_frame().await.unwrap();
        assert_eq!(second.event, "approval");
        assert_eq!(hub.subscriber_count(), 1);
    }

    #[tokio::test]
    async fn an_sse_response_opens_with_the_comment_and_writes_frames() {
        let hub = EventHub::new();
        let response = sse_response(hub.subscribe());
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["x-accel-buffering"], "no");

        hub.publish_session_event("session-1", &serde_json::json!({"n": 1}));
        hub.close();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.starts_with(STREAM_OPEN));
        assert!(text.contains("event: session\n"));
        assert!(text.contains("{\"session\":\"session-1\",\"event\":{\"n\":1}}"));
    }
}
