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
//! # Wire framing (JSON-RPC 2.0, the part-4 protocol)
//!
//! One JSON-RPC 2.0 message per line on the child's stdio, as `heddle-tools`'
//! `PROTOCOL.md` states. The first message is `initialize`, answered with a result; every event after it is
//! `hooks/call`, whose `params` are [`HookCall`] (`point`, `mode`, `payload`):
//!
//! ```text
//! {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":"heddle-component/1","row":"hook-1","config":{...},"workspaceRoot":"/work","mode":"workspace-write"}}
//! {"jsonrpc":"2.0","id":1,"result":{"listeners":[...]}}
//! {"jsonrpc":"2.0","id":7,"method":"hooks/call","params":{"point":"tools/pre-execute","mode":"waterfall","payload":{"name":"write_file","args":{}}}}
//! {"jsonrpc":"2.0","id":7,"result":{"kind":"replace","value":{"allowed":false,"reason":"this hook refuses writes"}}}
//! {"jsonrpc":"2.0","method":"hooks/call","params":{"point":"session/event","mode":"emit","payload":{}}}
//! {"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"this hook is broken"}}
//! ```
//!
//! An `emit` point is a notification (no `id`) and is never answered. A JSON-RPC `error` answer, an
//! unreadable line, a reply after the timeout or the child exiting fails the pending calls with
//! [`HookErrorKind::Failed`](crate::HookErrorKind::Failed); the child's stderr goes to the log. `shutdown`
//! and `exit` end the connection ([`StdioListener::shutdown`]).
//!
//! # Configuration row (for the boot and the `60-hooks` branch)
//!
//! ```yaml
//! - id: hook-1
//!   name: outside-listener
//!   config:
//!     command: [node, ./retarget.mjs]
//!     points: [model/request]
//! ```
//!
//! `row`, `workspaceRoot` and `mode` in the handshake come from the row the boot built and the deployment;
//! a listener started outside that context defaults them (`outside-listener`, the current directory,
//! `workspace-write`).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

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

/// The protocol version the handshake announces.
pub const COMPONENT_PROTOCOL: &str = "heddle-component/1";

/// The time the child has to answer `initialize`.
const HANDSHAKE_TIMEOUT_MS: u64 = 10_000;

/// One call's answer channel: the raw JSON-RPC result, parsed by the caller.
type PendingSender = oneshot::Sender<Result<Value, HookError>>;

/// The calls waiting for an answer, by the id the host gave them.
type PendingCalls = HashMap<u64, PendingSender>;

/// One request to the child, as JSON-RPC 2.0 writes it; a notification has no `id`.
#[derive(Serialize)]
struct RpcRequest<'a> {
    jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<u64>,
    method: &'a str,
    params: Value,
}

/// One line the child writes.
#[derive(Deserialize)]
struct RpcReply {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RpcError>,
}

/// The JSON-RPC error arm of a reply.
#[derive(Deserialize)]
struct RpcError {
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "the message is what a person reads; the code is carried by the protocol"
    )]
    code: Option<i64>,
    message: String,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "the protocol's data arm; only SANDBOX reads it, in heddle-tools"
    )]
    data: Option<Value>,
}

/// Fail every pending call — the child died, or it wrote something that is not a reply.
fn fail_pending(pending: &Mutex<PendingCalls>, message: &str) {
    let mut pending = pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err(HookError::fail(message.to_owned())));
    }
}

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
    /// The configuration row's id, for the initialize handshake; the boot fills it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<String>,
    /// The deployment's workspace root, for the handshake; the boot fills it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<PathBuf>,
    /// The deployment's mode, for the handshake; `workspace-write` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
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
    /// The process did not complete the handshake.
    #[error("outside listener '{row}' did not complete the handshake: {message}")]
    Handshake {
        /// The row.
        row: String,
        /// Why.
        message: String,
    },
    /// A configured point is not exposed.
    #[error(transparent)]
    UnknownPoint(#[from] UnknownPoint),
}

