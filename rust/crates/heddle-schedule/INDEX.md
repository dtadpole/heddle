---
title: The heddle-schedule crate
created: 2026-10-29T12:30:00Z
modified: 2026-10-29T12:30:00Z
version: 0.1.0
description: The Rust port crate for schedules and reminders — the four tools, the rules, the store, the service, delivery, the page routes and the time context — what it ports and what judges it.
grounded_in:
  - source: src/schedule (errors, time, cron, rules, store, service, delivery, tool, http, time-context) and src/plugins/schedule.ts, read 2026-10-29
  - source: test/schedule-*.test.ts
  - source: _verifiers_/50-agentic-loop/check-schedules.mjs
  - source: the DSH parity spec schedules-spec.md, sections 1 to 4 and 6
---

# `rust/crates/heddle-schedule`

The Rust port of reminders: a model in a session calls `schedule_create` with a prompt, a title and exactly one
timing rule; when the rule comes due, the prompt is delivered back into **that** session as the user message of a
new turn. Behaviour, messages, key order and the store file are the TypeScript build's, which ports DSH 0.2.1-rc.2.

| | |
|---|---|
| Ported from | `src/schedule/*.ts`, `src/plugins/schedule.ts`, the `/api/schedule/` dispatch and `schedule` SSE event of `src/server/web.ts`, the start in `heddle web` (`src/cli.ts`) and the time-context hook in `src/agent/loop.ts` |
| Judged by | `_verifiers_/50-agentic-loop/check-schedules.mjs` through the `heddle` binary; the unit tests port `test/schedule-*.test.ts` |
| Sources | [`src/`](src/INDEX.md) |

## Where the Rust port differs, and why

- **Time zones** come from the operating system's compiled IANA database (`/usr/share/zoneinfo`, or `TZDIR`), read by
  a small TZif reader, not from ICU. A zone name is matched case-insensitively and answered in the database's
  spelling, and the names ECMA-402 maps to `UTC` answer `UTC`. Other links keep their own spelling (`US/Pacific`
  stays `US/Pacific`, where `Intl` answers `America/Los_Angeles`); their offsets, and so every target, are the same.
- **The FIFO** takes a request's place when the operation is called, as the promise chain does, and a dropped
  operation gives its place up.
- **A waiting reminder** is woken by the live-turn registry's `when_idle` when the profile loads `turns`, and by the
  session's turn events otherwise; the minute's busy recheck stays as the net.
- **The catalog** sorts by plain string order where the TypeScript build uses `localeCompare`; for canonical
  instants and `schedule-<uuid>` ids the two orders agree.
- **A corrupt store's** "not JSON" detail is serde's sentence, not V8's.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../heddle-goal/INDEX.md`](../heddle-goal/INDEX.md) for the
other subsystem that starts turns on its own.
