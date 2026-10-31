---
title: Jobs
version: 1.0.3
description: Background jobs a session starts and collects later - the in-memory registry and its output ring, the three job tools, background bash, the completion notice that wakes an idle session, and the page's job routes.
grounded_in:
  - source: dsh-0.2.1-rc.2
  - source: dsh-jobs, dsh-jobs-local, dsh-tool-jobs, dsh-tool-bash, dsh-bash-local and dsh-api-job-controller compiled lib code, read read-only on 2026-10-30
  - source: owner goal 2026-10-30 - DSH parity, background jobs (inventory rows A50-A55, A57's routes)
---

# `jobs`

Background jobs, ported from DSH's `dsh-jobs-local` (the registry), `dsh-tool-jobs` (the tools and the notice),
`dsh-tool-bash` (`run_in_background`) and `dsh-api-job-controller` (the person's job API). A model in a session calls
`bash` with `run_in_background: true`, gets `started background job <id>` at once, and goes on working; it reads the
output later with `job_output`, lists its jobs with `job_list` and stops one with `job_kill`. When a job ends on its
own, the session is told with a completion notice, which starts a turn if the session is idle. The doc comments cite
`LOCAL:n` (`dsh-jobs-local/lib/index.js`), `TOOL:n` (`dsh-tool-jobs/lib/index.js`) and `BASH:n`
(`dsh-tool-bash/lib/index.js`).

| File | What it is |
|---|---|
| [`ring.ts`](ring.ts) | `OutputRing`: chunks at absolute UTF-8 byte offsets, the oldest whole chunks dropped past the cap, an oversized chunk cut to a UTF-8-safe tail marked `gapBefore`, non-consuming reads that answer `lossy` below `earliest`; channels `stdout`, `stderr`, `log` |
| [`registry.ts`](registry.ts) | `JobRegistry`, the substrate: `JobView`, the five statuses, `<kind>-<16 hex>` ids re-rolled on collision, the producer spec (`run(handle) -> {cancel, done}`, pull sources), preflight in DSH's order, the per-owner cap, the pump (150 ms, then a final drain before settle), the one consuming `read` and the non-consuming `readAt`, `kill`, `wait`, `remove`, first-wins settle with the kill reason merged, ownership, the `job/registered` and `job/settled` session-log events, the event stream, teardown |
| [`tools.ts`](tools.ts) | `job_output`, `job_list`, `job_kill`: DSH's descriptions, parameter schemas and renderings verbatim (status line, `(no new output)`, the `[stderr]` section, the dropped-output note, `(no background jobs)`, the kill answers) |
| [`bash.ts`](bash.ts) | background `bash`: the producer (confined by the same sandbox path as a foreground call, detached in its own process group, SIGTERM then SIGKILL after 3000 ms through the sandbox's `killProcessGroup`, DSH's outcome mapping and sandbox notes), the runner the jobs row attaches to the `bash` tool, and `runForeground`: a foreground call run as a job, promoted to the background when it outlives its wall time (`renderPromoted`) |
| [`notice.ts`](notice.ts) | the completion notice's text and source, and `NoticeDelivery`: who is told, wake or inject, per-session serialization, `quiet` delivery and the wake budget |
| [`http.ts`](http.ts) | the person's routes under `/api/jobs`: list, follow (non-consuming), kill (`cancelled by the user`) |

The plugin that wires them is [`../plugins/jobs.ts`](../plugins/jobs.ts): it provides `ctx.jobs`, registers the
three tools, attaches background `bash`, delivers notices with `runTurn` as its turn starter and the session inbox as
its injector, emits `jobs/changed` on every lifecycle event (the server forwards it to the page as the SSE event
`jobs`), and disposes the registry with the row.

## How a refusal reaches the model

DSH throws the registry's sentence and the model reads `Error: <message>`. Heddle keeps its own tool error shape,
`{code, message}`, so the model reads `error (<code>): <message>` with DSH's sentence. The codes are stable:

| Code | When | Message (DSH's, adapted where it names a package) |
|---|---|---|
| `JOB_UNKNOWN` | no job has the id | `unknown job <id>` |
| `JOB_FOREIGN` | the job belongs to another session | `job <id> belongs to another session` |
| `JOB_INVALID_ARGS` | an empty `job_id`, a bad wait timeout or read offset, an empty kind or label, a bad `outputLimitBytes` | `invalid job_id: expected a non-empty string, got ""`, `invalid wait timeout: …`, `invalid output read offset: …`, `invalid job kind: …`, `invalid job label: …`, `invalid outputLimitBytes: …` |
| `JOB_OWNER_UNAVAILABLE` | the owner session does not exist, or no session store is reachable | `session "<id>" has no live agent (background job owner must be live)`; `background job ownership requires the session store (load the session row)` |
| `JOB_UNAVAILABLE` | no controller serves the registry, or `bash` was asked for the background with no jobs row loaded | `background jobs unavailable: no job controller serves this agent (load the jobs row, src/plugins/jobs.ts, in its composition)`; `background jobs unavailable: load the jobs row (src/plugins/jobs.ts)` |
| `JOB_LIMIT` | the owner already holds the cap of running and stopping jobs | `background job limit reached for this owner (limit: 10); use job_kill to stop an unneeded job, wait for it to finish, then retry` |
| `JOB_WAIT_ABORTED` | the turn was stopped during `job_output`'s wait | `wait aborted` |
| `JOB_LIVE` | `remove` on a job that has not settled | `job <id> is still <status>; kill it and wait for settlement before removing it` |
| `JOB_DISPOSED` | a start after the registry was disposed | `jobs service disposed` |
| `TOOL_ABORTED` | a background start after the turn was stopped | `tool call aborted` |

The routes answer an unknown or foreign job as `404 {code: 'job/not-found', message}` (DSH's code) and any other
refusal as `400 {code, message}`. An error is recognised by class **or** by name and code, because the server is
compiled while a row's registry may be loaded from source.

## How `bash` reaches the registry

The tools row builds `bash` (`src/tools/builtin.ts`) over the sandbox service; the jobs row attaches a
`BashBackground` for that service (`attachBashBackground`). While one is attached, `bash`'s schema carries
`run_in_background` with DSH's description and a call that sets it is handed to the runner; with none attached the
schema and the foreground run are exactly what they were. The seam is keyed by the sandbox service — unwrapped from
Cordis's per-context proxy — because that is the one object both rows already share; the tools row is unchanged and
the dependency stays optional. A background command is confined by `launchShell`, the same function the foreground
run uses.

## Where heddle differs from DSH, and why

- **Owner liveness is session existence.** DSH requires a live agent for the owner and cancels its jobs when that
  agent is disposed (`owner disposed`). Heddle has no per-session agent object, so the owner must exist in the session
  store, and a job lives until it ends, is killed, or the row is disposed (`jobs service disposed`).
- **The archive kill is a method, not a hook.** `killOwnedBy(session, 'session archived')` exists; heddle has no
  archive event yet (the schedule row notes the same gap), so nothing calls it.
- **The tool call is read from the log.** DSH's producer receives the call id; heddle's tool context carries none. As
  `bash` is an exclusive tool, the running call is the first unanswered `bash` call of the current model answer with
  the same arguments; `toolCall` is omitted when the log cannot say.
- **Delivery.** DSH's `followup` is a turn whose prompt is the notice (`runTurn`, purpose `jobs-notice`), and its
  `inject` is the session inbox's next-step list (`queueSteer`). A notice injected into a turn that ends before it
  claims it is answered by a turn of its own once the session is idle, as heddle's background-subagent notice is. A
  person's message (a user message with no `source`) resets the wake count, as DSH's claimed user message does.
- **Background stdin is closed.** A background command's stdin is `ignore`, since nothing can ever write to it; the
  foreground run keeps its pipe.
- **The `tool:jobs` prompt section** reaches the model through the `model/request` waterfall (`withJobsSection`):
  DSH's text, after a blank line, at the end of the request's first `system` message, or as that message when there
  is none, on every request that offers `job_output`. DSH composes it into its system prompt; heddle composes no
  sections, and the session log keeps the request as the loop built it.
- **`promoteOnTimeout`** (default true) is the jobs row's option, not `bash`'s: the tools row builds `bash` without
  knowing about jobs, so the row hands it `runForeground` through the same seam. While it is set, every foreground
  call is a job from its start, as DSH's is: ended in time, the record is removed and the call answers as the
  foreground does (`shellResult`, shared); still running at the wall time, nothing is killed and the call answers
  DSH's promoted text; stopped, the job is killed with `tool call aborted` and removed. A registration the row refuses
  (the session at its cap) runs in the foreground with the wall-time kill. With it false, the wall time kills.
- **Not ported**: the `outputLimitBytes` truncation of tool answers and notices (no heddle producer sets a limit),
  spill files, and the streamed `job.list` / `job.follow` frames — the page refreshes on the `jobs` event and polls
  the follow route.

## Tests

- [`../../test/jobs-promote.test.ts`](../../test/jobs-promote.test.ts) — `promoteOnTimeout`: DSH's promoted text, a call
  that ends in time (no record, no notice), one that outlives its wall time (output so far, then `job_output` goes on),
  the notice of a promoted job, a Stop during the wait, the option off, and the cap's foreground fallback.
- [`../../test/jobs-registry.test.ts`](../../test/jobs-registry.test.ts) — the ring, ids, preflight order and texts,
  the cap, consuming against non-consuming reads, result-once, kill and settle with the reason merged, wait, remove,
  ownership, the session-log events, the event stream, the pump, teardown.
- [`../../test/jobs-tools.test.ts`](../../test/jobs-tools.test.ts) — the renderings and schemas verbatim, the `bash`
  schema with and without the runner, and background `bash` end to end with real processes: kill reaches the process
  group, SIGKILL after the grace period, `exit code: 3`, spawn failure, the logged tool call, and the rows composed.
- [`../../test/jobs-notice.test.ts`](../../test/jobs-notice.test.ts) — the notice text, wake against inject, the
  rescue of an unclaimed notice, every case with no notice, `quiet`, the wake budget, then the plugin over a real
  session store and the real turn loop.
- [`../../test/jobs-http.test.ts`](../../test/jobs-http.test.ts) — the three routes over HTTP.
- [`../../_verifiers_/50-agentic-loop/check-jobs.mjs`](../../_verifiers_/50-agentic-loop/check-jobs.mjs) — rows A50-A55
  and A57 through `heddle web` and the scripted endpoint.

## Read next

[`../INDEX.md`](../INDEX.md) for the source tree, and [`../schedule/INDEX.md`](../schedule/INDEX.md) for the other
subsystem that starts turns in a session on its own.
