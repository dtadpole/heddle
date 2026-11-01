import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { openAiChatAdapter } from '../src/llm/adapters.ts'
import type { Chunk, EndpointConfig, GenerateRequest } from '../src/llm/types.ts'

/**
 * A Chat Completions stream asks for its usage and reads it from OpenAI's own last frame (#69).
 *
 * Measured before (developer-four, GPT-6 Luna on meta-gpt, both builds): turns answered normally but recorded no
 * usage, so the stats dock, the context headline and the token totals missed them. Neither build sent
 * `stream_options.include_usage`, which DSH's OpenAI-completions layer sends unless a model's compat says the
 * provider cannot; and the fold took usage only from the finish frame, while OpenAI reports it in a frame of its
 * own after that one, `choices: []`, before `[DONE]`. DeepSeek puts usage on the finish frame unasked.
 */

const request: GenerateRequest = { endpoint: 'e', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }

/** A gateway shaped like OpenAI's: usage only when asked, and then in its own frame after the finish frame. */
async function gateway(stream: boolean): Promise<{ body: Record<string, unknown>; chunks: Chunk[] }> {
  let body: Record<string, unknown> = {}
  const server = createServer((incoming, response) => {
    let raw = ''
    incoming.on('data', (chunk) => {
      raw += chunk
    })
    incoming.on('end', () => {
      body = JSON.parse(raw) as Record<string, unknown>
      const asked = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 1 } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`)
      frame({ choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      if (asked) frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const chunks: Chunk[] = []
  try {
    const endpoint: EndpointConfig = { name: 'e', kind: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'm', stream }
    for await (const chunk of openAiChatAdapter(endpoint, request)) chunks.push(chunk)
  } finally {
    server.close()
  }
  return { body, chunks }
}

test('a stream asks for its usage and its done carries the usage from the frame after the finish frame', async () => {
  const { body, chunks } = await gateway(true)
  assert.deepEqual(body.stream_options, { include_usage: true }, 'the stream asks for usage')
  const done = chunks.filter((chunk) => chunk.type === 'done')
  assert.equal(done.length, 1, 'one done')
  assert.deepEqual(done[0], { type: 'done', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } })
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => (chunk as { text: string }).text), ['ok'])
})

test('a single answer sends no stream_options, which a non-streamed call refuses', async () => {
  const { body } = await gateway(false)
  assert.equal('stream_options' in body, false)
})
