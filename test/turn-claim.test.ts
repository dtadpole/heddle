import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { NOTHING_CLAIMED, runTurn } from '../src/agent/loop.ts'
import { TurnRegistry } from '../src/agent/turns.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { ContextService } from '../src/context/service.ts'
import { ModelService } from '../src/llm/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { claimNextTurn, pendingInbox, queueSteer, queueTurn } from '../src/session/inbox.ts'
import { SessionService } from '../src/session/service.ts'
import type { SessionEvent } from '../src/session/store.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A turn that answers a queued row claims it once it holds its session (`RunTurnOptions.claim`, #162 follow-up).
 *
 * The queue's drain used to claim the row - the splice and its user message, one write - before the turn waited for the
 * session's slot, so a direct turn that took the slot in between answered the row as well, and the drained turn then had
 * nothing new (developer-three's point 3). DSH claims the next-turn row at the turn's first step. These pin the rule
 * developer-five set for the callback: called exactly once, after pending steers; no request and no message when the row
 * is gone; nothing claimed by a turn stopped while it waited; the registry released on every path.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-turn-claim-'))
const previousHome = process.env.HEDDLE_HOME
process.env.HEDDLE_HOME = join(scratch, 'home')
after(() => {
  if (previousHome === undefined) delete process.env.HEDDLE_HOME
  else process.env.HEDDLE_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
})

function harness(label: string) {
  const ctx = new Context()
  const work = join(scratch, `${label}-work`)
  mkdirSync(work, { recursive: true })
  const sessions = new SessionService(ctx, { root: join(scratch, `${label}-sessions`) })
  const session = sessions.start({ cwd: work })
  const sandbox = new SandboxService(ctx, { workspaceRoot: work, backend: 'none' })
  const approvals = new ApprovalService(ctx, { mode: 'allow' })
  new ToolRegistry(ctx, approvals, sandbox, sessions)
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const script = join(scratch, `${label}-script.json`)
  writeFileSync(script, JSON.stringify({ steps: [{ text: 'answered' }] }))
  new ModelService(ctx, [{ name: 'scripted', kind: 'scripted', baseUrl: script }])
  const turns = new TurnRegistry(ctx)
  return { ctx, sessions, session, turns, store: sessions.store }
}

/** The log's user messages, in order. */
const userTexts = (events: readonly SessionEvent[]): string[] =>
  events
    .filter((event) => event.type === 'message' && (event.message as { role: string }).role === 'user')
    .map((event) => (event.message as { content: { text?: string }[] }).content.map((part) => part.text ?? '').join(''))

const settle = () => new Promise((resolvePromise) => setImmediate(resolvePromise))

test('a claimed turn queued behind a running one claims its row only when it holds the session, so a later direct turn never answers it', async () => {
  const { ctx, session, turns, store } = harness('order')
  const running = turns.begin(session.id)
  queueTurn(store, session, [{ type: 'text', text: 'QUEUED-ROW' }])
  let claims = 0
  const drained = runTurn(ctx, {
    session,
    endpoint: 'scripted',
    prompt: '',
    claim: () => {
      claims += 1
      return claimNextTurn(store, session)?.content
    },
  })
  const direct = runTurn(ctx, { session, endpoint: 'scripted', prompt: 'DIRECT-TURN' })
  await settle()
  assert.equal(claims, 0, 'nothing is claimed while another turn holds the session')
  assert.deepEqual(userTexts(store.read(session)), [], 'and nothing is written')
  running.settle()
  const [first, second] = await Promise.all([drained, direct])
  assert.equal(claims, 1, 'the callback ran exactly once')
  assert.equal(first.rounds, 1)
  assert.equal(second.rounds, 1)
  const events = store.read(session)
  assert.deepEqual(userTexts(events), ['QUEUED-ROW', 'DIRECT-TURN'], 'the row is answered by its own turn, first, once')
  const rowSeq = events.find((event) => userTexts([event])[0] === 'QUEUED-ROW')!.seq
  const directSeq = events.find((event) => userTexts([event])[0] === 'DIRECT-TURN')!.seq
  const requests = events.filter((event) => event.type === 'model/request').map((event) => event.seq)
  assert.equal(requests.length, 2)
  assert.ok(requests[0]! > rowSeq && requests[0]! < directSeq, 'the drained turn asked the model after its claim and before the direct turn wrote anything')
  assert.deepEqual(pendingInbox(store, session)['next-turn'], [])
  assert.equal(turns.isRunning(session.id), false)
})

test('a claimed turn whose row is gone writes nothing, asks the model nothing and releases the session', async () => {
  const { ctx, session, turns, store } = harness('gone')
  const before = store.count(session)
  let claims = 0
  const result = await runTurn(ctx, {
    session,
    endpoint: 'scripted',
    prompt: '',
    claim: () => {
      claims += 1
      return claimNextTurn(store, session)?.content
    },
  })
  assert.equal(claims, 1)
  assert.equal(result.rounds, 0)
  assert.deepEqual(result.ended, [NOTHING_CLAIMED])
  assert.equal(store.count(session), before, 'no message, no request, no turn end: nothing at all')
  assert.equal(turns.isRunning(session.id), false)
})

test('a pending steer is still answered when the row is gone', async () => {
  const { ctx, session, store } = harness('steer')
  queueSteer(store, session, [{ type: 'text', text: 'STEER-WAITING' }])
  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: '', claim: () => undefined })
  assert.equal(result.rounds, 1, 'the steer written at the turn start is answered')
  assert.deepEqual(userTexts(store.read(session)), ['STEER-WAITING'], 'and no empty prompt is written beside it')
})

test('a claim that throws fails the turn and releases the session', async () => {
  const { ctx, session, turns } = harness('throws')
  let claims = 0
  await assert.rejects(
    runTurn(ctx, {
      session,
      endpoint: 'scripted',
      prompt: '',
      claim: () => {
        claims += 1
        throw new Error('the log refused the claim')
      },
    }),
    /the log refused the claim/,
  )
  assert.equal(claims, 1)
  assert.equal(turns.isRunning(session.id), false)
})

test('a claimed turn stopped while it waited claims nothing: the row stays queued', async () => {
  const { ctx, session, turns, store } = harness('stopped')
  const running = turns.begin(session.id)
  queueTurn(store, session, [{ type: 'text', text: 'KEPT-ROW' }])
  const controller = new AbortController()
  let claims = 0
  const drained = runTurn(ctx, {
    session,
    endpoint: 'scripted',
    prompt: '',
    signal: controller.signal,
    claim: () => {
      claims += 1
      return claimNextTurn(store, session)?.content
    },
  })
  await settle()
  controller.abort()
  running.settle()
  const result = await drained
  assert.equal(claims, 0, 'a stopped turn never claims')
  assert.deepEqual(result.ended, ['stopped by the caller'])
  assert.deepEqual(
    pendingInbox(store, session)['next-turn'].map((row) => (row.content[0] as { text?: string }).text),
    ['KEPT-ROW'],
    'the row is still queued, held by the Stop',
  )
  assert.equal(turns.isRunning(session.id), false)
})
