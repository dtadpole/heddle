---
title: Schedule
version: 1.2.0
description: Durable reminders a session sets for itself - the four model tools, the rules that compute targets, the store file, the service and the delivery driver that turns a due reminder into a turn.
grounded_in:
  - source: dsh-0.2.1-rc.2
  - source: dsh-tool-schedule and dsh-schedule compiled lib code, read and executed read-only on 2026-10-29
  - source: owner goal 2026-10-29 - DSH parity phase B, schedules and reminders in both builds
---

# `schedule`

Reminders, ported from DSH's `dsh-tool-schedule` and `dsh-schedule`. A model in a session calls
`schedule_create` with a prompt, a title and exactly one timing rule; when the rule comes due, the prompt is delivered
back into **that** session as the user message of a new turn. The reference is DSH 0.2.1-rc.2's
compiled code, cited in the doc comments here as `TOOL:n` (`dsh-tool-schedule/lib/index.js`) and `SVC:n`
(`dsh-schedule/lib/index.js`).

| File | What it is |
|---|---|
| [`errors.ts`](errors.ts) | `ScheduleInputError` (a public `{code, message}` a model reads) and `ScheduleLogError` (stored data that is wrong; never shown to a model) |
| [`time.ts`](time.ts) | calendar and zone arithmetic without Temporal: epoch-day plain dates, offsets from `Intl.DateTimeFormat#formatToParts`, local wall time to instant with DSH's `earlier` disambiguation **and** round trip (a gap has no instant, an overlap takes the earlier), zone validation and canonicalization, canonical `YYYY-MM-DDTHH:mm:ss.sssZ` |
| [`cron.ts`](cron.ts) | five-field Vixie cron: DSH's grammar and exact diagnostics, its canonical spelling (which keeps whether a field was `*`-led), and the day rule (both day fields restricted is OR, otherwise AND) |
| [`rules.ts`](rules.ts) | the records (`after`, `at`, `every`, `daily`, `weekly`, `cron`) and every rule over them: selector validation, record construction, the next target, the latest missed occurrence, the compare-and-set update, the strict decoder, and the view |
| [`store.ts`](store.ts) | `<HEDDLE_HOME>/schedule.json` in DSH's storage-domain unit shape, rows decoded strictly, every write atomic (temp file, fsync, rename); an absent file is empty and a corrupt one refuses to open |
| [`service.ts`](service.ts) | `ScheduleService`: one FIFO for every write, create's clock sampled before the queue and update's inside it, `list` / `catalog` / `history` / `delete` / `update` / `stopSessionTasks`, retention pruning, and a change callback after every committed write |
| [`delivery.ts`](delivery.ts) | the two message templates and `ScheduleDriver`: one timer, one drive at a time inside the FIFO, one-shots alone and a session's recurring reminders in one batch, a busy session waited for, and a delivery committed only once its message is found in the session's own log |
| [`tool.ts`](tool.ts) | the four tools, their DSH descriptions and compiled parameter schemas, DSH's argument validation with its diagnostics, and the mapping of DSH values onto heddle's `ToolResult` |
| [`time-context.ts`](time-context.ts) | the clock reading DSH's `dsh-time-context` gives the model, which reminders depend on: DSH's three baselines folded from the log, the ten-minute refresh rule, the exact three-line text, and `recordTimeContext`, which the turn loop calls once per step beside the runtime-context snapshot |
| [`http.ts`](http.ts) | the page's reminder routes under `/api/schedule/`: DSH's remote `schedule` namespace (`catalog`, `list`, `history`, `update`, `delete`; no create, as in DSH), the service's own values, a refused input as `400 {code, message}` |

The plugin that wires them is [`../plugins/schedule.ts`](../plugins/schedule.ts): it opens the store, provides
`ctx.schedule`, registers the four tools, forwards change callbacks as the `schedule/changed` event, and runs the driver
with `runTurn` as its turn starter.

## How a DSH value becomes a heddle tool result

