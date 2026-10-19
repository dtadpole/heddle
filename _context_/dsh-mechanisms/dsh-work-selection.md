---
title: How DSH decides between a tool call, a background job, a delegation and a team
level: L2
version: 1.0.0
description: What DSH leaves to the model and what it supplies when work should outlive one step — the tool-call path and its gates, every way a background job actually starts, the model-facing sentences that say when, and how Agent Teams sit on the continuable-subagent lane, read from the installed 0.2.0-rc.2 build and observed in its Web GUI.
status: unverified
grounded_in:
  - source: human-authored
  - source: the installed DSH packages at ~/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai, all at 0.2.0-rc.2, read on 2026-10-18
  - source: live DSH Web GUI session session-419fafd5-0ef8-4283-9332-1b0d975d12af on local port 3080 and its session log under ~/.dsh, observed on 2026-10-18
  - source: the composed profile at ~/.dsh/profiles/web/cordis.yml, read on 2026-10-18
---

# How DSH decides between a tool call, a background job, a delegation and a team

Read against the installed build:

```
P = ~/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
```

every package at `0.2.0-rc.2`, plus this machine's composed profile at
`~/.dsh/profiles/web/cordis.yml`. Citations are `package/file:line` under `P`. `(observed)` marks
something seen in the live Web GUI and its session log rather than only in code.

This reading covers the **decision layer**: how a call is made at all, what makes some work become
a background job, which sentences DSH gives the model about when to choose each shape, and where
Agent Teams sit. The mechanisms themselves are in
[`dsh-jobs.md`](dsh-jobs.md) (the job runtime, tools and notices) and
[`dsh-agent-teams.md`](dsh-agent-teams.md) (the agent / subagent / team layers); this document does
not restate them.

## 1. The short answer

**DSH has no scheduler that decides to background work.** The model decides; DSH supplies four
things that shape the decision:

1. **A tool catalog** — which tools exist for this agent, and their schemas (`ctx.tools`).
2. **Descriptions that change with configuration** — the same plugin's `run_in_background` parameter
   carries different wording, and a different default, depending on `backgroundMode` /
   `enableRunInBackground`.
3. **Ordered prompt sections** — a fixed order table gives the model policy before tool advice
   (`PLAN_POLICY: 500`, `TEAM_POLICY: 600`, `TOOL_BASH: 1000`, `TOOL_JOBS: 1600`,
   `TOOL_WORKFLOW: 2600`, `TOOL_RALPH: 2700`, `TOOL_SUBAGENT: 2800`) plus surface text
   (`dsh-system-prompt/lib/index.js:9-40`).
4. **Automatic paths and caps** — two automatic ways for work to become background (a timeout
   promotion, and a mode default) and a set of limits that make "background everything" expensive.

The one-sentence version of DSH's own answer to *when*: **background is for work whose result the
next step does not need**, and the only place the build says that to the model in those words is the
continuable-subagent parameter description — *"Set false only when your next action depends on the
result."* Everywhere else the model infers it from consequences ("No timeout applies", "you are
notified when the job finishes").

## 2. How a tool call happens at all

A turn is a sequence of steps; each model response may carry tool calls. The loop executes them
through one scheduler, and that is the only path a tool ever runs (`dsh-agent-loop/lib/index.js`):

```js
async function executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext) {   // :506
  const planned = toolCalls.map((block) => ({ block, exec: { callId, name, arguments, agent, signal } }))
  ...
  const mode = ctx.tools.executionMode(first.exec).kind
  const outcome = await runGroup(ctx, turn, step, mode === "parallel" ? planned.slice(next) : [first], ...)
```

- **Grouping by execution mode.** Parallelism is **opt-in per tool and fail-closed**: a call joins the
  pool only when the tool's own classifier returns exactly `true` from `isConcurrencySafe(args)`;
  unknown, hidden, undeclared or throwing classifiers are `exclusive`
  (`dsh-tools/lib/index.js:3057-3065`). A parallel tool takes the rest of the message's calls, an
  exclusive one is a barrier, and the pool is bounded by `maxParallelToolCalls` (default 10,
  `dsh-agent-loop/lib/index.js:1285, 553`). Results always commit in **model order** even when
  execution overlapped (`:565-576, 619-621`).
