import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The page's queue lives on the host (issue #162): a message queued while a turn runs survives a reload, is the same
 * list another client reads, and runs once when the turn ends.
 *
 * DSH queues it in the session's durable next-turn inbox and draws its dock from that projection. heddle's page kept
 * the queue in a page-local map, so a reload dropped the queued message without a word and it never ran.
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

test('#162: a message queued in the page survives a reload, is the host\'s, and runs once when the turn ends', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = await harness('queue-host-page')
  let browser = null
  try {
    const first = await h.post('/api/turn', { prompt: 'ready', folder: h.work, new: true, detach: true })
    const session = first.body.session
    await until(() => h.log(session).some((event) => event.type === 'turn/completed'), 10_000, 'the first turn')
    browser = await openBrowser({ width: 1280, height: 900 })
    const row = `document.querySelector('#tree li[data-kind="session"][data-session-id="${session}"] > .row')`
    const open = async () => {
      await browser.goto(h.server.url)
      await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
      await browser.waitFor(`${row} !== null`, 15_000)
      await browser.evaluate(`${row}.click()`)
      await browser.waitFor('document.getElementById("log").innerText.includes("ready")', 10_000)
    }
    await open()

    // A turn runs (another client's), and the person queues a message behind it in the page.
    await h.post('/api/turn', { session, prompt: 'HOLD this turn', detach: true })
    await until(() => h.provider.held() === 1, 10_000, 'the held turn to reach the model')
    await browser.waitFor('document.getElementById("log").innerText.includes("HOLD this turn")', 10_000)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    await browser.evaluate(`(() => {
      const field = document.querySelector('textarea')
      field.value = 'QUEUED-162 from the page'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      return true
    })()`)
    await until(async () => ((await h.get(`/api/sessions/${session}/queue`)).body.items ?? []).some((item) => item.text === 'QUEUED-162 from the page'), 10_000, 'the host to hold the queued message')
    await browser.waitFor(`[...document.querySelectorAll('#queue .row')].some((row) => row.textContent.includes('QUEUED-162'))`, 10_000)

    // A reload: the dock is drawn from the host's queue again.
    await open()
    try {
      await browser.waitFor(`[...document.querySelectorAll('#queue .row')].some((row) => row.textContent.includes('QUEUED-162'))`, 10_000)
    } catch {
      assert.fail(`after a reload the dock still shows the queued message\ndock: ${await browser.evaluate('document.getElementById("queue").innerText')}`)
    }

    // The turn ends: the host runs the queued message once, and the dock empties.
    h.provider.release()
    await until(() => userTexts(h.log(session)).includes('QUEUED-162 from the page') && h.log(session).filter((event) => event.type === 'turn/completed').length >= 3, 20_000, 'the queued message to run')
    assert.equal(userTexts(h.log(session)).filter((text) => text === 'QUEUED-162 from the page').length, 1, 'it ran once')
    await browser.waitFor('document.getElementById("queue").hidden === true', 10_000)
  } finally {
    await browser?.close()
    h.close()
  }
})
