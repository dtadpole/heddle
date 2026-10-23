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
| Ported from | `src/server/attachments.ts`, `src/server/uploads.ts`, `src/server/picker.ts`, `src/server/code.ts`, `src/server/docs.ts`, `src/server/markdown.ts`, `src/server/highlight.ts`, `src/server/sanitize.ts`; the file routes of `src/server/web.ts` (not `html.ts`, which stayed with `heddle-server`) |
| Judged by | `_verifiers_/88-file-preview`, `_verifiers_/80-web-ui` (check-file-view), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |
| Unit tests | `cargo test --manifest-path rust/Cargo.toml -p heddle-web-files` |

## Status

**Ported** (2026-10-22): every item of the contract is implemented and tested beside its code — 138 unit tests in
`cargo test -p heddle-web-files`, with `cargo fmt` and `cargo clippy --all-targets` clean. The port plan below is
complete except for its last step, which is not this crate's to finish: `_verifiers_/88-file-preview` cannot judge
anything through `HEDDLE_BIN` until the `heddle` binary answers `web` (developer-two) and the server mounts
[`routes::FilesRoutes::router`](src/routes.rs) behind its token layer (developer-ten), and until the check itself runs
its server through `heddleCommand` instead of `node dist/cli.js` (integrator-two, open question 5).

Three findings are recorded where they were made, because each changes a decision:

- **A live allow-list bypass in `sanitize.ts`, fixed rather than ported.** The exact input, measured on `main` on
  2026-10-22 by running the TypeScript function itself: a document whose last block is a self-closed tag ending the
  string, e.g. `# A`, a blank line, then `<img src="x" onerror="alert(1)"/>`. `marked` answers
  `<h1>A</h1>\n<img src="x" onerror="alert(1)"/>` — `/>` at the end, no trailing newline — and the TypeScript
  scanner reads that close as an *unterminated* text node, so it copies the input from the `<` to the end of the
  string and the attribute allow-list never runs. The page assigns that answer to `innerHTML`
  (`src/server/page.html:9126` and `:4887`), so the handler reaches the DOM and the browser runs it when `src="x"`
  fails to load: `sanitizeHtml('<img src="x" onerror="alert(1)"/>')` returns its input unchanged. The same branch
  also corrupts what follows such a tag — `<p>Hello <img …/></p>\n` came back as `<p>Hello <img … />/p>\n`, the
  `</p>`'s `<` consumed. [`sanitize`](src/sanitize.rs) ends a tag at `/>`, so both are fixed and pinned by
  `a_self_closed_tag_is_reduced_and_never_passed_through_whole`; on this input the port is stricter than
  `sanitize.ts`, not different. The TypeScript tree on `main` still carries it (2026-10-22).
- **`comrak` cannot emit an attribute**, and a link to a workspace file needs `data-heddle-path` while a refused link
  must lose its anchor. Both are done in one pass over the rendered document
  ([`markdown::rewrite_anchors`](src/markdown.rs)), with a marker only this crate can write as the signal.
- **The highlighter's JSON keys are `meta.mapping.key.*` scopes**, not `meta.structure.dictionary.*`; the mapping was
  measured against the syntax set rather than assumed.

## Evidence for step 10, as far as it can be judged today

`_verifiers_/88-file-preview`'s first check was run **against this crate's router** through a stand-in server (a
throwaway binary that mounts [`routes::mount`](src/routes.rs) over a `FilesHost` and serves the repository's
`page.html`, standing in for `heddle web`), with the check copied and only two things changed: the server is started
through `heddleCommand`/`HEDDLE_BIN` instead of `node dist/cli.js`, and its fixture path names a directory that
exists. Result: **1 check, 1 pass, 0 fail** — the document (a table, a frontmatter section, no surviving `<script>`,
no visible backtick), the source file (language, `hljs-` classes, `class="ln"` gutter), YAML as code, `LICENSE` as
text with no `html`, the SVG served inline as `image/svg+xml`, a markdown file offered as a download, `/etc/passwd`
refused by both routes, and the served page carrying `data-view="file"` with no Docs surface.

What that leaves to the seats that own it: the real server's `web` command, the check's own `startCli` and fixture,
and its second and third checks, which judge `/api/html` (the server's route) and the tree (the server's route) in a
browser.

