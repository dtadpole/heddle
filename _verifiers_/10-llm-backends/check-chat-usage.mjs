/**
 * Verifier — a Chat Completions turn records its token usage on an OpenAI-shaped gateway too (#69).
 *
 * **The claim it decides:** a streamed turn on an `openai-chat` endpoint records the usage the provider reports. That
 * includes a gateway that reports usage only when the request asks for it (`stream_options.include_usage`), and then
 * in a frame of its own after the finish frame. A DeepSeek-shaped route, which puts usage on the finish frame unasked,
 * still records it.
 *
 * Measured before (developer-four, GPT-6 Luna on meta-gpt, both builds): the turns answered, but the done chunk had no
 * usage, so the stats dock, the context headline and the token totals missed them. DSH's OpenAI-completions layer
 * sends `include_usage` unless a model's compat says the provider cannot (pi-ai `supportsUsageInStreaming`).
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, runCli, sessionsUnder, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A streaming chat double. `openai`: usage only when asked, in its own `choices: []` frame after the finish frame.
 * `deepseek`: usage on the finish frame, asked or not.
 */
async function double(shape) {
  const bodies = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no model list' }))
        return
      }
      const body = JSON.parse(raw || '{}')
      bodies.push(body)
      const usage = { prompt_tokens: 12, completion_tokens: 3 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`)
      frame({ choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })
      if (shape === 'deepseek') {
        frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })
      } else {
        frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })
        if (body.stream_options?.include_usage === true) frame({ choices: [], usage })
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, bodies, close: () => server.close() }
}

async function supportsTurns() {
  const help = await runCli(['--help'])
  return /--endpoint/.test(help.stdout) && /--turn/.test(help.stdout)
}

/** One `--turn` on a double of the given shape; the usage its done chunk recorded, and the run. */
async function turnOn(shape) {
  const home = isolatedHome(`chat-usage-${shape}`)
  const work = join(home, 'work')
  const sessions = join(home, 'sessions')
  mkdirSync(work, { recursive: true })
  const provider = await double(shape)
  const config = join(home, 'heddle.json')
  writeFileSync(
    config,
    `${JSON.stringify({ default: 'gw', endpoints: [{ name: 'gw', kind: 'openai-chat', baseUrl: `http://127.0.0.1:${provider.port}/v1`, model: 'gw-model', stream: true }] }, null, 2)}\n`,
  )
  try {
    const run = await runCli(['--endpoint', 'gw', '--sandbox-root', work, '--session-root', sessions, '--turn', 'Say ok', '--json'], {
      // From the repository root, as every part-10 check runs the harness (it finds its profile there).
      env: { HOME: home, HEDDLE_CONFIG: config },
    })
    // The store's layout is its own business: ask the root for its sessions, and read each by root and id.
    const ids = sessionsUnder(sessions)
    const events = ids.length === 1 ? readTranscript(join(sessions, ids[0])) : []
    const done = events.find((event) => event.type === 'assistant/chunk' && event.chunk?.type === 'done')
    return { run, bodies: provider.bodies, usage: done?.chunk?.usage, sessions: ids.length }
  } finally {
    provider.close()
    removeDir(home)
  }
}

test('a turn on an OpenAI-shaped gateway asks for usage and records it from the frame after the finish frame', async (context) => {
  if (!skipUnless(context, await supportsTurns(), '`--endpoint` and `--turn`')) return
  const { run, bodies, usage, sessions } = await turnOn('openai')
  assert.equal(run.code, 0, `the turn ended normally\n${run.stdout}\n${run.stderr}`)
  assert.equal(sessions, 1, 'the turn recorded one session')
  assert.deepEqual(bodies[0]?.stream_options, { include_usage: true }, 'the stream asks for its usage')
  assert.equal(usage?.inputTokens, 12, `the done chunk records the input tokens (${JSON.stringify(usage)})`)
  assert.equal(usage?.outputTokens, 3, 'and the output tokens')
})

test('a turn on a DeepSeek-shaped route still records the usage it puts on the finish frame', async (context) => {
  if (!skipUnless(context, await supportsTurns(), '`--endpoint` and `--turn`')) return
  const { run, usage } = await turnOn('deepseek')
  assert.equal(run.code, 0, `the turn ended normally\n${run.stdout}\n${run.stderr}`)
  assert.equal(usage?.inputTokens, 12, `the done chunk records the input tokens (${JSON.stringify(usage)})`)
  assert.equal(usage?.outputTokens, 3, 'and the output tokens')
})
