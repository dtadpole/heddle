//! Outside listeners: a hook written as a process, attached to a point by its name.
//!
//! The TypeScript build loads a hook as a plugin module; a Rust binary cannot, so part 6's Rust shape is "an
//! outside listener uses the part-4 protocol" (`rust/ULTIMATE_GOAL.md`). Three layers:
//!
//! 1. **The message shapes** — [`HookCall`] (what the listener is told) and [`HookReply`] (what it answers).
//! 2. **The seam** — [`JsonListener`], anything that answers a `HookCall`, and the bridges that attach one to a
//!    typed point: [`Scope::on_json_emit`], [`Scope::on_json_parallel`], [`Scope::on_json_waterfall`], or by
//!    name with [`Scope::on_json`] for a point a crate [exposed](EventBus::expose_waterfall).
//! 3. **The transport** — [`StdioListener`], a child process spoken to as line-delimited JSON, configured by
//!    an [`OutsideListenerConfig`] row. *Proposed*: the framing below is to be made identical to
//!    `heddle-tools`' outside-tool protocol once that is fixed, so one process client serves both.
//!
//! # Wire framing (proposed)
//!
//! One JSON object per line. Heddle writes to the child's stdin:
//!
//! ```text
//! {"id":7,"method":"hook","params":{"point":"tools/pre-execute","mode":"waterfall","payload":{"name":"write_file","args":{}}}}
//! {"method":"hook","params":{"point":"session/event","mode":"emit","payload":{}}}
//! ```
//!
//! The second line has no `id`: an `emit` point is observation, so it is a notification and never answered.
//! The child answers each request on its stdout, in any order, by `id`:
//!
//! ```text
//! {"id":7,"result":{"kind":"replace","value":{"allowed":false,"reason":"this hook refuses writes"}}}
//! {"id":8,"result":{"kind":"next"}}
//! {"id":9,"result":{"kind":"refuse","reason":"this hook refuses to send the request"}}
//! {"id":10,"error":{"message":"this hook is broken"}}
//! ```
//!
//! An `error`, an unreadable line, a reply after the timeout, or the child exiting fails the pending calls with
//! [`HookErrorKind::Failed`](crate::HookErrorKind::Failed); the child's stderr goes to the log.
//!
//! # Configuration row (proposed, for the boot and the `60-hooks` branch)
//!
//! ```yaml
//! - id: hook-1
//!   name: outside-listener
//!   config:
//!     command: [node, ./retarget.mjs]
//!     points: [model/request]
//! ```

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bus::{EventBus, HookFuture, ListenOptions, Listener, Scope};
use crate::error::HookError;
use crate::event::{EmitEvent, Event, ParallelEvent, WaterfallEvent};
use crate::mode::Mode;
use crate::waterfall::Next;

/// One dispatch, as an outside listener is told it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HookCall {
    /// The point's name.
    pub point: String,
    /// The point's mode.
    pub mode: Mode,
    /// The payload, serialized.
    pub payload: Value,
}

/// An outside listener's answer, tagged by `kind`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HookReply {
    /// Run the rest of the chain and return its value unchanged (in a waterfall); acknowledge (otherwise).
    Next,
    /// Return `value` without running the rest of the chain — replace, or refuse by value (a
    /// `tools/pre-execute` answer `{allowed:false, reason}`). Only meaningful in a waterfall.
    Replace {
        /// A value of the point's output type, serialized.
        value: Value,
    },
    /// Refuse the step on purpose.
    Refuse {
        /// What the person reads after `refused by hook: `.
        reason: String,
    },
    /// The listener failed.
    Fail {
        /// What went wrong.
        message: String,
    },
}

/// Serialize one payload into the message an outside listener is handed.
fn hook_call<E: Event>(payload: &E::Payload, mode: Mode) -> Result<HookCall, HookError>
where
    E::Payload: Serialize,
{
    serde_json::to_value(payload)
        .map(|value| HookCall {
            point: E::NAME.to_owned(),
            mode,
            payload: value,
        })
        .map_err(|error| {
            HookError::fail(format!(
                "the payload of {} does not serialize: {error}",
                E::NAME
            ))
        })
}

/// Anything that answers a [`HookCall`]: a process, or a test double.
pub trait JsonListener: Send + Sync + 'static {
    /// A dispatch that waits for the answer (waterfall, parallel, serial).
    fn call(&self, call: HookCall) -> HookFuture<HookReply>;
    /// An `emit` dispatch: observation, never waited for. Must not block.
    fn notify(&self, call: HookCall);
}

