---
title: The heddle-web-files crate
version: 0.2.0
description: The Rust port crate for attachments, uploads, the picker, file previews, markdown, highlighting and sanitizing — its public contract, its seams, and the order it is ported in.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/server/attachments.ts, uploads.ts, picker.ts, code.ts, docs.ts, markdown.ts, highlight.ts, sanitize.ts, html.ts, and the file routes of web.ts, read 2026-10-22
  - source: _verifiers_/88-file-preview/check.mjs and _verifiers_/80-web-ui/check-file-view.mjs, read 2026-10-22
---

# `rust/crates/heddle-web-files`

The Rust port of attachments, uploads, the picker, file previews, markdown, highlighting and sanitizing, and of the
HTTP routes the File panel, the composer's `+ → File` and the workspace column's folder picker call.

| | |
|---|---|
| Ported from | `src/server/attachments.ts`, `src/server/uploads.ts`, `src/server/picker.ts`, `src/server/code.ts`, `src/server/docs.ts`, `src/server/markdown.ts`, `src/server/highlight.ts`, `src/server/sanitize.ts`; the file routes of `src/server/web.ts`; **proposed**: `src/server/html.ts` (see "Open questions") |
| Judged by | `_verifiers_/88-file-preview`, `_verifiers_/80-web-ui` (check-file-view), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |
| Unit tests | `cargo test --manifest-path rust/Cargo.toml -p heddle-web-files` |

## Status

**Contract landed** (2026-10-22): every public item is declared and documented in [`src/`](src/INDEX.md). The wire
shapes (serde derives), constants, tables, the renderer decision, `escape_html`, `safe_url`, `supports_language` and
the inline content-type table are real and tested (28 tests); every other body is `todo!()` until its step below.

## The public API

Paths are `crate::module::item`. Every item that crosses the HTTP or session-log boundary serializes to the exact
JSON the TypeScript build writes; the tests assert the strings.

| Module | Ported from | Public items |
|---|---|---|
| [`sanitize`](src/sanitize.rs) | `sanitize.ts` | `sanitize_html(html, SanitizeOptions) -> String`, `SanitizeOptions { url: Option<UrlPolicy> }`, `UrlSite { tag, attribute }`, `UrlPolicy` |
| [`highlight`](src/highlight.rs) | `highlight.ts` | `highlight_code(code, Option<&str>) -> String` (inner HTML, `hljs-*` classes), `supports_language(&str) -> bool` |
| [`markdown`](src/markdown.rs) | `markdown.ts` | `render_markdown(source, MarkdownOptions { base }) -> String`, `render_inline(text) -> String`, `escape_html`, `safe_url`, `LINK_DATA_ATTRIBUTE` |
| [`code`](src/code.rs) | `code.ts` | `renderer_for(&Path) -> RendererDecision`, `language_for`, `render_code(source, language, CodeOptions { gutter }) -> String`, `render_source(&Path, text) -> Rendered`, `RendererName`, `Rendered` |
| [`html_preview`](src/html_preview.rs) | `html.ts` (proposed) | `rewrite_resources(html, base, serve) -> String`, `PREVIEW_CSP`, `ALLOWED_TAGS`, `ALLOWED_ATTRS`, `ALLOWED_URI`, `MAX_HTML_PREVIEW_BYTES` |
| [`uploads`](src/uploads.rs) | `uploads.ts` | `save_upload(home, name, data, now) -> io::Result<SavedUpload>`, `safe_upload_name`, `upload_stamp`, `upload_directory`, `MAX_UPLOAD_BYTES`, `SavedUpload` |
| [`attachments`](src/attachments.rs) | `attachments.ts`; `attachmentsOf` of `web.ts` | `read_attachments(upload_dir, Option<&Value>) -> Result<Vec<AttachmentPart>, AttachmentInputError>`, `read_attachment`, `display_name_for_stored`, `attachments_of(&[Value]) -> Vec<TurnAttachment>`, `AttachmentPart`, `ImageMediaType`, `TurnAttachment`, `MAX_ATTACHMENTS` |
| [`picker`](src/picker.rs) | `picker.ts` | `pick_folder(&Platform, &dyn CommandRunner) -> PickerOutcome`, `PickerOutcome`, `CommandRunner`, `CommandResult`, `SystemRunner`, `Platform`, `PICK_TIMEOUT` |
| [`docs`](src/docs.rs) | `docs.ts` | `find_docs`, `read_doc`, `is_inside`, `DocEntry`, `DocError`, `FindDocsOptions`, `MAX_DOC_BYTES` |
| [`host`](src/host.rs) | the seam | `trait FilesHost { heddle_home, workspace_owner, read_file_text }`, `WorkspaceAnswer`, `FileReading`, `FileReadError` |
| [`routes`](src/routes.rs) | the file routes of `web.ts` | `FilesRoutes::new(Arc<dyn FilesHost>).with_picker(..).router() -> axum::Router`, `ROUTES` |

### The routes

`FilesRoutes::router()` answers `GET /api/file`, `GET /api/raw`, `GET /api/uploads/{leaf}`, `POST /api/uploads`,
`POST /api/markdown`, `POST /api/workspaces/pick` and (proposed) `GET /api/html`. Each status, body and header is
tabled in [`src/routes.rs`](src/routes.rs). The router does no authentication and has no fallback: the server merges
it and puts its token layer over the result, exactly as every one of these routes sits after the token decision in
`web.ts`.

### Who calls what

