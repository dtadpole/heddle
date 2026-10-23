//! `heddle-web-files` — attachments, uploads, the picker, file previews, markdown, highlighting and sanitizing.
//!
//! Ported from the TypeScript build: `src/server/attachments.ts`, `src/server/uploads.ts`, `src/server/picker.ts`, `src/server/code.ts`, `src/server/docs.ts`, `src/server/markdown.ts`, `src/server/highlight.ts`, `src/server/sanitize.ts`.
//! Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/88-file-preview`, `_verifiers_/80-web-ui` (check-file-view).
//! Nothing is ported yet; the public API lands here first so dependent crates can build against it.
