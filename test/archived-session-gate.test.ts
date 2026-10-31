import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../src/agent/loop.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { ContextService } from '../src/context/service.ts'
import { GoalService } from '../src/goal/service.ts'
import * as GoalDriverPlugin from '../src/plugins/goal-driver.ts'
import { ModelService } from '../src/llm/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { INBOX_SPLICED, pendingInbox, queueSteer } from '../src/session/inbox.ts'
import { SessionService } from '../src/session/service.ts'
import type { SessionEvent, SessionHandle } from '../src/session/store.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * DSH's archived-session gate (issue #26), through real turns.
 *
 * DSH's `ArchivedSessionGate` (dsh-api-session-controller lib/index.js:2508-2541) answers `agent/pre-step` with
 * `reject` while the agent's session, or a session above it in its subagent lineage, is archived. The prompt is
 * accepted; the loop opens the turn, claims its input, the gate rejects before any model request, and the turn ends
 * `blocked` with the claimed input discarded (dsh-agent-loop lib/index.js:956-963, dsh-agent lib/index.js:53-62).
 * Measured before this gate (phase A and issue #26): a turn into an archived session asked the model and grew the
 * session from one turn to two on both builds.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-archived-gate-'))
const previousHome = process.env.HEDDLE_HOME
process.env.HEDDLE_HOME = join(scratch, 'home')
after(() => {
  if (previousHome === undefined) delete process.env.HEDDLE_HOME
  else process.env.HEDDLE_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
})

/** One wired harness; `slow_tool` runs `whileRunning` while its call is in flight. */
function harness(label: string, steps: unknown[], whileRunning: (session: SessionHandle) => void = () => {}) {
  const ctx = new Context()
  const work = join(scratch, `${label}-work`)
  mkdirSync(work, { recursive: true })
  /** Every append reaches `session/event`, as the session plugin re-emits it, so the goal-driver plugin can follow it. */
  const sessions = new SessionService(ctx, { root: join(scratch, `${label}-sessions`) }, { onEvent: (handle, event) => ctx.emit('session/event', { session: handle.id, event }) })
  const session = sessions.start({ cwd: work })
  const sandbox = new SandboxService(ctx, { workspaceRoot: work, backend: 'none' })
  const approvals = new ApprovalService(ctx, { mode: 'allow' })
  const tools = new ToolRegistry(ctx, approvals, sandbox, sessions)
  tools.register({
    spec: { name: 'slow_tool', description: 'Stands for a long bash call', parameters: { type: 'object', properties: {} } },
    run: async () => {
      whileRunning(session)
      return { output: 'tool finished' }
    },
  })
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const script = join(scratch, `${label}-script.json`)
  writeFileSync(script, JSON.stringify({ steps }))
  new ModelService(ctx, [{ name: 'scripted', kind: 'scripted', baseUrl: script }])
  return { ctx, sessions, session, work }
}

const of = (events: readonly SessionEvent[], type: string): number => events.filter((event) => event.type === type).length
const turnsOf = (sessions: SessionService, id: string): number | undefined => sessions.list().find((meta) => meta.id === id)?.turns
const BLOCKED = 'blocked: an archived session runs no model step until it is unarchived'

test('a turn into an archived session is accepted, blocked before any model request, and discards what it claimed', async () => {
  const { ctx, sessions, session } = harness('blocked', [{ text: 'an answer' }])
  const first = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'before the archive' })
  assert.equal(first.text, 'an answer', 'a live session runs')
  /** A steer left pending is next-step input the blocked turn claims and discards, as DSH's claim does. */
  queueSteer(sessions.store, session, [{ type: 'text', text: 'a steer left pending' }])
  assert.notEqual(sessions.flags(session.id, { archived: true }), null, 'the session is archived')
  /** A count, not the array: the store answers its cached list, which later appends extend in place. */
  const before = sessions.store.read(session).length
  const turnsBefore = turnsOf(sessions, session.id)

  const blocked = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'into the archive' })

  assert.equal(blocked.finishReason, 'blocked', `the turn ends blocked\nsaw: ${JSON.stringify(blocked)}`)
  assert.equal(blocked.rounds, 0, 'without a step')
  assert.equal(blocked.text, '', 'and without an answer')
  assert.deepEqual(blocked.ended, [BLOCKED], 'saying why')
  const added = sessions.store.read(session).slice(before)
  assert.equal(added.length, 4, `the blocked turn wrote its record\nsaw: ${added.map((event) => event.type).join(', ')}`)
  assert.equal(of(added, 'model/request'), 0, 'no model request was made')
  assert.equal(of(added, 'message'), 0, 'neither the prompt nor the steer reached the conversation')
  assert.equal(of(added, 'assistant/completed'), 0, 'no answer was appended')
  assert.equal(of(added, 'turn/completed'), 0, 'and the turn did not complete')
  assert.deepEqual(
    added.map((event) => (event.type === INBOX_SPLICED ? `${event.type} ${String(event.target)} ${event.removedCount === undefined ? '+' : '-'}${String(event.removedCount ?? (event.inserted as unknown[]).length)}` : event.type)),
    [
      `${INBOX_SPLICED} next-turn +1`,
      `${INBOX_SPLICED} next-step -1`,
      `${INBOX_SPLICED} next-turn -1`,
      'turn/failed',
    ],
    'DSH order: the prompt is queued, the step claims the steer and the queued prompt, the gate rejects, the turn ends',
  )
  assert.deepEqual(added.at(-1), { ...added.at(-1), type: 'turn/failed', reason: { kind: 'blocked' } }, 'with DSH\'s turn-end reason')
  const queued = (added[0]!.inserted as { content: { text?: string }[] }[])[0]
  assert.equal(queued?.content[0]?.text, 'into the archive', 'the queued prompt is the one that was sent')
  assert.ok(added.slice(1, 3).every((event) => event.outcome === undefined), 'a claim delivers to the step; the rejection is what drops it')
  assert.deepEqual(pendingInbox(sessions.store, session), { 'next-turn': [], 'next-step': [] }, 'nothing is left pending')
  assert.equal(turnsOf(sessions, session.id), turnsBefore, 'the session records the same number of turns')
  assert.equal(sessions.list().find((meta) => meta.id === session.id)?.archived, true, 'and stays archived')

  sessions.flags(session.id, { archived: false })
  const restored = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'after the restore' })
  assert.equal(restored.text, 'an answer', 'unarchiving lifts the gate')
})

