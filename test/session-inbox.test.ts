import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../src/agent/loop.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { ContextService } from '../src/context/service.ts'
import { ModelService } from '../src/llm/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { claimNextStep, foldInbox, INBOX_SPLICED, pendingInbox, queueSteer } from '../src/session/inbox.ts'
import { SessionService } from '../src/session/service.ts'
import type { SessionEvent, SessionHandle } from '../src/session/store.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A steer waits in the session's inbox and is written at the next step boundary (R-developer-two-5).
 *
 * The defect these pin was measured on both builds: a steer sent while `bash sleep 30` ran was written between
 * the assistant's tool call and its result, and a stop then left nothing pending. DSH keeps the steer in its
 * next-step inbox until the step that asked for the tool has written the result, and its session cancel keeps
 * the inbox. These tests drive real turns through `runTurn` with a scripted model, and the tool itself queues
 * the steer, which is exactly "a steer sent during a tool call".
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-session-inbox-'))
const previousHome = process.env.HEDDLE_HOME
process.env.HEDDLE_HOME = join(scratch, 'home')
after(() => {
  if (previousHome === undefined) delete process.env.HEDDLE_HOME
  else process.env.HEDDLE_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
})

/** One wired harness with a tool whose run does what the test needs while the call is in flight. */
function harness(label: string, steps: unknown[], whileRunning: (session: SessionHandle) => void) {
  const ctx = new Context()
  const work = join(scratch, `${label}-work`)
  mkdirSync(work, { recursive: true })
  const sessions = new SessionService(ctx, { root: join(scratch, `${label}-sessions`) })
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
  return { ctx, sessions, session }
}

/** The log's messages in order, as `role:text` (a tool message reads `tool:<result>`). */
function messageOrder(events: readonly SessionEvent[]): string[] {
  const order: string[] = []
  for (const event of events) {
    if (event.type !== 'message') continue
    const message = event.message as { role: string; content: { type: string; text?: string }[] }
    order.push(`${message.role}:${message.content.map((part) => part.text ?? '').join('')}`)
  }
  return order
}

function seqOf(events: readonly SessionEvent[], predicate: (event: SessionEvent) => boolean): number {
  const found = events.find(predicate)
  assert.ok(found !== undefined, 'the event is in the log')
  return found.seq
}

const isToolResult = (event: SessionEvent): boolean => event.type === 'message' && (event.message as { role: string }).role === 'tool'
const isUserText = (text: string) => (event: SessionEvent): boolean => {
  if (event.type !== 'message') return false
  const message = event.message as { role: string; content: { text?: string }[] }
  return message.role === 'user' && message.content.some((part) => part.text === text)
}

test('a steer sent during a tool call is written after the tool result and answered by the same turn', async () => {
  const { ctx, sessions, session } = harness(
    'order',
    [{ toolCall: { name: 'slow_tool', arguments: {} } }, { text: 'answered after the steer' }],
    (handle) => {
      queueSteer(sessions.store, handle, [{ type: 'text', text: 'steered during the tool' }])
    },
  )
  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'run the slow tool', maxRounds: 4 })
  const events = sessions.store.read(session)
  const resultSeq = seqOf(events, isToolResult)
  const steerSeq = seqOf(events, isUserText('steered during the tool'))
  assert.ok(steerSeq > resultSeq, `the steer (seq ${steerSeq}) follows the tool result (seq ${resultSeq})`)
  assert.deepEqual(messageOrder(events), [
    'user:run the slow tool',
    'tool:tool finished',
    'user:steered during the tool',
  ])
  const secondRequest = events.filter((event) => event.type === 'model/request')[1]
  assert.ok(secondRequest !== undefined && secondRequest.seq > steerSeq, 'the next model call is asked after the steer is written')
  assert.equal(result.text, 'answered after the steer')
  assert.deepEqual(pendingInbox(sessions.store, session)['next-step'], [], 'nothing is left pending')
})

