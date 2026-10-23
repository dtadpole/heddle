//! `heddle-web-files` — attachments, uploads, the picker, file previews, markdown, highlighting and sanitizing.
//!
//! Ported from the TypeScript build: `src/server/attachments.ts`, `src/server/uploads.ts`, `src/server/picker.ts`,
//! `src/server/code.ts`, `src/server/docs.ts`, `src/server/markdown.ts`, `src/server/highlight.ts`,
//! `src/server/sanitize.ts`, and the file routes of `src/server/web.ts` (`/api/file`, `/api/raw`, `/api/uploads`,
//! `/api/uploads/{leaf}`, `/api/markdown`, `/api/workspaces/pick`, and — proposed, see [`html_preview`] — `/api/html`).
//! Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/88-file-preview` and `_verifiers_/80-web-ui`
//! (check-file-view).
//!
//! # Layers
//!
//! The crate is four layers, and each depends only on the ones above it:
//!
//! 1. **Pure renderers** — [`sanitize`], [`highlight`], [`markdown`], [`code`], [`html_preview`]: text in, markup out,
//!    no I/O, no global state. The one rule they share is that **this crate writes every tag**: a file's bytes are
//!    somebody else's, so they are escaped or reduced to an allow-list, never interpolated.
//! 2. **Stores** — [`uploads`], [`attachments`], [`docs`]: the filesystem, always rooted at a directory the caller
//!    passes, so a test never touches the operator's home and a request can never choose where a path lands.
//! 3. **The platform** — [`picker`]: the native folder dialog, behind an injectable command runner.
//! 4. **Routes** — [`routes`]: the HTTP surface the File panel, the composer and the workspace column call, as an
//!    `axum::Router` the server mounts **behind its token layer**, over the [`host::FilesHost`] seam.
//!
//! # Status
//!
//! The contract: every public item is declared and documented. The wire shapes (serde derives) and constants are
//! real and tested; function bodies are `todo!()` until each is ported, in the order the crate's `INDEX.md` gives.
// Contract phase: bodies are `todo!()`, so their parameters and the private tables they will read are unused yet.
// Removed module by module as the bodies land.
#![allow(unused_variables, dead_code)]

pub mod attachments;
pub mod code;
pub mod docs;
pub mod highlight;
pub mod host;
pub mod html_preview;
pub mod markdown;
pub mod picker;
pub mod routes;
pub mod sanitize;
pub mod uploads;

mod node_path;
