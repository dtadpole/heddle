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
    /// The heartbeat every `/api/events` subscriber gets once per interval.
    pub const HEARTBEAT: &str = "heartbeat";
    /// Sent after `ready` when the presented cursor cannot be honoured: re-read the baselines.
    pub const RESET: &str = "reset";
    /// A turn's normal end, on its own response.
    pub const DONE: &str = "done";
    /// A turn that was stopped, on its own response.
    pub const CANCELLED: &str = "cancelled";
    /// A turn that failed, on its own response.
    pub const ERROR: &str = "error";
}

/// One SSE frame: a name and its data, already serialized to one line of JSON, and the id the hub gave it
/// (`None` until it is published, and for the frames about the connection: `ready`, `reset`, heartbeats).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
}

impl SseFrame {
    /// A frame whose data is `data` serialized compactly.
    pub fn new(event: impl Into<String>, data: &impl Serialize) -> Self {
        SseFrame {
            event: event.into(),
            data: serde_json::to_string(data).expect("a serializable frame payload"),
            id: None,
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
            id: None,
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
                cursor: None,
                resumed: None,
                heartbeat_ms: None,
            },
        )
    }

    /// The heartbeat frame, `{"type":"heartbeat"}` — the bytes `src/server/stream.ts` writes.
    pub fn heartbeat() -> Self {
        SseFrame {
            event: names::HEARTBEAT.to_owned(),
            data: "{\"type\":\"heartbeat\"}".to_owned(),
            id: None,
        }
    }

    /// An `approval` frame for one approval request, as the approval service emitted it.
    pub fn approval(request: &Value) -> Self {
        SseFrame {
            event: names::APPROVAL.to_owned(),
            data: serde_json::to_string(request).expect("an approval request serializes"),
            id: None,
        }
    }

    /// `event: <name>\ndata: <data>\n\n`, with `id: <id>\n` first when the hub gave it one.
    pub fn encode(&self) -> String {
        match &self.id {
            Some(id) => format!("id: {id}\nevent: {}\ndata: {}\n\n", self.event, self.data),
            None => format!("event: {}\ndata: {}\n\n", self.event, self.data),
        }
    }

    /// The `reset` frame: the client's cursor could not be honoured, so it re-reads its baselines.
    pub fn reset() -> Self {
        SseFrame {
            event: names::RESET.to_owned(),
            data: "{\"type\":\"reset\"}".to_owned(),
            id: None,
        }
    }

    /// The opening `ready` frame with heddle's follow fields after DSH's keys — the bytes
    /// `readyFrame(clientId, home, follow)` writes in `src/server/stream.ts`.
    pub fn ready_with(client_id: &str, home: &str, follow: &ReadyFollow) -> Self {
        SseFrame::new(
            names::READY,
            &ReadyData {
                kind: "ready",
                client_id,
                host: ReadyHost { home },
                cursor: Some(&follow.cursor),
                resumed: Some(follow.resumed),
                heartbeat_ms: Some(follow.heartbeat_ms),
            },
        )
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

/// The data of the opening `ready` frame: DSH's keys, then heddle's follow fields when a stream sends them.
#[derive(Serialize)]
struct ReadyData<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "clientId")]
    client_id: &'a str,
    host: ReadyHost<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resumed: Option<bool>,
    #[serde(rename = "heartbeatMs", skip_serializing_if = "Option::is_none")]
    heartbeat_ms: Option<u64>,
}

/// The follow fields of `ready`: the newest id this stream has been given, whether the presented cursor was
/// honoured, and the heartbeat interval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyFollow {
    pub cursor: String,
    pub resumed: bool,
    pub heartbeat_ms: u64,
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

/// DSH's default `websocketHeartbeatIntervalMs`, two seconds.
pub const DEFAULT_HEARTBEAT_MS: u64 = 2000;

/// The heartbeat interval a raw `HEDDLE_WEB_HEARTBEAT_MS` value names: a whole number of at least 50 ms, else
/// DSH's two seconds — the rule `heartbeatInterval` applies in `src/server/stream.ts`.
pub fn heartbeat_interval_from(raw: Option<&str>) -> std::time::Duration {
    let millis = raw
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|millis| *millis >= 50)
        .unwrap_or(DEFAULT_HEARTBEAT_MS);
    std::time::Duration::from_millis(millis)
}