/// No point of that name was exposed for outside listeners, or it was exposed in a mode that cannot be bridged.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("no hook point named '{name}' accepts an outside listener; exposed: {exposed}")]
pub struct UnknownPoint {
    /// The name asked for.
    pub name: String,
    /// The exposed names, comma-separated, for the message.
    pub exposed: String,
}

impl EventBus {
    /// Let outside listeners attach to the [`EmitEvent`] `E` by its name.
    pub fn expose_emit<E: EmitEvent>(&self)
    where
        E::Payload: Serialize,
    {
        self.inner().expose(
            E::NAME,
            Mode::Emit,
            Arc::new(|scope, listener, options| scope.on_json_emit::<E>(listener, options)),
        );
    }

    /// Let outside listeners attach to the [`ParallelEvent`] `E` by its name.
    pub fn expose_parallel<E: ParallelEvent>(&self)
    where
        E::Payload: Serialize,
    {
        self.inner().expose(
            E::NAME,
            Mode::Parallel,
            Arc::new(|scope, listener, options| scope.on_json_parallel::<E>(listener, options)),
        );
    }

    /// Let outside listeners attach to the [`WaterfallEvent`] `E` by its name. The crate that owns a point's
    /// marker calls this when its payload and output serialize — `model/stream`, whose output is a stream, is
    /// not exposed.
    pub fn expose_waterfall<E: WaterfallEvent>(&self)
    where
        E::Payload: Serialize,
        E::Output: DeserializeOwned,
    {
        self.inner().expose(
            E::NAME,
            Mode::Waterfall,
            Arc::new(|scope, listener, options| scope.on_json_waterfall::<E>(listener, options)),
        );
    }

    /// The points outside listeners may attach to, with their modes, sorted by name.
    pub fn exposed(&self) -> Vec<(&'static str, Mode)> {
        self.inner().exposed_points()
    }
}

impl Scope {
    /// Attach an outside listener to the exposed point named `point`.
    pub fn on_json(
        &self,
        point: &str,
        listener: Arc<dyn JsonListener>,
        options: ListenOptions,
    ) -> Result<Listener, UnknownPoint> {
        let attach = self.bus().inner().attacher(point)?;
        Ok(attach(self, listener, options))
    }

    /// Attach an outside listener to the [`EmitEvent`] `E`: every dispatch is a [`JsonListener::notify`].
    pub fn on_json_emit<E: EmitEvent>(
        &self,
        listener: Arc<dyn JsonListener>,
        options: ListenOptions,
    ) -> Listener
    where
        E::Payload: Serialize,
    {
        self.on_emit::<E>(
            move |payload| match hook_call::<E>(payload, Mode::Emit) {
                Ok(call) => listener.notify(call),
                Err(error) => {
                    tracing::warn!(point = E::NAME, error = %error, "an outside listener was not told");
                }
            },
            options,
        )
    }

    /// Attach an outside listener to the [`ParallelEvent`] `E`: `next` and `replace` succeed, `refuse` and
    /// `fail` are failures.
    pub fn on_json_parallel<E: ParallelEvent>(
        &self,
        listener: Arc<dyn JsonListener>,
        options: ListenOptions,
    ) -> Listener
    where
        E::Payload: Serialize,
    {
        self.on_parallel::<E>(
            move |payload: Arc<E::Payload>| {
                let listener = listener.clone();
                Box::pin(async move {
                    let call = hook_call::<E>(&payload, Mode::Parallel)?;
                    match listener.call(call).await? {
                        HookReply::Next | HookReply::Replace { .. } => Ok(()),
                        HookReply::Refuse { reason } => Err(HookError::refuse(reason)),
                        HookReply::Fail { message } => Err(HookError::fail(message)),
                    }
                })
            },
            options,
        )
    }

    /// Attach an outside listener to the [`WaterfallEvent`] `E`: `next` runs the rest of the chain, `replace`
    /// returns its value (deserialized as `E::Output`; a value that does not deserialize is a failure),
    /// `refuse` and `fail` end the dispatch.
    pub fn on_json_waterfall<E: WaterfallEvent>(
        &self,
        listener: Arc<dyn JsonListener>,
        options: ListenOptions,
    ) -> Listener
    where
        E::Payload: Serialize,
        E::Output: DeserializeOwned,
    {
        self.on_waterfall::<E>(
            move |payload: Arc<E::Payload>, next: Next<E>| {
                let listener = listener.clone();
                Box::pin(async move {
                    let call = hook_call::<E>(&payload, Mode::Waterfall)?;
                    match listener.call(call).await? {
                        HookReply::Next => next.run().await,
                        HookReply::Replace { value } => {
                            serde_json::from_value::<E::Output>(value).map_err(|error| {
                                HookError::fail(format!(
                                    "the value an outside listener replaced at {} does not decode: {error}",
                                    E::NAME
                                ))
                            })
                        }
                        HookReply::Refuse { reason } => Err(HookError::refuse(reason)),
                        HookReply::Fail { message } => Err(HookError::fail(message)),
                    }
                })
            },
            options,
        )
    }
}

