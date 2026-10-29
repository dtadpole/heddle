// Provider retry on transient failures, as DSH's dsh-llm-retry executes an endpoint's retryPolicy (A110): a turn
// whose provider answers 429 and then 503 is retried (honouring Retry-After, then bounded backoff) and answers, with
// each retry recorded in the session log before its wait; an endpoint whose policy allows no retries fails at once.
// Runs against whichever harness HEDDLE_BIN names, or the TypeScript build. A local double stands in for the provider.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, runCli } from '../../_tools_/verify-runner/lib.mjs'

/** An OpenAI-compatible double answering each request with the next reply. */
async function provider(replies) {
  const queue = [...replies]
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if ((request.url ?? '').endsWith('/models')) {
        response.writeHead(404).end()
        return
      }
      requests += 1
      const reply = queue.shift() ?? { status: 500 }
      if (reply.status !== undefined) {
        response.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) })
        response.end('{"error":{"message":"the double failed on purpose"}}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests: () => requests,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }),
  }
}

/** Every session event under `root`, read with the runner's transcript reader (zstd frames or plain lines). */
function sessionEvents(root) {
  const events = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd')) events.push(...readTranscript(path))
    }
  }
  walk(root)
  return events
}

async function turnAgainst(replies, retryPolicy) {
  const home = isolatedHome('retry')
  const double = await provider(replies)
  try {
    const config = join(home, 'heddle.json')
    const endpoint = { name: 'flaky', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'double', stream: true, ...(retryPolicy ? { retryPolicy } : {}) }
    writeFileSync(config, JSON.stringify({ default: 'flaky', exclude: ['scripted'], endpoints: [endpoint] }))
    const run = await runCli(['--endpoint', 'flaky', '--sandbox-root', home, '--turn', 'say something', '--json'], {
      env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    })
    return { run, requests: double.requests(), events: sessionEvents(join(home, '.heddle')) }
  } finally {
    await double.close()
    removeDir(home)
  }
}

test('a rate limit and a server error are retried as DSH retries them, and the turn answers', async () => {
  const { run, requests, events } = await turnAgainst([
    { status: 429, headers: { 'retry-after': '0.05' } },
    { status: 503 },
    { text: 'recovered after two retries' },
  ])
  assert.equal(run.code, 0, `the turn answers\n${run.stderr.slice(-600)}`)
  assert.match(run.stdout, /recovered after two retries/)
  assert.equal(requests, 3, 'the first request and two retries')
  const retries = events.filter((event) => event.type === 'llm/retry')
  assert.deepEqual(
    retries.map((event) => [event.retry, event.failure?.code]),
    [
      [1, 'RATE_LIMIT'],
      [2, 'SERVER'],
    ],
    'each retry is recorded with the failure it answers',
  )
  assert.equal(retries[0].delayMs, 50, "the provider's Retry-After is the first wait")
  assert.ok(retries[1].delayMs >= 900 && retries[1].delayMs <= 1100, `then the default backoff, 1000 ms ± 10%: ${retries[1].delayMs}`)
  assert.equal(events.filter((event) => event.type === 'llm/retry-started').length, 2)
})

test('an endpoint whose policy allows no retries fails at the first transient failure', async () => {
  const { run, requests, events } = await turnAgainst([{ status: 503 }, { text: 'never asked' }], { mode: 'normal', maxRetries: 0 })
  assert.notEqual(run.code, 0, 'the turn fails')
  assert.equal(requests, 1, 'the endpoint said no retries')
  assert.equal(events.filter((event) => event.type === 'llm/retry').length, 0)
})
