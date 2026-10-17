---
title: DSH agents, subagents and agent teams
version: 1.0.0
description: How DSH models an agent, how a parent delegates to a child subagent, and what its experimental agent team adds, verified against the installed build.
grounded_in:
  - source: human-authored
  - source: dsh-0.2.0-rc.2
---

# DSH agents, subagents and agent teams

Read against the installed DSH 0.2.0-rc.2 (`~/.volta/.../@deepseek-ai/dsh/node_modules/@deepseek-ai/`).
Three layers, increasingly ambitious:

| Layer | Packages | What it is |
|---|---|---|
| **agent** | `dsh-agent` | one agent owns one session and drives it; `ctx.agents` is the registry |
| **subagent** | `dsh-subagent`, `-in-process-driver`, `-spawn-in-process`, `-fork-in-process`, `dsh-tool-subagent` | a parent agent spawns a **child run** and receives its result |
| **agent team** | `dsh-experimental-agent-team`, `-profile`, `-tool-agent-team`, `-client-ui-agent-team` | several agents in one session with a roster, a mailbox, a shared task board and a journal |

## 1. An agent is a session's driver

`dsh-agent/lib/types/index.d.ts`:

```ts
CreateAgentOptions {
  sessionId; parentAgent?;
  meta?: { cwd?, parentSession?, isSeeded?, origin?: 'subagent', delegationDepth?, agentPreset? }
  inheritedEventCount?; seed?: readonly SessionEvent[];
  agentOptions?; signal?; setup?;
}
AgentFactory { createAgent(ownerCtx, options): Promise<AgentHandle>; resume(ownerCtx, options): Promise<AgentHandle> }
AgentHandle { agent; dispose(): Promise<void> }
```

Two facts matter for the delegation model. An agent is **created for a session** (or resumed for one), and a
child may be created with a **parentAgent**, `origin:'subagent'`, a `parentSession`, a `delegationDepth`, and
optionally `seed` + `inheritedEventCount` — i.e. a child can run in the **same session with inherited history**,
or in a session of its own. The registry (`ctx.agents`) owns dispatch and the initiator/queue machinery.

## 2. A subagent is a child run, not a second name for an agent

`dsh-subagent/lib/types/index.d.ts` exports the run vocabulary (`SubagentRun`, `SubagentRunId`,
`SubagentResult`, `SubagentStopReason`, `SubagentStartRequest`, continuable starts) and a runtime
`ctx.subagents: SubagentRuntime` with **providers** registered by packages:

