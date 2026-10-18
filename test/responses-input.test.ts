import assert from 'node:assert/strict'
import { test } from 'node:test'

import { toResponsesContent, toResponsesInput } from '../src/llm/adapters.ts'
import type { Message } from '../src/llm/types.ts'

/**
 * The Responses shape's `input` list, which is not a message list.
 *
 * Three rules here were measured against a live Meta-internal Codex route on 2026-10-18 rather than read
 * off a specification, and each one had been wrong in a way that reading alone did not show:
 *
 * - an assistant message's text part is `output_text`, not `input_text` — the route refused the latter with
 *   `Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'`, so a conversation
 *   failed on its second turn while a one-shot probe passed;
 * - a tool call is a `function_call` **item beside the messages**, because the shape has no content part for
 *   one, and an adapter that dropped it ran a tool loop that could never continue;
 * - a tool result is a `function_call_output` item, because the shape has no `tool` role.
 *
 * The fourth rule is about the stream rather than the request, and lives in the adapter: the item's `id` and
 * its `call_id` are different strings, and the argument deltas name the first while the request needs the
 * second.
 */

test('an assistant message is sent as output_text, and every other role as input_text', () => {
  assert.deepEqual(toResponsesContent([{ type: 'text', text: 'hi' }], 'assistant'), [
    { type: 'output_text', text: 'hi' },
  ])
  assert.deepEqual(toResponsesContent([{ type: 'text', text: 'hi' }], 'user'), [
    { type: 'input_text', text: 'hi' },
  ])
  // The default is the role a caller most often means, and it must not become the assistant's part.
  assert.deepEqual(toResponsesContent([{ type: 'text', text: 'hi' }]), [{ type: 'input_text', text: 'hi' }])
})

test('a conversation becomes messages, function calls and function results, in order', () => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"echo hi"}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'it printed hi' }] },
  ]
  assert.deepEqual(toResponsesInput(messages), [
    { role: 'developer', content: [{ type: 'input_text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
    { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"echo hi"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'hi' },
    { role: 'assistant', content: [{ type: 'output_text', text: 'it printed hi' }] },
  ])
})

test('an assistant turn made only of reasoning is not sent as an empty message', () => {
  // Reasoning is not replayed, so the message would arrive with no content — which the route refuses. The
  // turn still has to be recorded in the session; it just is not part of what the provider is asked.
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'I should answer in one word' }] },
  ]
  assert.deepEqual(toResponsesInput(messages), [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }])
})

test('a tool result with several text blocks keeps them apart', () => {
  const messages: Message[] = [
    {
      role: 'tool',
      toolCallId: 'call_9',
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
    },
  ]
  assert.deepEqual(toResponsesInput(messages), [
    { type: 'function_call_output', call_id: 'call_9', output: 'line one\nline two' },
  ])
})
