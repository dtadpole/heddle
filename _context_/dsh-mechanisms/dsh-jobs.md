---
title: DSH background jobs, and how subagents run in the background
level: L2
version: 1.0.0
description: How DSH keeps long-running tool work alive — the ctx.jobs registry, its process-local backend, the three model-facing controls, completion notices, and the bash/workflow/pwsh/one-shot-subagent producers — and how a background subagent differs from a background job, read from the installed 0.2.0-rc.2 build and observed live in its Web GUI.
status: unverified
grounded_in:
  - source: human-authored
  - source: the installed DSH packages at ~/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai, all at 0.2.0-rc.2, read on 2026-10-18
  - source: live DSH Web GUI session session-419fafd5-0ef8-4283-9332-1b0d975d12af on local port 3080 and its session log at ~/.dsh/sessions/--Users-zhenc-heddle--/session-419fafd5-0ef8-4283-9332-1b0d975d12af/session.v4.jsonl.zstd, observed on 2026-10-18
---

# DSH background jobs, and how subagents run in the background

Read against the installed build:

```
P = ~/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
```

every package at `0.2.0-rc.2`. Citations are `package/file:line` under `P`. A fact marked
`(observed)` was seen in this machine's live DSH Web GUI and its session log, not only in the
code; everything else is `(read)` from the shipped JavaScript and types.

## 1. Two lanes, not one

DSH has **two unrelated ways** for work to outlive one model step, and they are easy to confuse
because both are called "background":

| | background **job** | background **continuable subagent** |
|---|---|---|
| runtime | `ctx.jobs` (a generic long-running-work registry) | `ctx.subagents` (a durable child session plus a process-local Activation) |
| identity | `JobId` `<kind>-N`, e.g. `bash-1`, `workflow-3` | the child's **SessionId** (a UUID) |
| what exists | one in-memory record owned by a session; a producer `run()` does the work | a real child Agent with its own session, model, tools and depth |
| the model collects it with | `job_output`, `job_list`, `job_kill` | `send_message`, `interrupt_agent`, `list_agents`, or by reading the child session |
| completion reaches the parent as | a `tool-jobs` notice, optionally waking an idle owner | a `subagent-settled` notice, optionally waking an idle owner |
| survives a DSH restart | no — the record and its output die with the process | the child session and its descriptor do; the notice does not replay |

The bridge between the lanes is one sentence in the shipped code: *"Only the one-shot background
path uses Jobs; continuable children have no Task, no per-message result, and no Task
cancellation."* (`dsh-subagent/lib/types/run-settlement.js:1-5`). A **one-shot** background
subagent is a job whose producer happens to start a child agent; a **continuable** background
subagent is not a job at all.

## 2. The job contract: `ctx.jobs`

`JobRegistry` is an abstract Cordis service named `jobs` (`dsh-jobs/lib/index.js:115-121`,
`super(ctx, "jobs")`), declared on `Context.jobs` (`dsh-jobs/lib/types/index.d.ts:16-20`).
Loading the abstract class directly throws, so a composition with no backend fails at load
rather than registering an empty service.

The service members (`dsh-jobs/lib/types/index.d.ts:59-146`):

| member | signature |
|---|---|
| `events` | `readonly events: JobEvents` — a getter, subscribed with `events.subscribe(filter, listener)` |
| `start` | `start(spec: JobSpec): JobId` — synchronous; registers, or throws before any work runs |
| `list` | `list(caller?: SessionId): JobView[]` |
| `get` | `get(id, caller?): JobView` — fresh projection |
| `read` | `read(id, caller?): JobRead` — advances the **model** cursor |
| `readAt` | `readAt(id, from, caller?): JobOutputRead` — non-consuming, for observers |
| `kill` | `kill(id, caller?, reason?): 'requested' \| 'already-finished'` |
| `wait` | `wait(id, timeoutMs, caller?, signal?): Promise<JobView>` — never cancels |
| `remove` | `remove(id, caller?): void` — settled records only |
| `attachController` | `attachController(name): () => void` — a producer may start only when one is attached |