/// The heartbeat interval this process uses, from `HEDDLE_WEB_HEARTBEAT_MS`.
pub fn heartbeat_interval() -> std::time::Duration {
    heartbeat_interval_from(std::env::var("HEDDLE_WEB_HEARTBEAT_MS").ok().as_deref())
}

/// The frames of `/api/events`: the opening `ready` frame, then every frame the subscription carries.
///
/// The subscription is passed in already registered with the hub, so every frame published after a client
/// reads `ready` is queued for it: a baseline read that starts on `ready` cannot race an increment, which is
/// the ordering DSH's `$events` source guarantees.
pub fn events_frames(
    subscription: Subscription,
    client_id: &str,
    home: &str,
) -> impl Stream<Item = SseFrame> + Send + 'static {
    futures::stream::once(std::future::ready(SseFrame::ready(client_id, home))).chain(subscription)
}

/// The replay without questions that no longer wait: an `approval` frame is kept only while its question is in
/// `waiting` (the approval service's pending ids), as DSH replays pending questions and not settled ones. Every
/// other frame, `approval-settled` included, is kept. `withoutSettledApprovals` in `src/server/stream.ts` is the same.
pub fn without_settled_approvals(
    frames: Vec<SseFrame>,
    waiting: &std::collections::HashSet<String>,
) -> Vec<SseFrame> {
    frames
        .into_iter()
        .filter(|frame| {
            if frame.event != names::APPROVAL {
                return true;
            }
            serde_json::from_str::<Value>(&frame.data)
                .ok()
                .and_then(|data| data.get("id").and_then(Value::as_str).map(str::to_owned))
                .is_some_and(|id| waiting.contains(&id))
        })
        .collect()
}

/// The frames of `/api/events` for a client that may be reconnecting: `ready` with the follow fields, then
/// `reset` when its cursor could not be honoured, else the frames it missed, then everything published after.
pub fn follow_frames(
    follow: Follow,
    presented: bool,
    client_id: &str,
    home: &str,
    heartbeat_ms: u64,
) -> impl Stream<Item = SseFrame> + Send + 'static {
    let Follow {
        subscription,
        replay,
        cursor,
    } = follow;
    let resumed = presented && replay.is_some();
    let mut opening = vec![SseFrame::ready_with(
        client_id,
        home,
        &ReadyFollow {
            cursor,
            resumed,
            heartbeat_ms,
        },
    )];
    match replay {
        Some(frames) => opening.extend(frames),
        None => opening.push(SseFrame::reset()),
    }
    futures::stream::iter(opening).chain(subscription)
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
///
/// Besides delivering frames it keeps the stream's log — the follow cursor of `src/server/stream.ts`'s `EventLog`:
/// every published frame except a heartbeat gets the id `<epoch>-<seq>` (`epoch` random per hub, `seq` from 1),
/// the newest are kept within a count and a byte bound, and [`EventHub::subscribe_from`] gives a reconnecting
/// client the kept frames after its cursor, or tells it the cursor cannot be honoured.
#[derive(Clone)]
pub struct EventHub {
    inner: Arc<Mutex<HubInner>>,
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

struct HubInner {
    next: u64,
    subscribers: Vec<(u64, mpsc::UnboundedSender<SseFrame>)>,
    closed: bool,
    epoch: String,
    seq: u64,
    kept: std::collections::VecDeque<(u64, SseFrame, usize)>,
    kept_bytes: usize,
    max_frames: usize,
    max_bytes: usize,
}

/// A subscription opened at a cursor: the frames the client missed (`None` when its cursor cannot be honoured),
/// the newest id at the moment it was opened, and the subscription that carries everything published after.
pub struct Follow {
    pub subscription: Subscription,
    pub replay: Option<Vec<SseFrame>>,
    pub cursor: String,
}

impl EventHub {
    pub fn new() -> Self {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).expect("the operating system entropy source");
        Self::with_log(
            bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
            4096,
            16 * 1024 * 1024,
        )
    }