/// An outside listener running as a child process, spoken to as line-delimited JSON-RPC 2.0 on its stdio.
///
/// The child lives as long as the last `Arc` to this value; it is killed when dropped. [`shutdown`] asks it
/// to end first.
///
/// [`shutdown`]: StdioListener::shutdown
pub struct StdioListener {
    /// The child, kept only so dropping the listener can kill it.
    child: Mutex<Child>,
    /// Lines waiting to be written to the child's stdin; `notify` never blocks on the pipe.
    outbox: mpsc::UnboundedSender<String>,
    /// Calls waiting for an answer, by the id the host gave them.
    pending: Arc<Mutex<PendingCalls>>,
    next_id: AtomicU64,
    timeout: Duration,
}

impl StdioListener {
    /// Start the configured process and complete the `initialize` handshake.
    ///
    /// Must be called inside a Tokio runtime. The child is killed when the last `Arc` to the listener drops.
    pub async fn spawn(config: &OutsideListenerConfig) -> Result<Arc<StdioListener>, OutsideError> {
        if config.command.is_empty() {
            return Err(OutsideError::Config("the command is empty".into()));
        }
        if config.points.is_empty() {
            return Err(OutsideError::Config("no points are named".into()));
        }
        let mut command = Command::new(&config.command[0]);
        command.args(&config.command[1..]);
        if let Some(cwd) = &config.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &config.env {
            command.env(key, value);
        }
        command
            .env("HEDDLE_COMPONENT_PROTOCOL", COMPONENT_PROTOCOL)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|source| OutsideError::Spawn {
            command: config.command.join(" "),
            source,
        })?;
        let stdin = child
            .stdin
            .take()
            .expect("a piped child stdin is always present");
        let stdout = child
            .stdout
            .take()
            .expect("a piped child stdout is always present");
        let stderr = child
            .stderr
            .take()
            .expect("a piped child stderr is always present");
        let pending: Arc<Mutex<PendingCalls>> = Arc::default();
        let (outbox, outbox_rx) = mpsc::unbounded_channel::<String>();
        let listener = Arc::new(StdioListener {
            child: Mutex::new(child),
            outbox,
            pending: pending.clone(),
            next_id: AtomicU64::new(1),
            timeout: Duration::from_millis(config.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)),
        });

        // Writes are queued so a caller never blocks on the pipe; one task owns the child's stdin.
        let mut outbox_rx = outbox_rx;
        tokio::spawn(async move {
            let mut stdin = BufWriter::new(stdin);
            while let Some(line) = outbox_rx.recv().await {
                let written = stdin.write_all(format!("{line}\n").as_bytes()).await;
                if written.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        // The child's answers are correlated by id; EOF fails whatever is still waiting.
        let pending_for_reader = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let reply: RpcReply = match serde_json::from_str(trimmed) {
                            Ok(reply) => reply,
                            Err(error) => {
                                tracing::error!(
                                    %error,
                                    line = trimmed,
                                    "an outside listener wrote a line that is not a JSON-RPC reply"
                                );
                                fail_pending(
                                    &pending_for_reader,
                                    "the outside listener wrote a line that is not a JSON-RPC reply",
                                );
                                break;
                            }
                        };
                        let RpcReply { id, result, error } = reply;
                        let Some(id) = id else {
                            tracing::warn!(
                                line = trimmed,
                                "an outside listener wrote a reply without an id"
                            );
                            continue;
                        };
                        let sender = pending_for_reader
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .remove(&id);
                        if let Some(sender) = sender {
                            let outcome = match (result, error) {
                                (_, Some(error)) => Err(HookError::fail(error.message)),
                                (Some(result), None) => Ok(result),
                                (None, None) => Err(HookError::fail(
                                    "an outside listener reply had neither a result nor an error",
                                )),
                            };
                            let _ = sender.send(outcome);
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        tracing::error!(%error, "reading an outside listener failed");
                        break;
                    }
                }
            }
            fail_pending(
                &pending_for_reader,
                "the outside listener exited before answering",
            );
        });

        // The child's stderr is the log, never the protocol.
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(target: "heddle_events::outside", "{line}");
            }
        });

        // The handshake is the first message, as the part-4 protocol states.
        let row = config
            .row
            .clone()
            .unwrap_or_else(|| "outside-listener".to_owned());
        let workspace_root = config
            .workspace_root
            .clone()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
            .display()
            .to_string();
        let mode = config
            .mode
            .clone()
            .unwrap_or_else(|| "workspace-write".to_owned());
        let handshake = serde_json::json!({
            "protocol": COMPONENT_PROTOCOL,
            "row": row,
            "config": {
                "command": config.command,
                "points": config.points,
                "cwd": config.cwd,
                "env": config.env,
                "timeoutMs": config.timeout_ms,
            },
            "workspaceRoot": workspace_root,
            "mode": mode,
        });
        let initialized = tokio::time::timeout(
            Duration::from_millis(HANDSHAKE_TIMEOUT_MS),
            listener.request("initialize", handshake),
        )
        .await;
        let failure = match initialized {
            Ok(Ok(_result)) => None,
            Ok(Err(error)) => Some(error.to_string()),
            Err(_) => Some(format!("no answer within {HANDSHAKE_TIMEOUT_MS}ms")),
        };
        if let Some(message) = failure {
            return Err(OutsideError::Handshake { row, message });
        }
        Ok(listener)
    }

    /// One JSON-RPC request: write it, then wait for the answer correlated by id.
    fn request(&self, method: &'static str, params: Value) -> HookFuture<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, sender);
        let request = RpcRequest {
            jsonrpc: "2.0",
            id: Some(id),
            method,
            params,
        };
        let outcome = match serde_json::to_string(&request) {
            Ok(line) => self
                .outbox
                .send(line)
                .map_err(|_| "the outside listener is not running: its input is closed".to_owned()),
            Err(error) => Err(format!("the request does not serialize: {error}")),
        };
        if let Err(message) = outcome {
            self.pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id);
            return Box::pin(async move { Err(HookError::fail(message)) });
        }
        let pending = self.pending.clone();
        let outbox = self.outbox.clone();
        let timeout = self.timeout;
        Box::pin(async move {
            match tokio::time::timeout(timeout, receiver).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_)) => Err(HookError::fail(
                    "the outside listener stopped before it answered",
                )),
                Err(_) => {
                    pending
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&id);
                    if let Ok(line) = serde_json::to_string(&RpcRequest {
                        jsonrpc: "2.0",
                        id: None,
                        method: "$/cancelRequest",
                        params: serde_json::json!({ "id": id }),
                    }) {
                        let _ = outbox.send(line);
                    }
                    Err(HookError::fail(format!(
                        "the outside listener did not answer within {}ms",
                        timeout.as_millis()
                    )))
                }
            }
        })
    }

    /// One notification: no id, never answered.
    fn notify_raw(&self, method: &'static str, params: Value) {
        if let Ok(line) = serde_json::to_string(&RpcRequest {
            jsonrpc: "2.0",
            id: None,
            method,
            params,
        }) {
            let _ = self.outbox.send(line);
        }
    }

    /// End the connection: `shutdown` (request), then `exit` (notification). Dropping the listener kills a
    /// child that has not exited.
    pub async fn shutdown(&self) {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            self.request("shutdown", Value::Null),
        )
        .await;
        self.notify_raw("exit", Value::Null);
    }
}