/// The default time an outside listener has to answer one call.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// One configured outside listener: the process to start and the points it listens on. Deserialized from a
/// configuration row's `config`, with the TypeScript build's camel-case keys.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutsideListenerConfig {
    /// The program and its arguments; the program is resolved like a shell would, relative paths from `cwd`.
    pub command: Vec<String>,
    /// The exposed points to attach to.
    pub points: Vec<String>,
    /// The working directory; the configuration file's directory when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    /// Extra environment for the child.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Per-call answer deadline; [`DEFAULT_TIMEOUT_MS`] when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// Starting or speaking to an outside listener failed.
#[derive(Debug, thiserror::Error)]
pub enum OutsideError {
    /// The configuration cannot be used (an empty command, no points).
    #[error("outside listener configuration: {0}")]
    Config(String),
    /// The process could not be started.
    #[error("outside listener could not start '{command}': {source}")]
    Spawn {
        /// The program.
        command: String,
        /// Why.
        source: std::io::Error,
    },
    /// A configured point is not exposed.
    #[error(transparent)]
    UnknownPoint(#[from] UnknownPoint),
}

/// An outside listener running as a child process, spoken to as line-delimited JSON on its stdio.
///
/// The child lives as long as the last `Arc` to this value; it is killed when dropped.
pub struct StdioListener {
    _private: (),
}

impl StdioListener {
    /// Start the configured process. Must be called inside a Tokio runtime.
    pub async fn spawn(config: &OutsideListenerConfig) -> Result<Arc<StdioListener>, OutsideError> {
        let _ = config;
        todo!("heddle-events: StdioListener::spawn")
    }
}

impl JsonListener for StdioListener {
    fn call(&self, call: HookCall) -> HookFuture<HookReply> {
        let _ = call;
        todo!("heddle-events: StdioListener::call")
    }

