---
title: The heddle-events sources
version: 0.2.0
description: The sources of the heddle-events crate, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-events/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation and a compiled example, and the re-exports |
| [`event.rs`](event.rs) | the `Event` trait and the five mode traits |
| [`mode.rs`](mode.rs) | `Mode`, serialized as Cordis names the modes |
| [`bus.rs`](bus.rs) | `EventBus`, `Scope`, `Listener`, `ListenOptions`, `HookFuture` |
| [`waterfall.rs`](waterfall.rs) | `Next`, the continuation a waterfall listener receives |
| [`error.rs`](error.rs) | `HookError` (refused or failed, attributed), `ParallelError` |
| [`points.rs`](points.rs) | the point names, the `heddle hooks` catalog, the lifecycle events |
| [`command.rs`](command.rs) | `heddle hooks [--json]`, behind the binary's entry-point convention (D-043) |
| [`bridge.rs`](bridge.rs) | the catalog's points as JSON, the blocking dispatch, and one function per hook-port method |
| [`ports.rs`](ports.rs) | `BusHooks` over `heddle-tools`' and `heddle-agent`'s hook ports, and an outside component's declared listeners |
| [`outside.rs`](outside.rs) | outside listeners: message shapes, the `JsonListener` seam, bridges, the stdio transport |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports and what judges it.