impl JsonListener for StdioListener {
    fn call(&self, call: HookCall) -> HookFuture<HookReply> {
        let params = match serde_json::to_value(&call) {
            Ok(params) => params,
            Err(error) => {
                return Box::pin(async move {
                    Err(HookError::fail(format!(
                        "a hook call does not serialize: {error}"
                    )))
                });
            }
        };
        let answer = self.request("hooks/call", params);
        Box::pin(async move {
            let value = answer.await?;
            serde_json::from_value::<HookReply>(value).map_err(|error| {
                HookError::fail(format!(
                    "the outside listener answered something that is not a hook reply: {error}"
                ))
            })
        })
    }

    fn notify(&self, call: HookCall) {
        if let Ok(params) = serde_json::to_value(&call) {
            self.notify_raw("hooks/call", params);
        }
    }
}

impl Drop for StdioListener {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
    }
}

/// Start the configured process and attach it, through `scope`, to every point it names. Fails without
/// attaching anything when a point is not exposed.
pub async fn attach_outside_listener(
    scope: &Scope,
    config: &OutsideListenerConfig,
) -> Result<Vec<Listener>, OutsideError> {
    if config.command.is_empty() {
        return Err(OutsideError::Config("the command is empty".into()));
    }
    if config.points.is_empty() {
        return Err(OutsideError::Config("no points are named".into()));
    }
    // Every point is checked before the process starts, so a bad row attaches nothing.
    for point in &config.points {
        scope.bus().inner().attacher(point)?;
    }
    let listener = StdioListener::spawn(config).await?;
    let mut handles = Vec::with_capacity(config.points.len());
    for point in &config.points {
        handles.push(scope.on_json(point, listener.clone(), ListenOptions::APPEND)?);
    }
    Ok(handles)
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

    fn script_config(script: &str, points: &[&str]) -> OutsideListenerConfig {
        OutsideListenerConfig {
            command: vec!["/bin/sh".into(), "-c".into(), script.into()],
            points: points.iter().map(|point| (*point).to_string()).collect(),
            cwd: None,
            env: BTreeMap::new(),
            timeout_ms: Some(5_000),
            row: None,
            workspace_root: None,
            mode: None,
        }
    }

    fn waterfall_call(payload: &str) -> HookCall {
        HookCall {
            point: Echoed::NAME.to_owned(),
            mode: Mode::Waterfall,
            payload: serde_json::json!(payload),
        }
    }

    #[tokio::test]
    async fn a_stdio_listener_answers_by_correlating_the_id() {
        let script = r#"read handshake
printf '{"jsonrpc":"2.0","id":1,"result":{}}\n'
read line
printf '{"jsonrpc":"2.0","id":2,"result":{"kind":"replace","value":"replaced"}}\n'
"#;
        let config = script_config(script, &[Echoed::NAME]);
        let listener = StdioListener::spawn(&config).await.unwrap();
        let reply = listener.call(waterfall_call("base")).await.unwrap();
        assert_eq!(
            reply,
            HookReply::Replace {
                value: serde_json::json!("replaced")
            }
        );
    }

    #[tokio::test]
    async fn a_child_that_exits_without_answering_fails_the_pending_call() {
        let config = script_config(
            "read handshake\nprintf '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\\n'\nread line\nexit 0\n",
            &[Echoed::NAME],
        );
        let listener = StdioListener::spawn(&config).await.unwrap();
        let error = listener.call(waterfall_call("base")).await.unwrap_err();
        assert_eq!(error.kind(), HookErrorKind::Failed);
        assert!(
            error.message().contains("exited") || error.message().contains("not running"),
            "saw: {}",
            error.message()
        );
    }

    #[tokio::test]
    async fn a_child_that_never_answers_times_out_with_its_own_message() {
        let mut config = script_config(
            "read handshake\nprintf '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\\n'\nread line\nsleep 2\n",
            &[Echoed::NAME],
        );
        config.timeout_ms = Some(150);
        let listener = StdioListener::spawn(&config).await.unwrap();
        let error = listener.call(waterfall_call("base")).await.unwrap_err();
        assert_eq!(error.kind(), HookErrorKind::Failed);
        assert!(
            error.message().contains("did not answer within"),
            "saw: {}",
            error.message()
        );
    }

    #[tokio::test]
    async fn a_notification_carries_the_point_but_no_id() {
        let path = std::env::temp_dir().join(format!(
            "heddle-events-notify-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut config = script_config(
            "read handshake\nprintf '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\\n'\nread line\nprintf '%s' \"$line\" > \"$OUT\"\n",
            &[Reported::NAME],
        );
        config.env.insert("OUT".into(), path.display().to_string());
        let listener = StdioListener::spawn(&config).await.unwrap();
        listener.notify(HookCall {
            point: Reported::NAME.to_owned(),
            mode: Mode::Emit,
            payload: serde_json::json!({"seq": 1}),
        });
        let mut recorded = None;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(&path)
                && !text.is_empty()
            {
                recorded = Some(text);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let _ = std::fs::remove_file(&path);
        let text = recorded.expect("the child recorded the notification");
        assert!(text.contains("\"jsonrpc\":\"2.0\""), "saw: {text}");
        assert!(text.contains("\"method\":\"hooks/call\""), "saw: {text}");
        assert!(text.contains("\"point\":\"test/json-emit\""), "saw: {text}");
        assert!(
            !text.contains("\"id\""),
            "a notification has no id\nsaw: {text}"
        );
    }

    #[tokio::test]
    async fn attaching_checks_every_point_before_the_process_starts() {
        let bus = EventBus::new();
        bus.expose_waterfall::<Echoed>();
        let scope = bus.scope("outside");
        let config = script_config("cat > /dev/null\n", &["test/absent"]);
        match attach_outside_listener(&scope, &config).await {
            Err(OutsideError::UnknownPoint(error)) => {
                assert_eq!(error.name, "test/absent");
                assert_eq!(error.exposed, Echoed::NAME);
            }
            other => panic!("expected an unknown point, got {other:?}"),
        }
        let empty = script_config("cat > /dev/null\n", &[]);
        assert!(matches!(
            attach_outside_listener(&scope, &empty).await,
            Err(OutsideError::Config(_))
        ));
    }

    #[tokio::test]
    async fn an_outside_listener_attaches_to_every_point_it_names() {
        let bus = EventBus::new();
        bus.expose_waterfall::<Echoed>();
        let scope = bus.scope("outside");
        let config = script_config(
            "read handshake\nprintf '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\\n'\ncat > /dev/null\n",
            &[Echoed::NAME],
        );
        let handles = attach_outside_listener(&scope, &config).await.unwrap();
        assert_eq!(handles.len(), 1);
        assert!(handles[0].is_active());
        assert_eq!(bus.listener_count(Echoed::NAME), 1);
        scope.dispose();
        assert_eq!(bus.listener_count(Echoed::NAME), 0);
    }

    #[tokio::test]
    async fn a_json_rpc_error_reply_fails_the_hook_with_its_message() {
        let script = r#"read handshake
printf '{"jsonrpc":"2.0","id":1,"result":{}}\n'
read line
printf '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"this hook is broken"}}\n'
"#;
        let config = script_config(script, &[Echoed::NAME]);
        let listener = StdioListener::spawn(&config).await.unwrap();
        let error = listener.call(waterfall_call("base")).await.unwrap_err();
        assert_eq!(error.kind(), HookErrorKind::Failed);
        assert!(error.message().contains("this hook is broken"));
    }

    #[tokio::test]
    async fn a_reply_that_is_not_a_hook_reply_fails_rather_than_guessing() {
        let script = r#"read handshake
printf '{"jsonrpc":"2.0","id":1,"result":{}}\n'
read line
printf '{"jsonrpc":"2.0","id":2,"result":{"kind":"maybe"}}\n'
"#;
        let config = script_config(script, &[Echoed::NAME]);
        let listener = StdioListener::spawn(&config).await.unwrap();
        let error = listener.call(waterfall_call("base")).await.unwrap_err();
        assert_eq!(error.kind(), HookErrorKind::Failed);
        assert!(error.message().contains("not a hook reply"));
    }

    #[tokio::test]
    async fn an_attached_process_answers_a_real_dispatch() {
        let bus = EventBus::new();
        bus.expose_waterfall::<Echoed>();
        let scope = bus.scope("outside");
        let script = r#"read handshake
printf '{"jsonrpc":"2.0","id":1,"result":{}}\n'
read line
printf '{"jsonrpc":"2.0","id":2,"result":{"kind":"replace","value":"from the process"}}\n'
"#;
        let config = script_config(script, &[Echoed::NAME]);
        let handles = attach_outside_listener(&scope, &config).await.unwrap();
        assert_eq!(handles.len(), 1);
        let value = bus
            .waterfall::<Echoed>("base".to_string(), |payload| format!("default:{payload}"))
            .await
            .unwrap();
        assert_eq!(value, "from the process");
        assert_eq!(bus.listener_count(Echoed::NAME), 1);
        let next_config = script_config(
            r#"read handshake
printf '{"jsonrpc":"2.0","id":1,"result":{}}\n'
read line
printf '{"jsonrpc":"2.0","id":2,"result":{"kind":"next"}}\n'
"#,
            &[Echoed::NAME],
        );
        let second = EventBus::new();
        second.expose_waterfall::<Echoed>();
        let second_scope = second.scope("outside");
        attach_outside_listener(&second_scope, &next_config)
            .await
            .unwrap();
        let value = second
            .waterfall::<Echoed>("base".to_string(), |payload| format!("default:{payload}"))
            .await
            .unwrap();
        assert_eq!(value, "default:base", "next runs the default");
    }
}
