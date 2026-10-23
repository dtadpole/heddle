---
title: The heddle-web-files crate
version: 0.1.0
description: The Rust port crate for attachments, uploads, the picker, file previews, markdown, highlighting and sanitizing.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates/heddle-web-files`

The Rust port of attachments, uploads, the picker, file previews, markdown, highlighting and sanitizing.

| | |
|---|---|
| Ported from | `src/server/attachments.ts`, `src/server/uploads.ts`, `src/server/picker.ts`, `src/server/code.ts`, `src/server/docs.ts`, `src/server/markdown.ts`, `src/server/highlight.ts`, `src/server/sanitize.ts` |
| Judged by | `_verifiers_/88-file-preview`, `_verifiers_/80-web-ui` (check-file-view), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |

Its public API lands first, so the crates that depend on it can build against it while it is implemented.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