## The public API

Paths are `crate::module::item`. Every item that crosses the HTTP or session-log boundary serializes to the exact
JSON the TypeScript build writes; the tests assert the strings.

| Module | Ported from | Public items |
|---|---|---|
| [`sanitize`](src/sanitize.rs) | `sanitize.ts` | `sanitize_html(html, SanitizeOptions) -> String`, `SanitizeOptions { url: Option<UrlPolicy> }`, `UrlSite { tag, attribute }`, `UrlPolicy` |
| [`highlight`](src/highlight.rs) | `highlight.ts` | `highlight_code(code, Option<&str>) -> String` (inner HTML, `hljs-*` classes), `supports_language(&str) -> bool` |
| [`markdown`](src/markdown.rs) | `markdown.ts` | `render_markdown(source, MarkdownOptions { base }) -> String`, `render_inline(text) -> String`, `escape_html`, `safe_url`, `LINK_DATA_ATTRIBUTE` |
| [`code`](src/code.rs) | `code.ts` | `renderer_for(&Path) -> RendererDecision`, `language_for`, `render_code(source, language, CodeOptions { gutter }) -> String`, `render_source(&Path, text) -> Rendered`, `RendererName`, `Rendered` |
| [`uploads`](src/uploads.rs) | `uploads.ts` | `save_upload(home, name, data, now) -> io::Result<SavedUpload>`, `safe_upload_name`, `upload_stamp`, `upload_directory`, `MAX_UPLOAD_BYTES`, `SavedUpload` |
| [`attachments`](src/attachments.rs) | `attachments.ts`; `attachmentsOf` of `web.ts` | `read_attachments(upload_dir, Option<&Value>) -> Result<Vec<AttachmentPart>, AttachmentInputError>`, `read_attachment`, `display_name_for_stored`, `attachments_of(&[Value]) -> Vec<TurnAttachment>`, `AttachmentPart`, `ImageMediaType`, `TurnAttachment`, `MAX_ATTACHMENTS` |
| [`picker`](src/picker.rs) | `picker.ts` | `pick_folder(&Platform, &dyn CommandRunner) -> PickerOutcome`, `PickerOutcome`, `CommandRunner`, `CommandResult`, `SystemRunner`, `Platform`, `PICK_TIMEOUT` |
| [`docs`](src/docs.rs) | `docs.ts` | `find_docs`, `read_doc`, `is_inside`, `DocEntry`, `DocError`, `FindDocsOptions`, `MAX_DOC_BYTES` |
| [`host`](src/host.rs) | the seam | `trait FilesHost { heddle_home, workspace_owner, read_file_text }`, `WorkspaceAnswer`, `FileReading`, `FileReadError` |
| [`routes`](src/routes.rs) | the file routes of `web.ts` | `mount(axum::Router, Arc<dyn FilesHost>) -> axum::Router`, `mount_routes`, `FilesRoutes::new(..).with_picker(..).router()`, `ROUTES`, and the answer shapes `FileAnswer`, `MarkdownRequest`, `MarkdownAnswer`, `ErrorAnswer`, `FileQuery` |

### The routes

`FilesRoutes::router()` answers `GET /api/file`, `GET /api/raw`, `GET /api/uploads/{leaf}`, `POST /api/uploads`,
`POST /api/markdown` and `POST /api/workspaces/pick` — not `GET /api/html`, which is `heddle-server`'s. Each status,
body and header is
tabled in [`src/routes.rs`](src/routes.rs). The router does no authentication and has no fallback: the server merges
it and puts its token layer over the result, exactly as every one of these routes sits after the token decision in
`web.ts`.

### Mounting

The router is merged, not constructed by the server: `heddle_web_files::routes::mount(router, Arc::new(host))` takes
a router whose own state is already applied (`axum::Router<()>`) and answers `axum::Router<()>` with the file routes
in it, so a caller applies its state, mounts, and then puts its token layer over the result. `mount_routes` takes
the routes already configured (a replaced folder dialog). axum only merges routers of the same state type, which is
why this is a call rather than "build the router and merge it". The shapes a caller reads the answers through are
public and serialized exactly as the routes write them: `FileAnswer` (the reading flattened with the renderer's
decision), `MarkdownAnswer`, `ErrorAnswer`, and `SavedUpload`/`PickerOutcome` for the other two.

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

