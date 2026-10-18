import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { chatDouble, fixtureDir, isolatedHome, removeDir, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The LLM switcher, judged in a browser against two real doubles.
 *
 * The claim is the owner's: a session's model can be switched from the bottom of the chat panel. Every part of
 * that sentence is judged here, and each one has a failure mode a screenshot would not show:
 *
 * - **the list is the server's**, so a page cannot offer a backend the run does not have — and it must be
 *   drawn by the page rather than by a native `<select>`, because an endpoint a session recorded that the
 *   configuration no longer holds still has to be named;
 * - **choosing one asks that backend**, which is measured where it happens: one double receives the next
 *   turn and the other receives nothing;
 * - **the choice is recorded on the session**, which is what a reload is: the second `goto` has no page
 *   memory at all, and the seat has to come back to the same endpoint from the server's answer alone.
 *
 * The two doubles are the two endpoints, which is DSH's shape: `conversation.input.model` offers the backends
 * the host knows, and selecting one binds it to **this session** rather than to the harness.
 */

const CAPABILITY = 'the Web UI'

/** Two endpoints, each its own local double, so which one answered is a countable fact. */
async function startServer(label) {
  const home = isolatedHome(`switcher-${label}`)
  const work = fixtureDir(`switcher-${label}-work`)
  const one = await chatDouble({ content: 'answer from one' })
  const two = await chatDouble({ content: 'answer from two' })
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'double-one',
    endpoints: [
      { name: 'double-one', kind: 'openai-chat', baseUrl: one.baseUrl, model: 'model-one', stream: true },
      { name: 'double-two', kind: 'openai-chat', baseUrl: two.baseUrl, model: 'model-two', stream: true },
    ],
  })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'double-one', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_CONFIG: config } },
  )
  return {
    one,
    two,
    url: child.url,
    close: async () => {
      child.kill()
      await one.close()
      await two.close()
      removeDir(home)
      removeDir(work)
    },
  }
}

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], {
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
          resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
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
      }, 15_000)
    })()
  })
}

/** The cookie the printed URL mints, the way a browser gets it, so a check can read the API too. */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

test('a session can be switched to another endpoint, and the switch survives a reload', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('switch')
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("model-label") !== null', 20_000), 'the panel is up')

    /**
     * The seat starts on the endpoint the run nominated, which is what `selectWorkspace`-style defaults mean:
     * a page that opened on the first row of the list would ignore `--endpoint` and the configuration.
     *
     * Wait for the **text**, not only for the element: the label exists as `model` before `loadEndpoints` answers,
     * so asserting on presence alone measured the boot order rather than the seat (it failed on this machine while
     * other checks held the machine busy, on a build where nothing in this area had changed).
     */
    assert.ok(
      await browser.waitFor('document.getElementById("model-label").textContent.startsWith("double-one")', 20_000),
      'the seat shows the endpoint the run nominated',
    )
    assert.equal(
      await browser.evaluate('document.getElementById("model-label").textContent'),
      'double-one · model-one',
      'with the model the endpoint answers with',
    )

    /** The menu holds every configured endpoint, with the current one marked, and it is drawn by the page. */
    await browser.evaluate('document.getElementById("model-trigger").click()')
    const menu = JSON.parse(
      await browser.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('#model-menu button')).map((item) => ({
        text: item.textContent,
        checked: item.getAttribute('aria-checked')
      })))`),
    )
    const names = menu.map((item) => item.text)
    assert.ok(names.some((text) => text.startsWith('double-one')), `the list names the endpoints (${names.join(', ')})`)
    assert.ok(names.some((text) => text.startsWith('double-two')), 'all of them, not only the default')
    assert.equal(menu.find((item) => item.text.startsWith('double-one')).checked, 'true', 'the current one is marked')

    /** Choosing one takes effect: the next turn is answered by the other double, and only by it. */
    await browser.evaluate(`Array.from(document.querySelectorAll('#model-menu button')).find((item) => item.textContent.startsWith('double-two')).click()`)
    assert.equal(
      await browser.evaluate('document.getElementById("model-label").textContent'),
      'double-two · model-two',
      'the seat shows the new choice at once',
    )
    await browser.evaluate(`(() => { const field = document.querySelector('textarea'); field.value = 'who answers?'; field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true })()`)
    assert.ok(
      await browser.waitFor('document.getElementById("log").innerText.includes("answer from two")', 20_000),
      'the chosen endpoint answered the turn',
    )
    assert.equal(server.two.requests.length, 1, 'the chosen double was asked')
    assert.equal(server.one.requests.length, 0, 'and the previous endpoint was not')

    /**
     * The choice is on the session, not only in the page. Read it over the API — the same record the tree and
     * a listing read — and then **reload**, which throws away every variable on the page: a switch that lived
     * only in memory would come back to the default here.
     */
    const cookie = await cookieFor(server.url)
    const sessions = await (await fetch(new URL('/api/sessions', server.url), { headers: { cookie } })).json()
    const newest = sessions[0]
    assert.equal(newest?.endpoint, 'double-two', `the session records the endpoint it was switched to (${JSON.stringify(newest)})`)

    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("model-label") !== null', 20_000), 'the panel came back')
    assert.ok(
      await browser.waitFor('document.getElementById("model-label").textContent.startsWith("double-two")', 10_000),
      'and the seat came back to the recorded endpoint rather than to the default',
    )
  } finally {
    browser.close()
    await server.close()
  }
})

test('the switcher refuses an endpoint the run does not have', async (context) => {
  /**
   * The route is the only place a name from a browser reaches the store, so it is validated there rather than
   * trusted. This is judged over HTTP rather than in the browser because it is the route's rule: a typo must be
   * refused **without** being recorded, or every following turn of that session fails with a name nobody
   * chose.
   */
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('refuse')
  try {
    const cookie = await cookieFor(server.url)
    const created = await fetch(new URL('/api/folders/session', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ folder: process.cwd() }),
    }).then((response) => response.json())
    const id = created.session?.id ?? created.session
    assert.ok(typeof id === 'string' && id.length > 0, `a session exists to switch (${JSON.stringify(created)})`)

    const refused = await fetch(new URL(`/api/sessions/${encodeURIComponent(id)}/model`, server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: 'no-such-endpoint' }),
    })
    assert.equal(refused.status, 400, 'an endpoint the run does not have is refused')
    const sessions = await (await fetch(new URL('/api/sessions', server.url), { headers: { cookie } })).json()
    assert.notEqual(sessions.find((session) => session.id === id)?.endpoint, 'no-such-endpoint', 'and nothing was recorded')

    const allowed = await fetch(new URL(`/api/sessions/${encodeURIComponent(id)}/model`, server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: 'double-two' }),
    })
    assert.equal(allowed.status, 200, 'a configured endpoint is accepted')
    const switched = await allowed.json()
    assert.equal(switched.endpoint, 'double-two', 'and the answer is the session record')
  } finally {
    await server.close()
  }
})
