//! The bridge from the feature crates' hook ports to the bus.
//!
//! `heddle-llm`, `heddle-tools` and `heddle-agent` each intercept their calls through a **port** of their own
//! (`ModelHooks`, `ToolHooks`, `TurnHooks`), synchronous and free of any dependency on this crate. What
//! `60-hooks` judges is that a listener attached to the bus — in the binary, an outside listener — sees those
//! calls and changes them. This module is the whole of that seam, so an adapter that implements a port over the
//! bus is a few lines of `serde` in whichever crate holds it:
//!
//! - **JSON points** ([`AgentPreStep`], [`ModelRequest`], [`ToolsPreExecute`], [`ToolsPostExecute`],
//!   [`SessionEvent`]): the catalog's points with the TypeScript payload shapes as JSON — what an outside listener
//!   is handed anyway, and what the verifier's hooks act on (`{...request, endpoint}`, `call.name`,
//!   `{...result, output}`). [`expose_catalog`] exposes them for outside listeners. `model/stream`, whose output
//!   is a stream, is not exposed.
//! - **A blocking dispatch** ([`EventBus::waterfall_blocking`]): a port answers synchronously, a listener over a
//!   process answers asynchronously; this runs the chain to completion from synchronous code.
//! - **One function per port method** ([`model_request`], [`pre_execute`], [`post_execute`], [`pre_step`],
//!   [`session_event`]): payload in, decision out, with the TypeScript defaults, and no runtime touched at all
//!   when nothing listens.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::bus::EventBus;
use crate::error::HookError;
use crate::event::{EmitEvent, Event, WaterfallEvent};
use crate::points;

macro_rules! json_waterfall {
    ($(#[$doc:meta])* $marker:ident, $name:path) => {
        $(#[$doc])*
        pub struct $marker;
        impl Event for $marker {
            const NAME: &'static str = $name;
            type Payload = Value;
        }
        impl WaterfallEvent for $marker {
            type Output = Value;
        }
    };
}

json_waterfall!(
    /// `agent/pre-step` as JSON: payload and output `{messages, tools, round}`.
    AgentPreStep,
    points::AGENT_PRE_STEP
);
json_waterfall!(
    /// `model/request` as JSON: payload and output the request, `{endpoint, model?, messages, tools?, …}`.
    ModelRequest,
    points::MODEL_REQUEST
);
json_waterfall!(
    /// `tools/pre-execute` as JSON: payload `{name, args}`, output `{allowed, reason?}`.
    ToolsPreExecute,
    points::TOOLS_PRE_EXECUTE
);
json_waterfall!(
    /// `tools/post-execute` as JSON: payload `{name, args, result}`, output the result `{output, error?, data?}`.
    ToolsPostExecute,
    points::TOOLS_POST_EXECUTE
);

/// `session/event` as JSON: `{session, event}`, emitted after the event reached the session's file.
pub struct SessionEvent;
impl Event for SessionEvent {
    const NAME: &'static str = points::SESSION_EVENT;
    type Payload = Value;
}
impl EmitEvent for SessionEvent {}

/// Expose every catalog point an outside listener may attach to, as JSON. The boot calls it once, before it
/// attaches any component's declared listeners.
pub fn expose_catalog(bus: &EventBus) {
    bus.expose_waterfall::<AgentPreStep>();
    bus.expose_waterfall::<ModelRequest>();
    bus.expose_waterfall::<ToolsPreExecute>();
    bus.expose_waterfall::<ToolsPostExecute>();
    bus.expose_emit::<SessionEvent>();
}

impl EventBus {
    /// [`waterfall`](EventBus::waterfall), run to completion from synchronous code — the shape of every hook
    /// port. With no listener on the point, the result is `inner(&payload)` and no runtime is touched.
    ///
    /// Inside a multi-thread Tokio runtime the calling worker is handed back to the runtime while it waits, so an
    /// outside listener's I/O keeps running. Outside any runtime a private one drives the chain; a listener's own
    /// tasks run on the runtime that started it, which must outlive the dispatch. A current-thread runtime cannot
    /// wait on itself, so there the dispatch fails with a message that says so rather than deadlocking.
    pub fn waterfall_blocking<E: WaterfallEvent>(
        &self,
        payload: impl Into<std::sync::Arc<E::Payload>>,
        inner: impl FnOnce(&E::Payload) -> E::Output + Send + 'static,
    ) -> Result<E::Output, HookError> {
        let payload = payload.into();
        if self.listener_count(E::NAME) == 0 {
            return Ok(inner(&payload));
        }
        let dispatch = self.waterfall::<E>(payload, inner);
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => match handle.runtime_flavor() {
                tokio::runtime::RuntimeFlavor::CurrentThread => Err(HookError::fail(format!(
                    "{} has listeners, and a synchronous hook point cannot wait for them inside a \
                     current-thread runtime; run the host on the multi-thread runtime",
                    E::NAME
                ))
                .attributed(E::NAME, "the host")),
                _ => tokio::task::block_in_place(|| handle.block_on(dispatch)),
            },
            Err(_) => tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| {
                    HookError::fail(format!(
                        "no runtime could be started for {}: {error}",
                        E::NAME
                    ))
                    .attributed(E::NAME, "the host")
                })?
                .block_on(dispatch),
        }
    }
}