test('a notice delivered to an archived parent opens no step either', async () => {
  const { ctx, sessions, session } = harness('notice', [{ purpose: 'subagent-notice', text: 'the parent read the notice' }])
  sessions.flags(session.id, { archived: true })
  const before = sessions.store.read(session).length
  const source = { kind: 'subagent', form: 'notice', summary: 'child settled' }
  const blocked = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'child settled', source, purpose: 'subagent-notice' })
  assert.equal(blocked.finishReason, 'blocked')
  const added = sessions.store.read(session).slice(before)
  assert.equal(of(added, 'model/request'), 0, 'the settlement did not ask the model')
  assert.equal(of(added, 'message'), 0, 'nor wrote the notice into the conversation')
  assert.deepEqual((added[0]!.inserted as { source?: unknown }[])[0]?.source, source, 'the discarded input keeps its source')

  /** A notice already in the log (written into a turn that then ended) is answered with `answerPending`: still no step. */
  const pending = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'child settled', answerPending: true, purpose: 'subagent-notice' })
  assert.equal(pending.finishReason, 'blocked')
  assert.equal(of(sessions.store.read(session), 'model/request'), 0)
})

test('a subagent child of an archived session is blocked too, and a fork of one is not', async () => {
  const { ctx, sessions, session, work } = harness('lineage', [{ text: 'ran' }])
  sessions.flags(session.id, { archived: true })
  const child = sessions.store.create({ cwd: work, parentSession: session.id, origin: 'subagent', delegationDepth: 1 })
  const grandchild = sessions.store.create({ cwd: work, parentSession: child.id, origin: 'subagent', delegationDepth: 2 })
  const fork = sessions.store.create({ cwd: work, parentSession: session.id })

  for (const [name, handle] of [['the child', child], ['its own child', grandchild]] as const) {
    const result = await runTurn(ctx, { session: handle, endpoint: 'scripted', prompt: 'child task', purpose: 'turn' })
    assert.equal(result.finishReason, 'blocked', `${name} of an archived session is blocked`)
    assert.equal(of(sessions.store.read(handle), 'model/request'), 0, `${name} asked no model`)
  }
  const forked = await runTurn(ctx, { session: fork, endpoint: 'scripted', prompt: 'fork task' })
  assert.equal(forked.text, 'ran', 'a fork of an archived session is an independent conversation')
})

