import assert from 'node:assert/strict'
import { test } from 'node:test'

import { repairToolPairing } from '../src/context/pairing.ts'
import type { Message } from '../src/llm/types.ts'

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
