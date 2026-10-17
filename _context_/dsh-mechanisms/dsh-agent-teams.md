---
title: DSH agents, subagents and agent teams
version: 2.0.0
description: How DSH models an agent, how a parent delegates to a child subagent, and how the experimental Agent Teams layer coordinates several durable teammates through a journal, a mailbox and a shared task board, read against the installed 0.2.0-rc.2 build.
grounded_in:
  - source: human-authored
  - source: dsh-0.2.0-rc.2
---

# DSH agents, subagents and agent teams

Read against the installed build: `~/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`,
all packages at `0.2.0-rc.2`. Three layers, each built on the one above:

| Layer | Packages | What it is |
|---|---|---|
| **agent** | `dsh-agent` | one agent drives one session; `ctx.agents` is the registry, `agent.status` is the live availability |
| **subagent** | `dsh-subagent`, `-in-process-driver`, `-spawn-in-process`, `-fork-in-process`, `dsh-tool-subagent` | a parent delegates to a child **run** in its own session; one-shot or **continuable** |
| **agent team** | `dsh-experimental-agent-team`, `-tool-agent-team`, `-agent-team-profile`, `-client-ui-agent-team` | a Lead and named durable **teammates** coordinate through a journal, a mailbox and a shared task board |

## 1. An agent is a session's driver

`dsh-agent/lib/types/index.d.ts`:

```ts
CreateAgentOptions {
  sessionId; parentAgent?;
  meta?: { cwd?, parentSession?, isSeeded?, origin?: 'subagent', delegationDepth?, agentPreset? }
  inheritedEventCount?; seed?: readonly SessionEvent[];
  agentOptions?; signal?; setup?;
}
AgentFactory { createAgent(ownerCtx, options); resume(ownerCtx, options) }
AgentHandle { agent; dispose(): Promise<void> }
```

An agent is created **for a session** (or resumed for one). A child may be created with a `parentAgent`, a
`parentSession`, `origin:'subagent'`, a `delegationDepth`, and optionally `seed` + `inheritedEventCount` — so a
child can run in the parent's session **with inherited history**, or in a session of its own. Availability is
live, not durable: `availability(agent) = agent.status === 'running' ? 'running' : 'inactive'`
(`dsh-experimental-agent-team/lib/index.js:728`).

## 2. Subagents: child runs, one-shot or continuable

`dsh-subagent` vocabulary (`lib/types/types.d.ts`):

```ts
ContinuableStartSpec { provider; label; childId?; request; signal }
ContinuableStart     { childId; messageId; kind: 'user' }
SubagentStartRequest { label?; prompt; parent; signal; agentOptions?; outputSchema?; ... }
SubagentRunInfo      { runId; provider; id; local }
SubagentRunEndInfo   { ...; stopReason; lastAssistantMessage? }
SubagentCapabilities { agentOptions; outputSchema; depthLimit; toolFilter; persona }
```

