---
title: The heddle-session crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T08:24:41Z
version: 0.4.0
description: The Rust port crate for the append-only session log, its store layouts, transcripts and definitions — its public API and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/session/, the TypeScript sources it ports
  - source: _verifiers_/70-workspaces-sessions/check.mjs, the checks that judge it
---

# `rust/crates/heddle-session`

The Rust port of the append-only session log: the store and its two layouts, the zstd-framed transcript,
the surface a request is derived from, the access-mode fold, and the session definitions written into a
branch.

| | |
|---|---|
| Ported from | `src/session/` (`store.ts`, `transcript.ts`, `layout.ts`, `mode.ts`, `definition.ts`, `service.ts`), `src/plugins/session.ts` |
| Depends on | [`heddle-config`](../heddle-config/INDEX.md) for the path rules of `src/paths.ts` (`canonical_path`, `is_under`, `depth_of`) and the environment (`Env`, `heddle_home`, `expand_home`) |
| Not here | `src/session/tree.ts` — the folder tree is in [`../heddle-workspace/`](../heddle-workspace/INDEX.md), beside the roots it is a view of |
| Judged by | `_verifiers_/70-workspaces-sessions`, through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

## Articles

| Article | What it holds |
|---|---|
| [`contract.md`](contract.md) | What a log written by either build must look like for the other to read it, and the decisions a dependent crate should know. |
| [`public-api.md`](public-api.md) | Every item the crate re-exports at its root, and what each one is for. |
| [`port-plan.md`](port-plan.md) | The nine steps of the port, the unit tests each one carries, and what each step unblocks. |
| [`status.md`](status.md) | What is merged and tested, what answers through the binary, what waits on whom, and the next step. |

## Read next

[`src/INDEX.md`](src/INDEX.md) for the files; [`../heddle-workspace/`](../heddle-workspace/INDEX.md) for the
tree; [`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md)
for the parts.
