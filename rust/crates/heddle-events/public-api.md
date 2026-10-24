---
title: The heddle-events public API
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T06:19:40Z
level: L1
version: 1.0.0
description: Every public item of the crate, what it is, and the modules that hold them.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: node_modules/@deepseek-ai/cordis/src/events.ts (Cordis 4.0.4), read 2026-10-22
  - source: the event declarations in src/events.ts, src/llm/service.ts, src/llm/types.ts, src/tools/service.ts, src/agent/loop.ts, src/approvals/service.ts, src/plugins/team.ts, and the hooks command in src/cli.ts
  - source: _verifiers_/60-hooks/check.mjs
---

# The heddle-events public API

Every body is ported, with its unit tests beside it; the docs on each item are the contract.
`cargo doc -p heddle-events` renders it.

| Item | What it is |
|---|---|
| `Event`, `EmitEvent`, `ParallelEvent`, `SerialEvent`, `BailEvent`, `WaterfallEvent` | an event is a marker type with a `NAME` and a `Payload`, and exactly one mode trait, so a wrong-mode dispatch does not compile |
| `EventBus` | the shared bus (cheap clone): `emit`, `bail` (sync), `parallel`, `serial`, `waterfall` (async), `listener_count` |
| `Scope`, `Listener`, `ListenOptions` | Cordis's fiber: listeners are registered through a scope and released when it is dropped or disposed, with its children; `on_emit`, `on_bail`, `on_parallel`, `on_serial`, `on_waterfall`, and the two sync helpers `on_waterfall_replace` (replace or pass) and `on_waterfall_map` (run the rest, rewrite the result) |
| `Next<E>` | the continuation a waterfall listener receives; `run()` consumes it, so the rest of the chain runs at most once |
| `HookError`, `HookErrorKind`, `ParallelError` | a listener's failure: `refuse` (the TypeScript `HookRefusal`) or `fail`, attributed by the bus to the point and the listener's scope |
| `points` | the name constants of every point, `HOOK_POINTS` and its JSON and text renderings for `heddle hooks`, and the lifecycle events `Ready`, `ConfigProblem`, `TeamChanged` |
| `outside` | outside listeners over the part-4 protocol (JSON-RPC 2.0, `hooks/call`): `HookCall`/`HookReply` (`next`, `replace`, `merge`, `refuse`, `fail`), the `JsonListener` seam, `EventBus::expose_*` and `Scope::on_json*`; `ListenerDeclaration`, `parse_listener_declarations` and `attach_declared` for the listeners a component declares in `initialize`; `RpcListener`, which wraps any part-4 client (the boot's `heddle-tools` `OutsideComponent`); `OutsideListenerConfig` (`program` + `args` + `config`, D-031) and `StdioListener`, a stand-alone client; `attach_outside_listener` |
| `bridge` | the seam from the feature crates' synchronous hook ports to the bus: the catalog's points as JSON markers (`AgentPreStep`, `ModelRequest`, `ToolsPreExecute`, `ToolsPostExecute`, `SessionEvent`), `expose_catalog`, `EventBus::waterfall_blocking`, and one function per port method (`model_request`, `pre_execute`, `post_execute`, `pre_step`, `session_event`) with the TypeScript defaults and no runtime touched when nothing listens |
| `ports` | `BusHooks`, which implements `heddle-llm`'s `ModelHooks`, `heddle-tools`' `ToolHooks` and `heddle-agent`'s `TurnHooks` over the bus (the oracle's failure semantics where the port can express them), and `attach_component_listeners`, which attaches a `heddle-tools` `OutsideComponent`'s declared listeners over its own connection. This crate depends on those three; they must never depend on it |
| `command` | `heddle hooks [--json]` behind the binary's entry-point convention (D-043) |

## Read next

[`INDEX.md`](INDEX.md) for the crate.
