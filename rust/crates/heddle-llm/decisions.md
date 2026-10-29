---
title: The decisions behind the heddle-llm API
created: 2026-10-23T05:08:05Z
modified: 2026-10-29T13:23:52Z
level: L1
version: 1.2.0
description: Why the heddle-llm API has the shape it has — JSON parity, stream cancellation, the hook seam, the fold split and the HTTP client.
status: unverified
grounded_in:
  - source: the TypeScript sources src/llm/ and src/plugins/model.ts, read 2026-10-22
---

# The decisions behind the heddle-llm API

1. **JSON is the TypeScript build's, byte for byte.** `ContentPart`, `Message`, `Chunk` and `TokenUsage` are written
   into the session log, so each serializes with its `type` tag first, its fields in the order the TypeScript code
   builds them, absent optionals omitted. `Message` carries `source` so one type serves the request and the log;
   tests in `types.rs` pin each shape.
2. **`serde_json` with `preserve_order`**, so objects keep insertion order as `JSON.stringify` does — in every crate
   of the binary, since Cargo unifies features.
3. **The endpoint vocabulary is `heddle-config`'s**, re-exported, never redeclared.
4. **A stream is cancelled by dropping it.** No call takes an abort signal; a caller that races a stop with
   `tokio::select!` drops the stream and the request goes with it.
5. **The `model/request` and `model/stream` hooks are a trait, `ModelHooks`,** with Cordis's waterfall semantics:
   outermost first in registration order, `next()` runs the rest, not calling it vetoes, and a `model/request` hook
   that fails ends the call with its own error, as a throwing listener does.
6. **`ModelService::stream` returns `Result`**: `NO_ENDPOINT` and a failing hook are known before any stream exists,
   as the TypeScript call throws before iterating. Failures while building or sending a request are stream items.
7. **Each wire shape is a pure request builder plus a pure fold** (`StreamFold`), driven over a live body by
   `fold_sse`, so translation and event vocabulary are tested without a socket.
8. **HTTP is `reqwest` with rustls**, with Title-Case headers; the timeout is socket inactivity, not a total, so a long
   stream is not cut. A proxied call sends the target in the proxy's absolute form.
9. **The `--stream` view is shared and fed through a hub.** The session service takes its one listener before any turn
   exists, so `StreamHub` sits between it and each turn's view, holding views weakly.
10. **`anthropic-messages` is spoken from `EndpointKind::Other`.** `heddle-config` reads every kind it has no variant
    for as `Other(String)` and leaves the decision to this crate, so the kind needs no change outside it:
    `adapter_for` matches `Other("anthropic-messages")` ([`messages::ANTHROPIC_MESSAGES`]). A variant in
    `heddle-config` later is a rename of one match arm.
11. **The two Anthropic kinds share the translation and the fold**, not the envelope: `to_anthropic_messages`,
    `anthropic_system` and `AnthropicFold` serve both; the Messages adapter turns on live tool-call fragments
    (`with_live_tool_calls`), so the publisher route's output is unchanged.
12. **A configuration change rebuilds every adapter.** `reconfigure` builds all of them before replacing anything, so
    a configuration no adapter can speak leaves the service as it was, and that failure is reported (`tracing::warn!`
    from the refresh, as the TypeScript service warns). Unlike the TypeScript service it does not keep an unchanged
    endpoint's adapter; the cost is one re-asked model-info lookup per endpoint after a change, which is harmless,
    and keeping unchanged adapters is the change to make if that lookup ever matters.