/// The `tools/pre-execute` decision, as the TypeScript build's listeners answer it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreExecuteDecision {
    /// Whether the call may run.
    pub allowed: bool,
    /// The sentence the model is told when it may not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `model/request`: the request the adapter is chosen for. Unchanged when nothing listens.
pub fn model_request(bus: &EventBus, request: Value) -> Result<Value, HookError> {
    bus.waterfall_blocking::<ModelRequest>(request, |request| request.clone())
}

/// `tools/pre-execute`: whether the call named `name` with `args` may run; allowed when nothing listens. An
/// answer that is not `{allowed, reason?}` is a broken hook.
pub fn pre_execute(
    bus: &EventBus,
    name: &str,
    args: &Value,
) -> Result<PreExecuteDecision, HookError> {
    let answer = bus.waterfall_blocking::<ToolsPreExecute>(
        json!({ "name": name, "args": args }),
        |_| json!({ "allowed": true }),
    )?;
    serde_json::from_value::<PreExecuteDecision>(answer).map_err(|error| {
        HookError::fail(format!(
            "a tools/pre-execute listener answered something that is not {{allowed, reason?}}: {error}"
        ))
        .attributed(points::TOOLS_PRE_EXECUTE, "the host")
    })
}

/// `tools/post-execute`: what stands in the place of `result`. Unchanged when nothing listens.
pub fn post_execute(
    bus: &EventBus,
    name: &str,
    args: &Value,
    result: Value,
) -> Result<Value, HookError> {
    bus.waterfall_blocking::<ToolsPostExecute>(
        json!({ "name": name, "args": args, "result": result }),
        |call| call["result"].clone(),
    )
}

/// `agent/pre-step`: the round as it will be sent. Unchanged when nothing listens; a refusal ends the round.
pub fn pre_step(bus: &EventBus, step: Value) -> Result<Value, HookError> {
    bus.waterfall_blocking::<AgentPreStep>(step, |step| step.clone())
}

