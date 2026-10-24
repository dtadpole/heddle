---
title: The heddle-workspace crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T08:24:41Z
version: 0.4.0
description: The Rust port crate for workspaces, the folders they name, and the classified recursive tree — its public API and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/workspace/service.ts and src/session/tree.ts, the TypeScript sources it ports
  - source: _verifiers_/70-workspaces-sessions/check.mjs and _verifiers_/80-web-ui/check-workspaces.mjs, the checks that judge it
---

# `rust/crates/heddle-workspace`

The Rust port of workspaces — a target folder plus the record that says it is one — the containment rule
that groups sessions under the nearest root, and the folder tree the left column and `heddle tree` show.

| | |
|---|---|
| Ported from | `src/workspace/service.ts`; `src/session/tree.ts` (`tree`, `kindOf`, `classify`, `badgeFor`, `readFileText`) |
| Depends on | [`heddle-session`](../heddle-session/INDEX.md) for `SessionMeta` and the definitions; [`heddle-config`](../heddle-config/INDEX.md) for the path rules and `Env` |
| Judged by | `_verifiers_/70-workspaces-sessions`, `_verifiers_/80-web-ui` (`check-workspaces`), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

## Articles

| Article | What it holds |
|---|---|
| [`public-api.md`](public-api.md) | Every item the crate re-exports at its root, and the decisions a dependent crate should know. |
| [`port-plan.md`](port-plan.md) | The five steps of the port, the unit tests each one carries, and what each step unblocks. |
| [`status.md`](status.md) | What is merged and tested, what answers through the binary, what waits on whom, and the next step. |

## Read next

[`src/INDEX.md`](src/INDEX.md) for the files; [`../heddle-session/`](../heddle-session/INDEX.md) for the log;
[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the
parts.
