---
title: The heddle-llm crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T05:09:31Z
version: 0.5.0
description: The Rust port crate for the backend wire shapes, the HTTP client, streamed content and reasoning deltas, model info and usage — what it is, its state, and where to read next.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: the TypeScript sources src/llm/, src/stream/printer.ts and src/plugins/model.ts, and their importers under src/, read 2026-10-22
  - source: _verifiers_/10-llm-backends, _verifiers_/20-streaming, _verifiers_/98-model-endpoints and _tools_/model-validation, read 2026-10-22
---

# `rust/crates/heddle-llm`

The model layer: one streaming call over three provider wire shapes and an offline scripted endpoint, the endpoint
registry with its `model/request` and `model/stream` hooks, the `--stream` view, and the `models` command.

| | |
|---|---|
| Ported from | `src/llm/`, `src/stream/printer.ts`, the service half of `src/plugins/model.ts`, the `models` and `--stream` parts of `src/cli.ts` |
| Judged by | `_verifiers_/10-llm-backends`, `_verifiers_/20-streaming`, `_verifiers_/98-model-endpoints`, through the `heddle` binary |
| Unit tests | `cargo test --manifest-path rust/Cargo.toml -p heddle-llm`, offline |

**State.** Every body is ported and tested. What remains is outside the crate: the binary advertising its
capabilities and feeding the `--stream` view (see the port plan).

## Read next

| Where | What |
|---|---|
| [`src/`](src/INDEX.md) | the module map |
| [`tests/`](tests/INDEX.md) | end-to-end tests against local doubles of each route |
| [`consumers.md`](consumers.md) | its one dependency, and what each crate uses from it |
| [`decisions.md`](decisions.md) | the decisions behind the API |
| [`port-plan.md`](port-plan.md) | the steps, what the verifiers measured, and what step 6 needs |
| [`../INDEX.md`](../INDEX.md) | the other crates |
