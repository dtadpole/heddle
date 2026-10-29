import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { repairToolPairing } from '../src/context/pairing.ts'
import { ContextService } from '../src/context/service.ts'
import type { Message } from '../src/llm/types.ts'
import { SessionService } from '../src/session/service.ts'

/**
 * The tool-pair repair: every assistant `tool_calls` message reaches the provider with one answer per call.
 *
 * The provider's own words are the contract — an assistant message with tool calls "must be followed by tool
 * messages responding to each tool_call_id". A stopped or throwing turn used to break that, and the log stayed
 * broken, so every later request failed. These pin the repair, including the mirror-image case of an answer whose
 * question is gone.
 */

const assistant = (...ids: readonly string[]): Message => ({
  role: 'assistant',
  content: [
    { type: 'text', text: 'working' },
    ...ids.map((id) => ({ type: 'tool-call' as const, id, name: 'bash', arguments: '{}' })),
  ],
})

const answer = (id: string, text = 'ok'): Message => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text }] })

test('a call the turn never answered gets an interrupted answer before the next message', () => {
  const broken = [assistant('c1', 'c2'), answer('c1')]
  const repaired = repairToolPairing(broken)
  assert.deepEqual(
    repaired.map((message) => [message.role, message.toolCallId ?? null]),
    [
      ['assistant', null],
      ['tool', 'c1'],
      ['tool', 'c2'],
    ],
  )
  const filled = repaired[2]
  assert.ok(filled !== undefined && filled.role === 'tool')
  assert.match(String(filled.content[0]?.type === 'text' ? filled.content[0].text : ''), /INTERRUPTED/)
  assert.equal(broken.length, 2, 'the log-shaped input is not mutated')
})

test('a paired conversation is returned unchanged, and no copy is made', () => {
  const paired = [assistant('c1', 'c2'), answer('c1'), answer('c2'), { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] }]
  assert.equal(repairToolPairing(paired), paired, 'a valid request passes through as the same array')
})

test('every call is answered when the conversation ends on the calls', () => {
  const repaired = repairToolPairing([assistant('c1', 'c2', 'c3'), answer('c1')])
  const answers = repaired.filter((message) => message.role === 'tool').map((message) => message.toolCallId)
  assert.deepEqual(answers, ['c1', 'c2', 'c3'])
})

test('an answer separated from its call by a steering message is moved into place, not replaced', () => {
  const separated = [
    assistant('c1'),
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'steer: also check the tests' }] },
    answer('c1', 'the real tool output'),
  ]
  const repaired = repairToolPairing(separated)
  assert.deepEqual(
    repaired.map((message) => [message.role, message.toolCallId ?? null]),
    [
      ['assistant', null],
      ['tool', 'c1'],
      ['user', null],
    ],
  )
  const result = repaired[1]
  assert.ok(result !== undefined && result.role === 'tool')
  assert.match(String(result.content[0]?.type === 'text' ? result.content[0].text : ''), /the real tool output/)
})

test('an answer whose question is absent is dropped rather than sent as an orphan', () => {
  const repaired = repairToolPairing([answer('gone'), { role: 'user', content: [{ type: 'text', text: 'next' }] }])
  assert.deepEqual(
    repaired.map((message) => message.role),
    ['user'],
  )
})

test('text that is not a tool exchange is left alone', () => {
  const plain = [
    { role: 'system' as const, content: [{ type: 'text' as const, text: 'be brief' }] },
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'hello' }] },
  ]
  assert.equal(repairToolPairing(plain), plain)
})

/**
 * A log written before the inbox existed keeps its bad order on disk, and every request built from it is repaired.
 *
 * R-developer-two-5 measured the shape on both builds: the prompt, the assistant's `bash` call (seq 4-5), the steer
 * written at once (seq 6), the call's result (seq 7), then the stop. Logs are append-only, so nothing rewrites
 * such a session. What keeps it answerable is the request path: `prepare` derives the messages from the surface and
 * runs them through the repair, which moves the result back beside its call and keeps the steer after it.
 */
const oldLogs = mkdtempSync(join(tmpdir(), 'heddle-pairing-old-log-'))
const previousHome = process.env.HEDDLE_HOME
process.env.HEDDLE_HOME = join(oldLogs, 'home')
after(() => {
  if (previousHome === undefined) delete process.env.HEDDLE_HOME
  else process.env.HEDDLE_HOME = previousHome
  rmSync(oldLogs, { recursive: true, force: true })
})

test('an old log with a steer between a call and its result reaches the model repaired, and the log is left as written', async () => {
  const ctx = new Context()
  const sessions = new SessionService(ctx, { root: join(oldLogs, 'sessions') })
  const session = sessions.start({ cwd: oldLogs })
  sessions.user(session, 'run long')
  sessions.store.assistantChunk(session, { type: 'tool-call', id: 'call-bash', name: 'bash', arguments: '{"command":"sleep 30"}' })
  sessions.store.assistantChunk(session, { type: 'done', finishReason: 'tool_calls' })
  sessions.user(session, 'queued steer')
  sessions.store.message(session, { role: 'tool', toolCallId: 'call-bash', content: [{ type: 'text', text: 'error (EXIT): the command exited null' }] })
  sessions.store.append(session, { type: 'assistant/completed', text: '', ended: ['stopped by the caller'] })

  const shapeOf = (messages: readonly Message[]) =>
    messages
      .filter((message) => message.role !== 'system' && !(message.role === 'user' && message.content.every((part) => part.type === 'text' && part.text.startsWith('Current runtime context'))))
      .map((message) => `${message.role}:${message.content.map((part) => (part.type === 'text' ? part.text : part.type === 'tool-call' ? `call(${part.id})` : '')).join('')}`)

  const stored = shapeOf(sessions.store.deriveMessages(session))
  assert.deepEqual(stored, ['user:run long', 'assistant:call(call-bash)', 'user:queued steer', 'tool:error (EXIT): the command exited null'], 'the log keeps the bad order')

  const context = new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const report = await context.prepare(session, { cwd: oldLogs, endpoint: 'scripted' })
  assert.deepEqual(shapeOf(report.messages).slice(-4), ['user:run long', 'assistant:call(call-bash)', 'tool:error (EXIT): the command exited null', 'user:queued steer'], 'the request carries the call, its result, then the steer')
  assert.deepEqual(shapeOf(sessions.store.deriveMessages(session)), stored, 'the repair is the request\'s, not a rewrite of the log')
})
