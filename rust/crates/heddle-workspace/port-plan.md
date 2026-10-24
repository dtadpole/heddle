---
title: The heddle-workspace port plan
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T08:24:41Z
level: L1
version: 1.0.0
description: The five steps of the port, the unit tests each one carries, and what each step unblocks.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/workspace/service.ts and src/session/tree.ts, the TypeScript sources it ports
  - source: _verifiers_/70-workspaces-sessions/check.mjs and _verifiers_/80-web-ui/check-workspaces.mjs, the checks that judge it
---

# Port plan


Each step lands with its unit tests (`cargo test --manifest-path rust/Cargo.toml -p heddle-workspace`).

| Step | Module | Unit tests that can fail | Unblocks |
|---|---|---|---|
| 1 | `record`, `service` read/write | a version-1 file loses `sessionIds`; missing origin is `added`; written bytes equal a `JSON.stringify(_, null, 2)` fixture; new record prepended | `heddle workspaces` |
| 2 | `service` association | nearest root owns; `/a/b-sibling` not a member; `sessions` minus nearer roots; `ensure` promotes `auto` → `added`; `remove`'s three outcomes and its sentence; `bootstrap` idempotent | `workspace add/remove/rename`, `/api/workspaces` |
| 3 | `collate`, `badge_for`, `classify` | `TLS`, `VRF`, `MNT`, `FRM`, `CTX`, `CNV`, `CNS`, `WEB`; numeric and case-blind order; `_x_` before letters | 4 |
| 4 | `tree`, `kind_of` | the `70-workspaces-sessions` fixture as a unit test: levels, folders before files, dot/plumbing hidden, generated, instance-only sessions, `_sessions_` hoisted newest/pinned first, captured-session suppression, archived filter, `adHoc`; JSON key order | `heddle tree`, `/api/tree` |
| 5 | `file` | small file whole; truncated at the limit; NUL refused; invalid UTF-8 refused; directory refused; `lines` with and without a trailing newline | `heddle file`, file preview |
