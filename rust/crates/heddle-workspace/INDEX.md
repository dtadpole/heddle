---
title: The heddle-workspace crate
version: 0.2.0
description: The Rust port crate for workspaces, the folders they name, and the classified recursive tree — its public API and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/workspace/service.ts and src/session/tree.ts, the TypeScript sources it ports
  - source: _verifiers_/70-workspaces-sessions/check.mjs and _verifiers_/80-web-ui/check-workspaces.mjs, the checks that judge it
---

# `rust/crates/heddle-workspace`

The Rust port of workspaces — a target folder plus the record that says it is one — the containment rule
that groups sessions under the nearest root, and the folder tree the left column and `heddle tree` show.

| | |
|---|---|
| Ported from | `src/workspace/service.ts`; `src/session/tree.ts` (`tree`, `kindOf`, `classify`, `badgeFor`, `readFileText`) |
| Depends on | [`heddle-session`](../heddle-session/INDEX.md) for `SessionMeta` and the definitions; [`heddle-config`](../heddle-config/INDEX.md) for the path rules and `Env` |
| Judged by | `_verifiers_/70-workspaces-sessions`, `_verifiers_/80-web-ui` (`check-workspaces`), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

## Public API

Everything is re-exported at the crate root.

| Item | What it is |
|---|---|
| `WorkspaceService` | `read`, `list`, `ensure`, `add` → `WorkspaceAddition`, `remove` → `WorkspaceRemoval`, `find`, `rename`, `owner`, `owner_among`, `sessions`, `ensure_owner`, `bootstrap` → `BootstrapReport`. Reads the file on every call; one lock serializes this process's writes |
| `WorkspaceConfig`, `default_workspace_file(&Env)` | the config row `{ file, generated }`; `$HEDDLE_HOME/workspaces.json`. `WorkspaceService::new(&config, &Env)` |
| `WorkspaceRecord`, `WorkspaceOrigin`, `WorkspaceStoreShape` | `{ id, path, title, origin, createdAt, updatedAt }`; `added` / `auto`; the version-3 file |
| `listing_row` | one row of `heddle workspaces --json`: `{ ...record, sessions: [ids] }` |
| `tree`, `kind_of`, `classify`, `badge_for` + `TreeInput`, `TreeRoot`, `TreeNode`, `TreeSession`, `NodeKind`, `ArchivedFilter` | the tree, one level at a time, serialized in the TypeScript key order |
| `read_file_text`, `FileReading`, `FileReadError`, `FILE_LIMIT_BYTES` | the right panel's file reader and its three refusals |
| `compare_names` | the tree's name order (`Intl.Collator`, numeric, base sensitivity) |
| `WorkspaceError` | failures; `StillHoldsSessions` carries the `still holds N session(s)` sentence the `409` returns |

### Decisions a dependent crate should know

1. **The tree is here, not in `heddle-session`.** It is a view of the roots; the CLI's `tree` and `file`
   commands and the server's `/api/tree` and file routes call this crate.
2. **The refusal of a path outside every root is the caller's**: check `owner(path).is_none()` first and
   answer `... is not under any workspace root; register it with 'heddle workspace add <path>'` (CLI) or
   `400` (HTTP), as the TypeScript build does.
3. **`bootstrap` is the caller's to run** after constructing the service, with `SessionService::list()`.
4. **HTTP-only rules stay in the server**: a path must be absolute and exist, a name must be a slug.

## Port plan

Each step lands with its unit tests (`cargo test --manifest-path rust/Cargo.toml -p heddle-workspace`).

| Step | Module | Unit tests that can fail | Unblocks |
|---|---|---|---|
| 1 | `record`, `service` read/write | a version-1 file loses `sessionIds`; missing origin is `added`; written bytes equal a `JSON.stringify(_, null, 2)` fixture; new record prepended | `heddle workspaces` |
| 2 | `service` association | nearest root owns; `/a/b-sibling` not a member; `sessions` minus nearer roots; `ensure` promotes `auto` → `added`; `remove`'s three outcomes and its sentence; `bootstrap` idempotent | `workspace add/remove/rename`, `/api/workspaces` |
| 3 | `collate`, `badge_for`, `classify` | `TLS`, `VRF`, `MNT`, `FRM`, `CTX`, `CNV`, `CNS`, `WEB`; numeric and case-blind order; `_x_` before letters | 4 |
| 4 | `tree`, `kind_of` | the `70-workspaces-sessions` fixture as a unit test: levels, folders before files, dot/plumbing hidden, generated, instance-only sessions, `_sessions_` hoisted newest/pinned first, captured-session suppression, archived filter, `adHoc`; JSON key order | `heddle tree`, `/api/tree` |
| 5 | `file` | small file whole; truncated at the limit; NUL refused; invalid UTF-8 refused; directory refused; `lines` with and without a trailing newline | `heddle file`, file preview |

## Where it stands, 2026-10-22

Steps 1–5 are ported, each with the unit tests the table names: **36 unit tests pass**, plus **4
cross-crate tests** in [`tests/verifier_shape.rs`](tests/verifier_shape.rs) that hold
`70-workspaces-sessions`'s claims at the seam the command line will call — one folder one session and
`--new`, containment and the nearest root, the sibling-prefix trap, hoisted sessions and the
instance-only rule, and the file reader's refusals. That is **40 tests** for this crate alongside
`heddle-session`'s 120, and `rustfmt` and `clippy -D warnings` are clean. The tree's fixture is the verifier's own shape: type and
instance classification, badges, folders before files, plumbing and generated folders, the boundary that
only an instance carries a session, hoisted `_sessions_` rows (pinned first, then updated), the
captured-session suppression, the archived filter and the virtual root's `adHoc` group. What is not
judged yet is the command line and the page that call it.

**Done** with `heddle-session`: when `70-workspaces-sessions` and `80-web-ui check-workspaces` pass through
`HEDDLE_BIN` and the backend lane's integrator has merged the branch.

## Read next

[`src/INDEX.md`](src/INDEX.md) for the files; [`../heddle-session/`](../heddle-session/INDEX.md) for the log;
[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the
parts.
