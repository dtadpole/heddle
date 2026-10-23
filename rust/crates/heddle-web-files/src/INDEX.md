---
title: The heddle-web-files sources
version: 0.2.0
description: The sources of the heddle-web-files crate, one module per TypeScript source, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: rust/crates/heddle-web-files/INDEX.md, the crate's contract and port plan
---

# `rust/crates/heddle-web-files/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code. One module per TypeScript
source; the order below is the crate's layering, each module depending only on those above it.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root: the layers, and the contract-phase lint allowance removed as bodies land |
| [`node_path.rs`](node_path.rs) | Node's POSIX `extname` and `basename`, exactly (crate-private) |
| [`sanitize.rs`](sanitize.rs) | the allow-list over rendered HTML (`sanitize.ts`) |
| [`highlight.rs`](highlight.rs) | the one highlighter, in `highlight.js`'s class vocabulary (`highlight.ts`) |
| [`markdown.rs`](markdown.rs) | GFM markdown, link and image rules, frontmatter (`markdown.ts`) |
| [`code.rs`](code.rs) | the renderer decision and the gutter code renderer (`code.ts`) |
| [`uploads.rs`](uploads.rs) | the upload store under `$HEDDLE_HOME/uploads` (`uploads.ts`) |
| [`attachments.rs`](attachments.rs) | attachment references into content parts, and transcript cards (`attachments.ts`) |
| [`picker.rs`](picker.rs) | the platform folder dialog behind an injectable runner (`picker.ts`) |
| [`docs.rs`](docs.rs) | the bounded markdown document store (`docs.ts`, no caller) |
| [`host.rs`](host.rs) | the `FilesHost` seam the routes read the harness through |
| [`routes.rs`](routes.rs) | the file routes of `web.ts` as one `axum::Router`, with every status tabled |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, its public API, and the order it is ported in.
