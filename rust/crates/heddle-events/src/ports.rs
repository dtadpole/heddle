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
//! | `heddle_tools::ToolHooks::pre_execute` | `tools/pre-execute` | `ToolHookError` with the hook's sentence; the loop answers that call as `INTERRUPTED` and the turn goes on, as the oracle's does |
//! | `heddle_tools::ToolHooks::post_execute` | `tools/post-execute` | `TOOL_FAILED` with the sentence, as the oracle's `try` around the call does |
//! | `heddle_agent::TurnHooks::pre_step` | `agent/pre-step` | a refusal is reported as is; a broken hook as `HookFailure::Broken`, which the loop prints as `a hook failed at agent/pre-step — …` |
//!
//! | `heddle_llm::ModelHooks::request` | `model/request` | the call fails before any stream exists, with the hook's sentence and [`MODEL_HOOK_FAILED`] (or [`MODEL_HOOK_REFUSED`]) |
//!
//! `heddle-llm` runs its own hooks in a chain whose `next` continues with the *original* request, so the bus is
//! one link of it: when every listener passes, the rest of that chain runs; when one changed the request, its
//! answer stands. Nothing here touches a runtime while no listener is attached; with one, the process must run
//! on Tokio's multi-thread runtime ([`EventBus::waterfall_blocking`]).
//!
//! **Direction of dependency.** This crate depends on `heddle-tools` and `heddle-agent` for their port traits;
//! they must never depend on this crate, or the workspace has a cycle. Every feature crate keeps its port for
//! that reason.

use std::sync::Arc;

use heddle_agent::{HookFailure, PreStep, TurnHooks};
use heddle_llm::{GenerateRequest, ModelError, ModelHooks, ModelService};
use heddle_tools::{
    OutsideComponent, PreExecute, ToolCall, ToolError, ToolHookError, ToolHooks, ToolResult,
};
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

/// The code a call fails with when a `model/request` listener broke.
pub const MODEL_HOOK_FAILED: &str = "HOOK_FAILED";

/// The code a call fails with when a `model/request` listener refused it.
pub const MODEL_HOOK_REFUSED: &str = "HOOK_REFUSED";

