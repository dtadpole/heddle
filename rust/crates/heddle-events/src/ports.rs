//! The feature crates' hook ports, implemented over the bus — what the boot hands `heddle-tools` and
//! `heddle-agent` instead of their no-listener defaults.
//!
//! Each feature crate intercepts its calls through a port of its own and does not depend on this crate (D-025:
//! a feature crate adapts behind the seam). [`BusHooks`] is the one value that implements those ports by
//! dispatching the catalog's points on the run's [`EventBus`], through [`bridge`](crate::bridge), so a listener
//! — in the binary, an outside component's declared listener — sees and changes every call:
//!
//! | Port | Point | When the listener fails |
//! |---|---|---|
//! | `heddle_tools::ToolHooks::pre_execute` | `tools/pre-execute` | the oracle's throw fails the turn; the port cannot fail, so the call is refused with the failure's sentence |
//! | `heddle_tools::ToolHooks::post_execute` | `tools/post-execute` | `TOOL_FAILED` with the sentence, as the oracle's `try` around the call does |
//! | `heddle_agent::TurnHooks::pre_step` | `agent/pre-step` | a refusal is reported as is; a broken hook as `HookFailure::Broken`, which the loop prints as `a hook failed at agent/pre-step — …` |
//!
//! `model/request` is implemented for `heddle_llm::ModelHooks` once that port can fail (developer-three's
//! change, next on main). Nothing here touches a runtime while no listener is attached; with one, the
//! process must run on Tokio's multi-thread runtime ([`EventBus::waterfall_blocking`]).
//!
//! **Direction of dependency.** This crate depends on `heddle-tools` and `heddle-agent` for their port traits;
//! they must never depend on this crate, or the workspace has a cycle. Every feature crate keeps its port for
//! that reason.

use std::sync::Arc;

use heddle_agent::{HookFailure, PreStep, TurnHooks};
use heddle_tools::{OutsideComponent, PreExecute, ToolCall, ToolError, ToolHooks, ToolResult};
use serde_json::{Value, json};

use crate::bridge;
use crate::bus::{EventBus, Listener, Scope};
use crate::outside::{OutsideError, RpcListener, attach_declared, parse_listener_declarations};
use crate::points;

/// The hook ports of `heddle-tools` and `heddle-agent`, over one bus. A cheap clone: every clone dispatches
/// on the same bus.
#[derive(Clone, Default)]
pub struct BusHooks {
    bus: EventBus,
}

impl BusHooks {
    /// The ports over `bus`.
    pub fn new(bus: EventBus) -> Self {
        Self { bus }
    }

    /// The bus the ports dispatch on.
    pub fn bus(&self) -> &EventBus {
        &self.bus
    }
}

/// A tool result that says the call failed, as the registry reports any thrown error.
fn tool_failed(message: String) -> ToolResult {
    ToolResult {
        output: String::new(),
        error: Some(ToolError {
            code: "TOOL_FAILED".to_owned(),
            message,
        }),
        data: None,
    }
}

impl ToolHooks for BusHooks {
    fn pre_execute(&self, call: &ToolCall<'_>) -> PreExecute {
        match bridge::pre_execute(&self.bus, call.name, &Value::Object(call.args.clone())) {
            Ok(decision) if decision.allowed => PreExecute::Allowed,
            Ok(decision) => PreExecute::Refused {
                reason: decision.reason,
            },
            Err(error) => PreExecute::Refused {
                reason: Some(error.to_string()),
            },
        }
    }

    fn post_execute(&self, call: &ToolCall<'_>, result: ToolResult) -> ToolResult {
        if self.bus.listener_count(points::TOOLS_POST_EXECUTE) == 0 {
            return result;
        }
        let produced = match serde_json::to_value(&result) {
            Ok(produced) => produced,
            Err(error) => return tool_failed(format!("a tool result does not serialize: {error}")),
        };
        match bridge::post_execute(&self.bus, call.name, &Value::Object(call.args.clone()), produced) {
            Ok(answer) => serde_json::from_value::<ToolResult>(answer).unwrap_or_else(|error| {
                tool_failed(format!(
                    "a tools/post-execute listener answered something that is not a tool result: {error}"
                ))
            }),
            Err(error) => tool_failed(error.to_string()),
        }
    }
}

impl TurnHooks for BusHooks {
    fn pre_step(&self, step: PreStep) -> Result<PreStep, HookFailure> {
        if self.bus.listener_count(points::AGENT_PRE_STEP) == 0 {
            return Ok(step);
        }
        let encoded = (|| -> Result<Value, serde_json::Error> {
            Ok(json!({
                "messages": serde_json::to_value(&step.messages)?,
                "tools": serde_json::to_value(&step.tools)?,
                "round": step.round,
            }))
        })()
        .map_err(|error| HookFailure::Broken(format!("the round does not serialize: {error}")))?;
        let answer = bridge::pre_step(&self.bus, encoded).map_err(|error| {
            if error.is_refusal() {
                HookFailure::Refusal(error.to_string())
            } else {
                HookFailure::Broken(error.message().to_owned())
            }
        })?;
        let decode = |key: &str| -> Result<Value, HookFailure> {
            answer.get(key).cloned().ok_or_else(|| {
                HookFailure::Broken(format!(
                    "an agent/pre-step listener answered without '{key}'"
                ))
            })
        };
        let messages = serde_json::from_value(decode("messages")?).map_err(|error| {
            HookFailure::Broken(format!(
                "an agent/pre-step listener's messages do not decode: {error}"
            ))
        })?;
        let tools = serde_json::from_value(decode("tools")?).map_err(|error| {
            HookFailure::Broken(format!(
                "an agent/pre-step listener's tools do not decode: {error}"
            ))
        })?;
        Ok(PreStep {
            messages,
            tools,
            round: step.round,
        })
    }
}