test('a stop during a tool call leaves the steer pending, and the next turn writes it before its own prompt', async () => {
  const controller = new AbortController()
  const { ctx, sessions, session } = harness(
    'stop',
    [{ toolCall: { name: 'slow_tool', arguments: {} } }, { text: 'never asked' }],
    (handle) => {
      queueSteer(sessions.store, handle, [{ type: 'text', text: 'steered then stopped' }])
      controller.abort()
    },
  )
  const stopped = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'run then stop', maxRounds: 4, signal: controller.signal })
  assert.ok((stopped.ended ?? []).includes('stopped by the caller'), `the turn was stopped (${(stopped.ended ?? []).join(', ')})`)
  const afterStop = sessions.store.read(session)
  assert.ok(!messageOrder(afterStop).includes('user:steered then stopped'), 'the stopped turn did not write the steer')
  const pending = pendingInbox(sessions.store, session)['next-step']
  assert.equal(pending.length, 1, 'the steer is still pending after the stop')
  assert.deepEqual(pending[0]?.content, [{ type: 'text', text: 'steered then stopped' }])

  // The next turn: its scripted rounds start again at step 0, so give it a plain answer.
  writeFileSync(join(scratch, 'stop-script.json'), JSON.stringify({ steps: [{ text: 'both answered' }] }))
  const next = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'the next prompt', maxRounds: 4 })
  assert.equal(next.text, 'both answered')
  const events = sessions.store.read(session)
  const order = messageOrder(events)
  const steerAt = order.indexOf('user:steered then stopped')
  const promptAt = order.indexOf('user:the next prompt')
  assert.ok(steerAt !== -1 && promptAt !== -1 && steerAt < promptAt, `the kept steer is written before the next prompt (${order.join(' | ')})`)
  assert.ok(order.indexOf('tool:tool finished') < steerAt, 'and after the stopped call’s result')
  assert.deepEqual(pendingInbox(sessions.store, session)['next-step'], [], 'nothing is left pending')
})

test('the inbox folds DSH splices and refuses an invalid one by its seq', () => {
  const message = (id: string) => ({ id, role: 'user', content: [{ type: 'text', text: id }] })
  const events = [
    { seq: 1, type: INBOX_SPLICED, target: 'next-step', start: 0, inserted: [message('a')] },
    { seq: 2, type: 'message', message: { role: 'user', content: [] } },
    { seq: 3, type: INBOX_SPLICED, target: 'next-step', start: 1, inserted: [message('b')] },
    { seq: 4, type: INBOX_SPLICED, target: 'next-turn', start: 0, inserted: [message('c')] },
    { seq: 5, type: INBOX_SPLICED, target: 'next-step', start: 0, removedCount: 1, inserted: [] },
  ]
  const inbox = foldInbox(events)
  assert.deepEqual(inbox['next-step'].map((entry) => entry.id), ['b'])
  assert.deepEqual(inbox['next-turn'].map((entry) => entry.id), ['c'])
  assert.throws(
    () => foldInbox([...events, { seq: 6, type: INBOX_SPLICED, target: 'next-step', start: 0, removedCount: 2, inserted: [] }]),
    /invalid persisted inbox splice at session seq 6/,
  )
  assert.throws(
    () => foldInbox([...events, { seq: 7, type: INBOX_SPLICED, target: 'next-step', start: 0, inserted: [message('c')] }]),
    /invalid persisted inbox splice at session seq 7/,
  )
})

test('a claim records the removal first and writes each message in order, and claims nothing when empty', () => {
  const ctx = new Context()
  const sessions = new SessionService(ctx, { root: join(scratch, 'claim-sessions') })
  const session = sessions.start({ cwd: scratch })
  const written: string[] = []
  const write = (content: readonly { type: string; text?: string }[]) => {
    const text = content.map((part) => part.text ?? '').join('')
    written.push(text)
    sessions.userContent(session, content as never)
  }
  assert.deepEqual(claimNextStep(sessions.store, session, write), [], 'an empty inbox claims nothing')
  const countBefore = sessions.store.count(session)
  queueSteer(sessions.store, session, [{ type: 'text', text: 'first' }])
  queueSteer(sessions.store, session, [{ type: 'text', text: 'second' }], { kind: 'team-message', messageId: 'm1' })
  assert.equal(sessions.store.count(session), countBefore + 2, 'a steer is one splice event and no message')
  const claimed = claimNextStep(sessions.store, session, write)
  assert.deepEqual(claimed.map((entry) => entry.source), [undefined, { kind: 'team-message', messageId: 'm1' }])
  assert.deepEqual(written, ['first', 'second'])
  const events = sessions.store.read(session).slice(countBefore + 2)
  assert.equal(events[0]?.type, INBOX_SPLICED, 'the claim is recorded before the messages')
  assert.equal(events[0]?.removedCount, 2)
  assert.equal(events[0]?.outcome, undefined, 'a claim delivers, it does not cancel')
  assert.deepEqual(events.slice(1).map((event) => event.type), ['message', 'message'])
  assert.deepEqual(pendingInbox(sessions.store, session)['next-step'], [])
})
