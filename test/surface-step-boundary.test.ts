import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deriveMessage, foldSurface, indexBySeq, type SessionEvent } from '../src/session/store.ts'

/**
 * A message that lands mid-step is placed at the step boundary (#30).
 *
 * Measured before (developer-one, on main 8ce30549): a steer or a settlement notice written while the model streamed
 * closed the chunk run, the rest of the step became a second assistant node after it, and the next request ended with
 * that assistant message. In thinking mode the provider read it as a prefix to continue and refused it for want of
 * its reasoning, and in any mode the model never saw its own reply before the message. An inbox splice inside a run
 * cut the step, and its later chunks were lost.
 */

/** A log built in order, each event taking the next seq. */
function log(...events: readonly Omit<SessionEvent, 'seq'>[]): readonly SessionEvent[] {
  return events.map((event, index) => ({ ...event, seq: index + 1 }) as SessionEvent)
}
const text = (value: string) => ({ type: 'assistant/chunk', chunk: { type: 'text-delta', text: value } })
const reasoning = (value: string) => ({ type: 'assistant/chunk', chunk: { type: 'reasoning-delta', text: value } })
const call = (id: string) => ({ type: 'assistant/chunk', chunk: { type: 'tool-call', id, name: 'bash', arguments: '{}' } })
const done = { type: 'assistant/chunk', chunk: { type: 'done', finishReason: 'stop' } }
const user = (value: string) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: value }] } })
const result = (id: string) => ({ type: 'message', message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'ok' }] } })

/** What the model would read: every node, derived, as role and text. */
function read(events: readonly SessionEvent[]): string[] {
  const bySeq = indexBySeq(events)
  return foldSurface(events)
    .nodes.map((seq) => deriveMessage(bySeq, seq))
    .filter((message) => message !== null)
    .map((message) => `${message.role}:${message.content.map((part) => ('text' in part ? part.text : `[${part.type}]`)).join('')}`)
}

test('a message written while the model streams is read after the whole step, which stays one assistant message', () => {
  const events = log(user('count'), { type: 'model/request' }, reasoning('think '), text('1 2 '), user('NOTICE'), text('3'), done)
  assert.deepEqual(read(events), ['user:count', 'assistant:think 1 2 3', 'user:NOTICE'])
})

test('when the step called tools, a mid-step message is read after their results, so a call and its result stay adjacent', () => {
  const streaming = log(user('go'), { type: 'model/request' }, text('running '), user('STEER'), call('c1'), done, result('c1'))
  assert.deepEqual(read(streaming), ['user:go', 'assistant:running [tool-call]', 'tool:ok', 'user:STEER'])
  const whileTheToolRuns = log(user('go'), { type: 'model/request' }, call('c1'), done, user('STEER'), result('c1'))
  assert.deepEqual(read(whileTheToolRuns), ['user:go', 'assistant:[tool-call]', 'tool:ok', 'user:STEER'])
})

test('an inbox splice inside a run does not cut the step', () => {
  const events = log(user('count'), { type: 'model/request' }, text('1 2 '), { type: 'agent/inbox/spliced', target: 'next-step' }, text('3'), done)
  assert.deepEqual(read(events), ['user:count', 'assistant:1 2 3'])
})

test('a run cut short by the turn’s end stops there, and what follows is read in order', () => {
  const events = log(user('count'), { type: 'model/request' }, text('1 2 '), { type: 'turn/completed' }, user('next'), { type: 'model/request' }, text('ok'), done)
  assert.deepEqual(read(events), ['user:count', 'assistant:1 2 ', 'user:next', 'assistant:ok'])
})

test('a log that ends mid-step shows what is held at its end, and ordinary logs are unchanged', () => {
  const live = log(user('count'), { type: 'model/request' }, text('1 2 '), user('NOTICE'))
  assert.deepEqual(read(live), ['user:count', 'assistant:1 2 ', 'user:NOTICE'])
  const ordinary = log(user('a'), { type: 'model/request' }, call('c1'), done, result('c1'), { type: 'model/request' }, text('b'), done, user('c'))
  assert.deepEqual(read(ordinary), ['user:a', 'assistant:[tool-call]', 'tool:ok', 'assistant:b', 'user:c'])
})
