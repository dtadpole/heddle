---
title: Where the heddle-session port stands
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T05:17:28Z
level: L1
version: 1.1.0
description: What is merged and tested, what answers through the binary, what waits on whom, and the next step.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/session/, the TypeScript sources it ports
  - source: _verifiers_/70-workspaces-sessions/check.mjs, the checks that judge it
---

# Where it stands, 2026-10-22 (evening)


**Merged.** Steps 1–9 are on `main` (integrator-one, through `b0ef8ab`). Two later commits wait for the
next candidate on `hd/developer-eight`: `2c63ed5` (floats) and `b51e3a1` (the command entry point).

**Tested.** `cargo test --manifest-path rust/Cargo.toml -p heddle-session`: **129 unit tests**, **5
byte-oracle tests** and **1 TypeScript-decoder test**; `rustfmt` and `clippy -D warnings` clean. The
interop is checked three ways:

- **Their bytes read here.** `store.rs` opens a session whose frames Node 24's `zlib.zstdCompressSync`
  wrote, derives its surface, appends without touching the earlier bytes, and prints every line back.
- **Our bytes read there.** [`tests/typescript_interop.rs`](tests/typescript_interop.rs) runs
  `src/session/transcript.ts`'s own `decodeTranscript` over a transcript this crate wrote.
- **The bytes are the oracle's.** [`tests/typescript_bytes.rs`](tests/typescript_bytes.rs) has Node
  `JSON.stringify` the event lines, meta records and instants the store writes, forty generated texts,
  and the `model/request` event built exactly as `src/agent/loop.ts` builds it (mutation-checked).
- **Floats print back.** serde_json's default parser re-prints `0.9999551342447491` as `…492`;
  `float_roundtrip` is on, and `event::tests` pins it, so `heddle transcript` keeps the bytes.
- **Writes are atomic.** A meta file rewritten while another thread read it could be caught empty, so
  `meta(id)` reported no session (the ui check-goal 404, 377 of 8658 reads in developer-ten's probe).
  [`src/fsio.rs`](src/fsio.rs) writes a sibling file and renames it; a store test reading during 1500
  renames failed 278 of 3362 on the old writes and passes now (`4f65141`).

**Answers.** [`src/command.rs`](src/command.rs) answers `sessions` and `transcript` in the convention
developer-two published (D-043): `run(Command, &Args, &Context, out, err) -> i32`, no binary dependency,
no process globals, exit `0`/`1`. Dependents on `main` build against this crate and pass:
`heddle-context`, `heddle-team`.

**Waits on.** The binary's dispatch line and the session row's adapter (developer-two; a tested adapter
patch is at `~/hd-handoff/developer-eight/`). Then `70-workspaces-sessions` still cannot be judged on its
own: its invocation boots the whole `heddle.patch.yml` profile, and with session and workspace adapted the
real binary refuses with `12 row(s) failed to load: console, model, context, goal, goal-driver,
subagent-tool, goal-tool, todo, todo-tool, turns, team, tools`. The flip is a whole-backend event.

**Next step.** When developer-two dispatches these words and every profile row starts, run
`HEDDLE_BIN=<binary> node --test _verifiers_/70-workspaces-sessions/check.mjs` from the lane and report the
counts. A throwaway probe outside the repository (not committed) already passes the 11 of 22 checks that
need neither the loop nor the server.

**Done** when `70-workspaces-sessions` and `80-web-ui check-workspaces` pass through `HEDDLE_BIN` with the
CLI (`heddle`) and server (`heddle-server`) crates composing this one, and the backend lane's integrator
has merged it.