/// `session/event`: tell every listener an event reached `session`'s file. Emit after the write, never before.
pub fn session_event(bus: &EventBus, session: &str, event: &Value) {
    bus.emit::<SessionEvent>(&json!({ "session": session, "event": event }));
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::bus::{HookFuture, ListenOptions};
    use crate::mode::Mode;
    use crate::outside::{HookCall, HookReply, JsonListener, ListenerDeclaration, attach_declared};
    use crate::waterfall::Next;

    struct Replying(fn(&HookCall) -> Result<HookReply, HookError>);

    impl JsonListener for Replying {
        fn call(&self, call: HookCall) -> HookFuture<HookReply> {
            let reply = (self.0)(&call);
            Box::pin(async move {
                tokio::task::yield_now().await;
                reply
            })
        }
        fn notify(&self, _call: HookCall) {}
    }

    fn attached(
        reply: fn(&HookCall) -> Result<HookReply, HookError>,
        point: &str,
    ) -> (EventBus, crate::Scope) {
        let bus = EventBus::new();
        expose_catalog(&bus);
        let scope = bus.scope("hook-1");
        attach_declared(
            &scope,
            Arc::new(Replying(reply)),
            &[ListenerDeclaration::on(point)],
        )
        .unwrap();
        (bus, scope)
    }

    #[test]
    fn the_catalog_exposes_every_point_but_the_stream() {
        let bus = EventBus::new();
        expose_catalog(&bus);
        assert_eq!(
            bus.exposed(),
            vec![
                ("agent/pre-step", Mode::Waterfall),
                ("model/request", Mode::Waterfall),
                ("session/event", Mode::Emit),
                ("tools/post-execute", Mode::Waterfall),
                ("tools/pre-execute", Mode::Waterfall),
            ]
        );
    }

    #[test]
    fn with_nothing_listening_every_port_gets_the_typescript_default_without_a_runtime() {
        let bus = EventBus::new();
        expose_catalog(&bus);
        let request = json!({"endpoint": "double", "messages": []});
        assert_eq!(model_request(&bus, request.clone()).unwrap(), request);
        assert_eq!(
            pre_execute(&bus, "write_file", &json!({"path": "x"})).unwrap(),
            PreExecuteDecision {
                allowed: true,
                reason: None
            }
        );
        let result = json!({"output": "the real contents"});
        assert_eq!(
            post_execute(&bus, "read_file", &json!({}), result.clone()).unwrap(),
            result
        );
        let step = json!({"messages": [], "tools": [], "round": 1});
        assert_eq!(pre_step(&bus, step.clone()).unwrap(), step);
    }

    #[test]
    fn a_retarget_from_synchronous_code_outside_any_runtime() {
        let (bus, _scope) = attached(
            |call| {
                let mut request = call.payload.clone();
                request["endpoint"] = json!("scripted");
                Ok(HookReply::Replace { value: request })
            },
            "model/request",
        );
        let sent = model_request(&bus, json!({"endpoint": "double", "model": "double"})).unwrap();
        assert_eq!(sent, json!({"endpoint": "scripted", "model": "double"}));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refusal_by_value_from_inside_a_multi_thread_runtime() {
        let (bus, _scope) = attached(
            |call| {
                if call.payload["name"] == "write_file" {
                    Ok(HookReply::Replace {
                        value: json!({"allowed": false, "reason": "this hook refuses writes"}),
                    })
                } else {
                    Ok(HookReply::Next)
                }
            },
            "tools/pre-execute",
        );
        let refused = pre_execute(&bus, "write_file", &json!({"path": "x"})).unwrap();
        assert_eq!(
            refused,
            PreExecuteDecision {
                allowed: false,
                reason: Some("this hook refuses writes".into())
            }
        );
        assert!(pre_execute(&bus, "read_file", &json!({})).unwrap().allowed);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stdio_listener_answers_a_synchronous_port_inside_the_runtime() {
        let bus = EventBus::new();
        expose_catalog(&bus);
        let scope = bus.scope("hook-1");
        let script = r#"read handshake
printf '{"jsonrpc":"2.0","id":1,"result":{"listeners":[{"point":"tools/post-execute"}]}}\n'
read line
printf '{"jsonrpc":"2.0","id":2,"result":{"kind":"merge","value":{"output":"redacted by the hook"}}}\n'
"#;
        let config: crate::outside::OutsideListenerConfig = serde_json::from_value(
            json!({"program": "/bin/sh", "args": ["-c", script], "row": "hook-1"}),
        )
        .unwrap();
        crate::outside::attach_outside_listener(&scope, &config)
            .await
            .unwrap();
        let result = tokio::task::spawn_blocking({
            let bus = bus.clone();
            move || {
                post_execute(
                    &bus,
                    "read_file",
                    &json!({}),
                    json!({"output": "the real contents", "exitCode": 0}),
                )
            }
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            result,
            json!({"output": "redacted by the hook", "exitCode": 0})
        );
        // And from a worker thread itself, which is where a port is called inside a turn.
        let again = post_execute(&bus, "read_file", &json!({}), json!({"output": "x"}));
        assert!(
            again.is_err(),
            "the script answered once; a second call finds it gone"
        );
    }

    #[tokio::test]
    async fn a_current_thread_runtime_fails_with_a_message_rather_than_deadlocking() {
        let (bus, _scope) = attached(|_call| Ok(HookReply::Next), "agent/pre-step");
        let error = pre_step(&bus, json!({"round": 1})).unwrap_err();
        assert!(
            error.message().contains("current-thread runtime"),
            "{error}"
        );
        assert_eq!(error.point(), Some("agent/pre-step"));
    }

    #[test]
    fn a_pre_step_refusal_and_a_broken_listener_are_hook_errors() {
        let (bus, _scope) = attached(
            |_call| {
                Ok(HookReply::Refuse {
                    reason: "refused by hook: this hook refuses to send the request".into(),
                })
            },
            "agent/pre-step",
        );
        let error = pre_step(&bus, json!({"round": 1})).unwrap_err();
        assert!(error.is_refusal());
        assert_eq!(
            error.to_string(),
            "refused by hook: this hook refuses to send the request"
        );

        let (bus, _scope) = attached(
            |_call| Err(HookError::fail("this hook is broken too")),
            "model/request",
        );
        let error = model_request(&bus, json!({"endpoint": "double"})).unwrap_err();
        assert_eq!(
            error.to_string(),
            "a hook failed at model/request (hook-1) — this hook is broken too"
        );
    }

    #[test]
    fn a_pre_execute_answer_of_the_wrong_shape_is_a_broken_hook() {
        let (bus, _scope) = attached(
            |_call| {
                Ok(HookReply::Replace {
                    value: json!({"verdict": "no"}),
                })
            },
            "tools/pre-execute",
        );
        let error = pre_execute(&bus, "write_file", &json!({})).unwrap_err();
        assert!(
            error.message().contains("not {allowed, reason?}"),
            "{error}"
        );
    }

    #[test]
    fn an_in_process_typed_listener_works_through_the_same_bridge() {
        let bus = EventBus::new();
        let scope = bus.scope("in-process");
        scope.on_waterfall::<ToolsPostExecute>(
            |_payload: Arc<Value>, next: Next<ToolsPostExecute>| {
                Box::pin(async move {
                    let mut result = next.run().await?;
                    result["data"] = json!({"replacedBy": "post-hook"});
                    Ok(result)
                })
            },
            ListenOptions::default(),
        );
        let result = post_execute(&bus, "read_file", &json!({}), json!({"output": "x"})).unwrap();
        assert_eq!(
            result,
            json!({"output": "x", "data": {"replacedBy": "post-hook"}})
        );
    }

    #[test]
    fn a_session_event_reaches_an_emit_listener_with_its_session() {
        let bus = EventBus::new();
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let scope = bus.scope("observer");
        let seen_in_listener = seen.clone();
        scope.on_emit::<SessionEvent>(
            move |payload| seen_in_listener.lock().unwrap().push(payload.clone()),
            ListenOptions::default(),
        );
        session_event(&bus, "s1", &json!({"seq": 4, "type": "todo/write"}));
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            [json!({"session": "s1", "event": {"seq": 4, "type": "todo/write"}})]
        );
    }
}
