import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Another client's pin, archive or unarchive reaches every open page (issue #167).
 *
 * DSH's workspace feed publishes `archived` and `pinned` whenever either set changes (dsh-api-workspace-controller
 * lib/index.js:115-129), so every client moves or drops the row at once. heddle's flags route pushed no stream frame on
 * either build, so an open page kept a pinned row unmarked and an archived row in place until something else redrew it.
 *
 * 1. The stream: a second client's POST /flags is followed by a `sessions` frame naming the session and its flags.
 * 2. The page: a row another client pins gets its pinned mark, one it archives leaves the tree, and an unarchive brings
 *    it back, each within a few seconds and with no reload.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`flags-frame-${label}`)
  const work = fixtureDir(`flags-frame-${label}-work`)
  mkdirSync(work, { recursive: true })
  const config = join(home, 'heddle.json')
  const script = join(home, 'script.json')
  scriptedConfig({ home, steps: [{ text: 'idle' }] })
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]), {
    cwd: work,
    env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise((resolvePromise, reject) => {
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) resolvePromise(match[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`the server exited ${code} before printing a URL\n${output}`)))
    setTimeout(() => reject(new Error(`the server printed no URL within 15s\n${output}`)), 15_000).unref()
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return {
    url,
    work,
    script,
    cookie,
    output: () => output,
    close: async () => {
      child.kill('SIGKILL')
      removeDir(home)
      removeDir(work)
    },
  }
}

async function api(server, path, init = {}) {
  const response = await fetch(new URL(path, server.url), { ...init, headers: { cookie: server.cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

/** The page's stream, read frame by frame. */
async function readFrames(server, signal) {
  const frames = []
  const stream = await fetch(new URL('/api/events', server.url), { headers: { cookie: server.cookie, accept: 'text/event-stream' }, signal })
  assert.equal(stream.status, 200, 'the stream opens')
  void (async () => {
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          let event = 'message'
          const data = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          }
          if (data.length === 0) continue
          try {
            frames.push({ event, data: JSON.parse(data.join('\n')) })
          } catch {
            frames.push({ event, data: data.join('\n') })
          }
        }
      }
    } catch {
      // aborted at the end of the test
    }
  })()
  return frames
}

async function sessionIn(server, folder, prompt) {
  const response = await fetch(new URL('/api/turn', server.url), {
    method: 'POST',
    headers: { cookie: server.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, folder, new: true }),
  })
  assert.equal(response.status, 200, 'the turn ran')
  return JSON.parse(/event: session\ndata: (.*)/.exec(await response.text())[1]).session
}

const until = async (condition, ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  return false
}

test('#167: a pin, an archive and an unarchive each push a sessions frame naming the session and its flags', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('stream')
  const controller = new AbortController()
  try {
    const folder = join(server.work, 'w1')
    mkdirSync(folder, { recursive: true })
    await api(server, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: folder }) })
    const session = await sessionIn(server, folder, 'hello')
    const frames = await readFrames(server, controller.signal)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    const flagFrames = () => frames.filter((frame) => frame.event === 'sessions' && frame.data?.type === 'session/flags' && frame.data?.session === session)
    for (const [patch, expected] of [
      [{ pinned: true }, { pinned: true, archived: false }],
      // Archiving unpins, as the store's flags rule has it; the frame carries what the record now says.
      [{ archived: true }, { pinned: false, archived: true }],
      [{ archived: false }, { pinned: false, archived: false }],
    ]) {
      const before = flagFrames().length
      const changed = await api(server, `/api/sessions/${encodeURIComponent(session)}/flags`, { method: 'POST', body: JSON.stringify(patch) })
      assert.equal(changed.status, 200, `the flags route answered (${JSON.stringify(changed.body)})`)
      assert.ok(await until(() => flagFrames().length > before, 3_000), `a sessions frame followed ${JSON.stringify(patch)}\nframes: ${JSON.stringify(frames.map((frame) => frame.event))}`)
      const last = flagFrames().at(-1).data
      assert.deepEqual({ pinned: last.pinned, archived: last.archived }, expected, `the frame names the flags after ${JSON.stringify(patch)}`)
    }
  } finally {
    controller.abort()
    await server.close()
  }
})

test('#167: an open page follows another client’s pin, archive and unarchive without a reload', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('page')
  let browser = null
  try {
    const folder = join(server.work, 'w1')
    mkdirSync(folder, { recursive: true })
    await api(server, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: folder }) })
    const keep = await sessionIn(server, folder, 'first')
    const target = await sessionIn(server, folder, 'second')
    browser = await openBrowser()
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    const row = (id) => `document.querySelector('#tree li[data-kind="session"][data-session-id="${id}"]')`
    await browser.waitFor(`${row(target)} !== null && ${row(keep)} !== null`, 15_000)
    const flag = async (patch) => {
      const changed = await api(server, `/api/sessions/${encodeURIComponent(target)}/flags`, { method: 'POST', body: JSON.stringify(patch) })
      assert.equal(changed.status, 200, JSON.stringify(changed.body))
    }
    const expectWithin = async (expression, what) => {
      try {
        await browser.waitFor(expression, 5_000)
      } catch {
        assert.fail(`${what}\nrows: ${await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#tree li[data-kind="session"]')].map((li) => ({ id: li.dataset.sessionId, pinned: li.dataset.pinned ?? null })))`)}`)
      }
    }
    await flag({ pinned: true })
    await expectWithin(`${row(target)}?.dataset.pinned === 'true' || ${row(target)}?.getAttribute('data-pinned') === 'true'`, 'the pinned row shows its mark')
    await flag({ archived: true })
    await expectWithin(`${row(target)} === null && ${row(keep)} !== null`, 'the archived row leaves the tree')
    await flag({ archived: false })
    await expectWithin(`${row(target)} !== null`, 'the unarchived row comes back')
  } finally {
    await browser?.close()
    await server.close()
  }
})
