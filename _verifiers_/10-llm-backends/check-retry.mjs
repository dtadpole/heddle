// Provider retry on transient failures, as DSH's dsh-llm-retry executes an endpoint's retryPolicy (A110): a turn
// whose provider answers 429 and then 503 is retried (honouring Retry-After, then bounded backoff) and answers, with
// each retry recorded in the session log before its wait; an endpoint whose policy allows no retries fails at once;
// and a message steered into the turn while it waits to retry is part of the retried request (#250).
// Runs against whichever harness HEDDLE_BIN names, or the TypeScript build. A local double stands in for the provider.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/** An OpenAI-compatible double answering each request with the next reply. */
async function provider(replies) {
  const queue = [...replies]
  let requests = 0
  /** The body of every turn request, in order, so a check can read what each attempt sent. */
  const bodies = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if ((request.url ?? '').endsWith('/models')) {
        response.writeHead(404).end()
        return
      }
      /** A new session's title request is not a turn, and must not take a turn's scripted reply (#68). */
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      requests += 1
      bodies.push(body)
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
    bodies: () => bodies,
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

/** `heddle web` on a free port, resolved with its URL and token once it prints them. */
function startServer(env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--sandbox-root', env.HOME]), {
        cwd: env.HOME,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ base: match[1], token: match[2], kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`the server printed no URL within 20s\n${output}`))
        }
      }, 20_000).unref()
    })()
  })
}

async function call(server, method, path, body) {
  const response = await fetch(`${server.base}${path}${path.includes('?') ? '&' : '?'}token=${server.token}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed, text }
}

const until = async (predicate, what, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * #250: a steer sent while the turn waits to retry a rate-limited call reached the session but not the retried request,
 * and the attempt's reading then counted it as said before the call, so no round answered it. DSH's retry re-runs the
 * step, which builds its request from the session again. Now the retried request carries the steer and answers it, and
 * no further round is asked for.
 */
test('a message steered while the turn waits to retry is in the retried request, which answers it (#250)', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), 'web')) return
  const home = isolatedHome('retry-steer')
  const double = await provider([{ status: 429, headers: { 'retry-after': '2' } }, { text: 'answered with the steer' }])
  let server
  try {
    const config = join(home, 'heddle.json')
    writeFileSync(config, JSON.stringify({
      default: 'flaky',
      exclude: ['scripted'],
      endpoints: [{ name: 'flaky', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'double', stream: true }],
    }))
    server = await startServer({ HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config })
    const turn = call(server, 'POST', '/api/turn', { prompt: 'RA30 B please' })
    await until(() => double.requests() >= 1, 'the first request')
    const id = await until(async () => (await call(server, 'GET', '/api/sessions')).body?.[0]?.id, 'the session')
    // The refusal has been answered and the 2 s wait has begun: the steer lands inside it.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const steer = await call(server, 'POST', `/api/sessions/${encodeURIComponent(id)}/steer`, { prompt: 'STEERED-250 mention this' })
    assert.equal(steer.status, 200, `the steer is accepted: ${steer.text}`)
    assert.equal(double.requests(), 1, 'the retry has not gone out yet')
    const done = await turn
    assert.equal(done.status, 200, done.text)
    const bodies = double.bodies()
    assert.equal(bodies.length, 2, `the refused request and its retry, and no round after it: ${bodies.length} requests`)
    assert.ok(!bodies[0].includes('STEERED-250'), 'the first request went out before the steer')
    assert.ok(bodies[1].includes('STEERED-250'), 'the retried request carries the steered message')
    assert.ok(bodies[1].indexOf('STEERED-250') > bodies[1].indexOf('RA30 B please'), 'after the prompt it was steered into')
  } finally {
    server?.kill()
    await double.close()
    removeDir(home)
  }
})
