---
title: The heddle-session crate
version: 0.2.0
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

## The contract: a log either build wrote, the other reads

- **Layout.** New: `<root>/<workspace-key>/<id>.v2.jsonl.zstd` and `<id>.json`. Old, read and appended to
  but never created: `<root>/<id>/{session.v2.jsonl.zstd | session.jsonl, meta.json}`.
- **Transcript.** One zstd frame per event with a content checksum; a torn tail is cut back to the last
  whole frame on open and recorded as `transcript/repaired { droppedBytes }`. Plain JSONL stays plain.
- **Event bytes.** `{"seq":…,"at":…,"type":…,…}` as `JSON.stringify` writes it; `at` is `toISOString`
  (`2026-10-22T18:17:41.123Z`). JSON objects keep insertion order (`serde_json/preserve_order`).
- **Meta and definition bytes.** `JSON.stringify(v, null, 2)` + `\n`; an edit keeps every untouched key
  where it was and appends a new one, as the TypeScript spread does.
- **Directory order.** Entries are visited in byte order, which is what Node's `readdirSync` returns.

## Public API

Everything is re-exported at the crate root.

| Item | What it is |
|---|---|
| `SessionStore` | the store: `create`, `open`, `open_newest`, `meta`, `list`, `append`, `read`, `count`, `surface`, `derive_messages`, `message`, `assistant_chunk`, `model_request`, `fork`, `rename`, `flags`, `set_model`, `touch`, `last_answer`, `bytes`, `framed`. `Send + Sync`, `&self` everywhere; share as `Arc` |
| `SessionService` | the face the loop, CLI and server call: `start`, `open`/`meta`/`exists`, `open_at` (one folder, one session; `fresh` for `--new`), `current`, `create_at` (session + definition), `fork` → `ForkOutcome`, `user`/`user_content` (titles from the first message), `folder`, `recorded_mode`/`effective_mode`/`set_mode`, and pass-throughs |
| `SessionConfig`, `EventListener` | the config row `{ root }`; the listener the boot wires to the `session/event` hook. `SessionStore::new(root, &Env)` and `SessionService::new(&config, &Env, listener)` take the environment, as every reader of `HEDDLE_HOME` does |
| `SessionEvent`, `NewEvent`, `Events`, `SessionHandle`, `SurfaceOp`, `AppendOptions` | an event (`seq`, `at`, `kind`, ordered `fields`); what a caller appends (`NewEvent::new("x").field(k, v)` or `json!` via `TryFrom`); a snapshot `Arc<Vec<Arc<SessionEvent>>>`; the four paths of a session; `append` / `replace {start_seq, end_seq}` |
| `SessionMeta` + `CreateOptions`, `ForkAttribution`, `ModelSelection`, `FlagPatch`, `SessionOrigin` | the meta record as its ordered JSON with getters, and what creates or edits it |
| `fold_surface`, `derive_message`, `derive_node_message`, `index_by_seq`, `completed_prefix`, `inherits_answer`, `SurfaceState` | the surface, generic over `Borrow<SessionEvent>` |
| `recorded_mode`, `effective_mode`, `inherit_recorded_mode`, `MODE_EVENT` | the `permission/mode` fold, generic over `M: Serialize + DeserializeOwned` — the vocabulary is `heddle-sandbox`'s `SandboxMode`, which fits as declared |
| `write_session_definition`, `read_session_definition`, `update_session_definition`, `existing_session_names`, `ensure_sessions_folder`, `session_name` | `<branch>/_sessions_/<session-yyyymmdd-hhmm>/{session.json, INDEX.md}` |
| `decode_transcript`, `encode_frame`, `split_frames`, `frame_end`, `looks_compressed` | the frame walk |
| `workspace_key`, `log_name`, `meta_name`, `transcript_in`, `default_session_root(&Env)` | where a log is filed |
| `title_from`, `fork_title` | a session's label from its first message; `<title> (n)` |
| `SessionError`, `SessionFlagError` | failures, with the TypeScript build's messages word for word |
| `Message`, `ContentPart`, `Chunk`, `Role`, `RecordedMessage`, `text_of` | `heddle-llm`'s types, re-exported: `RecordedMessage` is `Message` itself (its `source` names who wrote it), so a caller crossing between the crates needs no conversion; `text_of` stays here until `heddle-llm` re-exports it |

