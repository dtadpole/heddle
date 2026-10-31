---
title: heddle-web-trajectory public API
created: 2026-10-23T05:10:00Z
modified: 2026-10-31T16:03:56Z
level: L2
version: 1.1.0
description: What heddle-web-trajectory exports, what it reads from other crates, and where it deliberately differs from the TypeScript build.
status: unverified
grounded_in:
  - source: rust/crates/heddle-web-trajectory/src/lib.rs
  - source: src/server/ledger.ts, src/server/log-download.ts, src/server/tool-inspector.ts
---

# heddle-web-trajectory public API

## Exports

| Item | What it is |
|---|---|
| `project_ledger(&[Value]) -> Ledger` | events → turns → steps → records, with totals and the in-flight count |
| `project_rows`, `preview_of`, `lane_of` | the table's flat rows with their turn and step boundaries, one-line previews, the three lanes; a record outside every turn (`Ledger::loose`, placed by its `after_turn`) sits where it happened, in its own Between turns section |
| `project_timeline(&Ledger) -> Timeline` | the lane strip: one span per turn on the recorded domain, and `records`, one timed record per overview bar with an answer's TTFT split |
| `project_session_stats`, `context_breakdown_with_fallback`, `session_stats_view` | the composer dock's figures and the context panel's sections, for the chat route's `stats` |
| `inspect_tool`, `render_payload`, trait `JsonHighlighter` | a tool row's inspector blocks; highlighting is heddle-web-files' `render_code(.., "json", gutter: false)` |
| `log_file_name`, `content_disposition`, `ndjson` | the downloaded log's name, header and body |
| `ledger_view(id, events, catalog, highlighter) -> LedgerView` | the whole `?view=ledger` body `{ id, ledger, rows, timeline, tools }` |
| trait `TrajectoryHost`, `ledger_response`, `router(Arc<H>)` | what the routes read; the `?view=ledger` answer with its 400/404; the router for `GET /api/sessions/{id}/log` |
| `TokenUsage`, `merge_token_usage`, `billed_input_tokens` | temporary copies of heddle-llm's usage type and helpers, to become re-exports |

## What it reads from other crates

| From | What |
|---|---|
| heddle-web-composer | `SessionLookup`, the `http` answer helpers, the `js` behaviours, the tool `catalog` — agreed with its owner to stay stable |
| heddle-server, through the binary | the ledger registered as `SessionView` `"ledger"`, `router` mounted, `session_stats_view` as the stats projector |
| heddle-session, heddle-tools, heddle-web-files | events in written order and the title; `ToolSpec`s; the JSON highlighter — behind `TrajectoryHost` |

## Known divergences

- `Date.parse` reads a timestamp without a zone as UTC, where JavaScript reads local time; the log always writes `Z`.
- Slicing at 2000 or 80 UTF-16 units never splits a surrogate pair, where JavaScript can leave a lone half.
- A token count is an unsigned integer; a non-integer count in a log reads as absent.
- `?view=ledger`'s key order follows this crate's structs; the page reads fields, so it is the same answer.

## Read next

[`VERIFICATION.md`](VERIFICATION.md); [`src/`](src/INDEX.md).
