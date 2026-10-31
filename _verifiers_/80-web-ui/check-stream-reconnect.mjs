import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { isolatedHome, removeDir, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A session title request (C6) is not the conversation: refused at once, as lib.mjs's helpers do on newer trees. Kept
 * here so this check runs on a base that predates them.
 */
const isTitleRequest = (body) => typeof body === 'string' && body.includes('Create a concise title for an AI coding-assistant session')
const refuseTitleRequest = (response) => {
  response.writeHead(400, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message: 'this double answers turns, not session titles' } }))
}

/**
 * Verifier — a page whose event stream drops and reconnects catches up with the server (#122).
 *
 * **The claim it decides:** after the page's connection to the server is cut and comes back, the open conversation
 * matches the server: no hole in an answer, a turn that ended during the gap ends on the page (Send comes back and
 * the next message is sent, not queued for good), and a turn that ran wholly inside the gap appears.
 *
 * Measured before (issue #122, developer-ten, both builds): the page's single `EventSource('/api/events')` reconnected,
 * but nothing re-read what it missed. An answer kept a hole (`1 … 12 589 … 600`), a turn that ended in the gap kept
 * Stop and queued the next message, which never reached the server, and a turn inside the gap never appeared.
 *
 * **How:** the page reaches the server through a TCP proxy this check owns, so it can drop every connection of the page
 * at once and refuse new ones for a while, as a redeploy, a network change or a laptop sleep does. The turns are sent
 * by "another page", straight to the server, so the cut never touches them.
 */

const CAPABILITY = 'a Web UI whose page follows the event stream'
const COUNT = 60
const COUNTED = Array.from({ length: COUNT }, (_, index) => `n${index + 1}`).join(' ')

/** A chat double: a prompt with COUNT streams n1 … n60, one every 50 ms; any other prompt is answered at once. */
async function slowDouble() {
  const prompts = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', async () => {
      const pathname = new URL(request.url ?? '/', 'http://x').pathname
      if (pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      const messages = JSON.parse(body || '{}').messages ?? []
      /**
       * The prompt is the newest user message carrying one of this check's markers: the harness follows a prompt with
       * user messages of its own (the runtime context, the time, the workspace instructions), so the last user
       * message is not the prompt.
       */
      const texts = messages
        .filter((message) => message.role === 'user')
        .map((message) => (typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text ?? '').join('')))
      const prompt = [...texts].reverse().find((text) => /COUNT|SHORT|AFTER the gap|QUEUED behind/.test(text)) ?? ''
      prompts.push(prompt)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (delta, finish = null) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      frame({ role: 'assistant', content: '' })
      if (prompt.includes('COUNT')) {
        for (let index = 1; index <= COUNT; index += 1) {
          if (response.destroyed) return
          frame({ content: `n${index}${index < COUNT ? ' ' : ''}` })
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
        }
      } else {
        frame({ content: `answer to: ${prompt}` })
      }
      frame({}, 'stop')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    prompts,
    close: () =>
      new Promise((resolvePromise) => {
        server.closeAllConnections?.()
        server.close(() => resolvePromise())
      }),
  }
}

/** A TCP proxy in front of the server that can drop every connection through it and refuse new ones until restored. */
async function cuttableProxy(target) {
  const sockets = new Set()
  let refusing = false
  const server = net.createServer((client) => {
    if (refusing) {
      client.destroy()
      return
    }
    const upstream = net.connect(Number(target.port), target.hostname)
    sockets.add(client)
    sockets.add(upstream)
    const drop = () => {
      sockets.delete(client)
      sockets.delete(upstream)
      client.destroy()
      upstream.destroy()
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', drop)
    upstream.on('close', drop)
    client.pipe(upstream)
    upstream.pipe(client)
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    port: server.address().port,
    cut() {
      refusing = true
      for (const socket of [...sockets]) socket.destroy()
      sockets.clear()
    },
    restore() {
      refusing = false
    },
    close: () =>
      new Promise((resolvePromise) => {
        refusing = true
        for (const socket of [...sockets]) socket.destroy()
        server.close(() => resolvePromise())
      }),
  }
}

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { heddleCommand, repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const child = spawn(...heddleCommand(args), {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
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

async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await sleep(50)
  return predicate()
}

const LOG_TEXT = `document.getElementById('log').innerText`

/**
 * One scenario's world: the double, the server, the proxy, a session made by a first short turn, and the page opened
 * through the proxy with that session shown.
 */
async function world(label) {
  const opened = []
  try {
    return await openWorld(label, opened)
  } catch (error) {
    // A setup that fails still closes what it opened, so the test process can exit and its browser hold ends.
    for (const close of opened.reverse()) await Promise.resolve(close()).catch(() => {})
    throw error
  }
}

async function openWorld(label, opened) {
  const home = isolatedHome(`stream-reconnect-${label}`)
  opened.push(() => removeDir(home))
  const double = await slowDouble()
  opened.push(() => double.close())
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'double',
    endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'model-one', capabilities: ['chat', 'stream'] }],
  })
  // HOME is the scratch home too, so the cookie-signing secret survives a restart of the server on it.
  const env = { HEDDLE_CONFIG: config, HEDDLE_HOME: home, HOME: home }
  const launch = (port) => startCli(['web', '--host', '127.0.0.1', '--port', String(port), '--endpoint', 'double', '--session-root', join(home, 'sessions')], { env })
  let server = await launch(0)
  opened.push(() => server.kill())
  let cookie = await cookieFor(server.url)
  /** "Another page": a turn sent straight to the server, whose whole answer stream resolves when it ends. */
  const turn = async (body) => {
    const response = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200, `the turn was accepted (${body.prompt})`)
    return response.text().catch(() => '')
  }
  await turn({ prompt: 'SHORT first' })
  const sessions = await (await fetch(new URL('/api/sessions', server.url), { headers: { cookie } })).json()
  const session = sessions[0]?.id
  assert.ok(typeof session === 'string', 'the first turn made a session')
  const target = new URL(server.url)
  const proxy = await cuttableProxy(target)
  opened.push(() => proxy.close())
  const pageUrl = new URL(server.url)
  pageUrl.port = String(proxy.port)
  const browser = await openBrowser({ width: 1280, height: 900 })
  opened.push(() => browser.close())
  await browser.goto(pageUrl.toString())
  assert.ok(await browser.waitFor(`${LOG_TEXT}.includes('answer to: SHORT first')`, 20_000), 'the page shows the session')
  return {
    double,
    proxy,
    browser,
    session,
    turn,
    /** Kill the server mid-whatever and start it again on the same home and port: another epoch, as a redeploy is. */
    restart: async () => {
      const port = new URL(server.url).port
      await new Promise((resolvePromise) => {
        server.child.once('exit', () => resolvePromise())
        server.kill()
      })
      server = await launch(port)
      cookie = await cookieFor(server.url)
    },
    close: async () => {
      browser.close()
      await proxy.close()
      server.kill()
      await double.close()
      removeDir(home)
    },
  }
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

