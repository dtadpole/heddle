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
| `SessionStore` | the store: `create`, `open`, `open_newest`, `list`, `append`, `read`, `count`, `surface`, `derive_messages`, `message`, `assistant_chunk`, `model_request`, `fork`, `rename`, `flags`, `set_model`, `touch`, `last_answer`, `bytes`, `framed`. `Send + Sync`, `&self` everywhere; share as `Arc` |
| `SessionService` | the face the loop, CLI and server call: `start`, `open_at` (one folder, one session; `fresh` for `--new`), `current`, `create_at` (session + definition), `fork` → `ForkOutcome`, `user`/`user_content` (titles from the first message), `folder`, `recorded_mode`/`effective_mode`/`set_mode`, and pass-throughs |
| `SessionConfig`, `EventListener` | the config row `{ root }`; the listener the boot wires to the `session/event` hook. `SessionStore::new(root, &Env)` and `SessionService::new(&config, &Env, listener)` take the environment, as every reader of `HEDDLE_HOME` does |
| `SessionEvent`, `NewEvent`, `Events`, `SessionHandle`, `SurfaceOp`, `AppendOptions` | an event (`seq`, `at`, `kind`, ordered `fields`); what a caller appends (`NewEvent::new("x").field(k, v)` or `json!` via `TryFrom`); a snapshot `Arc<Vec<Arc<SessionEvent>>>`; the four paths of a session; `append` / `replace {start_seq, end_seq}` |
| `SessionMeta` + `CreateOptions`, `ForkAttribution`, `ModelSelection`, `FlagPatch`, `SessionOrigin` | the meta record as its ordered JSON with getters, and what creates or edits it |
| `fold_surface`, `derive_message`, `derive_node_message`, `index_by_seq`, `completed_prefix`, `inherits_answer`, `SurfaceState` | the surface, generic over `Borrow<SessionEvent>` |
| `recorded_mode`, `effective_mode`, `inherit_recorded_mode`, `MODE_EVENT` | the `permission/mode` fold, generic over `M: FromStr + AsRef<str>` — the vocabulary is `heddle-sandbox`'s `SandboxMode` |
| `write_session_definition`, `read_session_definition`, `update_session_definition`, `existing_session_names`, `ensure_sessions_folder`, `session_name` | `<branch>/_sessions_/<session-yyyymmdd-hhmm>/{session.json, INDEX.md}` |
| `decode_transcript`, `encode_frame`, `split_frames`, `frame_end`, `looks_compressed` | the frame walk |
| `workspace_key`, `log_name`, `meta_name`, `transcript_in`, `default_session_root(&Env)` | where a log is filed |
| `title_from`, `fork_title` | a session's label from its first message; `<title> (n)` |
| `SessionError`, `SessionFlagError` | failures, with the TypeScript build's messages word for word |
| `Message`, `ContentPart`, `Chunk`, `Role`, `RecordedMessage`, `text_of` | **stand-ins** for `heddle-llm`'s types, with the serde shape the log needs; replaced by `pub use heddle_llm::…` when that crate declares them |

### Decisions a dependent crate should know

1. **No dependency on `heddle-events`.** The store takes an `EventListener` closure; the boot passes one
   that emits `session/event { session, event }`. A transient `tool-call-delta` reaches the listener and
   never the log.
2. **No dependency on `heddle-sandbox`.** The mode fold is generic; `SandboxMode` needs `FromStr` (refusing
   any other word) and `AsRef<str>`.
3. **Message types move to `heddle-llm`.** Until then they live in `message.rs`. The shape they must keep:
   tagged by `"type"` first, kebab-case variants, camelCase fields, `Message` ordered `role`, `toolCallId?`,
   `content`, absent options omitted.
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

**Done** when `70-workspaces-sessions` and `80-web-ui check-workspaces` pass through `HEDDLE_BIN` with the
CLI (`heddle`) and server (`heddle-server`) crates composing this one, and the backend lane's integrator has merged it.

## Read next

[`src/INDEX.md`](src/INDEX.md) for the files; [`../heddle-workspace/`](../heddle-workspace/INDEX.md) for the
tree; [`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md)
for the parts.