### Decisions a dependent crate should know

1. **No dependency on `heddle-events`.** The store takes an `EventListener` closure; the boot passes one
   that emits `session/event { session, event }`. A transient `tool-call-delta` reaches the listener and
   never the log.
2. **No dependency on `heddle-sandbox`.** The mode fold is generic and reads and writes the event's `mode`
   through serde, so `SandboxMode` (kebab-case `Serialize + Deserialize`) is used as it is.
3. **Message types are `heddle-llm`'s.** `message.rs` re-exports `Message`, `ContentPart`, `Chunk`, `Role`, `ImagePart`, `FilePart`, `ImageMediaType`, `TokenUsage` and `ToolCall`, so the log and the wire share one declaration and a dependent crate converts nothing. `RecordedMessage` is `Message` (the `source` field is inline, as `src/llm/types.ts` has it). The shape the log still depends on:
   tagged by `"type"` first, kebab-case variants, camelCase fields, `Message` ordered `role`, `toolCallId?`,
   `content`, then `source` when the harness wrote it, absent options omitted.
4. **`read` returns a snapshot, not a borrow** — appending while holding one is fine.
5. **Fallible reads.** A transcript line that does not parse fails the load (`SessionError::InvalidLine`),
   so `read`, `count`, `surface` and `append` return `Result`.

## Port plan

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

## Where it stands, 2026-10-22

Steps 1–8 are ported, each with the unit tests the table names: **124 unit tests pass** with
`cargo test --manifest-path rust/Cargo.toml -p heddle-session`, and `rustfmt` and
`clippy -D warnings` are clean on both crates. Step 9 is green in both directions:

- **Their bytes read here.** `store.rs` opens a session whose transcript frames were produced by **Node
  24's `zlib.zstdCompressSync`** with a content checksum, derives its surface, appends to it without
  touching the earlier bytes, and prints every line back unchanged.
- **Our bytes read there.** [`tests/typescript_interop.rs`](tests/typescript_interop.rs) runs the
  TypeScript build's own `decodeTranscript` — `src/session/transcript.ts`, imported by the Node on this
  machine with its types stripped — over a transcript this crate just wrote, and asserts it sees the same
  three events, no tear, and the whole file consumed. It reports skipped rather than failing where Node
  is absent, so a host without the oracle still runs the suite.
- **The bytes are the oracle's bytes.** [`tests/typescript_bytes.rs`](tests/typescript_bytes.rs) asks the
  same Node to `JSON.stringify` the values the store writes — event lines, pretty meta records, and
  `new Date(ms).toISOString()` for six instants — and compares byte for byte, so an escaping or
  number-formatting drift is caught rather than copied into a fixture. A deterministic batch of forty
  generated texts adds the code points two writers most often disagree about: the line separators, C1
  controls, a byte-order mark, combining marks, Hebrew, CJK and astral ranges.

What remains for `70-workspaces-sessions` is the `heddle` binary composing this crate, which is another
seat's scope: it is honestly unjudged (exit 3) until then.

**Pre-triage, 2026-10-22.** A throwaway probe outside the repository (not committed, not this crate)
implements only `--help`, `workspace add/remove/rename`, `workspaces --json`, `sessions --json`,
`tree --json`, `file --json` and `session new` by calling this crate and `heddle-workspace`. Run as
`HEDDLE_BIN`, **11 of the verifier's 22 checks pass** — every check that needs neither the agent loop nor
the server/page: the tree's levels, classification and badges, the generated folder, the file reader and
its refusals, `session new` with its definition, hoisted `_sessions_` rows, and the outside-root refusal.
The other 11 need `--turn` (9), the server's workspace/tree routes (2) or the page, so they are not this
crate's to judge. The row stays unjudged until the real binary runs.

**Done** when `70-workspaces-sessions` and `80-web-ui check-workspaces` pass through `HEDDLE_BIN` with the
CLI (`heddle`) and server (`heddle-server`) crates composing this one, and the backend lane's integrator has merged it.

## Read next

[`src/INDEX.md`](src/INDEX.md) for the files; [`../heddle-workspace/`](../heddle-workspace/INDEX.md) for the
tree; [`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md)
for the parts.
