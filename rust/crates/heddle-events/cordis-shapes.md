---
title: Where heddle-events differs from Cordis
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T06:19:40Z
level: L1
version: 1.0.0
description: The Rust shapes that differ from Cordis on purpose, and why.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: node_modules/@deepseek-ai/cordis/src/events.ts (Cordis 4.0.4), read 2026-10-22
  - source: the event declarations in src/events.ts, src/llm/service.ts, src/llm/types.ts, src/tools/service.ts, src/agent/loop.ts, src/approvals/service.ts, src/plugins/team.ts, and the hooks command in src/cli.ts
  - source: _verifiers_/60-hooks/check.mjs
---

# Where heddle-events differs from Cordis

- **One mode per event**, fixed by its type; Cordis lets any event be dispatched in any mode, Heddle never does.
- **Async listeners take `Arc<Payload>`** and return an owned `HookFuture`, so a listener can move the payload into
  its future and a dispatch can be spawned; sync modes (`emit`, `bail`) take `&Payload`.
- **A waterfall's default is synchronous** (`FnOnce(&Payload) -> Output`), as every TypeScript call site's is.
- **`emit` listeners cannot fail**; `parallel` collects every failure (Cordis's `AggregateError`).
- **No `this` filtering, no `global` option, no `internal/*` events**: Heddle uses none of them.
- Kept from Cordis: registration order, `prepend`, `once`, a listener snapshot per dispatch, and release with the owner.

## Read next

[`INDEX.md`](INDEX.md) for the crate.
