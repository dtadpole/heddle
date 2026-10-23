---
title: The heddle-session sources
version: 0.2.0
description: The sources of the heddle-session crate, one module per TypeScript source, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/session/
---

# `rust/crates/heddle-session/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is | Ported from |
|---|---|---|
| [`lib.rs`](lib.rs) | the crate root, the contract, the re-exports | — |
| [`clock.rs`](clock.rs) | timestamps as `toISOString` prints them | `new Date().toISOString()` |
| [`layout.rs`](layout.rs) | `workspace_key`: the folder a log is filed under | `layout.ts` |
| [`transcript.rs`](transcript.rs) | one zstd frame per event: the frame walk, encode, decode | `transcript.ts` |
| [`message.rs`](message.rs) | stand-ins for `heddle-llm`'s `Message`, `ContentPart`, `Chunk` | `src/llm/types.ts` |
| [`event.rs`](event.rs) | `SessionEvent`, `NewEvent`, `SessionHandle`, `SurfaceOp`, `AppendOptions` | `store.ts` types |
| [`meta.rs`](meta.rs) | `SessionMeta` as ordered JSON, and the options that create or edit it | `store.ts` `SessionMeta` |
| [`surface.rs`](surface.rs) | the surface fold and message derivation | `store.ts` free functions |
| [`store.rs`](store.rs) | `SessionStore` | `store.ts` `SessionStore` |
| [`mode.rs`](mode.rs) | the `permission/mode` fold | `mode.ts` |
| [`definition.rs`](definition.rs) | `_sessions_/<name>/{session.json, INDEX.md}` | `definition.ts` |
| [`service.rs`](service.rs) | `SessionService`, `title_from`, `fork_title` | `service.ts`, `src/plugins/session.ts` |
| [`error.rs`](error.rs) | `SessionError`, `SessionFlagError` | the thrown messages |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, its port plan, and what judges it.