/// Attach the listeners an outside component declared in its `initialize` answer, through `scope`, over the
/// component's own connection — one process serves its tools and its listeners. A component that declared none
/// attaches nothing.
///
/// An emit point (`session/event`) is sent as a `hooks/call` request whose answer is dropped, on the current
/// runtime, until `OutsideComponent` offers a notification; with no runtime it is skipped.
pub fn attach_component_listeners(
    scope: &Scope,
    component: Arc<OutsideComponent>,
) -> Result<Vec<Listener>, OutsideError> {
    let declarations = parse_listener_declarations(component.listeners())?;
    if declarations.is_empty() {
        return Ok(Vec::new());
    }
    let for_requests = component.clone();
    let for_notifications = component;
    let listener = RpcListener::new(
        move |params| {
            let component = for_requests.clone();
            Box::pin(async move {
                component
                    .request(RpcListener::METHOD, params, None)
                    .await
                    .map_err(|error| error.to_string())
            })
        },
        move |params| {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let component = for_notifications.clone();
                handle.spawn(async move {
                    let _ = component.request(RpcListener::METHOD, params, None).await;
                });
            }
        },
    );
    attach_declared(scope, Arc::new(listener), &declarations)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use heddle_tools::ToolArgs;

    use super::*;
    use crate::bus::HookFuture;
    use crate::error::HookError;
    use crate::outside::{HookCall, HookReply, JsonListener, ListenerDeclaration};

    struct Replying(
        fn(&HookCall) -> Result<HookReply, HookError>,
        Arc<Mutex<Vec<HookCall>>>,
    );

    impl JsonListener for Replying {
        fn call(&self, call: HookCall) -> HookFuture<HookReply> {
            self.1.lock().unwrap().push(call.clone());
            let reply = (self.0)(&call);
            Box::pin(async move { reply })
        }
        fn notify(&self, _call: HookCall) {}
    }

    fn hooked(
        point: &str,
        reply: fn(&HookCall) -> Result<HookReply, HookError>,
    ) -> (BusHooks, Scope, Arc<Mutex<Vec<HookCall>>>) {
        let bus = EventBus::new();
        bridge::expose_catalog(&bus);
        let scope = bus.scope("hook-1");
        let seen: Arc<Mutex<Vec<HookCall>>> = Arc::default();
        attach_declared(
            &scope,
            Arc::new(Replying(reply, seen.clone())),
            &[ListenerDeclaration::on(point)],
        )
        .unwrap();
        (BusHooks::new(bus), scope, seen)
    }

    fn args(path: &str) -> ToolArgs {
        let mut args = ToolArgs::new();
        args.insert("path".to_owned(), json!(path));
        args
    }

    #[test]
    fn with_no_listener_every_port_is_its_default() {
        let hooks = BusHooks::new(EventBus::new());
        let args = args("x");
        let call = ToolCall {
            name: "write_file",
            args: &args,
        };
        assert_eq!(hooks.pre_execute(&call), PreExecute::Allowed);
        let result = ToolResult {
            output: "wrote x".into(),
            error: None,
            data: None,
        };
        assert_eq!(hooks.post_execute(&call, result.clone()), result);
        let step = PreStep {
            messages: Vec::new(),
            tools: Vec::new(),
            round: 1,
        };
        assert_eq!(hooks.pre_step(step.clone()), Ok(step));
    }

    #[test]
    fn a_pre_execute_listener_refuses_write_file_and_passes_the_rest() {
        let (hooks, _scope, seen) = hooked("tools/pre-execute", |call| {
            if call.payload["name"] == "write_file" {
                Ok(HookReply::Replace {
                    value: json!({"allowed": false, "reason": "this hook refuses writes"}),
                })
            } else {
                Ok(HookReply::Next)
            }
        });
        let write = args("should-not-exist.txt");
        assert_eq!(
            hooks.pre_execute(&ToolCall {
                name: "write_file",
                args: &write
            }),
            PreExecute::Refused {
                reason: Some("this hook refuses writes".into())
            }
        );
        assert_eq!(
            seen.lock().unwrap()[0].payload,
            json!({"name": "write_file", "args": {"path": "should-not-exist.txt"}}),
            "the listener sees the oracle's {{name, args}}"
        );
        let read = args("present.txt");
        assert_eq!(
            hooks.pre_execute(&ToolCall {
                name: "read_file",
                args: &read
            }),
            PreExecute::Allowed
        );
    }

    #[test]
    fn a_broken_pre_execute_listener_refuses_with_a_sentence_that_names_the_hook() {
        let (hooks, _scope, _seen) = hooked("tools/pre-execute", |_call| {
            Err(HookError::fail("this hook is broken"))
        });
        let args = args("x");
        assert_eq!(
            hooks.pre_execute(&ToolCall {
                name: "write_file",
                args: &args
            }),
            PreExecute::Refused {
                reason: Some(
                    "a hook failed at tools/pre-execute (hook-1) — this hook is broken".into()
                )
            }
        );
    }

    #[test]
    fn a_post_execute_merge_keeps_what_the_tool_produced() {
        let (hooks, _scope, seen) = hooked("tools/post-execute", |_call| {
            Ok(HookReply::Merge {
                value: json!({"output": "redacted by the hook", "data": {"replacedBy": "post-hook"}}),
            })
        });
        let args = args("present.txt");
        let result = ToolResult {
            output: "the real contents".into(),
            error: None,
            data: None,
        };
        let replaced = hooks.post_execute(
            &ToolCall {
                name: "read_file",
                args: &args,
            },
            result,
        );
        assert_eq!(replaced.output, "redacted by the hook");
        assert_eq!(replaced.error, None);
        assert_eq!(replaced.data.unwrap()["replacedBy"], "post-hook");
        assert_eq!(
            seen.lock().unwrap()[0].payload["result"],
            json!({"output": "the real contents"})
        );
    }

    #[test]
    fn a_broken_post_execute_listener_is_a_failed_call() {
        let (hooks, _scope, _seen) = hooked("tools/post-execute", |_call| {
            Err(HookError::fail("this hook is broken"))
        });
        let args = args("x");
        let result = hooks.post_execute(
            &ToolCall {
                name: "read_file",
                args: &args,
            },
            ToolResult {
                output: "x".into(),
                error: None,
                data: None,
            },
        );
        assert_eq!(result.output, "");
        let error = result.error.unwrap();
        assert_eq!(error.code, "TOOL_FAILED");
        assert_eq!(
            error.message,
            "a hook failed at tools/post-execute (hook-1) — this hook is broken"
        );
    }

    #[test]
    fn a_post_execute_answer_that_is_not_a_tool_result_is_a_failed_call() {
        let (hooks, _scope, _seen) = hooked("tools/post-execute", |_call| {
            Ok(HookReply::Replace {
                value: json!(["not", "a", "result"]),
            })
        });
        let args = args("x");
        let result = hooks.post_execute(
            &ToolCall {
                name: "read_file",
                args: &args,
            },
            ToolResult {
                output: "x".into(),
                error: None,
                data: None,
            },
        );
        assert_eq!(result.error.unwrap().code, "TOOL_FAILED");
    }

    #[test]
    fn a_pre_step_refusal_is_reported_as_is_and_a_broken_one_by_its_message() {
        let (hooks, _scope, seen) = hooked("agent/pre-step", |_call| {
            Ok(HookReply::Refuse {
                reason: "refused by hook: this hook refuses to send the request".into(),
            })
        });
        let step = PreStep {
            messages: Vec::new(),
            tools: Vec::new(),
            round: 2,
        };
        assert_eq!(
            hooks.pre_step(step),
            Err(HookFailure::Refusal(
                "refused by hook: this hook refuses to send the request".into()
            ))
        );
        assert_eq!(
            seen.lock().unwrap()[0].payload,
            json!({"messages": [], "tools": [], "round": 2})
        );

        let (hooks, _scope, _seen) =
            hooked("agent/pre-step", |_call| Err(HookError::fail("it broke")));
        let step = PreStep {
            messages: Vec::new(),
            tools: Vec::new(),
            round: 1,
        };
        assert_eq!(
            hooks.pre_step(step),
            Err(HookFailure::Broken("it broke".into()))
        );
    }

    #[test]
    fn a_pre_step_listener_may_replace_the_tools_and_must_answer_both_fields() {
        let (hooks, _scope, _seen) = hooked("agent/pre-step", |_call| {
            Ok(HookReply::Replace {
                value: json!({"messages": [], "tools": []}),
            })
        });
        let tools: Vec<heddle_tools::ToolSpec> = serde_json::from_value(json!([
            {"name": "read_file", "description": "Read a file.", "parameters": {"type": "object"}}
        ]))
        .unwrap();
        let step = PreStep {
            messages: Vec::new(),
            tools,
            round: 1,
        };
        let replaced = hooks.pre_step(step).unwrap();
        assert!(replaced.tools.is_empty(), "the listener withdrew the tools");
        assert_eq!(replaced.round, 1);

        let (hooks, _scope, _seen) = hooked("agent/pre-step", |_call| {
            Ok(HookReply::Replace {
                value: json!({"messages": []}),
            })
        });
        let step = PreStep {
            messages: Vec::new(),
            tools: Vec::new(),
            round: 1,
        };
        assert_eq!(
            hooks.pre_step(step),
            Err(HookFailure::Broken(
                "an agent/pre-step listener answered without 'tools'".into()
            ))
        );
    }
}
