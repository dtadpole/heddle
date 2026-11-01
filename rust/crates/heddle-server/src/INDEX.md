---
title: The heddle-server sources
created: 2026-10-23T00:55:27Z
modified: 2026-10-25T12:46:37Z
version: 0.3.5
description: The sources of the heddle-server crate, one module per concern, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/server/web.ts, src/server/token.ts, src/server/html.ts
---

# `rust/crates/heddle-server/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code. 144 tests pass with
`cargo test --manifest-path rust/Cargo.toml -p heddle-server`.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its shape, and the re-exports |
| [`command.rs`](command.rs) | `heddle web`'s entry point (D-043): dry run, start, announce, serve until shutdown |
| [`adapters.rs`](adapters.rs) | the service traits over the real crates: the session store adapter and its event listener |
| [`token.rs`](token.rs) | the launch token, the signing secret, the cookie, `authorize` |
| [`fence.rs`](fence.rs) | the Host and Origin fence and the cross-site write rule |
| [`page.rs`](page.rs) | the embedded page, its build marker, the favicon and the token form |
| [`preview.rs`](preview.rs) | the HTML preview policy and resource rewrite (`html.ts`) |
| [`respond.rs`](respond.rs) | response shapes, the JSON body reader, the session-id rule |
| [`stream.rs`](stream.rs) | the event hub and SSE framing |
| [`runs.rs`](runs.rs) | which sessions have a turn in flight, and stopping them |
| [`terminals.rs`](terminals.rs) | the page's interactive terminals (#85): PTY via `script(1)`, confined like bash, bounded, closed with their process tree |
| [`transcript.rs`](transcript.rs) | the chat view's fold of a session log |
| [`selection.rs`](selection.rs) | the endpoint, model and level ladders |
| [`services.rs`](services.rs) | the traits the server calls instead of a Cordis context |
| [`server.rs`](server.rs) | options, the builder, the shared state, features, the running server |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, the route table and the port plan.