- `dsh-subagent-in-process-driver` — `startInProcessRun(request, {seed?})`: runs the child **in this process**;
- `dsh-subagent-spawn-in-process` / `dsh-subagent-fork-in-process` — two providers (spawn a fresh child,
  or fork one seeded from the parent's history);
- `dsh-tool-subagent` — the **model-facing tool**; its config chooses the `provider`, an optional `toolName`,
  `enableRunInBackground` with `backgroundMode: 'one-shot' | 'continuable'`, `agentOptions`, `persona`, a
  `toolFilter {allow, deny}`, and `maxDepth`.

Limits are part of the runtime, not the tool: `Config {maxActiveSubagents, maxDepth}`, and
`assertSubagentMaxDepth` throws `SubagentDepthError("subagent depth N exceeds maxDepth M")`
(`lib/index.js:382-384`). The child's session metadata is built by `childSessionMeta(parent, childDepth,
isSeeded)` (`lib/index.js:470-481`):

```js
{ cwd, agentPreset, parentSession: parent.session.header.id, isSeeded, origin: 'subagent', delegationDepth }
```

The result is **not** a shared conversation: the child's own events are folded with `finalAssistantOutput(events)`
(`lib/index.js:184`), and `settleRun`/`settleRunResult` publish the settled run with its stop reason. A run can
be cancelled (`SubagentInterruptAuthority`, `interrupt`), and policy/composition overrides are delegated to the
child explicitly (`appendDelegatedPolicyOverrides`, `applyChildComposition`). Descriptors are **versioned**
(`SUBAGENT_DESCRIPTOR_VERSION`), so a changed shape fails loudly rather than being guessed.

## 3. The team layer: several agents in one session

`dsh-experimental-agent-team/lib/types/index.d.ts` — `ctx.agentTeams: TeamService`:

```ts
membership(agent); listMembers(agent);
spawnTeammate(caller, request); sendMessage(caller, request);
createTask(caller, request); getTask(caller, id); listTasks(caller);
updateTask(caller, request);
waitForChange(caller, timeoutMs, signal);
interrupt(caller, targetName);
```

Backed by files of its own: `roster` (who is on the team), `mailbox` (messages between agents, steered at step
boundaries), `task-board` + `task-graph` (shared tasks with ids and revisions), `journal` + `persisted` (durable
team state), `projection`/`activity`/`lifecycle`, `validation` and `TeamError`. The model-facing tool
(`dsh-experimental-tool-agent-team/lib/index.js`) exposes `spawn_teammate` (`:243`) and `send_message` (`:296`)
alongside the list/wait/interrupt/task tools. Its descriptions carry the semantics: a delivered message is
durable even when reported queued; `wait` only observes changes after the call starts and never wakes a member;
tasks are claimed with the current revision and completed, never "made ready"; a Lead must wait for required
teammates before answering.

So "agent team" = **one session, several long-lived agents, a roster, a mailbox, and a shared task board,
persisted so the team survives a restart**. It is explicitly experimental; the subagent layer is the stable
primitives beneath it.

## 4. What heddle had, and what this reading produced

Heddle before this reading: **no agent abstraction at all** — `src/agent/loop.ts` is a function `runTurn`,
a session is one append-only log, and context/goals/tools are keyed by the session. So the first honest slice
is the **subagent layer**, not the team layer:

- an **agent identity in the log's metadata**: a child session records `parentSession`, `origin:'subagent'` and
  `delegationDepth`, exactly the fields `childSessionMeta` writes;
- a **delegation tool** the parent's model calls, which creates a child session, runs one bounded child turn
  (its own context, its own tool scope, its own model/endpoint), and returns the child's **final assistant
  text** into the parent's turn — the shape `finalAssistantOutput` + `settleRun` implement;
- **depth and active limits** enforced by the runtime, refusing beyond them with a stable code;
- **cancellation** through the parent's abort signal, so a stopped parent does not leave a child running.

The team layer is recorded as the next slice and is **not** claimed by this reading: heddle has no roster,
mailbox or task board, and a same-session child (the `seed`/`inheritedEventCount` path) is not implemented.
The comparison at the end of the implementation says what remains and why.

## 5. After implementation: the comparison

Heddle now has the **subagent layer**, not the team layer. Mapped against the reading:

| DSH | Heddle | Verdict |
|---|---|---|
| `childSessionMeta`: `parentSession`, `origin:'subagent'`, `delegationDepth`, inherited cwd | the same four fields in `SessionMeta`, written when the delegate creates the child | matched |
| `dsh-tool-subagent`: a model-facing tool whose config chooses provider, tool filter, persona, background mode | `delegate{prompt}` with no configuration beyond the limits | **narrower** — no provider choice, tool filter, persona or background runs |
| `finalAssistantOutput` + `settleRun`: the child's own events folded to an answer, published with a stop reason | `finalAssistantText`: the last round's assistant output in the child's log; the tool result carries the session id and depth | matched in shape; heddle has no continuable run and no structured result |
| `maxDepth` + `assertSubagentMaxDepth` / `SubagentDepthError` | `maxDepth` limit in `delegateSubagent`, `SUBAGENT_DEPTH_EXCEEDED` | matched |
| `maxActiveSubagents` | `maxActive` in-flight cap, `SUBAGENT_BUSY` | matched, though per process rather than per parent |
| child interruption and parent abort | the parent's abort signal is passed to the child's `runTurn` | matched in the simple case |
| same-session child (`seed`, `inheritedEventCount`) | not implemented: every child gets a session of its own | **divergence** — attribution is by session, so a shared session would need event-level agent identity first |
| out-of-process driver, continuable runs, descriptors/versioning | not implemented | divergence, deliberately deferred |
| team layer: roster, mailbox, task board, journal, `spawn_teammate`/`send_message`/`waitForChange`/`interrupt` | not implemented | **the next slice** |

The team layer is a next slice rather than an omission because it needs the subagent layer's primitives first:
an agent identity (this change), a way to message a running agent (heddle has mid-turn steering but no agent
addressing), a durable task board with revisions (the goal model is the nearest thing), and a journal so the
team survives a restart. The subagent boundary — a child is a session, the parent sees a tool result — is the
line that makes each of those implementable without a second log format.

A measured defect this slice found in heddle's own boot is recorded where it belongs: `settle` did not wait for
a row in `loading`, which is judged by `test/boot.test.ts`. The delegation itself is judged by
`test/subagent.test.ts` and `_verifiers_/50-agentic-loop/check-subagents.mjs`.

## Read next

[`dsh-context.md`](dsh-context.md) for how the request is composed from a session, and
[`dsh-goal.md`](dsh-goal.md) for the round driver that keeps a goal running.