Each step landed with its unit tests (ported from the TypeScript suite named) and was pushed on its own. Steps 1-9
are done; step 10 is blocked on other seats and is named there.

| # | Step | Tests ported from | Done when |
|---|---|---|---|
| 1 ✅ | `sanitize_html` | `test/sanitize.test.ts` | the allow-list, numeric attributes, drop-with-content, comments, stray `<`, unterminated tags, URL policy sites |
| 2 ✅ | `highlight` over syntect: the scope table, `highlight_pieces`, `highlight_code` | `test/highlight.test.ts` | every registered language and alias; the three verifier strings above; exact text (strip spans + decode = input) for every grammar; no `&#x27;`-style residue |
| 3 ✅ | `render_code`, `render_source` | `test/render.test.ts` (code half) | rows = newlines + 1; gutter starts at 1; `<script>` arrives as `&lt;script&gt;`; a block comment spanning lines keeps its class on both rows |
| 4 ✅ | `render_markdown`, `render_inline` | `test/markdown.test.ts`, `test/render.test.ts` (markdown half) | frontmatter section; `_tools_` keeps its underscores outside code; refused links and images; relative links → `/api/raw?path=…` + `data-heddle-path`; raw `<img>` resolved; fences carry `language-*` and `hljs-*` |
| 5 ✅ | `uploads`, `attachments` | `test/uploads.test.ts`, `test/attachments.test.ts`, `test/server-attachments.test.ts` | safe names; collision suffixes; `0600`; symlink escape refused; batch limit; sha256 |
| 6 ✅ | `pick_folder`, `SystemRunner` | `test/picker.test.ts` | every platform branch through a fake runner: picked, cancelled, missing command, failure reason |
| 7 ↔️ | `rewrite_resources` | `test/html.test.ts` | **moved** to `heddle-server/src/preview.rs` with `GET /api/html`: the server owner had already ported and tested it there, and two implementations of one rewrite is worse than one. The eight tests written here went with it (developer-ten has the equivalent in-process tests) |
| 8 ✅ | `FilesRoutes::router` | the route rows of `test/web.test.ts` | one `tower::ServiceExt::oneshot` test per row of the routes table, over a `FilesHost` double |
| 9 ✅ | `docs` | — (no TypeScript test; no caller) | ported rather than deleted: no one has ruled it dead, and it is 4 tests |
| 10 ⛔ | verifiers | — | blocked: `88-file-preview` fails before it reaches any route — `spawn …/rust/target/release/heddle ENOENT` (no release binary; `heddle web` is unported, developer-two) — and its `startCli` still spawns `node dist/cli.js`, so even a built binary would not be the server under test until integrator-two moves it to `heddleCommand`; the server mount is developer-ten's |

## Open questions

1. **`/api/html` and `html.ts` — resolved** (2026-10-22): they stay in `heddle-server`
   (`src/preview.rs`, registered in its `CORE_ROUTES`). `GET /api/html` is removed from this crate's `ROUTES` and
   `src/html_preview.rs` is deleted, since `Router::merge` rejects an overlap and the server route is live.
2. **`/vendor/purify.js` — resolved**: a server page asset, served from `ServerOptions::asset_roots`; no route here.
3. **`FileReading`** (the session crate's owner): declared in [`src/host.rs`](src/host.rs) with the TypeScript field
   order. When the session tree's `read_file_text` lands, this crate re-exports that type if its JSON is identical.
4. **`docs.ts`**: ported, since no one ruled it dead; it still has no caller and can be deleted in one commit if the
   coordinator rules it out.
5. **The two verifiers** (integrator-two): `88-file-preview` and `80-web-ui check-file-view` spawn `dist/cli.js`
   directly rather than through `heddleCommand`, and `88-file-preview` registers `/Users/zhenc/heddle` as its
   workspace, which does not exist on this Mac. Both are in the integrator's write scope; the port is otherwise
   unjudgeable through `HEDDLE_BIN`.
6. **The `heddle` binary** (developer-two, planned): `rust/crates/heddle/src/main.rs` exits 2 for every command,
   and `heddle-server` has no routes, so no file route is reachable from a binary yet. The router is ready to be
   merged (`routes::ROUTES` lists its paths for the overlap assertion at boot).

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
