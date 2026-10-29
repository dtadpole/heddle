---
title: The heddle-llm end-to-end tests
created: 2026-10-23T05:08:33Z
modified: 2026-10-29T09:52:29Z
version: 1.1.0
description: End-to-end tests of heddle-llm against local doubles of each provider route, several replaying a verifier's own configuration and double.
grounded_in:
  - source: _verifiers_/10-llm-backends, _verifiers_/20-streaming and _tools_/verify-runner/lib.mjs, read 2026-10-22
---

# `rust/crates/heddle-llm/tests`

[`wire_shapes.rs`](wire_shapes.rs) drives the whole path a verifier sees — request builder, HTTP transport and fold —
over a real loopback socket, so it catches the join: a request the route would refuse, a header lost on the way, a body
the fold cannot parse. Several tests read a verifier's endpoint configuration as literal JSON and serve its double's
exact frames. Everything is offline and spends nothing.

The `anthropic-messages` kind has three: the whole path with its `x-api-key` and `anthropic-version` headers and live
tool-call fragments, a delta that arrives while the double still holds its body open, and a JSON answer when the
endpoint turns streaming off.

Run with `cargo test --manifest-path rust/Cargo.toml -p heddle-llm --test wire_shapes`. The unit tests sit beside the
code; see [`../src/`](../src/INDEX.md).