DSH renders **every** value its schedule tools return as one text block `JSON.stringify(value)` with `isError: false` —
the views, the lists, the delete and update receipts, and every `{code, message}` refusal, including
`subagent_session` and `internal_error`. Those refusals are part of each tool's declared output schema, not failures
(TOOL:157-268). Heddle's loop shows a model `result.output` when there is no `error`, and `error (code): message` when
there is one. So every DSH value is returned as `output` with no `error`, which makes the model-visible text
byte-identical to DSH's; `data.schedule` carries the same value for a caller.

The one genuine failure is DSH's too: arguments that break the parameter schema throw `ToolArgsError` before the tool
body runs, and DSH reports it as an error result `Error: invalid arguments: …`. That maps to heddle's
`error: {code: 'INVALID_ARGS', message: 'invalid arguments: …'}`, with DSH's violation wording; the model reads
`error (INVALID_ARGS): invalid arguments: …`, the closest a heddle error can come.

## Where heddle differs from DSH, and why

- **No agent inbox.** DSH queues a due reminder with `agent.followup(message)` and requires `sessions.flush()` to
  acknowledge it. Heddle starts a turn whose prompt is the reminder (`source: {kind: 'schedule'}`) when the session is
  idle; when it is mid-turn, the driver waits for the session's `turn/completed` (or `turn/failed`) and delivers then,
  which is DSH's observable order — the reminder is the next turn. The acknowledgement is the session's own log, as in
  the team service: the delivery commits only once the user message is found there. A log event has no id, so the
  receipt's `messageId` is `message-<uuid>`.
- **A busy recheck.** Heddle's loop appends nothing when a turn throws, so a reminder waiting on such a turn would wait
  for an unrelated drive. The driver therefore re-drives a minute after it parked a reminder behind a busy session.
  DSH has no such timer because its inbox owns the queued message.
- **Delegated children** are recognised from the session's metadata (`delegationDepth > 0`), durably, where DSH's
  service guard reads only a live agent. The tool refusal and the service refusal keep DSH's two texts.
- **Starting delivery.** The plugin starts delivering when it loads (`autoStart`, default true), as the DSH host does.
  A profile that wants heddle's one-shot rule — a `--turn` or `tree` command must not start turns for sessions it is
  not working on — sets `autoStart: false` and has the server call `ctx.schedule.startDelivery()` at boot, the way the
  goal and team sweeps are started.
- **Not ported here**: the Web views and the time context (spec sections 5-6), the transcript card's pending-call
  presentation, and the archive hook (`stopSessionTasks` exists; heddle has no `workspace/session-stop` event yet).

## Tests

- [`../../test/schedule-time.test.ts`](../../test/schedule-time.test.ts) — zones, epoch days, offsets, and the
  America/Los_Angeles gap (2026-03-08 02:30) and overlap (2026-11-01 01:30).
- [`../../test/schedule-cron.test.ts`](../../test/schedule-cron.test.ts) — every cron diagnostic, canonicalization, and
  the day rule.
- [`../../test/schedule-rules.test.ts`](../../test/schedule-rules.test.ts) — every selector's validation and next target
  across DST, the fixed-rate anchor and re-anchor, the latest missed occurrence, the update, and the decoder.
- [`../../test/schedule-store.test.ts`](../../test/schedule-store.test.ts) — the unit shape, the round trip, and the
  refusal of a corrupt file.
- [`../../test/schedule-service.test.ts`](../../test/schedule-service.test.ts) — the FIFO and its two clock samples,
  CAS, ended and not-found, subagent refusals, catalog, history and retention.
- [`../../test/schedule-tools.test.ts`](../../test/schedule-tools.test.ts) — the four tools' exact JSON text, key order,
  refusal order and `INVALID_ARGS`.
- [`../../test/schedule-delivery.test.ts`](../../test/schedule-delivery.test.ts) — the driver against a fake host and
  fake timers, then the plugin end to end over a real session store and the real turn loop.

## Read next

[`../INDEX.md`](../INDEX.md) for the source tree, and [`../goal/INDEX.md`](../goal/INDEX.md) for the other subsystem
that starts turns on its own.