test('a page whose stream drops in the middle of an answer catches up: the answer has no hole and is drawn once', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const at = await world('mid')
  try {
    const answered = at.turn({ prompt: 'COUNT for the page', session: at.session })
    assert.ok(await at.browser.waitFor(`${LOG_TEXT}.includes('n5 ')`, 15_000), 'the page follows the answer as it streams')
    at.proxy.cut()
    await sleep(1500)
    at.proxy.restore()
    await answered
    const whole = await at.browser.waitFor(`${LOG_TEXT}.includes(${JSON.stringify(COUNTED)})`, 20_000)
    const text = await at.browser.evaluate(LOG_TEXT)
    assert.ok(whole, `after the reconnect the answer is whole, n1 … n${COUNT} with no gap\n${text.slice(-600)}`)
    assert.equal(text.split('n1 n2 n3 ').length - 1, 1, 'and it is drawn once, not twice')
  } finally {
    await at.close()
  }
})

test('a turn that ends while the page is cut off ends on the page, and the next message is sent', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const at = await world('end')
  try {
    const answered = at.turn({ prompt: 'COUNT across the end', session: at.session })
    assert.ok(await at.browser.waitFor(`${LOG_TEXT}.includes('n5 ')`, 15_000), 'the page follows the answer as it streams')
    at.proxy.cut()
    await answered
    await sleep(300)
    at.proxy.restore()
    const ended = await at.browser.waitFor(
      `document.getElementById('stop').hidden === true && ${LOG_TEXT}.includes(${JSON.stringify(COUNTED)})`,
      20_000,
    )
    assert.ok(ended, `after the reconnect Send is back and the answer is whole\nstop hidden: ${await at.browser.evaluate(`document.getElementById('stop').hidden`)}`)
    await at.browser.evaluate(`(() => { const field = document.querySelector('#prompt textarea'); field.value = 'AFTER the gap'; field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
    assert.ok(await until(() => at.double.prompts.some((prompt) => prompt.includes('AFTER the gap')), 15_000), 'the next message reached the server, not a queue')
    assert.ok(await at.browser.waitFor(`${LOG_TEXT}.includes('answer to: AFTER the gap')`, 15_000), 'and its answer is shown')
  } finally {
    await at.close()
  }
})

test('a turn that runs wholly while the page is cut off appears after the reconnect', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const at = await world('gap')
  try {
    at.proxy.cut()
    await at.turn({ prompt: 'SHORT inside the gap', session: at.session })
    at.proxy.restore()
    assert.ok(
      await at.browser.waitFor(`${LOG_TEXT}.includes('SHORT inside the gap') && ${LOG_TEXT}.includes('answer to: SHORT inside the gap')`, 20_000),
      `the turn from the gap is shown, prompt and answer\n${(await at.browser.evaluate(LOG_TEXT)).slice(-400)}`,
    )
  } finally {
    await at.close()
  }
})

test('after a server restart, a message the page queued behind the cut-off turn is sent (the reset path)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const at = await world('reset')
  try {
    const answered = at.turn({ prompt: 'COUNT until the restart', session: at.session })
    assert.ok(await at.browser.waitFor(`${LOG_TEXT}.includes('n5 ')`, 15_000), 'the page follows the answer as it streams')
    await at.browser.evaluate(`(() => { const field = document.querySelector('#prompt textarea'); field.value = 'QUEUED behind the turn'; field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
    assert.ok(await at.browser.waitFor(`document.getElementById('queue').innerText.includes('QUEUED behind the turn')`, 5_000), 'the page queued the message behind the running turn')
    at.proxy.cut()
    await at.restart()
    await answered
    at.proxy.restore()
    assert.ok(
      await until(() => at.double.prompts.some((prompt) => prompt.includes('QUEUED behind the turn')), 25_000),
      `the queued message reached the restarted server (prompts: ${JSON.stringify(at.double.prompts)})`,
    )
    assert.ok(await at.browser.waitFor(`${LOG_TEXT}.includes('answer to: QUEUED behind the turn')`, 15_000), 'and its answer is shown')
    assert.ok(await at.browser.waitFor(`document.getElementById('stop').hidden === true`, 15_000), 'and Send is back once it ends (developer-ten)')
    assert.equal(at.double.prompts.filter((prompt) => prompt.includes('QUEUED behind the turn')).length, 1, 'sent once, not twice')
  } finally {
    await at.close()
  }
})
