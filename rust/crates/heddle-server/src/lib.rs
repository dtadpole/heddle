//! `heddle-server` — the HTTP server, the token, the live stream and the page it serves.
//!
//! Ported from the TypeScript build: `src/server/web.ts`, `src/server/token.ts`, `src/server/html.ts`, `src/server/page.html (embedded, not rewritten)`.
//! Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/80-web-ui` (check, check-chat-view, check-access), `_verifiers_/87-resizable-panels`, `_verifiers_/90-web-ui-token`.
//! Nothing is ported yet; the public API lands here first so dependent crates can build against it.
