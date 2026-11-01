/**
 * Verifier — an Anthropic turn marks its prompt for caching, and records what the cache saved (#70).
 *
 * **The claim it decides:** a turn on an `anthropic-messages` endpoint sends `cache_control: {type: 'ephemeral'}` on
 * the system prompt, on the last tool and on the last block of the last user message, as DSH's route does by
 * default. It records the provider's cache read and write in the turn's usage. An endpoint with `promptCache: false`
 * sends no breakpoint.
 *
 * Measured before (live, conclave-claude, Claude Sonnet 4.5, both builds): a two-turn session billed 5193 then 5205
 * input tokens with no cache read or write, because neither adapter set a breakpoint (pi-ai `anthropic-messages`:
 * `getCacheControl`, default retention "short").
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, runCli, sessionsUnder, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/** A Messages double that reports a cache read and write when the request carries a breakpoint, as Anthropic does. */
async function messagesDouble() {
  const bodies = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      if (request.method !== 'POST' || !(request.url ?? '').endsWith('/messages')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{"type":"error","error":{"type":"not_found_error","message":"not the Messages route"}}')
        return
      }
      bodies.push(JSON.parse(raw || '{}'))
      const marked = raw.includes('cache_control')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
      send('message_start', {
        message: { usage: { input_tokens: 20, ...(marked ? { cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 } : {}) } },
      })
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'one' } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
      send('message_stop', {})
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, bodies, close: () => server.close() }
}

async function supportsTurns() {
  const help = (await runCli(['--help'])).stdout
  return /--endpoint/.test(help) && /--turn/.test(help)
}

/** One `--turn` on the double; what the request carried and what the done chunk recorded. */
async function turnOn(label, extra) {
  const home = isolatedHome(`prompt-cache-${label}`)
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const double = await messagesDouble()
  try {
    const config = writeJson(join(home, 'heddle.json'), {
      default: 'claude',
      endpoints: [{ name: 'claude', kind: 'anthropic-messages', baseUrl: double.baseUrl, model: 'claude-model', apiKey: 'a-test-key', maxOutputTokens: 64, ...extra }],
    })
    const run = await runCli(['--endpoint', 'claude', '--sandbox-root', home, '--session-root', sessions, '--turn', 'Reply with only: one', '--max-rounds', '1', '--json'], {
      env: { HOME: home, HEDDLE_CONFIG: config },
      timeoutMs: 120_000,
    })
    const ids = sessionsUnder(sessions)
    const events = ids.length === 1 ? readTranscript(join(sessions, ids[0])) : []
    const done = events.find((event) => event.type === 'assistant/chunk' && event.chunk?.type === 'done')
    return { run, body: double.bodies[0], usage: done?.chunk?.usage }
  } finally {
    double.close()
    removeDir(home)
  }
}

const ephemeral = { type: 'ephemeral' }

test('an Anthropic turn marks its system prompt, last tool and last user block for caching, and records the cache read', async (context) => {
  if (!skipUnless(context, await supportsTurns(), '`--endpoint` and `--turn`')) return
  const { run, body, usage } = await turnOn('on', {})
  assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
  assert.ok(body, 'the double was called')
  // A profile may send no system prompt (a bare --turn does not); when there is one, it carries a breakpoint.
  if (body.system !== undefined) {
    assert.ok(Array.isArray(body.system), `the system prompt is a block list (${JSON.stringify(body.system)?.slice(0, 120)})`)
    assert.deepEqual(body.system.at(-1)?.cache_control, ephemeral, 'the system prompt carries a breakpoint')
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    assert.deepEqual(body.tools.at(-1)?.cache_control, ephemeral, 'the last tool carries a breakpoint')
    assert.ok(body.tools.slice(0, -1).every((tool) => tool.cache_control === undefined), 'and only the last')
  }
  const last = body.messages.at(-1)
  assert.equal(last?.role, 'user')
  assert.deepEqual(last.content.at(-1)?.cache_control, ephemeral, 'the last block of the last user message carries one')
  assert.equal(usage?.cacheReadTokens, 4000, `the turn records the cache read (${JSON.stringify(usage)})`)
  assert.equal(usage?.cacheWriteTokens, 300, 'and the cache write')
})

test('an endpoint with promptCache: false sends no breakpoint', async (context) => {
  if (!skipUnless(context, await supportsTurns(), '`--endpoint` and `--turn`')) return
  const { run, body } = await turnOn('off', { promptCache: false })
  assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
  assert.equal(JSON.stringify(body).includes('cache_control'), false, 'no cache_control anywhere in the request')
})
