---
title: The heddle-session sources
created: 2026-10-23T00:55:27Z
modified: 2026-10-31T03:20:00Z
version: 0.4.0
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
| [`command.rs`](command.rs) | `heddle sessions` and `heddle transcript`, answered here (D-043): `run(Command, &Args, &Context, out, err) -> i32`, plus the shared `refuse` and `write_pretty` | `src/cli.ts`, the `sessions` and `transcript` branches |
| [`layout.rs`](layout.rs) | `workspace_key`: the folder a log is filed under | `layout.ts` |
| [`transcript.rs`](transcript.rs) | one zstd frame per event: the frame walk, encode, decode | `transcript.ts` |
| [`message.rs`](message.rs) | `heddle-llm`'s `Message`, `ContentPart`, `Chunk` and friends, re-exported, plus `text_of` and the `RecordedMessage` alias | `src/llm/types.ts` via `heddle-llm` |
| [`event.rs`](event.rs) | `SessionEvent`, `NewEvent`, `SessionHandle`, `SurfaceOp`, `AppendOptions` | `store.ts` types |
| [`meta.rs`](meta.rs) | `SessionMeta` as ordered JSON, and the options that create or edit it | `store.ts` `SessionMeta` |
| [`surface.rs`](surface.rs) | the surface fold and message derivation | `store.ts` free functions |
| [`store.rs`](store.rs) | `SessionStore` | `store.ts` `SessionStore` |
| [`mode.rs`](mode.rs) | the `permission/mode` fold | `mode.ts` |
| [`repair.rs`](repair.rs) | the closers of a turn its writer never finished (DSH's `openTurnClosers`): appended at the first write-open after a restart, shown by a read while no writer holds the session (issue #5) | `repair.ts` |
| [`inbox.rs`](inbox.rs) | the pending-input inbox: DSH's `agent/inbox/spliced` fold, `queue_steer`, `claim_next_step` (R-developer-two-5) | `inbox.ts` |
| [`definition.rs`](definition.rs) | `_sessions_/<name>/{session.json, INDEX.md}` | `definition.ts` |
| [`service.rs`](service.rs) | `SessionService`, `title_from`, `fork_title` | `service.ts`, `src/plugins/session.ts` |
| [`error.rs`](error.rs) | `SessionError`, `SessionFlagError` | the thrown messages |
| [`search.rs`](search.rs) | content search: DSH's `session.search` over the current user and assistant messages — FTS5 `unicode61` phrase matching, DSH's ranking and 240-code-point snippet, and `SessionSearchIndex`, a scan cached per log (R-developer-eight-19) | `search.ts` |
| [`unicode61.rs`](unicode61.rs) | the tokenizer's tables, generated from SQLite by `src/session/unicode61-generate.ts`; do not edit | `unicode61.ts` |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, its port plan, and what judges it.
