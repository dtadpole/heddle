---
title: The heddle-events crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T05:06:23Z
version: 0.3.0
description: The Rust port crate for the event bus and the named hook points, with Cordis's emit, parallel, serial, bail and waterfall modes — its public API, who uses which part, and the port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: node_modules/@deepseek-ai/cordis/src/events.ts (Cordis 4.0.4), read 2026-10-22
  - source: the event declarations in src/events.ts, src/llm/service.ts, src/llm/types.ts, src/tools/service.ts, src/agent/loop.ts, src/approvals/service.ts, src/plugins/team.ts, and the hooks command in src/cli.ts
  - source: _verifiers_/60-hooks/check.mjs
---

# `rust/crates/heddle-events`

The Rust port of the event bus every crate emits into and listens on, and of the named hook points.

| | |
|---|---|
| Ported from | Cordis's `EventsService`; the `Events` declarations across `src/`; the catalog of `heddle hooks` in `src/cli.ts` |
| Judged by | `_verifiers_/60-hooks`, through the `heddle` binary, plus the outside-listener branch it needs |
| Sources | [`src/`](src/INDEX.md) |
| Owner | seat `developer-six`; merges through `integrator-one` |

## Public API

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

### Who uses which part

The feature crates do not depend on this crate: each intercepts its calls through a **port of its own**, and
this crate adapts to all of them in one place (`ports`), which is what keeps the workspace acyclic (D-025: a
feature crate adapts behind the seam). The binary is the only crate that builds a bus.

| Crate (seat) | How it meets the bus |
|---|---|
| `heddle-llm` (developer-three) | its `ModelHooks` port; `BusHooks` implements it for `model/request` (a failing listener fails the call before any stream exists). `model/stream`'s output is a stream, so it is not exposed to outside listeners |
| `heddle-tools` (developer-five) | its `ToolHooks` port; `BusHooks` implements `tools/pre-execute` (a broken listener is a `ToolHookError`, answered `INTERRUPTED`) and `tools/post-execute` (a broken listener is `TOOL_FAILED`). Its `OutsideComponent` hosts a component's tools; `attach_component_listeners` attaches the listeners the same process declared |
| `heddle-agent` (developer-five) | its `TurnHooks` port; `BusHooks` implements `agent/pre-step` (a refusal is reported as is, a broken hook as `a hook failed at agent/pre-step — …`). `agent/request-error` stays the port's own default: it is not in the catalog |
| `heddle-session` (developer-eight) | its store's `EventListener` closure; the boot calls `bridge::session_event` from it, after the write |
| `heddle-goal`, `heddle-todo` (developer-six) | none: they event-source from the session store and need no bus |
| `heddle` (developer-two) | builds the bus, calls `bridge::expose_catalog`, hands one `BusHooks` to the model service, the tool registry's gates and the agent runtime, attaches each outside component's declared listeners through a `Scope` per row, and dispatches `hooks` to `command::run`. Runs on the multi-thread Tokio runtime the ports block on |

## Rust shapes that differ from Cordis, on purpose

- **One mode per event**, fixed by its type; Cordis lets any event be dispatched in any mode, Heddle never does.
- **Async listeners take `Arc<Payload>`** and return an owned `HookFuture`, so a listener can move the payload into
  its future and a dispatch can be spawned; sync modes (`emit`, `bail`) take `&Payload`.
- **A waterfall's default is synchronous** (`FnOnce(&Payload) -> Output`), as every TypeScript call site's is.
- **`emit` listeners cannot fail**; `parallel` collects every failure (Cordis's `AggregateError`).
- **No `this` filtering, no `global` option, no `internal/*` events**: Heddle uses none of them.
- Kept from Cordis: registration order, `prepend`, `once`, a listener snapshot per dispatch, and release with the owner.

## Port plan

| Step | What | State |
|---|---|---|
| 1 | Public API, docs, catalog and its tests | landed |
| 2 | The bus: table, scopes and children, `once`, snapshot dispatch, the five modes, error attribution; unit tests for each Cordis rule (order, prepend, once, snapshot, release with scope and parent, veto, replace, map, attribution, parallel collection, serial and bail stop) | landed |
| 3 | The JSON bridges and the `expose_*` registry, tested with an in-memory `JsonListener` | landed |
| 4 | `StdioListener`: spawn, correlate by `id`, timeouts, child death, stderr to the log; tested against a small script child | landed |
| 4b | The component shape (D-031): listeners declared in `initialize`, `merge` for a post-execute rewrite that keeps the tool's result, `RpcListener` so one process serves tools and listeners, and a child's own requests answered without id collisions | landed |
| 4c | The port bridge: `llm`, `tools` and `agent` intercept through ports of their own, synchronous and without this crate; `bridge` makes an adapter over the bus a few lines in whichever crate holds it | landed |
| 4d | The port adapters (`ports`): the boot passes one `BusHooks` where it passes the no-listener defaults today, for model requests, tool calls and rounds | landed |
| 5 | `60-hooks` through `HEDDLE_BIN`: the verifier branch that writes each hook as a `.component.yml` and a process is on main; the boot's bus wiring (developer-two) is what remains. Rehearsal on developer-two's f45993a with only `SERVED` edited (2026-10-22): 1 of 6 checks passes, and the five failures are that one step | waiting on the boot |

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