    fn notify(&self, call: HookCall) {
        let _ = call;
        todo!("heddle-events: StdioListener::notify")
    }
}

/// Start the configured process and attach it, through `scope`, to every point it names. Fails without
/// attaching anything when a point is not exposed.
pub async fn attach_outside_listener(
    scope: &Scope,
    config: &OutsideListenerConfig,
) -> Result<Vec<Listener>, OutsideError> {
    let _ = (scope, config);
    todo!("heddle-events: attach_outside_listener")
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    use crate::error::HookErrorKind;

    #[test]
    fn a_reply_is_tagged_by_kind() {
        let replace: HookReply =
            serde_json::from_str(r#"{"kind":"replace","value":{"allowed":false}}"#).unwrap();
        assert_eq!(
            replace,
            HookReply::Replace {
                value: serde_json::json!({"allowed": false})
            }
        );
        let next: HookReply = serde_json::from_str(r#"{"kind":"next"}"#).unwrap();
        assert_eq!(next, HookReply::Next);
        let refuse: HookReply = serde_json::from_str(r#"{"kind":"refuse","reason":"no"}"#).unwrap();
        assert_eq!(
            refuse,
            HookReply::Refuse {
                reason: "no".into()
            }
        );
        assert!(serde_json::from_str::<HookReply>(r#"{"kind":"maybe"}"#).is_err());
    }

    #[test]
    fn a_configuration_row_reads_with_camel_case_keys_and_refuses_unknown_ones() {
        let config: OutsideListenerConfig = serde_json::from_str(
            r#"{"command":["node","./retarget.mjs"],"points":["model/request"],"timeoutMs":500}"#,
        )
        .unwrap();
        assert_eq!(config.command, ["node", "./retarget.mjs"]);
        assert_eq!(config.points, ["model/request"]);
        assert_eq!(config.timeout_ms, Some(500));
        assert!(
            serde_json::from_str::<OutsideListenerConfig>(
                r#"{"command":["x"],"points":[],"timeout":1}"#
            )
            .is_err()
        );
    }

    fn reply_next(_call: &HookCall) -> HookFuture<HookReply> {
        Box::pin(async { Ok(HookReply::Next) })
    }

    fn reply_replaced(_call: &HookCall) -> HookFuture<HookReply> {
        Box::pin(async {
            Ok(HookReply::Replace {
                value: serde_json::json!("replaced"),
            })
        })
    }

    fn reply_replacement_of_the_wrong_type(_call: &HookCall) -> HookFuture<HookReply> {
        Box::pin(async {
            Ok(HookReply::Replace {
                value: serde_json::json!(42),
            })
        })
    }

    fn reply_refused(_call: &HookCall) -> HookFuture<HookReply> {
        Box::pin(async {
            Ok(HookReply::Refuse {
                reason: "this hook refuses".into(),
            })
        })
    }

    fn reply_failed(_call: &HookCall) -> HookFuture<HookReply> {
        Box::pin(async {
            Ok(HookReply::Fail {
                message: "this hook is broken".into(),
            })
        })
    }

    struct MemoryListener {
        seen: Arc<Mutex<Vec<HookCall>>>,
        reply: fn(&HookCall) -> HookFuture<HookReply>,
    }

    impl JsonListener for MemoryListener {
        fn call(&self, call: HookCall) -> HookFuture<HookReply> {
            self.seen.lock().unwrap().push(call.clone());
            (self.reply)(&call)
        }

        fn notify(&self, call: HookCall) {
            self.seen.lock().unwrap().push(call);
        }
    }

    fn memory(
        reply: fn(&HookCall) -> HookFuture<HookReply>,
    ) -> (Arc<dyn JsonListener>, Arc<Mutex<Vec<HookCall>>>) {
        let seen: Arc<Mutex<Vec<HookCall>>> = Arc::default();
        let listener: Arc<dyn JsonListener> = Arc::new(MemoryListener {
            seen: seen.clone(),
            reply,
        });
        (listener, seen)
    }

    struct Echoed;
    impl Event for Echoed {
        const NAME: &'static str = "test/json-waterfall";
        type Payload = String;
    }
    impl WaterfallEvent for Echoed {
        type Output = String;
    }

    struct Reported;
    impl Event for Reported {
        const NAME: &'static str = "test/json-emit";
        type Payload = Value;
    }
    impl EmitEvent for Reported {}

    struct FannedJson;
    impl Event for FannedJson {
        const NAME: &'static str = "test/json-parallel";
        type Payload = u32;
    }
    impl ParallelEvent for FannedJson {}

    #[tokio::test]
    async fn an_exposed_waterfall_point_is_listed_and_a_next_reply_runs_the_default() {
        let bus = EventBus::new();
        bus.expose_waterfall::<Echoed>();
        assert_eq!(bus.exposed(), vec![(Echoed::NAME, Mode::Waterfall)]);
        let (listener, seen) = memory(reply_next);
        let scope = bus.scope("outside");
        let handle = scope
            .on_json(Echoed::NAME, listener, ListenOptions::APPEND)
            .unwrap();
        assert!(handle.is_active());
        let value = bus
            .waterfall::<Echoed>("base".to_string(), |payload| format!("default:{payload}"))
            .await
            .unwrap();
        assert_eq!(value, "default:base");
        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].point, Echoed::NAME);
        assert_eq!(calls[0].mode, Mode::Waterfall);
        assert_eq!(calls[0].payload, serde_json::json!("base"));
    }

    #[tokio::test]
    async fn a_replace_reply_is_the_value_and_the_rest_does_not_run() {
        let bus = EventBus::new();
        bus.expose_waterfall::<Echoed>();
        let (listener, _seen) = memory(reply_replaced);
        let scope = bus.scope("outside");
        scope
            .on_json(Echoed::NAME, listener, ListenOptions::APPEND)
            .unwrap();
        let ran_default = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ran_default_in_inner = ran_default.clone();
        let value = bus
            .waterfall::<Echoed>("base".to_string(), move |payload| {
                ran_default_in_inner.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                payload.clone()
            })
            .await
            .unwrap();
        assert_eq!(value, "replaced");
        assert_eq!(
            ran_default.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "the replacement stopped the chain"
        );
    }

    #[tokio::test]
    async fn a_refuse_reply_is_a_refusal_attributed_to_the_scopes_name() {
        let bus = EventBus::new();
        bus.expose_waterfall::<Echoed>();
        let (listener, _seen) = memory(reply_refused);
        let scope = bus.scope("outside-policy");
        scope
            .on_json(Echoed::NAME, listener, ListenOptions::APPEND)
            .unwrap();
        let error = bus
            .waterfall::<Echoed>("base".to_string(), |payload| payload.clone())
            .await
            .unwrap_err();
        assert!(error.is_refusal());
        assert_eq!(error.to_string(), "refused by hook: this hook refuses");
        assert_eq!(error.listener(), Some("outside-policy"));
    }

    #[tokio::test]
    async fn a_fail_reply_is_a_broken_hook_attributed_to_the_scopes_name() {
        let bus = EventBus::new();
        bus.expose_waterfall::<Echoed>();
        let (listener, _seen) = memory(reply_failed);
        let scope = bus.scope("outside-broken");
        scope
            .on_json(Echoed::NAME, listener, ListenOptions::APPEND)
            .unwrap();
        let error = bus
            .waterfall::<Echoed>("base".to_string(), |payload| payload.clone())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), HookErrorKind::Failed);
        assert_eq!(error.listener(), Some("outside-broken"));
        assert!(error.message().contains("this hook is broken"));
    }

    #[tokio::test]
    async fn a_replacement_that_does_not_decode_fails_rather_than_guessing() {
        let bus = EventBus::new();
        bus.expose_waterfall::<Echoed>();
        let (listener, _seen) = memory(reply_replacement_of_the_wrong_type);
        let scope = bus.scope("outside");
        scope
            .on_json(Echoed::NAME, listener, ListenOptions::APPEND)
            .unwrap();
        let error = bus
            .waterfall::<Echoed>("base".to_string(), |payload| payload.clone())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), HookErrorKind::Failed);
        assert!(error.message().contains("does not decode"));
    }