test('a session archived during a turn is blocked at its next step, and the steer it claims is discarded', async () => {
  let archivedBy: SessionService | undefined
  const { ctx, sessions, session } = harness(
    'mid-turn',
    [{ toolCall: { name: 'slow_tool', arguments: {} } }, { text: 'never asked' }],
    (handle) => {
      queueSteer(archivedBy!.store, handle, [{ type: 'text', text: 'steered into the archive' }])
      archivedBy!.flags(handle.id, { archived: true })
    },
  )
  archivedBy = sessions
  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'run the slow tool', maxRounds: 4 })
  const events = sessions.store.read(session)
  assert.equal(of(events, 'model/request'), 1, `only the step before the archive asked the model\nsaw: ${events.map((event) => event.type).join(', ')}`)
  assert.ok(result.ended?.includes(BLOCKED), `the turn says it was blocked\nsaw: ${JSON.stringify(result.ended)}`)
  assert.ok(!JSON.stringify(events).includes('never asked'), 'the second step never ran')
  const messages = events.filter((event) => event.type === 'message').map((event) => (event.message as { role: string }).role)
  assert.deepEqual(messages, ['user', 'tool'], 'the steer claimed at the blocked step was not written')
  assert.deepEqual(pendingInbox(sessions.store, session)['next-step'], [], 'and is not left pending')
  assert.equal(events.at(-1)?.type, 'turn/failed', 'the turn ends with the blocked record')
  assert.deepEqual(events.at(-1)?.reason, { kind: 'blocked' })
  assert.equal(of(events, 'turn/completed'), 0, 'not as a completed turn')
})

/**
 * The turn's end and the goal driver (developer-five's review of cc4d7410, inbox 8b48).
 *
 * DSH's loop ends a turn whose step the gate rejects with `turn/end {kind:'blocked'}` at any step, replacing the end the
 * previous step proposed (dsh-agent-loop lib/index.js:956-963, 1027-1032). Its goal driver is ready again whenever the
 * agent is idle, which every turn end makes it (dsh-goal-round-driver lib/index.js:84-86, 223-241). heddle's driver
 * reads "busy" from the log instead, so `turn/failed` has to end the busy span as `turn/completed` does; it starts no
 * round by itself, because the turn that wrote it was refused and a round started from its end would be refused again.
 */

/** The harness with the goal service and the real goal-driver plugin, which follows the session's own events. */
async function driven(label: string, steps: unknown[], whileRunning?: (session: SessionHandle) => void) {
  const wired = harness(label, steps, whileRunning)
  const goals = new GoalService(wired.ctx, wired.sessions.store)
  await wired.ctx.plugin(GoalDriverPlugin)
  assert.notEqual(wired.ctx.get('goalDriver'), undefined, 'the goal-driver plugin is loaded')
  return { ...wired, goals }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Time for any chain the events started to run: a round yields to the event loop between steps. */
const settle = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The goal rounds the log admitted, by number. */
const goalRounds = (events: readonly SessionEvent[]): number[] =>
  events
    .filter((event) => event.type === 'message' && (event.message as { source?: { kind?: string } }).source?.kind === 'goal')
    .map((event) => (event.message as { source: { round: number } }).source.round)

test('a step the gate rejects after the first ends the turn with the blocked finish reason, not the previous step\'s', async () => {
  let archivedBy: SessionService | undefined
  const { ctx, sessions, session } = harness('mid-turn-finish', [{ toolCall: { name: 'slow_tool', arguments: {} } }, { text: 'never asked' }], (handle) => {
    archivedBy!.flags(handle.id, { archived: true })
  })
  archivedBy = sessions
  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'run the slow tool', maxRounds: 4 })
  assert.equal(result.finishReason, 'blocked', `the result says blocked, not the first step's tool_calls\nsaw: ${JSON.stringify(result)}`)
  const completed = sessions.store.read(session).filter((event) => event.type === 'assistant/completed')
  assert.equal(completed.length, 1)
  assert.equal(completed[0]!.finishReason, 'blocked', 'and so does the turn\'s answer record')
})

test('a turn blocked at a later step leaves the goal driver at rest: a goal resumed after the unarchive starts a round', async () => {
  let archiveOnce = true
  let archivedBy: SessionService | undefined
  const { ctx, sessions, session, goals } = await driven(
    'driver-rest',
    [{ toolCall: { name: 'slow_tool', arguments: {} } }, { text: 'answered' }],
    (handle) => {
      if (!archiveOnce) return
      archiveOnce = false
      archivedBy!.flags(handle.id, { archived: true })
    },
  )
  archivedBy = sessions
  const created = goals.create(session, { objective: 'finish the report', maxGoalRounds: 1 })
  const paused = goals.pause(session, { id: created.id, revision: created.revision })
  await settle()
  assert.deepEqual(goalRounds(sessions.store.read(session)), [], 'a paused goal runs no round')

  /** A person's turn asks the model once; the session is archived while its tool runs, so the next step is refused. */
  const blocked = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'run the slow tool', maxRounds: 4 })
  assert.ok(blocked.ended?.includes(BLOCKED), `the second step was refused\nsaw: ${JSON.stringify(blocked.ended)}`)
  const ended = sessions.store.read(session).length
  await settle()
  assert.equal(sessions.store.read(session).length, ended, 'the blocked turn\'s end starts nothing by itself')

  sessions.flags(session.id, { archived: false })
  goals.resume(session, { id: paused.id, revision: paused.revision })
  await until(() => goalRounds(sessions.store.read(session)).length > 0, 'the resumed goal\'s round (the driver stayed busy after turn/failed)')
  await until(() => goals.get(session)?.phase === 'blocked', 'the round to settle at its cap')
  assert.deepEqual(goalRounds(sessions.store.read(session)), [1], 'the resume started round 1')
})

