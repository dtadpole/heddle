---
title: The heddle-tools sources
version: 0.2.0
description: The sources of the heddle-tools crate, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-tools/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its module map and its re-exports |
| [`tool.rs`](tool.rs) | one tool and one command, their contexts, `ToolResult` and the stable codes |
| [`registry.rs`](registry.rs) | `ToolRegistry`: registration, the allow list, and the gate order of every call |
| [`gates.rs`](gates.rs) | the ports the registry gates through: approvals, sandbox, per-session mode, hooks |
| [`builtin.rs`](builtin.rs) | `write_file`, `read_file`, `list_dir`, `bash` |
| [`config.rs`](config.rs) | the `tools` configuration row |
| [`protocol.rs`](protocol.rs) | the outside-component wire types ([`../PROTOCOL.md`](../PROTOCOL.md)) |
| [`outside.rs`](outside.rs) | starting an outside component and forwarding its tools' calls |
| [`upstream.rs`](upstream.rs) | provisional mirrors of types other crates own |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, its API and its port plan.
