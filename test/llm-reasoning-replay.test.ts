import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { openAiChatAdapter, replaysReasoningContent, toChatMessage } from '../src/llm/adapters.ts'
import type { EndpointConfig, GenerateRequest } from '../src/llm/types.ts'

/**
 * developer-ten-3 (P1): a DeepSeek thinking-mode continuation must replay each assistant message's
 * `reasoning_content`, or the provider answers 400 "The `reasoning_content` in the thinking mode must be passed back to
 * the API" — after a steer, a subagent's notice, or a tool round. DSH's rule (pi-ai's openai-completions compat
 * `requiresReasoningContentOnAssistantMessages`): auto-detected for a base URL containing `deepseek.com`; while
 * reasoning is on, every replayed assistant message carries its thinking text, or "" when it has none.
 */

const thinking: GenerateRequest['messages'][number] = {
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'count up' },
    { type: 'reasoning', text: '   ' },
    { type: 'reasoning', text: 'from one' },
    { type: 'text', text: '1 2 3' },
  ],
}
const plain: GenerateRequest['messages'][number] = { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
const user: GenerateRequest['messages'][number] = { role: 'user', content: [{ type: 'text', text: 'STEER: stop' }] }

test('a replayed assistant message carries its thinking, or "", only when asked; other roles never do', () => {
  assert.equal(toChatMessage(thinking, { reasoningContent: true }).reasoning_content, 'count up\nfrom one', 'blank blocks dropped')
  assert.equal(toChatMessage(plain, { reasoningContent: true }).reasoning_content, '', 'no thinking is ""')
  assert.equal('reasoning_content' in toChatMessage(user, { reasoningContent: true }), false, 'a user message has none')
  assert.equal('reasoning_content' in toChatMessage(thinking), false, 'off by default, as every other endpoint keeps it')
  assert.equal(toChatMessage(thinking, { reasoningContent: true }).content, '1 2 3', 'the text is unchanged')
})

test('only a DeepSeek base URL with reasoning on replays reasoning_content', () => {
  const deepseek: EndpointConfig = { name: 'ds', kind: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', model: 'm' }
  const other: EndpointConfig = { name: 'gw', kind: 'openai-chat', baseUrl: 'https://gateway.example/v1', model: 'm' }
  const quiet: GenerateRequest = { endpoint: 'ds', messages: [user, plain, user] }
  const thought: GenerateRequest = { endpoint: 'ds', messages: [user, thinking, user] }
  assert.equal(replaysReasoningContent(deepseek, quiet, true), true, 'a named reasoning level turns it on')
  assert.equal(replaysReasoningContent(deepseek, thought, false), true, 'so does reasoning already in the history')
  assert.equal(replaysReasoningContent(deepseek, quiet, false), false, 'no reasoning, no field')
  assert.equal(replaysReasoningContent(other, thought, true), false, 'another endpoint is left as it was')
})

/** One chat request against a loopback route; the body it sent. */
async function sent(path: string, request: GenerateRequest): Promise<{ messages: Record<string, unknown>[] }> {
  let body: { messages: Record<string, unknown>[] } = { messages: [] }
  const server = createServer((incoming, response) => {
    let raw = ''
    incoming.on('data', (chunk) => {
      raw += chunk
    })
    incoming.on('end', () => {
      body = JSON.parse(raw) as typeof body
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  try {
    const endpoint: EndpointConfig = { name: 'e', kind: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}${path}`, model: 'm', stream: true }
    for await (const _chunk of openAiChatAdapter(endpoint, request)) {
      // drain
    }
  } finally {
    server.close()
  }
  return body
}

test('the request a DeepSeek route receives replays reasoning_content on every assistant message', async () => {
  const request: GenerateRequest = { endpoint: 'e', messages: [user, thinking, user, plain, user] }
  const body = await sent('/deepseek.com/v1', request)
  const assistants = body.messages.filter((message) => message.role === 'assistant')
  assert.deepEqual(
    assistants.map((message) => message.reasoning_content),
    ['count up\nfrom one', ''],
  )
  assert.ok(body.messages.filter((message) => message.role === 'user').every((message) => !('reasoning_content' in message)))
})

test('any other chat route receives no reasoning_content at all', async () => {
  const request: GenerateRequest = { endpoint: 'e', messages: [user, thinking, user] }
  const body = await sent('/v1', request)
  assert.ok(body.messages.every((message) => !('reasoning_content' in message)), JSON.stringify(body.messages))
})
