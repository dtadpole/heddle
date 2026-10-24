---
title: The heddle-session port plan
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T08:24:41Z
level: L1
version: 1.0.0
description: The nine steps of the port, the unit tests each one carries, and what each step unblocks.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/session/, the TypeScript sources it ports
  - source: _verifiers_/70-workspaces-sessions/check.mjs, the checks that judge it
---

# Port plan


Each step lands with its unit tests (`cargo test --manifest-path rust/Cargo.toml -p heddle-session`) and
is pushed to its owner's branch on its own.

| Step | Module | Unit tests that can fail | Unblocks |
|---|---|---|---|
| 1 | `clock`, `layout` | ISO millis format and round trip; `workspace_key` for `/`, separators, non-ASCII and astral characters, the 120-unit cut | everything below |
| 2 | `transcript` | frame walk on single and multi-frame buffers; torn by 1 byte, inside the magic, mid-block; plain JSONL; a frame encoded here decodes with checksum | the log format |
| 3 | `event`, `meta`, `message` | event bytes equal a `JSON.stringify` fixture; field order kept on round trip; `SurfaceOp` both shapes; meta edits keep key order and unknown keys | 4 |
| 4 | `surface` | append, chunk runs, `done` closes a run, replacement splice, second compaction with `start > end`, unfoldable range; `completed_prefix`; `inherits_answer` on a fork of a fork | `heddle-context` |
| 5 | `store` | create both files; append bytes are a prefix; torn tail repaired once and next append readable; legacy layout read and appended; replacement validation (system head, tool result); list newest first across layouts; flags/pin/archive; set_model replace; fork copies the projection; listener after write, transient delta not recorded | `heddle-agent`, `heddle-context`, `heddle-team`, `heddle-goal`, `heddle-todo` |
| 6 | `mode` | last event wins; unknown word errors naming the seq; inherit | `heddle-tools`, `heddle-agent` |
| 7 | `definition` | name from the local clock and its ordinals; `INDEX.md` texts; update keeps keys | `heddle session new` |
| 8 | `service` | `title_from` (48 UTF-16 units, word cut, punctuation); `fork_title` (ASCII and full-width suffix, taken names); `open_at` one folder one session, `fresh`; `fork` → `Unavailable` without an answer; `set_mode` no-op appends nothing | the CLI and the server |
| 9 | interop | a log written by the TypeScript build (fixture bytes) reads here; a log written here decodes with `src/session/transcript.ts` on the host | `70-workspaces-sessions` through `HEDDLE_BIN` |
