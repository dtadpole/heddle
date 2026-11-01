---
title: The heddle-schedule sources
created: 2026-10-29T12:30:00Z
modified: 2026-10-29T12:30:00Z
version: 0.1.0
description: The sources of the heddle-schedule crate, with unit tests beside the code.
grounded_in:
  - source: src/schedule/INDEX.md
---

# `rust/crates/heddle-schedule/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation and the re-exports |
| [`errors.rs`](errors.rs) | `ScheduleInputError` (a public `{code, message}`) and `ScheduleLogError` (stored data that is wrong) |
| [`js.rs`](js.rs) | the JavaScript semantics the checks lean on: `trim`, `\s`, UTF-16 length, safe integers, `Number(text)` |
| [`tzif.rs`](tzif.rs) | the TZif v1-v3 reader, the POSIX footer rule, and the case-insensitive lookup in the zone database |
| [`time.rs`](time.rs) | epoch-day dates, offsets, wall time to instant (a gap has none, an overlap takes the earlier), zone canonicalization, canonical instants |
| [`cron.rs`](cron.rs) | five-field Vixie cron: DSH's grammar and diagnostics, its canonical spelling, the day rule |
| [`rules.rs`](rules.rs) | the records and every rule over them: selectors, construction, next targets, the latest missed occurrence, the compare-and-set update, the strict decoder, the view |
| [`store.rs`](store.rs) | `<heddle home>/schedule.json` in DSH's unit shape, decoded strictly, written atomically |
| [`service.rs`](service.rs) | `ScheduleService`: the FIFO, create / list / catalog / history / delete / update / the archive stop, retention, change listeners |
| [`delivery.rs`](delivery.rs) | the two message templates and `ScheduleDriver`: one timer, one drive at a time, batches, the busy wait, the proof in the session's own log |
| [`tool.rs`](tool.rs) | the four tools: DSH's descriptions, parameter schemas, argument validation and results |
| [`http.rs`](http.rs) | the page's routes, DSH's remote `schedule` namespace |
| [`time_context.rs`](time_context.rs) | DSH's time context: the baselines, the ten-minute rule, the three-line reading and its `context/note` |
| [`compose.rs`](compose.rs) | the `schedule` row over `heddle-session`, `heddle-agent` and `heddle-tools`, for the binary |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports and where it differs.