Runtime surface (`dsh-subagent/lib/index.js`): `startContinuable(spec):1671`, `sendMessage(sender, targetId,
content, options):1762`, `interrupt(targetSessionId, authority):1853`, `drainContinuableChildren(parent,
childIds):2957`, `prompt(request, signal):3010`. Providers are pluggable: `dsh-subagent-in-process-driver`
(`startInProcessRun(request, {seed?})`), `-spawn-in-process` (a fresh child) and `-fork-in-process` (a child
forked from the parent's history). `dsh-tool-subagent` is the model-facing tool; its config chooses the
provider, an optional name, `enableRunInBackground` with `backgroundMode: 'one-shot' | 'continuable'`,
`agentOptions`, `persona`, a `toolFilter {allow, deny}` and `maxDepth`.

Limits and attribution: `Config {maxActiveSubagents, maxDepth}`, `assertSubagentMaxDepth` →
`SubagentDepthError("subagent depth N exceeds maxDepth M")` (`lib/index.js:382-384`), and the child's metadata
`childSessionMeta(parent, depth, isSeeded)` (`:470-481`) is `{cwd, agentPreset, parentSession, isSeeded,
origin:'subagent', delegationDepth}`. The answer is folded from the **child's own events** by
`finalAssistantOutput(events)` (`:184`) and published by `settleRun`/`settleRunResult` with a stop reason.
Descriptors are versioned, policy/composition overrides are delegated explicitly, and cancellation flows through
abort signals and `SubagentInterruptAuthority`.

**Continuable is the bridge to teams**: a run that stays addressable can receive more prompts
(`sendMessage`), be interrupted, and be drained at shutdown — which is exactly what a durable teammate needs.

## 3. Agent Teams: the Lead, durable teammates, and three shared domains

### 3.1 Identity and membership

- `TeamId` is a **SessionId** (`TeamId(id: SessionId | string)`) — the team belongs to the Lead's session.
- `TeamMembership { root: Agent; id: TeamId; role: 'lead' | 'teammate'; name }`; `TeamRoster.membership(agent)`
  answers the Lead for the root agent and a teammate for a member's own session.
- A member **is a session of its own**: `TeamMemberSnapshot { id: SessionId; name; description; provider;
  context: 'fresh' | 'fork'; phase: 'provisioning' | 'active' | 'failed'; error? }`. Teammates are therefore
  continuable subagent children — each with its own log — coordinated by the Lead's session journal.
- `TeamMemberView` adds live state: `status: 'running' | 'inactive' | 'provisioning' | 'failed'`, `model`, and
  `diagnostics`.

### 3.2 The journal: team state is a projection of the Lead's session log

`dsh-experimental-agent-team/lib/types/journal.d.ts` + `projection.d.ts`:

- mutating event types: **`team/member`**, **`team/task`**, **`team/message/queued`**,
  **`team/message/delivered`**;
- `TeamJournal.transact(rootId, operation)` serializes per Lead session (`:140-147`, tails), with
  `appendAndFlush` and an `onCommit` notification; every write is flushed before the operation is acknowledged;
- `TeamState { id; members; tasks; messages; delivered; nextTaskNumber }` is folded from those events
  (`emptyTeamState(rootId)`), and the whole state is exposed through the session projection mechanism as
  `agentTeam: TeamProjection { members; tasks; failure? }` — so the UI and tools read one derived truth;
- a projection `failure` records containment: a broken member/team is visible as state, not as a crash.

### 3.3 Roster: spawning a teammate

`TeamRoster` (`lib/index.js:341-700`): `spawn(caller, request)` is **Lead-only** (`TEAM_LEAD_REQUIRED`), guarded
by `maxMembers`, and:

1. journals `team/member` with `phase: 'provisioning'` before the child exists;
2. starts a **continuable** child through the configured provider (`fresh` → `spawn`, `fork` → `fork`), with the
   prompt as its first user message, and the member's session id recorded;
3. settles to `phase: 'active'` (or `failed` with `error`) once the child session is durable;
4. on startup, `recoverFor(agent, signal)` reconciles provisioning when a member session starts
   (`:488-500`), and `settleProvisioning` resolves provisioning-only members from their **durable child
   sessions** (`:651-660`) — the failure path says it plainly: "provisioning did not leave a resumable child
   Session". A provisioning conflict is cleaned up with an `AggregateError`.

The Lead may `interrupt(caller, targetName)` one teammate (`TEAM_LEAD_REQUIRED`, `TEAM_INVALID_TARGET` for
itself) through `ctx.subagents.interrupt` (`:505-515`), and disposal drains continuable children with
`disposalTimeoutMs`.

### 3.4 Mailbox: durable messages, delivered at the target and confirmed there

`TeamMailbox` (`lib/index.js:732-1100`):

- `send` transacts on the Lead session: resolve the target by name (`resolveActiveMember`), refuse self-messages
  (`TEAM_SELF_MESSAGE`), enforce `maxPendingMessagesPerMember` (`TEAM_MAILBOX_FULL`) and `maxMessageBytes`
  (`TEAM_MESSAGE_TOO_LARGE`), then append **`team/message/queued`** and *then* attempt dispatch
  (`sendAdmitted:815-849`); the result is `{messageId, status: 'accepted' | 'queued'}` — queued is durable
  already, and the tool says so ("a successful send is already durable even when its result says queued").
- dispatch is **serialized per target** (`dispatchTails:877-890`, `inFlightMessages` dedupe) and delivers the
  pending messages in queue order (`dispatchThrough:892`, `dispatchOnce:915`);
- delivery to a teammate is a **steer prompt through the continuable child** with source
  `{kind:'team-message', teamId, messageId, senderId, senderName}` (`:938-946`); delivery to the Lead is
  `root.steer(input)` with the same source;
- **acceptance is confirmed at the target**, not by transport: `targetRecorded(target.session, messageId)` reads
  the target's own log (`messageAccepted:282`), `ctx.sessions.flush(target)` makes it durable, and only then is
  `team/message/delivered` journaled (`checkpointDelivered`/`markDelivered:955-970`);
- recovery when the target has no live agent: `readPersistedSession(persistence, id, signal)` (see
  `persisted.d.ts`) reads the child's durable session and marks the message delivered if it was already
  accepted, or leaves it queued;
- `messageAccepted` is also used for the initial teammate prompt (`:663`), so "the teammate started" is a fact
  read from the child's log.

### 3.5 Task board: shared work with compare-and-set

`TeamTaskBoard` (`task-board.d.ts`) over the same journal: tasks have `id`, `revision`, `subject`,
`description`, `status: 'pending' | 'in_progress' | 'completed' | 'deleted'`, `ownerId?`, `blockedBy[]`,
`writeScopes[]`. `TeamTaskView` adds `ownerName?`, `ready` and `writeScopeWarnings`. Actions are exactly the
tool's transitions: **claim, release, edit, set_dependencies, complete, reopen, reassign, delete**, each a
compare-and-set on the caller's `revision` (`team_task_update` requires `task_id`, `revision`, `action`, plus
action-specific fields). `assertTaskGraphCandidate` refuses `missing`, `duplicate` and **`cycle`** blockers.
`writeScopes` are **advisory** by design: the profile guidance says overlap is a warning, "not a lock".

