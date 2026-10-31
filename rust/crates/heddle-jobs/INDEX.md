---
title: The heddle-jobs crate
created: 2026-10-31T01:30:00Z
modified: 2026-10-31T06:52:53Z
version: 0.1.3
description: The Rust port crate for background jobs — the registry and its output ring, the three job tools, background bash, the completion notices and the page's job routes — what it ports and what judges it.
grounded_in:
  - source: src/jobs (ring, registry, tools, bash, notice, http, INDEX.md) and src/plugins/jobs.ts, read 2026-10-30
  - source: the bash seam in src/tools/builtin.ts and the /api/jobs dispatch and jobs SSE event in src/server/web.ts
  - source: test/jobs-registry.test.ts, test/jobs-tools.test.ts, test/jobs-notice.test.ts, test/jobs-http.test.ts
  - source: _verifiers_/50-agentic-loop/check-jobs.mjs
  - source: the DSH parity spec jobs-spec.md
---

# `rust/crates/heddle-jobs`

The Rust port of background jobs: a model in a session calls `bash` with `run_in_background: true`, gets
`started background job bash-<16 hex>` at once, and goes on working; it reads the output later with `job_output`,
lists its jobs with `job_list` and stops one with `job_kill`. When a job ends on its own, the session is told with a
completion notice, which starts a turn if the session is idle. Behaviour, model-visible texts, session-log events and
route JSON are the TypeScript build's, which ports DSH 0.2.1-rc.2's `dsh-jobs-local`, `dsh-tool-jobs`,
`dsh-tool-bash` and `dsh-api-job-controller`.

| | |
|---|---|
| Ported from | `src/jobs/*.ts`, `src/plugins/jobs.ts`, the bash seam of `src/tools/builtin.ts` (in `heddle-tools`), the `/api/jobs` dispatch and `jobs` SSE event of `src/server/web.ts` |
| Judged by | `_verifiers_/50-agentic-loop/check-jobs.mjs` through the `heddle` binary; the unit tests port `test/jobs-*.test.ts` |
| Sources | [`src/`](src/INDEX.md) |

## How a refusal reaches the model

A tool answers heddle's `{code, message}` with DSH's sentence; the codes are the TypeScript build's:
`JOB_UNKNOWN`, `JOB_FOREIGN`, `JOB_INVALID_ARGS`, `JOB_OWNER_UNAVAILABLE`, `JOB_UNAVAILABLE`, `JOB_LIMIT`,
`JOB_WAIT_ABORTED`, `JOB_LIVE`, `JOB_DISPOSED` and `TOOL_ABORTED`. The routes answer an unknown or foreign job as
`404 {code: 'job/not-found', message}` and any other refusal as `400 {code, message}`.

## Where the Rust port differs, and why

- **One ordering gate.** The TypeScript registry runs on one thread, so its events come out in call order. Here every
  mutation and the events it causes run under one gate per registry; a listener or a producer's cancel that calls
  back on the same thread passes it. Listeners see the TypeScript order.
- **A failed cancel** is not a refusal: the registry answers it with the internal code `JOB_CANCEL_FAILED`, which a
  tool turns into `TOOL_FAILED` and a route into `500 internal_error` — what the TypeScript build's rethrown `Error`
  becomes.
- **A producer's `done`** is a future that cannot reject; a panic in it is the contract violation, reported and settled
  `failed` with `producerReported: false`.
- **The `run_in_background` description** lives in `heddle-tools` beside `bash`'s two prebuilt schemas (a Rust tool
  answers its spec by reference) and is re-exported here; the TypeScript build passes it from the jobs row. The seam
  is keyed by the registry's sandbox gate, the one object both rows share.
- **Signals and spawn errors.** A signal is named as Node names it (`SIGTERM`); a spawn failure reads
  `spawn <program> <ERRNO>` for the common errors, Node's spelling, and `spawn <program> <io error>` otherwise.
- **Teardown** runs when the boot's services are dropped (`JobsTeardown`), the binary's stand-in for `ctx.effect`.
- **The `tool:jobs` prompt section** is a `model/request` hook (`prompt::JobsPromptSection`), registered by the binary
  beside the row and removed when the boot's services are dropped; the text lands as the TypeScript build's does.
- **`promoteOnTimeout`** is the row's option (`promoteOnTimeout`, default true), handed to `bash` as
  `BashBackground::run_foreground`; the behaviour is the TypeScript build's (`src/jobs/INDEX.md`).
- **Not ported**, as in the TypeScript build: the `outputLimitBytes` truncation, spill files, the
  archive hook (`kill_owned_by` exists, nothing calls it), and the streamed `job.list` / `job.follow` frames.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../heddle-schedule/INDEX.md`](../heddle-schedule/INDEX.md) for the
other subsystem that starts turns in a session on its own.