There is **no `onCompleted` callback** anywhere in the four job packages. Completion is an event:
`events.subscribe` yields `registered`, `progress`, `stopping`, `removed`, `settled`, and
`output` (`dsh-jobs/lib/types/types.d.ts:187-210`). The `settled` event is the one that matters —
it carries `cause: 'producer' | 'kill' | 'teardown'` and `awaited: boolean`, and it is emitted
**after** every released waiter has been resolved (`dsh-jobs-local/lib/index.js:736-756`). The
`output` event carries only `{id, owner?, total}`, never a payload: an observer is expected to
call `readAt` itself.

Status is a fixed five-value set — `running | stopping | completed | killed | failed`
(`dsh-jobs/lib/types/view.d.ts:15`); only the last three are terminal
(`dsh-jobs-local/lib/index.js:347-349`). A producer's outcome is narrower —
`completed | killed | failed` (`dsh-jobs/lib/types/types.d.ts:13-28`) — so `stopping` is
registry-owned state, never something a producer returns.

Identity is a branded string and nothing more (`JobId`, `dsh-jobs/lib/index.js:62-64`); the local
backend makes it `` `${spec.kind}-${count}` `` from a **process-wide, per-kind** counter
(`dsh-jobs-local/lib/index.js:420-422`). Ids are predictable by design, which is why the fence is
authorization rather than secrecy (`dsh-jobs/lib/types/index.d.ts:33-34`).

Ownership is the **session id**, not the agent id and not the tool call. `start` resolves
`spec.owner` to a live Agent (`dsh-jobs-local/lib/index.js:527-533`) and every read/control goes
through one comparison (`lib/index.js:565-567`):

```js
assertAccess(job, caller) {
  if (job.owner !== void 0 && job.owner.id !== caller)
    throw new Error(`job ${job.id} belongs to another session`);
}
```

A job with no owner is open to any caller; a caller-less call can never reach an owned job;
`list` returns the caller's jobs plus every unowned one (`lib/index.js:493-495`). Owner disposal
cancels and awaits its jobs and drops the records (`lib/index.js:762-776`); service disposal does
the same for everything (`:791-799`). Separately, the seam's constructor installs workspace
archive admission: `workspace/session-activity` reports running/stopping jobs, and
`workspace/session-stop` kills each with the reason `session archived`
(`dsh-jobs/lib/index.js:19-39`).

**Output is one bounded ring per job, addressed by absolute UTF-8 byte offsets.** A chunk is
`{at, text, channel?: 'stdout'|'stderr'|'log', gapBefore?: true}` (`view.d.ts:38-49`); the view
carries `output: {total, earliest, spillPaths?}` (`view.d.ts:89-93`). `stdout` and `stderr`
reach the model's consuming read; `log` is producer narration that only observers see
(`view.d.ts:31-36`). A producer either pushes through a `JobHandle` (`append`, `updateProgress`)
or names pull sources (`JobOutputSource.read(fromByte)`) that the registry pumps; it gets
`JobHooks` (`cancel(reason?)` and `done: Promise<JobOutcome>`) for control
(`types.d.ts:50-110`). The producer's optional `result` string — a workflow's rendered value, a
subagent's report — is handed out **exactly once**, on the first terminal `read`
(`types.d.ts:22-27`, `dsh-jobs-local/lib/index.js:601-602`).

`JobKindMap` is merge-extensible and the shipped build has four extensions: `bash` and
`subagent` from the seam itself (`view.d.ts:25-29`), `workflow` (`dsh-tool-workflow/lib/types/index.d.ts:17-18`)
and `pwsh` (`dsh-tool-pwsh/lib/types/index.d.ts:25-26`).

