---
title: The heddle-workspace public API
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T08:24:41Z
level: L1
version: 1.0.0
description: Every item the crate re-exports at its root, and the decisions a dependent crate should know.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/workspace/service.ts and src/session/tree.ts, the TypeScript sources it ports
  - source: _verifiers_/70-workspaces-sessions/check.mjs and _verifiers_/80-web-ui/check-workspaces.mjs, the checks that judge it
---

# Public API


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
| `command::{run, Command, Args, Context, describe_tree}` | `heddle workspaces`, `workspace add\|list\|remove\|rename`, `tree`, `file` and `session new`, answered here (D-043) |

## Decisions a dependent crate should know

1. **The tree is here, not in `heddle-session`.** It is a view of the roots; the CLI's `tree` and `file`
   commands and the server's `/api/tree` and file routes call this crate.
2. **The refusal of a path outside every root is the caller's**: check `owner(path).is_none()` first and
   answer `... is not under any workspace root; register it with 'heddle workspace add <path>'` (CLI) or
   `400` (HTTP), as the TypeScript build does.
3. **`bootstrap` is the caller's to run** after constructing the service, with `SessionService::list()`.
4. **HTTP-only rules stay in the server**: a path must be absolute and exist, a name must be a slug.