    /// A hub with a given epoch and log bounds — what the tests pin; [`EventHub::new`] picks a random epoch.
    pub fn with_log(epoch: String, max_frames: usize, max_bytes: usize) -> Self {
        EventHub {
            inner: Arc::new(Mutex::new(HubInner {
                next: 0,
                subscribers: Vec::new(),
                closed: false,
                epoch,
                seq: 0,
                kept: std::collections::VecDeque::new(),
                kept_bytes: 0,
                max_frames,
                max_bytes,
            })),
        }
    }

    /// The id of the newest published frame, or `<epoch>-0` before the first.
    pub fn cursor(&self) -> String {
        let inner = self.inner.lock().expect("the event hub lock");
        format!("{}-{}", inner.epoch, inner.seq)
    }

    /// Deliver one frame to every live subscriber, dropping those whose reader has gone. Every frame but a
    /// heartbeat is given the next id and kept in the log first.
    pub fn publish(&self, mut frame: SseFrame) {
        let mut inner = self.inner.lock().expect("the event hub lock");
        if inner.closed {
            return;
        }
        if frame.event != names::HEARTBEAT {
            inner.seq += 1;
            let seq = inner.seq;
            frame.id = Some(format!("{}-{seq}", inner.epoch));
            let size = frame.encode().len();
            inner.kept.push_back((seq, frame.clone(), size));
            inner.kept_bytes += size;
            while inner.kept.len() > inner.max_frames
                || (inner.kept_bytes > inner.max_bytes && inner.kept.len() > 1)
            {
                if let Some((_, _, size)) = inner.kept.pop_front() {
                    inner.kept_bytes -= size;
                }
            }
        }
        inner
            .subscribers
            .retain(|(_, sender)| sender.send(frame.clone()).is_ok());
    }

