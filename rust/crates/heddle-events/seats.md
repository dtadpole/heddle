---
title: Who uses heddle-events
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T06:19:40Z
level: L1
version: 1.0.0
description: How each feature crate and the binary meet the bus, and the direction of dependency that keeps the workspace acyclic.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: node_modules/@deepseek-ai/cordis/src/events.ts (Cordis 4.0.4), read 2026-10-22
  - source: the event declarations in src/events.ts, src/llm/service.ts, src/llm/types.ts, src/tools/service.ts, src/agent/loop.ts, src/approvals/service.ts, src/plugins/team.ts, and the hooks command in src/cli.ts
  - source: _verifiers_/60-hooks/check.mjs
---

# Who uses heddle-events

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

## Read next

[`INDEX.md`](INDEX.md) for the crate.
