---
title: The heddle-web-trajectory crate
version: 0.3.0
description: The Rust port crate for the trajectory view routes, the ledger and log download — its public API, what it needs from other crates, and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/server/ledger.ts, src/server/log-download.ts, src/server/tool-inspector.ts and the ledger, stats and log branches of src/server/web.ts
  - source: _verifiers_/85-trajectory-view/check.mjs; _verifiers_/80-web-ui/check-trajectory-view.mjs, check-runtime-context.mjs, check-composer.mjs (the dock)
  - source: test/ledger.test.ts, test/log-download.test.ts, test/tool-inspector.test.ts
---

# `rust/crates/heddle-web-trajectory`

The Rust port of the trajectory view routes, the ledger and log download. Almost all of it is a **pure
projection** of one session's recorded events, read as the JSON objects the log holds (`serde_json::Value`,
key order kept), so it depends on no session type.

| | |
|---|---|
| Ported from | `src/server/ledger.ts`, `src/server/log-download.ts`, `src/server/tool-inspector.ts` |
| Judged by | `_verifiers_/85-trajectory-view`, `_verifiers_/80-web-ui` (check-trajectory-view; the ledger half of check-runtime-context; the dock of check-composer), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |
| Status | **implemented and unit-tested — 95 tests across the two crates (61 here); the routes are mounted by `heddle-server` and the binary, which is the remaining step** |

## Public API

| Item | What it is |
|---|---|
| `project_ledger(&[Value]) -> Ledger` | events → turns → steps → records, with totals and the in-flight count |
| `project_rows(&Ledger) -> Vec<LedgerRow>`, `preview_of`, `lane_of` | the Trajectory table's flat rows, their one-line previews, the three timeline lanes |
| `project_timeline(&Ledger) -> Timeline` | the lane strip: one span per turn on the recorded domain |
| `project_session_stats(&[Value]) -> SessionStats`, `context_breakdown_with_fallback`, `session_stats_view` | the composer dock's figures and the context panel's sections, for the server's chat route `stats` field |
| `inspect_tool`, `render_payload`, trait `JsonHighlighter` | a tool row's inspector blocks; JSON highlighting comes from `heddle-web-files` |
| `log_file_name`, `content_disposition`, `ndjson` | the downloaded log's file name, header and body |
| `ledger_view(...) -> LedgerView` | the whole `?view=ledger` body: `{ id, ledger, rows, timeline, tools }` |
| trait `TrajectoryHost: SessionLookup + JsonHighlighter` | what the routes read: events, title, tool specs, highlighting |
| `ledger_response(&H, id) -> Response` | the `?view=ledger` answer, for the **server's** `GET /api/sessions/{id}` handler to return |
| `router(Arc<H>) -> axum::Router` | mounts `GET /api/sessions/{id}/log` (state applied; merges into any `Router<()>`) |
| `TokenUsage`, `merge_token_usage`, `billed_input_tokens` | **temporary** copies of `heddle-llm`'s usage type and helpers, to become re-exports with the same shape |
| `js` (from `heddle-web-composer`) | the JavaScript behaviours the projections reproduce; private to the crates, not a route |

## What it needs from other crates

| From | What | Until it exists |
|---|---|---|
| `heddle-web-composer` | `ToolSchema`, `catalog_of`, `SessionLookup`, the `http` answer helpers | — |
| `heddle-server` | its `GET /api/sessions/{id}` handler returns `ledger_response` when `view=ledger`, puts `session_stats_view` in the chat body's `stats`, merges `router`, and wraps it in the token and fence layers | test doubles drive `ledger_response` and `router` directly |
| `heddle-session` | events of one session as JSON objects in written order; the session's title | a double holding events in memory |
| `heddle-web-files` | `renderCode(source, "json", { gutter: false })` behind `JsonHighlighter` | a double that only escapes |
| `heddle-llm` | `TokenUsage`, `mergeTokenUsage`, `billedInputTokens`; `ToolSpec` | local copies, same serialised shape |
| `heddle-tools` | `describe()` → `ToolSpec`s | a double |

`serde_json` is enabled with `preserve_order` here, and Cargo unifies features across the binary: every crate's
`serde_json::Map` keeps insertion order, which is what a byte-compatible session log needs anyway.

## Port plan

1. **API** — types, traits, signatures, docs; `todo!()` bodies. Landed in `0e487cf`, rebased as `2e2e530`.
2. **JS-compatible helpers** — `Date.parse`/`Date#toISOString`, UTF-16 slicing, JavaScript's `\s`, JSON
   stringification and `encodeURIComponent`. They live in `heddle-web-composer`'s `js` module (the crate this
   one already depends on), each with its own tests.
3. **Usage, ledger, rows, timeline, stats** — every case of `test/ledger.test.ts` (and the usage cases of
   `test/usage.test.ts`) is a Rust unit test beside the code, including the in-flight, absent-not-zero and
   prompt-folded-once rules.
4. **Inspector and log download** — `test/tool-inspector.test.ts` and `test/log-download.test.ts` ported.
5. **View and routes** — `ledger_view`, `ledger_response`, `log_response` and `router`, tested in-process with
   a host double through `tower::ServiceExt::oneshot`: status codes, error sentences, headers, body bytes.
6. **Through the binary** (pending): once `heddle-server` mounts the routes and the binary implements
   `TrajectoryHost`, `85-trajectory-view` and `80-web-ui check-trajectory-view` through `HEDDLE_BIN`, and a
   byte comparison of `?view=ledger` and `/log` with the TypeScript build on the same session log.

## Known divergences

- `Date.parse` of a timestamp without a zone is read as UTC (JavaScript reads it as local time); the log writes
  `toISOString()`, which always carries `Z`.
- Slicing at 2000 / 80 UTF-16 units never splits a surrogate pair (JavaScript can leave a lone half).
- Token counts are unsigned integers; a non-integer count in a log is treated as absent.
- `JSON.stringify(v, null, 2)` is `serde_json`'s pretty printer: the indentation and key order agree, while a
  control character outside the escape shorthand is written `\u00XX` by both, and a non-ASCII string stays
  unescaped by both.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../heddle-web-composer/`](../heddle-web-composer/INDEX.md) for
the routes beside these; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
