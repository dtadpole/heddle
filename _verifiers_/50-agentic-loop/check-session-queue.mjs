import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A prompt sent while a turn runs is queued on the host, in the session's durable next-turn inbox (issue #162), and a
 * prompt queued during a goal round runs before the next round (#177).
 *
 * DSH writes a message sent while a turn runs into the session's inbox (`agent/inbox/spliced` on `next-turn`), draws its
 * queue dock from that projection, and runs the first queued message as the next turn once the running one ends; its
 * round driver yields to queued input (`competingQueued`). heddle's page kept its queue in a page-local map, so a reload
 * dropped it, and its send at the turn's end lost the race to the goal driver's next round.
 *
 * 1. The queue: queue three prompts behind a held turn (one retried with the same requestId, one edited, one removed).
 *    The list, the outcomes, and the order the turns run in follow DSH's inbox.
 * 2. #177: a prompt queued during a held goal round runs before round 2.
 */

const CAPABILITY = 'the Web UI'

/** Spawn `heddle web` on a free port and resolve with its URL once it prints one. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...heddleCommand(args), {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL') })
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
        reject(new Error(`the server printed no URL within 15s\n${output}`))
      }
    }, 15_000).unref()
  })
}

/** The token in the printed URL, exchanged for the cookie the API calls use. */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** A Chat Completions double: a prompt containing HOLD is held until released; everything else answers at once. */
async function double() {
  const requests = []
  const held = []
  const send = (response, text) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const frame of [{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]) response.write(`data: ${JSON.stringify(frame)}\n\n`)
    response.end('data: [DONE]\n\n')
  }
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      requests.push(raw)
      if (raw.includes('Create a concise title')) return send(response, 'A title')
      const body = JSON.parse(raw)
      // Held: a prompt that says HOLD and has no answer after it yet (context notes may follow it as user messages).
      const messages = body.messages ?? []
      const at = messages.findLastIndex((message) => JSON.stringify(message.content ?? '').includes('HOLD'))
      if (at !== -1 && !messages.slice(at + 1).some((message) => message.role === 'assistant')) {
        held.push(() => send(response, 'held answer'))
        return
      }
      return send(response, 'answered')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    held: () => held.length,
    release: () => {
      for (const resume of held.splice(0)) resume()
    },
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}

async function harness(label) {
  const home = isolatedHome(label)
  const work = fixtureDir(`${label}-work`)
  mkdirSync(work, { recursive: true })
  const provider = await double()
  const config = join(home, 'heddle.json')
  writeFileSync(config, `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`)
  const root = join(home, 'sessions')
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', root],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const cookie = await cookieFor(server.url)
  await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
  const post = (path, body) => api(server.url, cookie, path, { method: 'POST', body: JSON.stringify(body) })
  return {
    provider,
    server,
    work,
    root,
    post,
    get: (path) => api(server.url, cookie, path),
    log: (session) => readTranscript(join(root, session)),
    close: () => {
      server.kill()
      provider.close()
      removeDir(home)
      removeDir(work)
    },
  }
}

const userTexts = (log) =>
  log
    .filter((event) => event.type === 'message' && event.message?.role === 'user')
    .map((event) => (event.message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join(''))

const until = async (condition, ms, what) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('#162: prompts queued behind a running turn are kept on the host, listed, edited, removed and run in order', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const h = await harness('session-queue')
  try {
    const first = await h.post('/api/turn', { prompt: 'HOLD the first turn', folder: h.work, new: true, detach: true })
    assert.equal(first.status, 202, `the first turn started (${JSON.stringify(first.body)})`)
    const session = first.body.session
    await until(() => h.provider.held() === 1, 10_000, 'the first turn to reach the model')

    const queue = (prompt, requestId) => h.post('/api/turn', { session, prompt, queue: true, requestId, detach: true })
    const a = await queue('QUEUED-A', 'request-a')
    assert.equal(a.status, 202, JSON.stringify(a.body))
    assert.equal(a.body.queued, true, `a prompt sent to the busy session is queued\nsaw: ${JSON.stringify(a.body)}`)
    const retry = await queue('QUEUED-A', 'request-a')
    assert.deepEqual([retry.body.id, retry.body.duplicate], [a.body.id, true], 'a retry with the same requestId answers the same row')
    const b = await queue('QUEUED-B', 'request-b')
    const c = await queue('QUEUED-C', 'request-c')

    const edited = await h.post(`/api/sessions/${session}/queue/edit`, { id: c.body.id, text: 'QUEUED-C-EDITED' })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    const removed = await h.post(`/api/sessions/${session}/queue/remove`, { id: b.body.id })
    assert.deepEqual([removed.status, removed.body.outcome], [200, 'removed'], JSON.stringify(removed.body))

    const listed = await h.get(`/api/sessions/${session}/queue`)
    assert.deepEqual(
      listed.body.items.map((item) => [item.text, item.requestId]),
      [
        ['QUEUED-A', 'request-a'],
        ['QUEUED-C-EDITED', 'request-c'],
      ],
      'the list is the host\'s, in order, with each row\'s request id',
    )

    h.provider.release()
    await until(() => userTexts(h.log(session)).includes('QUEUED-C-EDITED') && h.log(session).filter((event) => event.type === 'turn/completed').length >= 3, 20_000, 'the queued turns to run')
    assert.deepEqual(userTexts(h.log(session)), ['HOLD the first turn', 'QUEUED-A', 'QUEUED-C-EDITED'], 'each queued prompt ran once, in order; the removed one never ran')
    const cancel = h.log(session).find((event) => event.type === 'agent/inbox/spliced' && event.outcome === 'canceled')
    assert.ok(cancel !== undefined, 'the removal is recorded as DSH records input dropped unrun')
    assert.deepEqual((await h.get(`/api/sessions/${session}/queue`)).body.items, [], 'nothing is left queued')
    const late = await h.post(`/api/sessions/${session}/queue/remove`, { id: a.body.id })
    assert.deepEqual([late.status, late.body.outcome], [409, 'claimed'], 'a row its turn already took cannot be removed')
  } finally {
    h.close()
  }
})

test('#177: a prompt queued during a goal round runs before the next round', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const h = await harness('session-queue-goal')
  try {
    const first = await h.post('/api/turn', { prompt: 'ready', folder: h.work, new: true, detach: true })
    const session = first.body.session
    await until(() => h.log(session).some((event) => event.type === 'turn/completed'), 10_000, 'the first turn')
    const created = await h.post('/api/goal', { session, action: 'create', objective: 'HOLD each round, never complete', max_goal_rounds: 2 })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    await until(() => h.provider.held() === 1, 10_000, 'round 1 to reach the model')
    const queued = await h.post('/api/turn', { session, prompt: 'QUEUED-177', queue: true, requestId: 'request-177', detach: true })
    assert.equal(queued.body.queued, true, `queued behind the round\nsaw: ${JSON.stringify(queued.body)}`)
    h.provider.release()
    await until(() => h.provider.held() === 1 || userTexts(h.log(session)).filter((text) => text.includes('Round: 2/')).length > 0, 20_000, 'round 2')
    const texts = userTexts(h.log(session))
    const queuedAt = texts.indexOf('QUEUED-177')
    const round2At = texts.findIndex((text) => text.includes('Round: 2/'))
    assert.ok(queuedAt !== -1 && round2At !== -1 && queuedAt < round2At, `the queued prompt ran before round 2\n${JSON.stringify(texts.map((text) => text.slice(0, 40)))}`)
    h.provider.release()
    await h.post('/api/goal', { session, action: 'clear' })
  } finally {
    h.close()
  }
})