test('a goal round refused at a later step, then at its first, is not started again by itself; a resume after the unarchive starts the next', async () => {
  let archiveOnce = true
  let archivedBy: SessionService | undefined
  const { sessions, session, goals } = await driven(
    'driver-refused',
    [{ toolCall: { name: 'slow_tool', arguments: {} } }, { text: 'answered' }],
    (handle) => {
      if (!archiveOnce) return
      archiveOnce = false
      archivedBy!.flags(handle.id, { archived: true })
    },
  )
  archivedBy = sessions
  const created = goals.create(session, { objective: 'finish the report', maxGoalRounds: 3 })
  /**
   * Round 1 asks the model and is refused at its second step. The driver goes on to round 2, as DSH's does at the next
   * idle, and the gate refuses that round's first step, so no message is admitted and the goal is blocked
   * `prompt-rejected`, as DSH blocks it (dsh-goal-round-driver lib/index.js:326-333).
   */
  await until(() => of(sessions.store.read(session), 'turn/failed') >= 2, 'round 1 and round 2 to be refused')
  await settle(300)
  /** A count, not the array: the store answers its cached list, which later appends extend in place. */
  const events = [...sessions.store.read(session)]
  assert.equal(of(events, 'turn/failed'), 2, `two refused turns and no more: the refused round was not started again\nsaw: ${events.map((event) => event.type).join(', ')}`)
  assert.equal(of(events, 'model/request'), 1, 'only round 1\'s first step asked the model')
  assert.deepEqual(goalRounds(events), [1], 'round 2 was never admitted')
  const refused = goals.get(session)
  assert.equal(refused?.phase, 'blocked', 'the refused round blocks its goal, as DSH\'s does')
  assert.deepEqual(refused?.blockedReason, { code: 'prompt-rejected', message: 'Goal round was rejected before entering its step.' })

  sessions.flags(session.id, { archived: false })
  await settle()
  assert.equal(sessions.store.read(session).length, events.length, 'unarchiving starts nothing by itself either')

  const resumed = goals.resume(session, { id: refused!.id, revision: refused!.revision })
  assert.notEqual(resumed.revision, created.revision)
  await until(() => goalRounds(sessions.store.read(session)).length > 1, 'the resumed goal\'s round (the driver stayed busy after turn/failed)')
  await until(() => goals.get(session)?.phase === 'blocked', 'the rounds to settle at their cap')
  assert.deepEqual(goalRounds(sessions.store.read(session)), [1, 2, 3], 'the resume started round 2, and round 3 followed it to the cap')
  const completed = sessions.store.read(session).filter((event) => event.type === 'assistant/completed')
  assert.equal(completed[0]!.finishReason, 'blocked', 'round 1, refused at its second step, ended blocked')
})

test('a goal round the gate refuses at its first step blocks the goal with DSH\'s prompt-rejected, and a resume after the unarchive runs it', async () => {
  const { sessions, session, goals } = await driven('driver-prompt-rejected', [{ text: 'the round ran' }])
  sessions.flags(session.id, { archived: true })
  const created = goals.create(session, { objective: 'finish the report', maxGoalRounds: 1 })
  await until(() => goals.get(session)?.phase !== 'active', 'the refused round to settle')
  const blocked = goals.get(session)!
  assert.equal(blocked.phase, 'blocked', `the goal is blocked, not left active and armed\nsaw: ${JSON.stringify(blocked)}`)
  assert.deepEqual(blocked.blockedReason, { code: 'prompt-rejected', message: 'Goal round was rejected before entering its step.' }, 'with DSH\'s code and sentence')
  assert.equal(blocked.roundsStarted, 0, 'the round was never admitted')
  await settle()
  const events = [...sessions.store.read(session)]
  assert.equal(of(events, 'model/request'), 0, 'no model request was made')
  assert.equal(of(events, 'turn/failed'), 1, 'one refused turn, and it was not started again')

  sessions.flags(session.id, { archived: false })
  goals.resume(session, { id: blocked.id, revision: blocked.revision })
  await until(() => goalRounds(sessions.store.read(session)).length > 0, 'the resumed goal\'s round')
  await until(() => goals.get(session)?.blockedReason?.code === 'round-limit', 'the round to settle at its cap')
  assert.deepEqual(goalRounds(sessions.store.read(session)), [1], 'the resume ran round 1')
  assert.ok(sessions.store.read(session).some((event) => event.type === 'assistant/completed' && event.text === 'the round ran'), 'and the round answered')
  assert.notEqual(created.revision, goals.get(session)?.revision)
})