### 3.6 Waiting and collaboration policy

- `TeamService.waitForChange(caller, timeoutMs, signal)` delegates to `activity.wait(teamId, timeoutMs,
  signal)` — it resolves on the next **journal commit or member-status change**, never wakes a member, and the
  tool returns `noProgress` when no member is `running | provisioning` (`ACTIVE_WAIT_STATUSES`).
- The tool plugin's `POLICY` (`dsh-experimental-tool-agent-team/lib/index.js:19-27`) is the collaboration
  contract, shared by Lead and teammates: create teammates only when asked; all members share one FS and edits
  are immediately visible; split writes into disjoint scopes and record them on shared tasks; use the member
  target from spawn/list; a send is durable even when reported queued; the task workflow is list → get → claim
  with the current revision → perform → complete; readiness never starts an owner; before `wait_agent` check
  that another required member is running or provisioning; re-list after a wakeup or timeout; the Lead must wait
  for required teammates before answering.

### 3.7 The tool surface

Nine tools (`dsh-experimental-tool-agent-team/lib/index.js`): `spawn_teammate{name, description, prompt,
context='fresh'|'fork'}`, `send_message{target, message}`, `list_agents`, `wait_agent{timeout_ms}`,
`interrupt_agent{target}`, `team_task_create`, `team_task_list`, `team_task_get`, `team_task_update`. The
runtime config is `maxMembers`, `maxTasks`, `maxPendingMessagesPerMember`, `maxMessageBytes`,
`disposalTimeoutMs`; the tool config is `freshProvider` / `forkProvider`.

### 3.8 The profile bundle and the UI

