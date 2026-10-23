---
title: The heddle-session public API
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T08:24:41Z
level: L1
version: 1.0.0
description: Every item the crate re-exports at its root, and what each one is for.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/session/, the TypeScript sources it ports
  - source: _verifiers_/70-workspaces-sessions/check.mjs, the checks that judge it
---

# Public API


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
| `command::{run, Command, Args, Context, refuse, write_pretty}` | `heddle sessions` and `heddle transcript`, answered here (D-043); `session new` is in `heddle_workspace::command` |
| `Message`, `ContentPart`, `Chunk`, `Role`, `RecordedMessage`, `text_of` | `heddle-llm`'s types, re-exported: `RecordedMessage` is `Message` itself (its `source` names who wrote it), so a caller crossing between the crates needs no conversion; `text_of` stays here until `heddle-llm` re-exports it |