## 3. The shipped runtime: `dsh-jobs-local`

The backend is one in-memory `Map` of `TrackedJob` records — no child process table, no file, no
serialization (`dsh-jobs-local/lib/index.js:370`). The producer owns execution resources; the
registry owns identity, lifecycle, the ring and the model cursor.

Defaults (all optional config, `dsh-jobs-local/lib/index.js:339-345, 357-360`):

| field | default | meaning |
|---|---|---|
| `maxConcurrentJobsPerOwner` | `10` | running + stopping per exact owner; unowned jobs share one bucket |
| `retainBytes` | `262144` (256 KiB) | live ring retention per job |
| `settledRetainBytes` | `16384` (16 KiB) | ring kept after settlement, never below the model's unread bytes |
| `pumpPollMs` | `150` | pull-source polling cadence |

Lifecycle details that change how the feature behaves:

- **Capacity is a wall, not a queue.** At the cap `start` throws before the producer runs —
  `background job limit reached for this owner (limit: N); use job_kill to stop an unneeded job,
  wait for it to finish, then retry` (`lib/index.js:419`). There is no queueing and no preemption.
- **Settlement is first-wins, and the event comes last.** The earliest terminal outcome records
  once, the pump drains one final time, the ring trims, released waiters resolve, and only then is
  one round of contained `settled` delivery followed by a final `output` event
  (`lib/index.js:736-756`).
- **`awaited` means "a live wait was released", not "someone was notified".** It is literally
  `waitResolvers.length > 0` at settlement (`lib/index.js:745-753`). A wait that timed out or was
  aborted has already removed itself, so its later settlement is announced normally.
- **Kill is cooperative and cancels before it changes state.** `killJob` calls the producer's
  synchronous `cancel(reason)` first, then sets `stopping`, records the reason and the
  `cause: 'kill'`, and emits `stopping` (`lib/index.js:611-622`). The registry holds no signal or
  process handle; the producer decides what cancellation means. A `cancel` that throws leaves the
  job `running` and propagates the throw.
- **A kill can settle as `completed`.** The status comes from the producer's outcome
  (`lib/index.js:738`), and the kill reason is merged only when that status is `killed` (`:739`),
  so a job that finishes during cancellation ends `completed` with `cause: 'kill'`.
- **Settlement does not shrink the ring below unread bytes.** It trims to
  `max(settledRetainBytes, total - modelCursor)` (`lib/index.js:744`); a job the model never read
  keeps the full 256 KiB live cap until its first terminal read trims it (`:603`).
- **Nothing is durable.** The records are in memory and "die with the harness process"
  (`dsh-jobs-local/README.md`); job ids are **not** in the session log at all —
  `KNOWN_SESSION_EVENT_TYPES` has no job event (`dsh-session/lib/types/known-event-types.js`), and
  a case-insensitive search for `job` across `dsh-session`, `-projection`,
  `-persistence-jsonl`, `-log-export` and `-format` finds nothing. `job_output` on an id from a
  previous process throws `unknown job <id>`. The counters restart at 1, so an old transcript's
  `bash-1` can alias a new job of the same kind.

The registry is also where the "no orphan work" rule lives: `start` refuses an owner that no
attached controller serves (`lib/index.js:412-414`), with an error that names
`@deepseek-ai/dsh-tool-jobs`.

## 4. Which tools produce jobs

- **`bash`** (and `pwsh`, same shape). With a registry loaded, *every* bash call registers its
  process as a job — `run_in_background: true` returns `started background job <id>` immediately,
  while a foreground call waits on the same registration and then `remove`s it, so the settlement
  is `awaited` and no notice follows a result the call already carries
  (`dsh-tool-bash/lib/index.js:391-437, 636-690`). A foreground command that outlives its timeout is
  **promoted**: it stays registered and the result says `[still running after <ms>; moved to
  background job <id>]` / `The command keeps running in the background. You will be notified when it
  finishes; read newer output with job_output, stop it with job_kill.` (`:181-183, 467-475`).
  Background jobs are started with `onExpiry: "none"`, i.e. the shell's own timeout does not apply;
  the shell's output collector still caps each stream and spills to a file, so "no timeout" is about
  time, not bytes. `enableRunInBackground: false` removes the parameter, rejects a forced `true`,
  and silently disables promotion too (`:342-343, 388-389, 659`).