- **One scheduler for every call.** Each call goes `prepare` → `dispatch` → (`finalize`) →
  `finish`, and only then is its result appended as `tool/result` (`:570-600`). The matching
  `tool/call` event is appended when the call starts (`:681-688`), the result when it commits
  (`:691-707`).
- **Abort is contained.** An abort stops new starts, drains and commits what started, appends
  synthetic `tool/call` + `tool/result` pairs for the unstarted calls, and rethrows nothing into the
  transcript (`:528-534, 663-679`); a whole-step throw is repaired by `ToolCallRecovery` so replay
  never sees a dangling call (`:973-989`).
- **The gates sit inside the call, before the body.** After a visibility snapshot and a
  caller-cancelled check, the `tools/pre-execute` waterfall may return `allow | deny | ask | cancel`;
  an `ask` goes to the approval service, then synchronous guards may veto; only then does the
  `tools/execute` waterfall wrap the actual `tool.execute`
  (`dsh-tools/lib/index.js:3140-3310`). A `deny` becomes an `isError` result the model reads; a
  `tools/post-execute` listener can only rewrite a result, never undo the effect
  (`:3503-3513, 3409-3427`). Plan-mode rules are **prompt text plus one tool**, not a permission
  gate (`dsh-plan-mode/lib/index.js:171-178`).
- **Sandbox denial is content, not an exception.** A confined file operation comes back as
  `[sandbox: file access denied under <mode> mode]` inside an ordinary result
  (`dsh-tool-bash/lib/index.js:140-171`); only spawn/abort/timeout are `isError`.

**Approval is the one gate the model cannot argue with, and its policy is part of the environment.**
`ask` calls the approval service; policy `never` returns `rejected` **without asking**
(`dsh-user-approval/lib/index.js:175`), which is exactly this session's state, so an escalation
request is rejected automatically rather than blocking. `(observed)` The runtime-context message for
this session says so: "Approval prompts are disabled in this session … do not request sandbox
escalation."

The practical consequence for this reading: **"the agent called a tool" is one event type with one
code path.** A background job is not a different kind of call — it is an ordinary tool call whose
result is a job id, and whose work continues after the call has returned.

## 3. What decides *which* tool the model can call

The catalog is per agent, not global (`ctx.tools.get(name, scope)`), and DSH can remove a tool from a
model's view or restrict its arguments without touching the tool's implementation:

- **Tool filters / scoping**: a subagent's child composition can be restricted with a
  `toolFilter {allow, deny}` (`dsh-tool-subagent` config), and an agent preset mounts a different
  set (the four presets in `~/.dsh/profiles/web/cordis.yml` each carry their own `delegation` group
  and tool rows).
- **Plan mode** (`PLAN_POLICY: 500`, preset text in `dsh-web-app/presets/*.patch.yml`): "The tool
  catalog stays the same across modes for request-cache stability", but the rules forbid mutation
  and make `exit_plan_mode` the only way out. The catalog does not shrink; the model is told not to
  use the mutating tools.
- **Name registration is a namespace.** Two packages can register the same tool name; the
  `(observed)` catalog shows the team plugin's `send_message` / `list_agents` descriptions, not
  `dsh-tool-subagent-control`'s, when both are mounted — the team layer wins the names it claims.
- **The schema is the contract.** A parameter that does not exist (`run_in_background` when the
  feature is off) cannot be passed: `enableRunInBackground: false` removes the parameter *and*
  rejects a forced `true` (`dsh-tool-bash/lib/index.js:658-659`,
  `dsh-tool-subagent/lib/index.js:356-358`).

**Hiding a tool is not a sandbox, though the dispatcher re-checks.** `tools.restrict({allow, deny})`
filters only what a scope **inherits**, never its own registrations
(`dsh-tools/lib/index.js:2944-2955`), and the dispatch boundary resolves the name again: an invisible
tool fails as `unknown tool "x"` — but only *after* `tools/pre-execute` has already seen the call
(`:3307-3308, 2537-2548`). What hiding cannot prevent is a side effect produced by another visible
tool (e.g. `bash`), so if correctness depends on something not happening, the enforcement has to be
approval, a guard, the sandbox or the tool's own refusal — not the catalog.

