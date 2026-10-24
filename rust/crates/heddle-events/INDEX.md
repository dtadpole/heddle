---
title: The heddle-events crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T06:19:40Z
version: 0.6.0
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

## Articles

| Article | What it holds |
|---|---|
| [`public-api.md`](public-api.md) | Every public item of the crate, what it is, and the modules that hold them. |
| [`seats.md`](seats.md) | How each feature crate and the binary meet the bus, and the direction of dependency that keeps the workspace acyclic. |
| [`cordis-shapes.md`](cordis-shapes.md) | The Rust shapes that differ from Cordis on purpose, and why. |
| [`port-plan.md`](port-plan.md) | The steps of the port, what each landed, and how part 6 is judged. |

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