- **`workflow`**. `run_in_background: true` registers the run as a job of kind `workflow` and
  returns `workflow "<name>" started in the background as job <id>. Its return value arrives with
  the completion notice; check on it with job_output, stop it with job_kill.`
  (`dsh-tool-workflow/lib/index.js:217-258, 378-397`). Its engine progress is mirrored into the
  ring as `channel: "log"` (:19-44), which the model's read filters out — so a running workflow's
  `job_output` says `(no new output)` while a browser can watch the phase lines. The script's
  value is the job's `result` and is handed out once, on the first `job_output` after settlement;
  the flag's "arrives with the completion notice" is loose, the notice only announces it
  (`dsh-tool-workflow/README.md`).
- **one-shot `subagent` / `subagent_fork`**. When the tool instance's `backgroundMode` is
  `one-shot`, `run_in_background: true` registers the child run as a job of kind `subagent` with a
  parent-owned `AbortController` for cancellation, and returns
  `started background subagent job <id>` (`dsh-tool-subagent/lib/index.js:534-555, 486`). Its
  report is the job's `result`, collected with `job_output`.
- **continuable `subagent` / `subagent_fork`** does **not** create a job (see §6).

A composition without `dsh-jobs-local` has no `ctx.jobs`; without `dsh-tool-jobs` there are no
tools and no controller, so `start` refuses. Both errors name the missing plugin, so a
misconfiguration is stated rather than silently degrading.

## 5. What the model sees and does

### 5.1 The three tools

Registered by `dsh-tool-jobs` (`dsh-tool-jobs/lib/index.js:297-415`), which also attaches the
controller (`ctx.jobs.attachController("tool-jobs")`, `:256`) and owns completion delivery.

- **`job_output(job_id, wait?, timeout_ms?)`** — reads the delta since the previous read for a
  stream job, or the result of a finished final-output job. It blocks only when `wait === true`,
  and then for `min(timeout_ms ?? 30000, 600000)`; a timeout **leaves the job running** and the
  read returns `[status: running]`. Every response ends with a `[status: ...]` line; stdout comes
  first, all stderr in one `[stderr]` section; `log` chunks never reach the model; bytes lost to
  retention or producer gaps end with a dropped-output line naming the spill paths when there are
  any (`:297-346`, `:61-70`). The producer's `result` appears once, on the first read after
  settlement.
- **`job_list()`** — `parameters: {}`; returns the caller's own jobs plus unowned ones, running and
  settled, with `owner`, ring offsets and `outputLimitBytes` stripped; rendered one per line
  `<id> [<kind>] <status> — <label>`, or `(no background jobs)` (`:350-365`, `publicJob` at `:28-39`).
- **`job_kill(job_id, reason?)`** — requests cancellation; the terminal result is
  `{outcome: 'cancellation-requested' | 'already-finished', job}` rendered `requested cancellation
  of job <id>` or `job <id> had already finished [status: ...]`. The `reason` is forwarded to the
  producer and merged into the terminal `detail` only if the job settles `killed` (`:367-415`).
  A model-requested kill is remembered so its completion notice is suppressed, because the model
  already has the answer.

A job's producer may attach `outputLimitBytes`; only `dsh-tool-jobs` enforces it, bounding the
complete model-facing read, kill snapshot or notice after the status metadata is added
(`:131-255`).

### 5.2 The prompt paragraph

`dsh-tool-jobs` registers one system-prompt section, and it is the sentence this repository's own
sessions receive verbatim (`:257-261`):

