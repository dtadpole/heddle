---
title: The heddle-events crate
version: 0.2.0
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

The API is landed with `todo!()` bodies where the behaviour is not yet ported; the docs on each item are the
contract. `cargo doc -p heddle-events` renders it.

| Item | What it is |
|---|---|
| `Event`, `EmitEvent`, `ParallelEvent`, `SerialEvent`, `BailEvent`, `WaterfallEvent` | an event is a marker type with a `NAME` and a `Payload`, and exactly one mode trait, so a wrong-mode dispatch does not compile |
| `EventBus` | the shared bus (cheap clone): `emit`, `bail` (sync), `parallel`, `serial`, `waterfall` (async), `listener_count` |
| `Scope`, `Listener`, `ListenOptions` | Cordis's fiber: listeners are registered through a scope and released when it is dropped or disposed, with its children; `on_emit`, `on_bail`, `on_parallel`, `on_serial`, `on_waterfall`, and the two sync helpers `on_waterfall_replace` (replace or pass) and `on_waterfall_map` (run the rest, rewrite the result) |
| `Next<E>` | the continuation a waterfall listener receives; `run()` consumes it, so the rest of the chain runs at most once |
| `HookError`, `HookErrorKind`, `ParallelError` | a listener's failure: `refuse` (the TypeScript `HookRefusal`) or `fail`, attributed by the bus to the point and the listener's scope |
| `points` | the name constants of every point, `HOOK_POINTS` and its JSON and text renderings for `heddle hooks`, and the lifecycle events `Ready`, `ConfigProblem`, `TeamChanged` |
| `outside` | outside listeners: `HookCall`/`HookReply`, the `JsonListener` seam, `EventBus::expose_*` and `Scope::on_json*`, `OutsideListenerConfig`, `StdioListener`, `attach_outside_listener` |

### Who uses which part

| Crate (seat) | Defines the marker of | Calls |
|---|---|---|
| `heddle-llm` (developer-three) | `model/request` (waterfall, request → request), `model/stream` (waterfall, request → chunk stream) | `waterfall`; `expose_waterfall` for `model/request` only |
| `heddle-tools` (developer-five) | `tools/pre-execute` (`{name,args}` → `{allowed,reason?}`), `tools/post-execute` (`{name,args,result}` → result) | `waterfall`, `expose_waterfall` |
| `heddle-agent` (developer-five) | `agent/pre-step`, `agent/request-error` | `waterfall`; turns a `HookError` into the turn's failure message (`is_refusal()` → its own words; else "a hook failed at …") |
| `heddle-session` (developer-eight) | `session/event` (emit, `{session, event}`) | `emit` after the write, never before; `expose_emit` |
| `heddle-context` (developer-four) | — | `on_waterfall` for `agent/request-error` |
| `heddle-sandbox` (developer-seven) | `approval/request` (emit) | `emit` |
| `heddle-server` (developer-ten) | — | `on_emit` for `session/event` and `approval/request` (the live stream); `on_waterfall_map` for `model/request` (the running-turn model rule) |
| `heddle` (developer-two) | — | builds the bus, one `Scope` per configuration row; prints `points::hook_points_json()` / `hook_points_text()` for `heddle hooks`; listens for `ConfigProblem`; emits `Ready`; attaches `outside-listener` rows |

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
| 5 | `60-hooks` through `HEDDLE_BIN`: the `outside-listener` row with developer-one and developer-two, the verifier branch that writes a process listener instead of a `.ts` plugin with integrator-one | next, with the binary |

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
