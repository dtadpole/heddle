import assert from 'node:assert/strict'
import { test } from 'node:test'

import { requestMessages, type Message } from '../src/llm/types.ts'

/**
 * The provider boundary's rule about assistant turns.
 *
 * Reasoning is not replayed, so an assistant turn made only of reasoning carries nothing a provider can
 * accept. Measured against a real OpenAI-compatible gateway: resuming such a session sent
 * `{role: 'assistant', content: null}` and the gateway refused the request with "Invalid assistant
 * message: content or tool_calls must be set". These checks pin the rule that keeps that turn out of the
 * request while leaving the session's own record untouched.
 */

test('an assistant turn made only of reasoning is not sent', () => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'I should answer in one word' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ]
  const sendable = requestMessages(messages)
  assert.deepEqual(
    sendable.map((message) => message.role),
    ['system', 'user', 'assistant'],
  )
  assert.deepEqual(sendable[2]?.content, [{ type: 'text', text: 'hi' }])
})

test('a reasoning part beside text or a tool call does not disqualify the turn', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'read the file' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'the tool can list it' },
        { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      ],
    },
    { role: 'tool', content: [{ type: 'text', text: 'file body' }], toolCallId: 'call-1' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'now answer' }, { type: 'text', text: 'done' }] },
  ]
  const sendable = requestMessages(messages)
  assert.equal(sendable.length, 4, 'every user, tool and answered assistant turn is kept')
})

test('user, system and tool messages are never dropped, whatever they contain', () => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'tool', content: [{ type: 'text', text: 'output' }], toolCallId: 'call-1' },
  ]
  assert.deepEqual(requestMessages(messages), messages)
})

test('an assistant turn with no parts is dropped, and the order of the rest is kept', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'assistant', content: [] },
    { role: 'user', content: [{ type: 'text', text: 'two' }] },
  ]
  assert.deepEqual(
    requestMessages(messages).map((message) => message.content[0]),
    [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ],
  )
})