impl ModelHooks for BusHooks {
    fn request(
        &self,
        service: &ModelService,
        request: &GenerateRequest,
        next: &mut dyn FnMut() -> Result<GenerateRequest, ModelError>,
    ) -> Result<GenerateRequest, ModelError> {
        let _ = service;
        if self.bus.listener_count(points::MODEL_REQUEST) == 0 {
            return next();
        }
        let fail =
            |message: String, code: &str| ModelError::new(message, request.endpoint.clone(), code);
        let sent = serde_json::to_value(request).map_err(|error| {
            fail(
                format!("the request does not serialize: {error}"),
                MODEL_HOOK_FAILED,
            )
        })?;
        let answer = bridge::model_request(&self.bus, sent.clone()).map_err(|error| {
            let code = if error.is_refusal() {
                MODEL_HOOK_REFUSED
            } else {
                MODEL_HOOK_FAILED
            };
            fail(error.to_string(), code)
        })?;
        if answer == sent {
            return next();
        }
        serde_json::from_value::<GenerateRequest>(answer).map_err(|error| {
            fail(
                format!(
                    "a model/request listener answered something that is not a request: {error}"
                ),
                MODEL_HOOK_FAILED,
            )
        })
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
    fn pre_execute(&self, call: &ToolCall<'_>) -> Result<PreExecute, ToolHookError> {
        match bridge::pre_execute(&self.bus, call.name, &Value::Object(call.args.clone())) {
            Ok(decision) if decision.allowed => Ok(PreExecute::Allowed),
            Ok(decision) => Ok(PreExecute::Refused {
                reason: decision.reason,
            }),
            Err(error) => Err(ToolHookError::new(error.to_string())),
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
/// An emit point (`session/event`) is a `hooks/call` notification, sent on the current runtime; with no
/// runtime it is skipped, and a component that has exited is skipped with a log line.
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
                    if let Err(error) = component.notify(RpcListener::METHOD, params).await {
                        tracing::warn!(%error, "an outside listener was not told of an event");
                    }
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
        assert_eq!(hooks.pre_execute(&call), Ok(PreExecute::Allowed));
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
            Ok(PreExecute::Refused {
                reason: Some("this hook refuses writes".into())
            })
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
            Ok(PreExecute::Allowed)
        );
    }

    #[test]
    fn a_broken_pre_execute_listener_fails_the_call_with_a_sentence_that_names_the_hook() {
        let (hooks, _scope, _seen) = hooked("tools/pre-execute", |_call| {
            Err(HookError::fail("this hook is broken"))
        });
        let args = args("x");
        assert_eq!(
            hooks.pre_execute(&ToolCall {
                name: "write_file",
                args: &args
            }),
            Err(ToolHookError::new(
                "a hook failed at tools/pre-execute (hook-1) — this hook is broken"
            ))
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

    fn request_to(endpoint: &str) -> GenerateRequest {
        GenerateRequest {
            endpoint: endpoint.to_owned(),
            model: Some(endpoint.to_owned()),
            messages: vec![heddle_llm::Message::new(
                heddle_llm::Role::User,
                vec![heddle_llm::ContentPart::Text {
                    text: "say something".into(),
                }],
            )],
            ..GenerateRequest::default()
        }
    }

    fn retarget(call: &HookCall) -> Result<HookReply, HookError> {
        let mut request = call.payload.clone();
        request["endpoint"] = json!("scripted");
        Ok(HookReply::Replace { value: request })
    }

    #[test]
    fn a_model_request_with_no_listener_runs_the_rest_of_the_chain() {
        let hooks = BusHooks::new(EventBus::new());
        let service = ModelService::new(Vec::new()).unwrap();
        let mut ran = 0;
        let out = hooks
            .request(&service, &request_to("double"), &mut || {
                ran += 1;
                Ok(request_to("from-next"))
            })
            .unwrap();
        assert_eq!(ran, 1);
        assert_eq!(out.endpoint, "from-next");
    }

    #[test]
    fn a_retarget_is_the_answer_and_a_passing_listener_hands_on_to_the_chain() {
        let (hooks, _scope, seen) = hooked("model/request", retarget);
        let service = ModelService::new(Vec::new()).unwrap();
        let mut ran = 0;
        let out = hooks
            .request(&service, &request_to("double"), &mut || {
                ran += 1;
                Ok(request_to("from-next"))
            })
            .unwrap();
        assert_eq!(out.endpoint, "scripted");
        assert_eq!(
            out.model.as_deref(),
            Some("double"),
            "the rest of the request is kept"
        );
        assert_eq!(ran, 0, "a listener that answered decided alone");
        assert_eq!(seen.lock().unwrap()[0].payload["endpoint"], "double");

        let (hooks, _scope, _seen) = hooked("model/request", |_call| Ok(HookReply::Next));
        let mut ran = 0;
        let out = hooks
            .request(&service, &request_to("double"), &mut || {
                ran += 1;
                Ok(request_to("from-next"))
            })
            .unwrap();
        assert_eq!((ran, out.endpoint.as_str()), (1, "from-next"));
    }

    #[test]
    fn a_broken_or_refusing_model_request_listener_fails_the_call_naming_the_hook() {
        let service = ModelService::new(Vec::new()).unwrap();
        let (hooks, _scope, _seen) = hooked("model/request", |_call| {
            Err(HookError::fail("this hook is broken too"))
        });
        let error = hooks
            .request(&service, &request_to("double"), &mut || {
                Ok(request_to("never"))
            })
            .unwrap_err();
        assert_eq!(error.code, MODEL_HOOK_FAILED);
        assert_eq!(error.endpoint, "double");
        assert_eq!(
            error.message,
            "a hook failed at model/request (hook-1) — this hook is broken too"
        );
        assert_eq!(
            error.to_string(),
            error.message,
            "the turn prints the hook's sentence"
        );

        let (hooks, _scope, _seen) = hooked("model/request", |_call| {
            Ok(HookReply::Refuse {
                reason: "not this model".into(),
            })
        });
        let error = hooks
            .request(&service, &request_to("double"), &mut || {
                Ok(request_to("never"))
            })
            .unwrap_err();
        assert_eq!(error.code, MODEL_HOOK_REFUSED);
        assert_eq!(error.message, "refused by hook: not this model");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_retargeted_request_is_answered_by_the_endpoint_the_hook_named() {
        let dir = std::env::temp_dir().join(format!(
            "heddle-events-ports-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("scripted.json");
        std::fs::write(&script, r#"{"steps":[{"text":"the scripted answer"}]}"#).unwrap();
        let endpoint = |name: &str, kind: heddle_llm::EndpointKind, base_url: &str| {
            heddle_llm::EndpointConfig {
                name: name.to_owned(),
                kind,
                base_url: base_url.to_owned(),
                model: Some(name.to_owned()),
                ..heddle_llm::EndpointConfig::default()
            }
        };
        let service = ModelService::new(vec![
            endpoint(
                "scripted",
                heddle_llm::EndpointKind::Scripted,
                &script.display().to_string(),
            ),
            endpoint(
                "double",
                heddle_llm::EndpointKind::OpenaiChat,
                "http://127.0.0.1:9/v1",
            ),
        ])
        .unwrap();
        let (hooks, _scope, _seen) = hooked("model/request", retarget);
        service.add_hooks(Arc::new(hooks));
        let generated = service.generate(request_to("double")).await;
        let _ = std::fs::remove_dir_all(&dir);
        let generated = generated.expect("the scripted endpoint answered");
        assert_eq!(
            generated.text, "the scripted answer",
            "the configured double was never reached"
        );
    }

    /// A part-4 component in `/bin/sh`: it declares `declared` in `initialize`, refuses `write_file` at
    /// `tools/pre-execute`, passes everything else, and appends each `session/event` notification to `$EVENTS`.
    fn component_script(declared: &str) -> String {
        format!(
            r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"tools":[],"listeners":{declared}}}}}\n' "$id" ;;
    *'"point":"session/event"'*) printf '%s\n' "$line" >> "$EVENTS" ;;
    *'"method":"hooks/call"'*write_file*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"kind":"replace","value":{{"allowed":false,"reason":"this hook refuses writes"}}}}}}\n' "$id" ;;
    *'"method":"hooks/call"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"kind":"next"}}}}\n' "$id" ;;
    *'"method":"shutdown"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":null}}\n' "$id" ;;
    *'"method":"exit"'*) exit 0 ;;
    *'"id":'*) printf '{{"jsonrpc":"2.0","id":%s,"error":{{"code":-32601,"message":"no such method"}}}}\n' "$id" ;;
  esac