`dsh-experimental-agent-team-profile/cordis.patch.yml` is the opt-in layer: it **disables the direct subagent
tools** (`tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent`, `tool-subagent-fork`) so
delegation goes through the Team, then inserts the service (`maxMembers: 8`, `maxTasks: 256`,
`maxPendingMessagesPerMember: 64`, `maxMessageBytes: 65536`, `disposalTimeoutMs: 5000`), the tool plugin
(`freshProvider: spawn`, `forkProvider: fork`) and the `ui-agent-team` client plugin; locale files describe it
as "Enable team collaboration, team tools, the member roster, and the shared task board". The client UI package
is `dsh-experimental-client-ui-agent-team` (`lib/index.js` + `client.js`), separate from
`dsh-client-ui-subagent`.

## 4. How the Team layer meets the reentrancy standard

| Property | DSH's mechanism |
|---|---|
| durable state is the only truth | team state is a projection of `team/*` events in the Lead's session log |
| actions are idempotent or confirmed | delivery is confirmed by reading the target's log and flushing, then journaling `delivered`; a re-dispatch of a recorded message is a no-op (`targetRecorded`) |
| edges are hints | mailbox dispatch is triggered by a queue append, recovery and by member status; correctness does not depend on one edge |
| one action in flight per subject | `transact` serializes per Lead session; `dispatchTails` serializes per target; `inFlightMessages` dedupes |
| startup is a resync | `recoverFor` / `settleProvisioning` reconcile provisioning from durable child sessions; persisted-target reads recover undelivered messages |
| waiting is level-triggered | `activity.wait` observes commits/status changes, returns `noProgress` when nothing can progress, and the tool requires re-listing rather than trusting a wakeup |
| stopping is a state | member `phase`/`status`, task `status`, and a projection `failure` — not inferred from silence |
| records are versioned | team event payloads carry `version: 2`; subagent descriptors have `SUBAGENT_DESCRIPTOR_VERSION` |
| absent collaborator is a condition | a member with no live agent is `inactive`/`provisioning`; the mailbox recovers through the durable session instead of failing |

## 5. What heddle does not have yet (the gap this reading exposes)

Heddle today: a session is one append-only log; the loop is a function `runTurn`; context, goals and tools are
keyed by the session; **no agent registry, no live agent status, no continuable child runs, no session
projection service, no system-prompt policy slot, no team UI**. Its only multi-agent piece is one-shot
delegation (`delegate{prompt}` → child session → answer back, `src/agent/subagent.ts`).

The mapping questions the implementation goal has to answer:

1. **Do teammates get their own sessions (as DSH does), or share the Lead's?** DSH's own answer is own
   sessions — which is what makes attribution trivial and the Lead's log small.
2. **Where does team state live?** The DSH shape maps cleanly onto heddle's event log: `team/member`,
   `team/task`, `team/message/queued`, `team/message/delivered` events in the Lead's session, folded to a
   projection (heddle already folds `goal/change` this way).
3. **What is "running" without an agent registry?** Heddle derives busy/idle from events today (`turn/completed`,
   `model/request`); a team needs a reliable answer per member, which may mean a process-local registry of live
   turns (the Web server already counts running turns per session).
4. **Continuable teammate**: heddle's `runTurn` is one-shot. A mailbox delivery can simply be another turn in
   the member's session (serialized per member), which is simpler than a persistent agent and still meets the
   durability properties — but then "running" means "a turn is in flight", and steering at a step boundary is
   the loop's existing inbox behaviour.
5. **Wait/interrupt**: a wait needs a commit signal (Cordis event) plus a timeout; interrupt needs an abort per
   session (the Web server has controllers; a CLI/server-wide registry would be needed).
6. **UI and policy**: a member roster and task board view, plus the collaboration guidance somewhere heddle can
   inject into the system prompt (the context service's notes are the nearest slot).

## 6. Read next

[`dsh-context.md`](dsh-context.md) for how a request is composed from a session, and
[`dsh-goal.md`](dsh-goal.md) for the round driver whose event-sourced shape the team journal should copy.