| Caller | Uses |
|---|---|
| `heddle-server` | mounts `FilesRoutes::router()` behind the token layer and implements `FilesHost`; `render_markdown(text, MarkdownOptions::default())` for each settled assistant row of `GET /api/sessions/{id}`; `read_attachments` for `POST /api/turn` and `…/steer` (`AttachmentInputError` → `400`); `attachments_of` for the transcript cards |
| `heddle-web-trajectory` | `render_code(json, "json", CodeOptions { gutter: false })` and `escape_html` for the tool inspector |
| the `FilesHost` implementation | `heddle_home` from `heddle-config`; `workspace_owner` from `heddle-workspace`'s `owner(path)`; `read_file_text` from the session tree's `readFileText` |

## Library decisions

The TypeScript build renders with `marked`, `marked-highlight` and `highlight.js`. The instruction recorded in
`markdown.ts` — render each type with a library, not with code written here — carries over as "a Rust library", not
as "a JavaScript engine running the old libraries", which would make the binary a host for the TypeScript build
rather than a port of it.

- **Markdown: `comrak`** (`default-features = false`) — a port of `cmark-gfm`, so tables, task lists,
  strikethrough and autolinks behave as GitHub renders them. Raw HTML passes through (`render.unsafe_`), as with
  `marked`, and is reduced by `sanitize_html`. Links and images are rewritten on the AST before rendering, which is
  where `marked`'s renderer hooks did it; fences go through a syntax-highlighter adapter that calls `highlight`.
  Rejected: `pulldown-cmark`, which has no GFM extended autolinks.
- **Highlighting: `syntect` with `two-face`'s syntax set** (bat's; it adds TypeScript, TOML and INI to Sublime's
  defaults). Its TextMate scopes are mapped onto `highlight.js`'s class vocabulary in one table (`keyword.*` and
  `storage.type.*` → `hljs-keyword`, `comment.*` → `hljs-comment`, `string.*` → `hljs-string`, `constant.numeric.*`
  → `hljs-number`, the JSON key scope → `hljs-attr`, …), the innermost mapped scope winning, punctuation inside a
  comment or string inheriting its parent's class. That table is what `page.html`'s theme and the verifiers need:
  the 29 `hljs-*` classes the page styles, `hljs-keyword">def<` for Python, `hljs-comment">// a tiny script<` in one
  span for JavaScript, and more than one class (so more than one colour) in `package.json`. Regex engine: `fancy-regex`
  (pure Rust) unless step 2 measures it too slow on a 256 KiB file, then Oniguruma.
- **Not kept**: `highlight.js`'s exact span boundaries. No verifier judges them; the page colours by class.

## Port plan

Each step lands with its unit tests (ported from the TypeScript suite named) and is pushed on its own.

| # | Step | Tests ported from | Done when |
|---|---|---|---|
| 1 | `sanitize_html` | `test/sanitize.test.ts` | the allow-list, numeric attributes, drop-with-content, comments, stray `<`, unterminated tags, URL policy sites |
| 2 | `highlight` over syntect: the scope table, `highlight_pieces`, `highlight_code` | `test/highlight.test.ts` | every registered language and alias; the three verifier strings above; exact text (strip spans + decode = input) for every grammar; no `&#x27;`-style residue |
| 3 | `render_code`, `render_source` | `test/render.test.ts` (code half) | rows = newlines + 1; gutter starts at 1; `<script>` arrives as `&lt;script&gt;`; a block comment spanning lines keeps its class on both rows |
| 4 | `render_markdown`, `render_inline` | `test/markdown.test.ts`, `test/render.test.ts` (markdown half) | frontmatter section; `_tools_` keeps its underscores outside code; refused links and images; relative links → `/api/raw?path=…` + `data-heddle-path`; raw `<img>` resolved; fences carry `language-*` and `hljs-*` |
| 5 | `uploads`, `attachments` | `test/uploads.test.ts`, `test/attachments.test.ts`, `test/server-attachments.test.ts` | safe names; collision suffixes; `0600`; symlink escape refused; batch limit; sha256 |
| 6 | `pick_folder`, `SystemRunner` | `test/picker.test.ts` | every platform branch through a fake runner: picked, cancelled, missing command, failure reason |
| 7 | `rewrite_resources` | `test/html.test.ts` | quoted `src`/`href`/`srcset`, fragments, `..` above the root, absolute and remote untouched |
| 8 | `FilesRoutes::router` | the route rows of `test/web.test.ts` | one `tower::ServiceExt::oneshot` test per row of the routes table, over a `FilesHost` double |
| 9 | `docs` | — (no TypeScript test; no caller) | ported, or deleted if ruled dead |
| 10 | verifiers | — | `88-file-preview` and `80-web-ui check-file-view` pass through `HEDDLE_BIN` once the server mounts the router and those checks run through `HEDDLE_BIN`; merged by the ui-lane integrator |

## Open questions

1. **`/api/html` and `html.ts`** (the server crate's owner): proposed here, since `88-file-preview` is its only
   judge. If the server keeps it, [`src/html_preview.rs`](src/html_preview.rs) and the route move there unchanged.
2. **`/vendor/purify.js`** (the server crate's owner): the browser-side sanitiser the html preview loads. Left with
   the server as a page asset beside the embedded `page.html`; the Rust build has to vendor the DOMPurify bundle,
   since the TypeScript build reads it from `node_modules` at request time.
3. **`FileReading`** (the session crate's owner): declared in [`src/host.rs`](src/host.rs) with the TypeScript field
   order. When the session tree's `read_file_text` lands, this crate re-exports that type if its JSON is identical.
4. **`docs.ts`**: it has no caller since the Docs tab was removed; port it or drop it.
5. **The two verifiers**: both spawn `dist/cli.js` directly rather than through `heddleCommand`, and
   `88-file-preview` registers `/Users/zhenc/heddle` as its workspace, which does not exist on a Linux build host.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