## 4. When a call becomes a background job

Grepping the whole install for `jobs.start(` outside the registry itself finds **two call sites**:
`dsh-tool-workflow` and `dsh-tool-subagent` (`dsh-tool-workflow/lib/index.js:223`,
`dsh-tool-subagent/lib/index.js:538`). Bash and pwsh reach the same registry through their own
`startJob` helper, which registers *every* invocation. That gives **four** job-producing surfaces —
bash, pwsh, workflow, subagent — and **three** ways a background job begins: an explicit flag, an
automatic promotion, or a mode default. `ralph` is a fifth delegation shape that never backgrounds.

| producer | how background begins | explicit or automatic | config that removes it |
|---|---|---|---|
| `bash` | `run_in_background: true` | **explicit** (default false) | `enableRunInBackground: false` |
| `bash` | foreground call exceeds its timeout | **automatic** (`promoteOnTimeout`, default true) | `promoteOnTimeout: false`, or background off (promotion is nested under it) |
| `pwsh` | same two paths as bash | explicit / automatic | same |
| `workflow` | `run_in_background: true` | **explicit** (default false) | `enableRunInBackground: false` |
| one-shot `subagent` | `run_in_background: true` | **explicit** (one-shot mode defaults false) | `enableRunInBackground: false` |
| continuable `subagent` | omitted `run_in_background` | **automatic default** (continuable mode defaults true) | `run_in_background: false` per call, or mount one-shot |
| `ralph` | — (foreground loop over workflow/subagent) | never background | disabled in the shipped presets |

Three details make the table behave differently from how it reads:

- **Every bash/pwsh foreground call is registered as a job too.** The foreground path waits on that
  registration and removes it, which is what makes the settlement `awaited` and suppresses a
  completion notice. Backgrounding therefore changes *who waits*, not whether the job exists
  (`dsh-tool-bash/lib/index.js:391-437, 658-690`).
- **Promotion makes "foreground" conditional on time, and the clock is the tool's own wait.** Every
  foreground bash/pwsh call is registered as a job and then awaited with the executor's deadline
  disarmed (`onExpiry: "none"`), so the *shell's* timeout never fires; the promotion trigger is the
  tool's `registry.wait(…, spec.timeoutMs)` expiring (`dsh-tool-bash/lib/index.js:439, 670-681`;
  `dsh-bash-local/lib/index.js:161-180`). The `timeoutMs` description says it outright: *"The executor
  applies its configured default and cap; on expiry the command moves to the background as a job
  instead of being killed."* The default is machine configuration: `dsh-bash-local` defaults to
  120 s (`dsh-bash-local/lib/index.js:71`), the shipped base lowers it to 60 s for `bash-sandbox`
  (`dsh-base/cordis.patch.yml:235-239`), pwsh keeps 120 s (`dsh-pwsh-local/lib/index.js:142-143`),
  and a model-supplied `timeoutMs` moves the threshold freely up to the 600 s cap. Two edges: if the
  wait expires before a process exists, the call is killed and returns a timed-out **foreground**
  result instead (`dsh-tool-bash/lib/index.js:444-466`); and if job admission is refused (owner at
  the 10-job cap, or no controller), bash logs the refusal and falls back to the foreground
  timeout-kill path (`:676-686`). The promoted result embeds one consuming read of the output so far,
  so `job_output` continues exactly after it (`:468-474`). `(observed)` A `sleep 60` call in this
  session was promoted at 60000 ms; the tool result became
  `[still running after 60000ms; moved to background job bash-11115]` plus the
  "You will be notified when it finishes" sentence, and the job id then worked with `job_output`.
- **The continuable lane's default is a configuration fact, not a property of subagents.** The
  tool's config declares `backgroundMode` default `'one-shot'` (`dsh-tool-subagent/lib/index.js:257`),
  and the effective route is `request.run_in_background ?? options.continuable` (`:360`). The shipped
  base mounts `subagent` continuable and `subagent_fork` one-shot; the Web presets override both to
  continuable. So "subagents run in the background" is true of this deployment and false of the bare
  base — see §7.
