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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use axum::body::{Body, Bytes};
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
    /// Set when a subscriber takes the frame: marks it written once its last holder lets it go.
    ack: Ack,
}

/// A taken frame's delivery mark. Its last holder is either the response body's bytes, which hyper's
/// queued writes (the strategy for a TCP stream) release only once the socket has taken all of them, or a
/// frame a reader filtered out; either way the drop counts the frame written. It never affects equality.
#[derive(Clone, Default)]
struct Ack(Option<Arc<AckOnDrop>>);

struct AckOnDrop(Arc<Delivery>);

impl Drop for AckOnDrop {
    fn drop(&mut self) {
        self.0.written.fetch_add(1, Ordering::SeqCst);
    }
}

impl PartialEq for Ack {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl Eq for Ack {}

impl std::fmt::Debug for Ack {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() {
            "Ack(taken)"
        } else {
            "Ack"
        })
    }
}

/// A frame's bytes, holding its delivery mark until hyper has written them.
struct Written {
    bytes: Vec<u8>,
    _ack: Arc<AckOnDrop>,
}

impl AsRef<[u8]> for Written {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

impl SseFrame {
    /// A frame whose data is `data` serialized compactly.
    pub fn new(event: impl Into<String>, data: &impl Serialize) -> Self {
        SseFrame {
            event: event.into(),
            data: serde_json::to_string(data).expect("a serializable frame payload"),
            ack: Ack::default(),
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
            ack: Ack::default(),
        }
    }

    /// An `approval` frame for one approval request, as the approval service emitted it.
    pub fn approval(request: &Value) -> Self {
        SseFrame {
            event: names::APPROVAL.to_owned(),
            data: serde_json::to_string(request).expect("an approval request serializes"),
            ack: Ack::default(),
        }
    }

    /// `event: <name>\ndata: <data>\n\n`.
    pub fn encode(&self) -> String {
        format!("event: {}\ndata: {}\n\n", self.event, self.data)
    }

    /// The frame as body bytes; a taken frame's bytes carry its delivery mark until they are written.
    fn into_body_bytes(self) -> Bytes {
        let text = self.encode();
        match self.ack.0 {
            Some(ack) => Bytes::from_owner(Written {
                bytes: text.into_bytes(),
                _ack: ack,
            }),
            None => Bytes::from(text),
        }
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
    subscribers: Vec<(u64, mpsc::UnboundedSender<SseFrame>, Arc<Delivery>)>,
    closed: bool,
}

/// How far one subscriber's reader has come: frames handed to its channel, and frames written — their bytes
/// handed to the socket, or filtered out by the reader. TypeScript writes every frame to every open response
/// in the tick that publishes it; here a response task takes and writes its frames when the runtime polls
/// it, which on a busy machine can be after a later frame on another response. [`EventHub::flushed`] waits
/// on these counts to restore TypeScript's order where it matters.
#[derive(Default)]
struct Delivery {
    sent: AtomicU64,
    written: AtomicU64,
    /// Set when the subscription is dropped: a reader that is gone is not waited on.
    closed: AtomicBool,
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
        inner.subscribers.retain(|(_, sender, delivery)| {
            let sent = sender.send(frame.clone()).is_ok();
            if sent {
                delivery.sent.fetch_add(1, Ordering::SeqCst);
            }
            sent
        });
    }

    /// Wait, at most `limit`, until every live subscriber has written every frame published before this
    /// call; `true` when they all have. A turn calls this before its terminal frame, so a page never
    /// sees its turn finish on one response while the turn's last text is still queued for another
    /// (`/api/events`, which draws the live text). A subscriber whose reader is gone is not waited on.
    pub async fn flushed(&self, limit: std::time::Duration) -> bool {
        let pending: Vec<(Arc<Delivery>, u64)> = {
            let inner = self.inner.lock().expect("the event hub lock");
            inner
                .subscribers
                .iter()
                .map(|(_, _, delivery)| {
                    (Arc::clone(delivery), delivery.sent.load(Ordering::SeqCst))
                })
                .collect()
        };
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let behind = pending.iter().any(|(delivery, sent)| {
                !delivery.closed.load(Ordering::SeqCst)
                    && delivery.written.load(Ordering::SeqCst) < *sent
            });
            if !behind {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
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
        let delivery = Arc::new(Delivery::default());
        let mut inner = self.inner.lock().expect("the event hub lock");
        if inner.closed {
            // A subscription to a closed hub ends at once, rather than waiting on a sender nobody holds.
            drop(sender);
        } else {
            inner.next += 1;
            let id = inner.next;
            inner.subscribers.push((id, sender, Arc::clone(&delivery)));
        }
        Subscription { receiver, delivery }
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
    delivery: Arc<Delivery>,
}

impl Subscription {
    /// The next frame, or `None` once the hub has closed.
    pub async fn next_frame(&mut self) -> Option<SseFrame> {
        let frame = self.receiver.recv().await;
        frame.map(|frame| self.taken(frame))
    }

    fn poll_frame(&mut self, cx: &mut Context<'_>) -> Poll<Option<SseFrame>> {
        self.receiver
            .poll_recv(cx)
            .map(|frame| frame.map(|frame| self.taken(frame)))
    }

    /// Mark a frame this subscriber took; it counts as written when its last holder drops it.
    fn taken(&self, mut frame: SseFrame) -> SseFrame {
        frame.ack = Ack(Some(Arc::new(AckOnDrop(Arc::clone(&self.delivery)))));
        frame
    }

    /// Only the `session` frames of one session — what a running turn relays on its own response.
    pub fn for_session(self, session: impl Into<String>) -> SessionFrames {
        SessionFrames {
            inner: self,
            session: session.into(),
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.delivery.closed.store(true, Ordering::SeqCst);
    }
}

impl Stream for Subscription {
    type Item = SseFrame;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.poll_frame(cx)
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
            match self.inner.poll_frame(cx) {
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
    let body = futures::stream::once(async { Ok::<_, std::io::Error>(Bytes::from(STREAM_OPEN)) })
        .chain(frames.map(|frame| Ok::<_, std::io::Error>(frame.into_body_bytes())));
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

    #[tokio::test]
    async fn flushed_waits_for_a_reader_that_has_not_taken_its_frames() {
        let hub = EventHub::new();
        let mut slow = hub.subscribe();
        hub.publish_session_event("s", &serde_json::json!({"type": "x"}));
        // Nobody has taken the frame: the wait runs to its limit and says so.
        assert!(!hub.flushed(std::time::Duration::from_millis(30)).await);
        assert!(slow.next_frame().await.is_some());
        assert!(hub.flushed(std::time::Duration::from_millis(30)).await);

        // A reader that is gone is not waited on.
        let gone = hub.subscribe();
        hub.publish_session_event("s", &serde_json::json!({"type": "y"}));
        drop(gone);
        assert!(slow.next_frame().await.is_some());
        assert!(hub.flushed(std::time::Duration::from_millis(30)).await);
    }

    #[tokio::test]
    async fn a_frame_another_session_filters_out_still_counts_as_taken() {
        let hub = EventHub::new();
        let mut other = Box::pin(hub.subscribe().for_session("other"));
        hub.publish_session_event("s", &serde_json::json!({"type": "x"}));
        let waker = futures::task::noop_waker();
        let mut context = Context::from_waker(&waker);
        // The frame is not this reader's: it is taken and dropped, and nothing is returned.
        assert!(other.as_mut().poll_next(&mut context).is_pending());
        assert!(hub.flushed(std::time::Duration::from_millis(30)).await);
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
                data: "not json".into(),
                ack: Ack::default(),
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
