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
use crate::event::{EmitEvent, ParallelEvent, WaterfallEvent};
use crate::mode::Mode;

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
        todo!("heddle-events: expose_emit")
    }

    /// Let outside listeners attach to the [`ParallelEvent`] `E` by its name.
    pub fn expose_parallel<E: ParallelEvent>(&self)
    where
        E::Payload: Serialize,
    {
        todo!("heddle-events: expose_parallel")
    }

    /// Let outside listeners attach to the [`WaterfallEvent`] `E` by its name. The crate that owns a point's
    /// marker calls this when its payload and output serialize — `model/stream`, whose output is a stream, is
    /// not exposed.
    pub fn expose_waterfall<E: WaterfallEvent>(&self)
    where
        E::Payload: Serialize,
        E::Output: DeserializeOwned,
    {
        todo!("heddle-events: expose_waterfall")
    }

    /// The points outside listeners may attach to, with their modes, sorted by name.
    pub fn exposed(&self) -> Vec<(&'static str, Mode)> {
        todo!("heddle-events: exposed")
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
        let _ = (point, listener, options);
        todo!("heddle-events: on_json")
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
        let _ = (listener, options);
        todo!("heddle-events: on_json_emit")
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
        let _ = (listener, options);
        todo!("heddle-events: on_json_parallel")
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
        let _ = (listener, options);
        todo!("heddle-events: on_json_waterfall")
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
}