    /// A subscription opened at `cursor`, all under one lock so no frame falls between the replay and the
    /// subscription. `cursor: None` (a first connection) replays nothing.
    pub fn subscribe_from(&self, cursor: Option<&str>) -> Follow {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut inner = self.inner.lock().expect("the event hub lock");
        if inner.closed {
            drop(sender);
        } else {
            inner.next += 1;
            let id = inner.next;
            inner.subscribers.push((id, sender));
        }
        let replay = match cursor {
            None => Some(Vec::new()),
            Some(cursor) => since(&inner, cursor),
        };
        Follow {
            subscription: Subscription { receiver },
            replay,
            cursor: format!("{}-{}", inner.epoch, inner.seq),
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

/// The kept frames after `cursor`, or `None` when it cannot be honoured: another epoch, older than the log,
/// ahead of it, or malformed — the rule of `EventLog.since` in `src/server/stream.ts`.
fn since(inner: &HubInner, cursor: &str) -> Option<Vec<SseFrame>> {
    let (epoch, seq) = cursor.rsplit_once('-')?;
    if epoch.is_empty()
        || epoch != inner.epoch
        || seq.is_empty()
        || !seq.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let seq: u64 = seq.parse().ok()?;
    if seq > inner.seq {
        return None;
    }
    let oldest = inner
        .kept
        .front()
        .map(|(seq, _, _)| *seq)
        .unwrap_or(inner.seq + 1);
    if seq + 1 < oldest {
        return None;
    }
    Some(
        inner
            .kept
            .iter()
            .filter(|(kept, _, _)| *kept > seq)
            .map(|(_, frame, _)| frame.clone())
            .collect(),
    )
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
                Poll::Ready(Some(mut frame)) => {
                    if frame.session_id().as_deref() == Some(self.session.as_str()) {
                        // A turn's own response is not the followed stream: its frames carry no id, as in TS.
                        frame.id = None;
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
    fn the_heartbeat_frame_writes_the_typescript_bytes() {
        assert_eq!(
            SseFrame::heartbeat().encode(),
            "event: heartbeat\ndata: {\"type\":\"heartbeat\"}\n\n"
        );
        // A heartbeat names no session, so a turn's own response (one session's frames) never carries it.
        assert_eq!(SseFrame::heartbeat().session_id(), None);
    }

    #[test]
    fn the_heartbeat_interval_is_two_seconds_unless_a_usable_value_is_named() {
        use std::time::Duration;
        assert_eq!(heartbeat_interval_from(None), Duration::from_millis(2000));
        assert_eq!(
            heartbeat_interval_from(Some("500")),
            Duration::from_millis(500)
        );
        for bad in ["", " ", "soon", "-5", "10", "1.5"] {
            assert_eq!(
                heartbeat_interval_from(Some(bad)),
                Duration::from_millis(2000),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_published_frame_carries_its_id_first_and_the_follow_frames_write_the_typescript_bytes() {
        let mut frame = SseFrame::session("s", &serde_json::json!({"type": "message"}));
        frame.id = Some("e1-3".into());
        assert_eq!(
            frame.encode(),
            "id: e1-3\nevent: session\ndata: {\"session\":\"s\",\"event\":{\"type\":\"message\"}}\n\n"
        );
        assert_eq!(
            SseFrame::reset().encode(),
            "event: reset\ndata: {\"type\":\"reset\"}\n\n"
        );
        let follow = ReadyFollow {
            cursor: "e1-7".into(),
            resumed: true,
            heartbeat_ms: 2000,
        };
        assert_eq!(
            SseFrame::ready_with("abc123", "/home/owner", &follow).encode(),
            "event: ready\ndata: {\"type\":\"ready\",\"clientId\":\"abc123\",\"host\":{\"home\":\"/home/owner\"},\"cursor\":\"e1-7\",\"resumed\":true,\"heartbeatMs\":2000}\n\n"
        );
    }

    fn ids(frames: &[SseFrame]) -> Vec<String> {
        frames
            .iter()
            .map(|frame| frame.id.clone().unwrap_or_default())
            .collect()
    }

    #[test]
    fn the_hub_numbers_what_it_publishes_but_not_the_heartbeat() {
        let hub = EventHub::with_log("e1".into(), 16, 1 << 20);
        assert_eq!(hub.cursor(), "e1-0");
        let mut subscription = hub.subscribe();
        hub.publish_session_event("s", &serde_json::json!({"n": 1}));
        hub.publish(SseFrame::heartbeat());
        hub.publish_approval_request(&serde_json::json!({"id": "approval-1"}));
        assert_eq!(hub.cursor(), "e1-2");
        let mut seen = Vec::new();
        while let Ok(frame) = subscription.receiver.try_recv() {
            seen.push(frame);
        }
        assert_eq!(
            ids(&seen),
            vec!["e1-1".to_owned(), String::new(), "e1-2".to_owned()]
        );
        assert!(
            EventHub::new().cursor().len() > "-0".len(),
            "a fresh hub picks a random epoch"
        );
    }

    #[test]
    fn a_cursor_in_the_log_is_given_exactly_what_follows_it() {
        let hub = EventHub::with_log("e1".into(), 16, 1 << 20);
        for n in 1..=5 {
            hub.publish_session_event("s", &serde_json::json!({ "n": n }));
        }
        assert_eq!(
            ids(&hub.subscribe_from(Some("e1-3")).replay.unwrap()),
            vec!["e1-4", "e1-5"]
        );
        assert!(hub.subscribe_from(Some("e1-5")).replay.unwrap().is_empty());
        assert_eq!(hub.subscribe_from(Some("e1-0")).replay.unwrap().len(), 5);
        assert!(
            hub.subscribe_from(None).replay.unwrap().is_empty(),
            "a first connection replays nothing"
        );
        assert_eq!(hub.subscribe_from(None).cursor, "e1-5");
    }

    #[test]
    fn a_cursor_the_log_cannot_honour_gets_none() {
        let hub = EventHub::with_log("e1".into(), 3, 1 << 20);
        for n in 1..=6 {
            hub.publish_session_event("s", &serde_json::json!({ "n": n }));
        }
        assert!(
            hub.subscribe_from(Some("e0-3")).replay.is_none(),
            "another epoch"
        );
        assert!(
            hub.subscribe_from(Some("e1-1")).replay.is_none(),
            "older than the log"
        );
        assert_eq!(hub.subscribe_from(Some("e1-3")).replay.unwrap().len(), 3);
        assert!(
            hub.subscribe_from(Some("e1-9")).replay.is_none(),
            "ahead of the log"
        );
        for bad in ["e1", "e1-", "-3", "e1-x", "e1-3.5"] {
            assert!(hub.subscribe_from(Some(bad)).replay.is_none(), "{bad:?}");
        }
    }

    #[test]
    fn the_log_is_bounded_by_bytes_and_keeps_the_newest_frame() {
        let hub = EventHub::with_log("e1".into(), 16, 150);
        hub.publish(SseFrame::new("session", &"x".repeat(60)));
        hub.publish(SseFrame::new("session", &"y".repeat(60)));
        assert!(
            hub.subscribe_from(Some("e1-0")).replay.is_none(),
            "the first frame was evicted"
        );
        assert_eq!(hub.subscribe_from(Some("e1-1")).replay.unwrap().len(), 1);
        hub.publish(SseFrame::new("session", &"z".repeat(500)));
        assert_eq!(hub.subscribe_from(Some("e1-2")).replay.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn follow_frames_open_with_ready_then_replay_or_reset_then_live() {
        let hub = EventHub::with_log("e1".into(), 16, 1 << 20);
        hub.publish_session_event("s", &serde_json::json!({"n": 1}));
        hub.publish_session_event("s", &serde_json::json!({"n": 2}));
        let mut frames = Box::pin(follow_frames(
            hub.subscribe_from(Some("e1-1")),
            true,
            "c",
            "/h",
            2000,
        ));
        hub.publish_session_event("s", &serde_json::json!({"n": 3}));
        let ready = frames.next().await.unwrap();
        assert_eq!(ready.event, names::READY);
        assert!(
            ready
                .data
                .contains("\"cursor\":\"e1-2\",\"resumed\":true,\"heartbeatMs\":2000"),
            "{}",
            ready.data
        );
        assert_eq!(
            frames.next().await.unwrap().id.as_deref(),
            Some("e1-2"),
            "the missed frame, replayed"
        );
        assert_eq!(
            frames.next().await.unwrap().id.as_deref(),
            Some("e1-3"),
            "then live, no duplicate"
        );

        let mut restarted = Box::pin(follow_frames(
            hub.subscribe_from(Some("e0-9")),
            true,
            "c",
            "/h",
            2000,
        ));
        let ready = restarted.next().await.unwrap();
        assert!(ready.data.contains("\"resumed\":false"), "{}", ready.data);
        assert_eq!(restarted.next().await.unwrap().event, names::RESET);
    }

    #[test]
    fn a_replay_keeps_an_approval_question_only_while_it_waits() {
        let hub = EventHub::with_log("e1".into(), 16, 1 << 20);
        hub.publish_approval_request(&serde_json::json!({"id": "approval-1", "tool": "bash"}));
        hub.publish(SseFrame::new(
            "approval-settled",
            &serde_json::json!({"type": "approval/settled", "id": "approval-1", "outcome": "rejected"}),
        ));
        hub.publish_approval_request(&serde_json::json!({"id": "approval-2", "tool": "bash"}));
        let replay = hub.subscribe_from(Some("e1-0")).replay.unwrap();
        let waiting: std::collections::HashSet<String> =
            ["approval-2".to_owned()].into_iter().collect();
        let kept = without_settled_approvals(replay, &waiting);
        let events: Vec<&str> = kept.iter().map(|frame| frame.event.as_str()).collect();
        assert_eq!(
            events,
            vec!["approval-settled", "approval"],
            "the answered question is dropped, its settlement kept"
        );
        assert!(kept[1].data.contains("approval-2"));
    }

    #[tokio::test]
    async fn a_turns_own_response_carries_no_ids() {
        let hub = EventHub::new();
        let mut frames = Box::pin(hub.subscribe().for_session("s"));
        hub.publish_session_event("s", &serde_json::json!({"type": "message"}));
        assert_eq!(frames.next().await.unwrap().id, None);
    }

    #[test]
    fn every_stream_gets_its_own_client_id_in_hex() {
        let ids: std::collections::HashSet<String> = (0..64).map(|_| new_client_id()).collect();
        assert_eq!(ids.len(), 64, "no two streams share an id");
        for id in &ids {
            assert_eq!(id.len(), 32, "{id}");
            assert!(
                id.chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{id}"
            );
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
                data: "not json".into(),
                id: None,
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