- **Once background, the call-timeout enforcer has nothing to enforce.** The bash tool declares no
  `timeoutMs` on its `defineTool` (`dsh-tool-bash/lib/index.js:487-695`), and
  `dsh-tool-call-timeout-policy` only arms a budget for tools that do (`lib/index.js:4`), so a
  backgrounded or promoted bash command is bounded only by `job_kill`, the owner's disposal, or the
  harness exiting. "No timeout applies" is literal.

## 5. The sentences DSH gives the model about *when*

The decision would be guesswork without text, so DSH ships policy and description prose. All of it,
for the shapes in scope:

- **Jobs — management, not selection** (`dsh-tool-jobs/lib/index.js:257-261`):
  > Track every background job id you start. You are notified in-session when a job finishes — do
  > not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running
  > job's work. Before giving a final answer, collect every still-relevant job with job_output (set
  > wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.

  This is the only prompt section about background jobs, and it assumes a job has already been
  started. It says nothing about when to start one; that judgement has to come from the tool
  descriptions and the task.

- **Bash — consequences, not a rule** (`dsh-tool-bash/lib/index.js:509-512, 501-503`):
  > Run in the background and return a job id immediately (collect with job_output, stop with
  > job_kill). No timeout applies.

  The foreground `timeoutMs` description carries the mirror-image sentence about promotion. Nothing
  says "background this because you have independent work"; the model has to infer the trade
  (a job id now vs a result up to the timeout later). The only other sentence in the install that
  tells the model to background anything is the **minimal** preset's persistent bash, and it means
  shell-level `&`, not `run_in_background`: *"Please run long lived commands in the background, e.g.
  'sleep 10 &' or start a server in the background."* (`dsh-web-app/presets/minimal.patch.yml:42,61`).

- **Subagent — the one explicit default rule** (`dsh-tool-subagent/lib/index.js:426-429, 400`):
  > Defaults to true. Set false only when your next action depends on the result.

  plus the tool-description suffix: *"It runs in the background by default and returns a subagent id
  you can continue with `send_message`; you are notified when the run settles."* and the prompt
  section *"Start independent subagent delegations together in one assistant message and continue
  useful work while they run."* (`:570-580`). This is the closest DSH comes to a general background
  policy, and it is scoped to delegation in the continuable mode.

- **Workflow — a scope restriction** (`dsh-tool-workflow/lib/index.js:262-267`):
  > Use the workflow tool ONLY when the user explicitly asks for a workflow or for large multi-agent
  > orchestration … For one or two delegations, prefer plain subagent calls.

- **Ralph — another explicit-ask gate** (`dsh-tool-ralph/lib/index.js:295-300`):
  > Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent
  > iterative execution … Use same-session goal tools for ordinary long-running objectives, and plain
  > subagents or workflows for bounded delegation and fan-out.

- **Teams — explicit-ask gate plus a collaboration contract** (`dsh-experimental-tool-agent-team/lib/index.js:21-31`):
  > Agent Teams is available in this session, but create teammates only when the user explicitly asks
  > to use Agent Teams or teammates.

  followed by the shared-filesystem, write-scope, mailbox and task-board rules (quoted in
  [`dsh-agent-teams.md`](dsh-agent-teams.md) §3.6).

- **Web surface — the one place backgrounding is prescribed** (`dsh-web-app/lib/index.js:92`):
  > … Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.

So the build's stated "when" rules cluster on **delegation**: workflows, ralph and teams require an
explicit human ask; plain subagents do not. Background jobs have **no selection rule at all** — only
consequences, a management policy, and one prescription for servers.

## 6. Choosing between the shapes

The model's actual choice is among five shapes, and DSH's own text gives each a scope:

| shape | the work it is for, per DSH's text | returns | who owns the result |
|---|---|---|---|
| foreground tool call | a step whose result the next step needs | the result | the calling session |
| background job | work that can finish later; "No timeout applies" | a job id | the calling session, via `job_*` |
| continuable subagent | independent/scoped work that can continue and report back; default background | a child id + a settlement notice | the child session |
| one-shot background subagent | the same, where the answer is a string collected once | a job id + `job_output` | the parent, as a job |
| workflow / ralph | fan-out or rounds, **only when explicitly asked** | a value or a loop result | the calling session |
| Agent Teams | several durable peers, **only when explicitly asked** | messages + task board | each member's own session |