done
"#
        )
    }

    struct Scratch(std::path::PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(label: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!(
            "heddle-events-component-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    async fn start_component(dir: &std::path::Path, declared: &str) -> Arc<OutsideComponent> {
        let config: heddle_sandbox::SandboxConfig = serde_json::from_value(json!({
            "mode": "workspace-write",
            "workspaceRoot": dir.display().to_string(),
            "backend": "none"
        }))
        .unwrap();
        let host = heddle_sandbox::SandboxHost::detect(dir.join("home")).unwrap();
        let gate: Arc<dyn heddle_tools::SandboxGate> =
            Arc::new(heddle_tools::adapters::Sandbox::new(Arc::new(
                heddle_sandbox::SandboxService::new(&config, &host),
            )));
        let mut spec = heddle_tools::OutsideComponentSpec::new("hook-1", "/bin/sh", dir);
        spec.args = vec!["-c".to_owned(), component_script(declared)];
        spec.env = vec![(
            "EVENTS".to_owned(),
            dir.join("events.jsonl").display().to_string(),
        )];
        Arc::new(
            OutsideComponent::start(spec, gate)
                .await
                .expect("the component starts"),
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_real_components_declared_listeners_answer_the_tool_port_from_the_turns_threads() {
        let dir = scratch("listeners");
        let component = start_component(
            &dir.0,
            r#"[{"point":"tools/pre-execute"},{"point":"session/event"}]"#,
        )
        .await;
        let bus = EventBus::new();
        bridge::expose_catalog(&bus);
        let scope = bus.scope("hook-1");
        let listeners = attach_component_listeners(&scope, component.clone()).unwrap();
        assert_eq!(listeners.len(), 2, "one listener per declared point");
        let hooks = BusHooks::new(bus.clone());

        // From the thread that block_on runs the turn on, as `heddle --turn` does.
        let write = args("should-not-exist.txt");
        assert_eq!(
            hooks.pre_execute(&ToolCall {
                name: "write_file",
                args: &write
            }),
            Ok(PreExecute::Refused {
                reason: Some("this hook refuses writes".into())
            })
        );
        let read = args("present.txt");
        assert_eq!(
            hooks.pre_execute(&ToolCall {
                name: "read_file",
                args: &read
            }),
            Ok(PreExecute::Allowed)
        );

        // From a worker, as a spawned turn (a goal round, the server's) does.
        let from_worker = tokio::spawn({
            let hooks = hooks.clone();
            async move {
                let write = args("x");
                hooks.pre_execute(&ToolCall {
                    name: "write_file",
                    args: &write,
                })
            }
        })
        .await
        .unwrap();
        assert!(
            matches!(from_worker, Ok(PreExecute::Refused { .. })),
            "{from_worker:?}"
        );

        // An emit point reaches the process as a notification.
        bridge::session_event(&bus, "s1", &json!({"seq": 3, "type": "todo/write"}));
        let events = dir.0.join("events.jsonl");
        let mut seen = String::new();
        for _ in 0..50 {
            seen = std::fs::read_to_string(&events).unwrap_or_default();
            if !seen.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
        assert!(seen.contains(r#""point":"session/event""#), "{seen}");
        assert!(
            !seen.contains(r#""id":"#),
            "an emit point is a notification, without an id: {seen}"
        );
        assert!(seen.contains(r#""session":"s1""#), "{seen}");

        // The handles do not own the listeners; the row's scope does.
        drop(listeners);
        assert_eq!(
            bus.listener_count(points::TOOLS_PRE_EXECUTE),
            1,
            "a dropped handle leaves the listener"
        );
        drop(scope);
        assert_eq!(
            bus.listener_count(points::TOOLS_PRE_EXECUTE),
            0,
            "dropping the row's scope detaches every listener the component declared"
        );
        assert_eq!(bus.listener_count(points::SESSION_EVENT), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_component_with_no_listeners_attaches_nothing_and_a_bad_declaration_attaches_none() {
        let dir = scratch("declarations");
        let bus = EventBus::new();
        bridge::expose_catalog(&bus);
        let scope = bus.scope("hook-1");

        let tools_only = start_component(&dir.0, "[]").await;
        assert!(
            attach_component_listeners(&scope, tools_only)
                .unwrap()
                .is_empty()
        );

        let unknown = start_component(
            &dir.0,
            r#"[{"point":"tools/pre-execute"},{"point":"model/strem"}]"#,
        )
        .await;
        let error = attach_component_listeners(&scope, unknown).unwrap_err();
        assert!(error.to_string().contains("model/strem"), "{error}");
        assert_eq!(
            bus.listener_count(points::TOOLS_PRE_EXECUTE),
            0,
            "every point is checked before any is attached"
        );

        let malformed =
            start_component(&dir.0, r#"[{"point":"tools/pre-execute","order":1}]"#).await;
        assert!(
            attach_component_listeners(&scope, malformed).is_err(),
            "unknown keys fail the row"
        );
    }
}
