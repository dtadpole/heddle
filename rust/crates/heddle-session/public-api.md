---
title: The heddle-session public API
created: 2026-10-23T00:55:27Z
modified: 2026-10-31T08:22:31Z
level: L1
version: 1.3.0
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
| `fold_surface`, `derive_message`, `derive_node_message`, `index_by_seq`, `completed_prefix`, `inherits_answer`, `fork_seed`, `inherited_by_fork`, `SurfaceState` | the surface, generic over `Borrow<SessionEvent>`; a fork's seed is the source's completed log (#52, #55) |
| `recorded_mode`, `effective_mode`, `inherit_recorded_mode`, `MODE_EVENT` | the `permission/mode` fold, generic over `M: Serialize + DeserializeOwned` — the vocabulary is `heddle-sandbox`'s `SandboxMode`, which fits as declared |
| `write_session_definition`, `read_session_definition`, `update_session_definition`, `existing_session_names`, `ensure_sessions_folder`, `session_name` | `<branch>/_sessions_/<session-yyyymmdd-hhmm>/{session.json, INDEX.md}` |
| `decode_transcript`, `encode_frame`, `split_frames`, `frame_end`, `looks_compressed` | the frame walk |
| `write_atomic` | a whole-file write a concurrent reader never sees half-done (sibling temporary file, then rename); every meta, definition and workspace-record write goes through it |
| `workspace_key`, `log_name`, `meta_name`, `transcript_in`, `default_session_root(&Env)` | where a log is filed |
| `title_from`, `fork_title` | a session's label from its first message; `<title> (n)` |
| `SessionTitles`, `TitleModel`, `LlmTitles`, `TitleAnswer`, `TitleDone`, `TitleSpawn`, `TitleTask`, `SESSION_TITLE_PURPOSE`, `normalize_session_title`, `title_from_answer` | the automatic first-prompt title (`src/session/title.ts`; DSH's `dsh-session-title` with its first-prompt model provider): `SessionService::attach_titles(model)` arms the store's shared coordinator (`SessionStore::titles()`), the first prompt's `model/request` starts one `session-title` call on that request's route, the answer replaces the `title_from` fallback through `rename`, and `SessionService::rename` supersedes it |
| `open_turn_closers`, `interrupted_turn_closers`, `CloserCause`, `INTERRUPTED_RESULT` | the closers of a turn its writer never finished (`src/session/repair.ts`; DSH's `openTurnClosers`): an `error (INTERRUPTED)` result per open call, `assistant/completed`, `turn/completed` with `reason.kind`. `SessionStore::claim` appends them at a fresh write-open; `SessionService::events` adds them, unwritten, while `SessionStore::writer_held` is false (issue #5) |
| `SessionError`, `SessionFlagError` | failures, with the TypeScript build's messages word for word |
| `title_text::{clean_session_title, clean_title_text, truncate_title_utf8, MAX_TITLE_BYTES, TITLE_INVALID_CODE, TITLE_INVALID_MESSAGE}` | DSH's `normalizeSessionTitle` at its shipped 80-byte cap (`src/session/title-text.ts`): `rename`, `create` and the definition writers clean every title with it, and the server's title route answers `400 session/title-invalid` when nothing visible is left. Reached by its module path, not re-exported at the root |
| `command::{run, Command, Args, Context, refuse, write_pretty}` | `heddle sessions` and `heddle transcript`, answered here (D-043); `session new` is in `heddle_workspace::command` |
| `Message`, `ContentPart`, `Chunk`, `Role`, `RecordedMessage`, `text_of` | `heddle-llm`'s types, re-exported: `RecordedMessage` is `Message` itself (its `source` names who wrote it), so a caller crossing between the crates needs no conversion; `text_of` stays here until `heddle-llm` re-exports it |