> Track every background job id you start. You are notified in-session when a job finishes — do not
> busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's
> work. Before giving a final answer, collect every still-relevant job with job_output (set wait:
> true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.

### 5.3 Completion notices — the other half of the feature

A `{ owners: 'scope' }` subscription turns a settlement into a **user-role message injected into
the owner's conversation**, never a new event type of its own. The subscription skips `removed`
events, settlements already `awaited` by a live wait, settlements whose `cause` is `teardown`,
unowned jobs, and ids the model killed through `job_kill`; then it resolves the owner Agent and
delivers (`:263-296`):

- **idle owner, `completionDelivery: "wakeup"` (default)** — `owner.followup(message)`, i.e. one
  independent model request. `maxConsecutiveWakes` (unset = unbounded) caps how many turns one
  owner may be woken for; each wake is counted per Agent in a `WeakMap` and the budget is
  restored when the owner claims a user-authored message (`agent/inbox/claimed`, `:230-232`).
  Past the budget, notices degrade to injection.
- **busy owner, or `quiet` delivery** — `owner.inject(message)`, which lands in the next step's
  inbox. "The turn cannot close while the inbox holds it", so several jobs settling together
  cost one step rather than one turn each.

The notice text is exactly (`fitCompletionNotice`, `:163-179`):

```
background job <id> (<kind>: <label>) finished [status: completed, exit code: 0]. Read its output with job_output.
```

with `source: { kind: 'tool-jobs', form: 'notice', summary }`. The delivery is itself a session
event — `session.append("agent/inbox/spliced", splice)` — and the claimed batch becomes an ordinary
`user/message` with `surfaceOp: "append"` at the start of the next step
(`dsh-agent-loop/lib/index.js:204, 1061`). So the notice is a **permanent user-role message** in
history and the model cannot tell it from human input except by its text; an idle owner gets it as
the first message of a new turn, a busy one gets it at the next step boundary, and nothing here
aborts or re-sends the in-flight request. `(observed)` In this session a
foreground `sleep` command was promoted to job `bash-11115`; its completion appeared in the
session log as an `agent/inbox/spliced` event with `target: "next-step"` carrying that exact
text and source. The corresponding config is `dsh-tool-jobs`: `waitTimeoutMs: 30000`,
`maxWaitTimeoutMs: 600000`, `completionDelivery: 'quiet' | 'wakeup'`, `maxConsecutiveWakes`
(`:89-92`).

Three consequences a reader should not have to derive:

- **Interrupting the turn does not stop a background job.** A bash job spawns under its own
  `AbortController` and the tool passes only that signal to the shell; `exec.signal` is checked
  before admission only (`dsh-tool-bash/lib/index.js:100-126, 401-407, 661`). A workflow run is
  started with no signal at all, so only a registry kill or owner teardown cancels it
  (`dsh-tool-workflow/lib/index.js:203-209, 228-233`). An interrupted *foreground* call does kill
  the job it was waiting on — but a promoted call has already returned, so its job is untouched.
- **A kill from the Web UI still notifies the model.** The remote `job.kill` always passes the
  reason `cancelled by the user` and does not enter the model-kill set, so only `job_kill` from the
  model suppresses the notice (`dsh-api-job-controller/lib/index.js:352-372`,
  `dsh-tool-jobs/lib/index.js:262-269, 403-408`).
- **No shipped producer sets `outputLimitBytes`.** The clipping ladder exists and is enforced only
  by `dsh-tool-jobs`, but a grep for the field finds only the registry's validation and the tool's
  own read; a bash job's label is the entire command line and rides the notice verbatim.

### 5.4 The API and the jobs panel

The Host exposes `ctx.jobController`, a Typert remote service in the `job` namespace, with three
wire invocations: `job.list` (stream, per session), `job.follow` (stream, from a byte offset) and
`job.kill` (command, fixed reason `cancelled by the user`). `follow` subscribes to
`{ owners: 'all' }`, reads with non-consuming `readAt`, and closes on the terminal status once the
cursor reaches the ring total (`dsh-api-job-controller/lib/index.js:83-200, 307-373`). Nothing
here is durable either: a Host restart loses every ring and roster
(`dsh-api-job-controller/README.md`).

The browser side is a *client* `ctx.jobs` service with `state`, `watchRows`, `observe` and `kill`,
streams reference-counted per session and per job (`dsh-api-job-controller/lib/client.js:192-263`).
`dsh-client-ui-jobs` renders one header action (`conversation.session.header.actions`, id
`job-list`, order 20): live rows first, settled rows after, a state dot, kind, label,
`progress ?? detail`, a live duration, an expandable ring view with a 128 KiB render tail, and a
stop control that arms on the first press and confirms on a second within 3 s. "Clear" hides
settled rows client-side and never calls `remove` (`dsh-client-ui-jobs/lib/client.js`). The
browser can list, follow and kill; it cannot wait, consume the model cursor, remove records, or
choose a kill reason.

## 6. Background subagents

The tool is one plugin mounted once per delegation target; `toolName` defaults to `subagent` and
the shipped compositions also mount `subagent_fork` (`dsh-tool-subagent/lib/index.js:254-262`).
Its background policy is configuration:

| field | default | meaning |
|---|---|---|
| `enableRunInBackground` | `true` | expose `run_in_background`; disabling also rejects a forced `true` |
| `backgroundMode` | `'one-shot'` | `one-shot` defaults a call to foreground; `continuable` defaults it to background |
| `provider` | required | `spawn` (fresh child), `fork` (seeded from the parent's completed turns), or an out-of-process backend |
| `maxDepth` | Host setting, `1` | absolute delegation-depth cap; `0` forbids delegation; `'provider-managed'` opts out |
| `agentOptions`, `persona`, `toolFilter` | — | per-child model/effort, persona and tool restriction, when the provider supports them |

The effective route is `run_in_background ?? continuable`
(`dsh-tool-subagent/lib/index.js:360`), so the same package yields **three** outcomes:

| route | immediate result | the model sees |
|---|---|---|
| foreground (one-shot without the flag) | the child's final text | the answer as the tool result |
| **one-shot background** | `{kind: 'background', jobId}` | `started background subagent job <id>` — collect with `job_output`, stop with `job_kill` |
| **continuable background** | `{kind: 'continuable', subagentId}` | `started subagent <childId>` — continue with `send_message`; a notice arrives when the run settles |

The `run_in_background` description flips with the mode, so the same plugin's model-facing schema
changes on redeploy (`:425-429`): `"Defaults to true. Set false only when your next action depends
on the result."` under continuable, `"Run as a background job and return its id (collect with
job_output, stop with job_kill). Defaults to false."` under one-shot.

### 6.1 The continuable lane

1. `execute` calls `ctx.subagents.startContinuable({provider, label, request, signal})` and
   returns its `childId` (`dsh-tool-subagent/lib/index.js:527-533`). The child id is a durable
   **SessionId** minted as `randomUUID()`; the call resolves when the child's inbox **accepts** the
   initial prompt, not when the turn starts (`dsh-subagent/lib/index.js:1677`, `:2852-2856`).
2. `startContinuable` journals a `subagent/descriptor` (`mode: 'continuable'`, provider, label,
   resolved child route, persona, toolFilter), resolves depth, materializes the child Agent, and
   submits the prompt with `delivery: 'queue'` (`:1685-1755`).
3. Residency is `ContinuableActivationRegistry.resident` — an explicitly **process-local** `Map`
   keyed by child session id (`:760-761`). It holds the provider handle, the inbox, ancestry,
   owned children, the observer and an `announced` flag.
4. A settlement watcher waits for the child to go idle and then requires no closing transaction,
   an empty inbox and no owned children before it disposes; a pending injected message keeps the
   Activation resident and delays the notice (`:1201-1206`).
5. The **only thing that crosses back** is the epoch's final assistant text plus the stop reason,
   in the settlement notice (`:613-653`, `:300-312`). There is no per-run result and no collected
   output.

The settlement notice (`createSettlementMessage`, `:633-653`) is a user-role message with
`source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: childId }`; the
first line is one of

```
Background subagent <childId> finished and will do no further work unless you send it more.
Background subagent <childId> was stopped before it finished.
Background subagent <childId> ran out of room before it finished.
Background subagent <childId> declined the task.
Background subagent <childId> failed before it finished.
```

followed by `Its closing message:` and the nonempty text blocks, or `It left no closing message.`
Delivery is `sendWaking(parent, message, parent.status === 'idle' ? 'queue' : 'steer')`
(`:1263`): an idle parent gets a new turn, a busy one is steered. A settlement whose parent Agent
is gone is dropped silently (`:1257-1259`); during the parent's own teardown it is only injected.
`(observed)` The settlement of the research subagent in this session appeared in the log as
`agent/inbox/spliced` with `target: 'next-step'`, that exact text and source kind
`subagent-settled`.

The child's own turns carry a return-guidance block only when the child's scope resolves the
standard `send_message` tool: *"Your parent agent id is … Before you finish, send your result to
that agent with send_message(…)"* (`:599-608`, gate at `:1738`).

### 6.2 Control of a continuable child

`dsh-tool-subagent-control` adds the global tools (`dsh-tool-subagent-control/README.md`):

- **`send_message(agent_id, message)`** — steers a working child at its nearest step boundary, or
  starts/resumes an idle one; it returns acceptance (the accepted `messageId`) and never the
  reply. A parent may message its direct continuable child; a resident child may message its
  direct parent. A missing child is **cold-resumed** from the durable session and descriptor
  (`dsh-subagent/lib/index.js:1808-1815, 1911-1965`).
- **`interrupt_agent(agent_id)`** — stops only the target's current turn, with `keepInbox: true`,
  so queued messages stay parked and descendants keep running (`:855`). Interrupting a finished
  agent is an accepted no-op.
- **`list_agents(scope?)`** — `running` / `inactive` from the live Agent registry, direct
  children by default or `descendants` with parent and depth annotations; one-shot children are
  omitted because they cannot accept `send_message` (`dsh-tool-subagent-control/lib/types/list-agents.js`).

Caps: `maxActiveSubagents` defaults to **8**, `maxDepth` to **1**, and the pool is per root and
inherited by descendants (`dsh-subagent/lib/index.js:2822-2823, 727-733, 970`). There is no message
size cap in `send_message`'s schema; only provider diagnostics are bounded
(`MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4096`, `:2494`).

### 6.3 What survives

The child session and its descriptor survive a DSH restart; a later `send_message` cold-resumes
it into a new residency epoch. The settlement notice does not replay, and the old epoch's work
produces no notice after the restart. Closing the parent session is not the same as disposing the
child: whether the Web UI stops resident children on parent-session close is unverified here.

### 6.4 Observed in this GUI

`(observed)` This session's tool catalog contains both `subagent` (spawn) and `subagent_fork`
(fork), each described as *"It runs in the background by default and returns a subagent id you can
continue with `send_message`; you are notified when the run settles."* — i.e. both are mounted
**continuable**. The composed config agrees: `~/.dsh/profiles/web/cordis.yml` lines 908-926 mount
the `delegation` group with `tool-subagent` (`provider: spawn`, `modelSelectionSettings: true`,
`backgroundMode: continuable`) and `tool-subagent-fork` (`provider: fork`,
`backgroundMode: continuable`); the `codex` and `claude-code` one-shot rows are `disabled: true`.
The base layer by contrast mounts fork **one-shot** (`dsh-base/cordis.patch.yml:370-388`), so the
Web presets are what make both delegation tools default to the continuable lane. In this GUI,
then, background delegation does not create a `ctx.jobs` job and does not appear in `job_list`;
jobs appear for `bash`, `workflow`, `pwsh`, and only for a subagent if a one-shot tool instance is
mounted (`subagent_codex` / `subagent_claude_code`, both disabled here).

## 7. The comparison, compressed

| question | background job | continuable background subagent |
|---|---|---|
| is it in `ctx.jobs`? | yes, by definition | **no** — the only `jobs` reference in `dsh-subagent` is a JSDoc sentence (`dsh-subagent/lib/index.js:2690`) |
| who owns it | a SessionId; the live Agent must be registered | the exact live parent Agent, validated by lineage |
| how to read its output | `job_output` (delta, `wait`, once-only `result`) | read the child session by id; the closing text is in the notice; `send_message` asks for more |
| how to stop it | `job_kill` → producer `cancel` (AbortController for a subagent) | `interrupt_agent` → current turn only, inbox preserved, child survives |
| how the model learns it finished | `tool-jobs` notice; idle owner woken unless budgeted/quiet | `subagent-settled` notice; idle owner woken (queued) |
| status the model can see | `running`, `stopping`, `completed`, `killed`, `failed` | `running` / `inactive` only; the stop reason appears in the notice |
| restart behavior | record gone; `unknown job <id>` | child resumable via `send_message`; notice never replayed |
| capacity | 10 running/stopping per owner | 8 active children per root, depth 1 |
| UI | header jobs panel, live output, stop | session-header catalog tree, child conversation, stop in composer |

The consequence worth stating: **a one-shot background subagent is just a job**, while a
continuable background subagent is **a session**. The lane is a configuration decision
(`backgroundMode`), not a property of "subagents" as a feature.

## 8. What this means beside heddle

Heddle today has neither lane: its delegation is one synchronous child turn whose final text
becomes the tool result (`src/agent/subagent.ts`, `src/tools/subagent.ts`), and it has no job
registry, no output ring, no completion notice and no continuable children. The two DSH shapes map
onto different pieces of what heddle already has — a job is an event-log record plus a producer
hook and a prompt notice, while a continuable child is a session plus a mailbox and live-turn
registry, which heddle's team layer already began. That mapping is a conclusion for the code and
the verifiers; this document only records what DSH does.

## 9. How this reading was verified

Three independent readings ran in parallel — the job registry and its API/UI, the producers and
the notice path, the background subagent lane — and every load-bearing fact was re-read in the
shipped files by the lead rather than accepted from a summary: the tool schemas and notice
delivery in `dsh-tool-jobs/lib/index.js:140-415`, the bash and workflow producers, the subagent
routes at `dsh-tool-subagent/lib/index.js:425-557`, the settlement notice in
`dsh-subagent/lib/index.js:600-700, 1240-1275`, and the composition in
`~/.dsh/profiles/web/cordis.yml`. Two live notices (a promoted bash job and a settled research
subagent) were read back out of this session's own log, which is where the `agent/inbox/spliced`
shape and both source kinds come from. The constants this reading leans on are asserted by
[`check-reading.mjs`](check-reading.mjs), whose last test reads this document; a fact that moves
in a future DSH makes the check name the document rather than pass silently.

Because a reading is only as good as the version it read: these line numbers are
`0.2.0-rc.2` under `$HEDDLE_DSH_ROOT` (default: the path above), and unverified points are
named in place rather than smoothed over.

## Read next

[`dsh-agent-teams.md`](dsh-agent-teams.md) for the subagent and team layers this lane sits under,
[`dsh-context.md`](dsh-context.md) for how the notice becomes part of the next request, and
[`../INDEX.md`](../INDEX.md) for the `_context_` type.
