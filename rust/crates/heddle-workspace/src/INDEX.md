---
title: The heddle-workspace sources
version: 0.2.0
description: The sources of the heddle-workspace crate, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/workspace/service.ts and src/session/tree.ts
---

# `rust/crates/heddle-workspace/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is | Ported from |
|---|---|---|
| [`lib.rs`](lib.rs) | the crate root, the model, the re-exports | — |
| [`record.rs`](record.rs) | the record file's shape and what the service answers with | `service.ts` types |
| [`service.rs`](service.rs) | `WorkspaceService` and its configuration | `service.ts` |
| [`tree.rs`](tree.rs) | the classified tree, one level at a time | `src/session/tree.ts` |
| [`file.rs`](file.rs) | the right panel's file reader | `readFileText` in `src/session/tree.ts` |
| [`collate.rs`](collate.rs) | the tree's name order | `Intl.Collator` in `src/session/tree.ts` |
| [`command.rs`](command.rs) | `heddle workspaces`, `workspace add\|list\|remove\|rename`, `tree`, `file` and `session new`, answered here (D-043), and `describe_tree`; `session new` lives here because it needs both services | `src/cli.ts`, those branches and `describeTree` |
| [`error.rs`](error.rs) | `WorkspaceError` | the thrown messages |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, its port plan, and what judges it.
