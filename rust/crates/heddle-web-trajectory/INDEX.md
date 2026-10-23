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
| Status | **implemented and unit-tested — 69 tests here; served through the real `heddle-server` router in a probe (below); the binary's `web` composition is the remaining step** |

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

## Verification so far

- **Unit tests**: 69 here. (`heddle-web-composer` moved to developer-twelve under D-037 and carries its own suite; this crate builds against that crate's `SessionLookup`, `http`, `js` and `catalog` surfaces, which the two seats agreed to keep stable.) `cargo test -p heddle-web-trajectory -p
  heddle-web-composer` is green; every case of `test/ledger.test.ts`, `test/usage.test.ts`,
  `test/tool-catalog.test.ts`, `test/log-download.test.ts` and `test/tool-inspector.test.ts` is ported.
  `cargo fmt --check` and `cargo clippy --all-targets` are clean; `cargo check --workspace` is green.
- **Differential against the TypeScript build** (2026-10-22): 15 scenarios written to cover the rules rather
  than the happy path (turn and step boundaries, prologue folded once, tool pairing by id and by newest-open,
  refusals, orphan results, context notes, unknown events, unfinished streams, provider-vs-estimated usage,
  a two-turn axis, a running axis and the stats rows), plus the 8 session logs the TypeScript build wrote for
  the live deployment under `~/.heddle/sessions/--Users-zhenchen-heddle-live--/` (129 events, one to twelve
  turns, runtime-context notes, compaction/recovery records) and the 3 recorded stores in
  `_verifiers_/50-agentic-loop/fixtures/team-recover/`. `src/server/ledger.ts` (run from source with Node 24)
  and this crate agree: **ledger, rows, timeline and stats are semantically identical in all 26**.
- **The download body**: re-serialising the same 11 logs through `ndjson` is **byte-identical** to the decoded
  TypeScript logs.

- **Through the real server** (2026-10-22, ui lane tree at 525f632, a scratch probe outside the repository):
  heddle-server's `ServerBuilder` booted with `router(host)` mounted beside its `CORE_ROUTES` (no route
  conflict), the ledger registered as `SessionView` `"ledger"`, `stats` set through `stats_projector` over
  `session_stats_view`, and JSON highlighted by heddle-web-files' `render_code(.., "json", gutter: false)`.
  Through the real door (token handshake, cookie; `401` without it), 27 sessions — the 26 logs above plus one
  adversarial case (float and exponent arguments, non-JSON arguments, markup in results, a quoted CJK title) —
  were compared with the same answers built from `src/server/web.ts`: `stats`, the `/log` body,
  `content-disposition` and `content-length` **identical in 27/27**; `?view=ledger` **identical as text in
  27/27**, and byte-identical in 22/27. The five that differ do so only in the highlight classes
  `render_code` emits (highlight.js marks JSON punctuation and `true`/`null` differently), which is
  heddle-web-files' renderer, not this crate. The refusals answer `400 {"error":"not a session id"}` and
  `404 {"error":"no session <id>"}` on both routes.
- **Two divergences this probe found and fixed**: `serde_json` reads a float one ulp off without its
  `float_roundtrip` feature (a logged `0.9999551342447491` downloaded as `…492`), now enabled on this crate's
  dependency and therefore across the binary; and `serde_json` prints an integral double as `1.0` where
  `JSON.stringify` prints `1`, so the inspector payload, the schema parameters, an unknown event's body and the
  `/log` lines now go through [`js_json`](src/js_json.rs), which formats numbers by `Number#toString`.

### How to repeat the differential

1. Decode a log: `zstd -dc session.v2.jsonl.zstd > /tmp/session.jsonl`.
2. This crate's projection:
   `LOCAL_BUILD_SLOTS=2 _tools_/local-build/run run --example project_log -p heddle-web-trajectory -- /tmp/session.jsonl > /tmp/rust.json`
   (the example prints `{ledger, rows, timeline, stats}`, the four projections the view uses).
3. The TypeScript build's, from the repository root (Node 24 runs the source directly):
   `node --input-type=module -e 'import { readFileSync } from "node:fs"; import { projectLedger, projectRows, projectTimeline, projectSessionStats } from "./src/server/ledger.ts"; const events = readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse); const ledger = projectLedger(events); console.log(JSON.stringify({ ledger, rows: projectRows(ledger), timeline: projectTimeline(ledger), stats: projectSessionStats(events) }, null, 2))' /tmp/session.jsonl > /tmp/ts.json`
4. Compare the two documents **structurally**, not as text: same keys, same array lengths, and numbers
   compared numerically (`0 == 0.0`). A first differing path is where to look. A same-shape difference in
   `ledger.turns[..].steps[..].records` means a projection rule diverges and is a bug in this crate; a
   difference confined to `timeline.spans[].start/end` formatting or to key order is the harmless one below.

`?view=ledger` is not yet byte-identical to the TypeScript build: `TimelineSpan::start`/`end` are `f64` and
`serde_json` writes an integral one as `0.0` where JavaScript writes `0` (the page parses both as numbers), and
a record's key order follows this crate's structs rather than the object literal that built it. Both are
harmless to the page, which reads fields; the download, where bytes matter, is identical.

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