A useful read of the table: **`background job` and `delegation` answer different questions.** A job
answers "how do I stop blocking on one call"; a subagent answers "how do I get another context". A
one-shot background subagent is the intersection, and the build names it honestly ("a plain
parent-owned Task"). Teams are *not* a third question — they are the many-peer form of delegation.

## 7. Where Agent Teams sit, and what they relate to

**Mechanically, a teammate is a continuable subagent child.** `spawn_teammate` starts a continuable
child through the configured provider (`freshProvider: spawn`, `forkProvider: fork`), records the
member in the Lead's session journal (`team/member`), and delivers messages through the same
continuable-child inbox; the tool simply adds identity, a roster, a mailbox and a task board. The
team code contains **no `ctx.jobs` reference at all** (grep over
`dsh-experimental-agent-team` and `dsh-experimental-tool-agent-team` returns nothing), and the
continuable-subagent code says the same from its side: *"Only the one-shot background path uses
Jobs; continuable children have no Task, no per-message result, and no Task cancellation."*
(`dsh-subagent/lib/types/run-settlement.js:1-5`). So:

```
agent
 ├── direct tool call ────────────── foreground, or a ctx.jobs job (bash/pwsh/workflow/one-shot subagent)
 ├── subagent ── one-shot ────────── ctx.jobs job of kind "subagent"  (nothing after the result)
 │            └─ continuable ────── durable child session + Activation (send_message / interrupt / notice)
 └── teammate ───────────────────── continuable child + journal + mailbox + task board (NO jobs)
```

Three consequences worth stating:

1. **A teammate can start jobs, and the Lead cannot see them.** Job ownership is fenced by the
   session id (`dsh-jobs-local/lib/index.js:565-567`), and a teammate is its own session. A
   teammate's `bash` background job belongs to the teammate: only the teammate's `job_list` shows
   it, only the teammate can collect it, and its completion notice is delivered to the teammate's
   conversation. The Lead sees the teammate's *messages*, never its jobs — and there is no transfer
   path for a job id, so handing one over is not a supported workflow. The teammate's report comes
   back the same way any continuable child's does, as a `subagent-settled` notice in the Lead's
   conversation (`dsh-subagent/lib/index.js:613-654`); the Team **mailbox** is a separate channel,
   used only by an explicit peer `send_message`, and its receipt is proven by the target's own log
   (`team/message/delivered` after the target records the message).
2. **Team waiting is not job waiting.** `wait_agent` is level-triggered on **edges**: its activity
   resolver is released only by a journal commit after flush or an `agent/status` change, never by
   polling, and it wakes nobody; `noProgress` is a model-facing shortcut taken *before* waiting when
   no other member is `running | provisioning` (`ACTIVE_WAIT_STATUSES`,
   `dsh-experimental-tool-agent-team/lib/index.js:28, 343-349`). `job_output(wait:)` instead resolves
   on a settlement or a timeout. The two waits are not interchangeable.
3. **The two lanes can be mounted together or not.** The bundled
   `dsh-experimental-agent-team-profile` is the opt-in layer that *disables* four base rows —
   `tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent`,
   `tool-subagent-fork` — and inserts the team service, tools and UI
   (`dsh-experimental-agent-team-profile/cordis.patch.yml:4-33`). Two reasons are bundled there:
   the control tools' `send_message` / `list_agents` / `interrupt_agent` **collide by name** with
   the Team tools, and the policy choice to route all delegation through the Team. This deployment
   does not use that bundle: it mounts the team service and tools at the root
   (`~/.dsh/profiles/web/cordis.yml:1461-1475`) **and** the direct `subagent` / `subagent_fork`
   tools in the standard preset, so the team's scoped registrations shadow the global control tools
   for each member. `(observed)` The live catalog therefore lists 54 tools, and its
   `send_message` / `list_agents` descriptions are the Team plugin's — both delegation lanes are
   visible at once. The consequence is a policy question, not a mechanism one: "create teammates
   only when the user explicitly asks" keeps teams opt-in, while plain subagents remain available
   for ordinary delegation; the only hard conflict is the three tool names, which shadow rather
   than coexist.

One more structural fact: **every ordinary runtime root is an implicit Lead.** There is no team
creation event; the durable state begins with the first member, message or task record, and the Team
tools are installed for every root agent once the plugin loads
(`dsh-experimental-agent-team/lib/types/roster.js:81,90`;
`dsh-experimental-tool-agent-team/lib/index.js:539-550`). The `team:policy` section at order 600 is
therefore present in every root session's prompt whether or not a teammate exists — which is why the
policy's first sentence, not the mere presence of the tools, is what keeps teams from being used
casually. The policy outranks every tool section, including `TOOL_SUBAGENT: 2800`.

## 8. Caps that bound the choice

DSH does not try to stop the model from backgrounding everything; it makes runaway backgrounding
observable and expensive:

| cap | value | what it bounds |
|---|---|---|
| `maxConcurrentJobsPerOwner` | 10 | running + stopping jobs per session; `start` throws rather than queueing (`dsh-jobs-local/lib/index.js:339, 419`) |
| ring retention | 256 KiB live / 16 KiB settled | what a job can keep for a late read (`:341-343`) |
| `maxConsecutiveWakes` | unset = unbounded | how many turns an idle owner may be woken by completions; past it notices degrade to injection (`dsh-tool-jobs/lib/index.js:88-93, 283-296`) |
| `completionDelivery` | `wakeup` | `quiet` keeps even idle owners on the injection lane |
| `maxActiveSubagents` | 8 | active continuable children per root (`dsh-subagent/lib/index.js:2822-2823`) |
| `maxDepth` | 1 | delegation depth (`:2822`) |
| team `maxMembers` / `maxTasks` / `maxPendingMessagesPerMember` | 8 / 256 / 64 | the team layer's own bounds (`~/.dsh/profiles/web/cordis.yml:1461-1468`) |

The wake budget deserves its own sentence: a woken turn may itself start work whose completion
wakes it again, so **backgrounding is a self-exciting loop**; the cap exists precisely because the
default is unbounded.

## 9. Observed in this deployment

- The composed profile mounts `jobs-local` and `tool-jobs` at the root, bash/pwsh through the shell
  plugins, the direct subagent tools continuable in the standard preset, and the team service and
  tools at the root — both delegation lanes visible at once (§7).
- The live tool catalog has **54 tools**; the background-relevant ones are `bash`, `workflow`,
  `job_output`, `job_list`, `job_kill`, `subagent`, `subagent_fork`, plus the team's
  `spawn_teammate`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent` and
  `team_task_*`. `ralph` and the one-shot `subagent_codex` / `subagent_claude_code` are not
  present (disabled in the presets).
- `(observed)` A foreground `sleep 60` was promoted to `bash-11115` at the profile's 60 s executor
  timeout, and its completion arrived as an in-session notice — the automatic path, exercised by
  accident while doing this research.
- `(observed)` The research subagents in this session were started with the continuable default
  (no `run_in_background` argument) and returned `started subagent <uuid>`; their settlements
  arrived as `subagent-settled` notices. No job id was involved, which is the two lanes' difference
  demonstrated on this machine.

## 10. How this reading was verified

Three readings ran in parallel (the tool-call path and its gates; the complete background-trigger
surface; the teams/delegation relationship), and every load-bearing claim was re-read in the shipped
files by the lead: the loop's call path (`dsh-agent-loop/lib/index.js:506-600`), the trigger table's
per-producer code (`dsh-tool-bash`, `-pwsh`, `-workflow`, `-subagent`), the prompt sections and the
order table (`dsh-system-prompt/lib/index.js:9-40`, `dsh-tool-jobs`, `-subagent`, `-workflow`,
`-ralph`, `dsh-experimental-tool-agent-team/lib/index.js:21-31`), and the composition
(`~/.dsh/profiles/web/cordis.yml`). The live catalog and both notices were read back out of this
session's log. [`check-reading.mjs`](check-reading.mjs) asserts the constants and sentences this
reading leans on, including its own statements, so a future DSH that moves them names this document
instead of passing silently.

## Read next

[`dsh-jobs.md`](dsh-jobs.md) for the job runtime and its notices, [`dsh-agent-teams.md`](dsh-agent-teams.md)
for the team journal, mailbox and task board, and [`../INDEX.md`](../INDEX.md) for the `_context_` type.
