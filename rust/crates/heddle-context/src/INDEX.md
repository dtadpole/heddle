---
title: The heddle-context sources
version: 0.3.0
description: The sources of the heddle-context crate, one file per TypeScript module plus the port's own seams, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/context/, the TypeScript module these files port
---

# `rust/crates/heddle-context/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root: the module map and the re-exports |
| [`meter.rs`](meter.rs) | the token estimate per node, with a provider-usage anchor (`meter.ts`) |
| [`budget.rs`](budget.rs) | the trigger and the retained tail, from the endpoint's window (`budget.ts`) |
| [`prune.rs`](prune.rs) | oversized tool results, rewritten as surface replacements (`prune.ts`) |
| [`compaction.rs`](compaction.rs) | span selection, summarising, and the one replacement (`compaction.ts`) |
| [`instructions.rs`](instructions.rs) | the project's rule files as one baseline in a byte budget (`instructions.ts`) |
| [`pairing.rs`](pairing.rs) | the repair of a log whose tool calls were left unanswered (`pairing.ts`) |
| [`runtime.rs`](runtime.rs) | the runtime-context snapshot's text (`service.ts`) |
| [`service.rs`](service.rs) | the seam the agent loop, the command line and the composer call (`service.ts`) |
| [`events.rs`](events.rs) | the `context/note` and `compaction/*` events this crate writes, typed |
| [`store.rs`](store.rs) | the `ContextStore` port this crate needs from the session store |
| [`types.rs`](types.rs) | `heddle-llm`'s message types, re-exported, and `text_message` |
| [`testing.rs`](testing.rs) | `MemoryStore`, an in-memory `ContextStore`, behind the `testing` feature |
| [`session_store.rs`](session_store.rs) | `impl ContextStore for heddle-session::SessionStore`, the real store bound to this crate's trait |
| [`error.rs`](error.rs) | `ContextError` |
| [`text.rs`](text.rs) | the JavaScript string rules the numbers rest on: UTF-16 length and `trim()` |

## Read next

[`../INDEX.md`](../INDEX.md) for the public API, the port order and what judges the crate.