    #[test]
    fn an_unknown_point_lists_what_is_exposed() {
        let bus = EventBus::new();
        bus.expose_waterfall::<Echoed>();
        bus.expose_emit::<Reported>();
        assert_eq!(
            bus.exposed(),
            vec![
                (Reported::NAME, Mode::Emit),
                (Echoed::NAME, Mode::Waterfall)
            ],
            "exposed points are sorted by name"
        );
        let (listener, _seen) = memory(reply_next);
        let scope = bus.scope("outside");
        let error = scope
            .on_json("test/absent", listener, ListenOptions::APPEND)
            .unwrap_err();
        assert_eq!(error.name, "test/absent");
        assert_eq!(error.exposed, "test/json-emit, test/json-waterfall");
    }

    #[tokio::test]
    async fn an_emit_point_notifies_an_outside_listener_without_waiting() {
        let bus = EventBus::new();
        bus.expose_emit::<Reported>();
        let (listener, seen) = memory(reply_next);
        let scope = bus.scope("observer");
        scope
            .on_json(Reported::NAME, listener, ListenOptions::APPEND)
            .unwrap();
        bus.emit::<Reported>(&serde_json::json!({"seq": 1}));
        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].mode, Mode::Emit);
        assert_eq!(calls[0].payload, serde_json::json!({"seq": 1}));
    }

    #[tokio::test]
    async fn a_parallel_json_listener_can_refuse_and_the_failure_is_collected() {
        let bus = EventBus::new();
        bus.expose_parallel::<FannedJson>();
        let (listener, _seen) = memory(reply_refused);
        let scope = bus.scope("outside-fanout");
        scope
            .on_json(FannedJson::NAME, listener, ListenOptions::APPEND)
            .unwrap();
        let error = bus.parallel::<FannedJson>(1u32).await.unwrap_err();
        assert_eq!(error.errors.len(), 1);
        assert_eq!(error.errors[0].kind(), HookErrorKind::Refused);
        assert_eq!(error.errors[0].listener(), Some("outside-fanout"));
    }

    #[tokio::test]
    async fn the_typed_bridges_attach_without_the_registry() {
        let bus = EventBus::new();
        let (listener, seen) = memory(reply_replaced);
        let scope = bus.scope("direct");
        scope.on_json_waterfall::<Echoed>(listener, ListenOptions::APPEND);
        let value = bus
            .waterfall::<Echoed>("base".to_string(), |payload| payload.clone())
            .await
            .unwrap();
        assert_eq!(value, "replaced");
        assert_eq!(seen.lock().unwrap()[0].point, Echoed::NAME);
    }

    #[test]
    fn a_disposed_scope_releases_its_outside_listener() {
        let bus = EventBus::new();
        bus.expose_emit::<Reported>();
        let (listener, _seen) = memory(reply_next);
        let scope = bus.scope("temporary");
        scope
            .on_json(Reported::NAME, listener, ListenOptions::APPEND)
            .unwrap();
        assert_eq!(bus.listener_count(Reported::NAME), 1);
        scope.dispose();
        assert_eq!(bus.listener_count(Reported::NAME), 0);
    }
}
