import assert from 'node:assert/strict'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { isolatedHome, isTitleRequest, refuseTitleRequest, removeDir, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The Settings dialog tells a failed read apart from an empty configuration (issue #60), and lists every registered
 * workspace, nested ones under their parent (issue #108).
 *
 * With the server unreachable, every route the dialog reads used to come back as "nothing", and the dialog stated as
 * facts that "no endpoint is configured in this profile" and "no workspace root is registered yet", about a
 * configuration that was intact. DSH's surfaces report a failed read rather than inventing an empty answer, and the
 * page's own tree already says "could not read the workspaces: Failed to fetch" in the same situation. The check opens
 * Settings with the server up, then stops the server under the loaded page and opens it again.
 */

const listeners = new Set()
after(() => Promise.all([...listeners].map((listener) => listener.close())))

const CAPABILITY = 'the Settings dialog in the Web UI'

/** A chat double that answers one text delta and lists one model, so the endpoint is a real, reachable one. */
async function plainDouble() {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      if (isTitleRequest(body)) return refuseTitleRequest(response) // a new session's title request is no turn (#68)
      if ((request.url ?? '').endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'model-one', object: 'model' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const double = { baseUrl: `http://127.0.0.1:${port}/d`, close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())) }
  listeners.add(double)
  return double
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
          resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL'), exited: new Promise((done) => child.once('exit', done)) })
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

/** Open Settings the way its button does and answer the dialog's text once it is open. */
async function openSettings(browser) {
  await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
  assert.ok(await browser.waitFor(`document.getElementById('settings-dialog').open === true`, 10_000), 'Settings opens')
  return browser.evaluate(`document.getElementById('settings-dialog').innerText`)
}

test('Settings says a section could not be read when the server is unreachable, instead of calling it empty', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('settings-dialog')
  const double = await plainDouble()
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'double-one',
    endpoints: [
      { name: 'double-one', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'model-one', models: [{ id: 'model-one', name: 'Model One' }] },
    ],
  })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'double-one', '--session-root', join(home, 'sessions')],
    { env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config } },
  )
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.getElementById('settings-open') !== null`, 20_000), 'the page is up')

    const online = await openSettings(browser)
    assert.match(online, /double-one/, `online, Settings lists the configured endpoint\n${online}`)
    assert.doesNotMatch(online, /could not read/, 'and reports no failed read')
    await browser.evaluate(`(() => { document.getElementById('settings-close').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('settings-dialog').open === false`, 5_000), 'Settings closes')

    server.kill()
    await server.exited
    assert.ok(
      await browser.waitFor(`(async () => { try { await fetch('/api/status'); return false } catch { return true } })()`, 10_000),
      'the loaded page can no longer reach its server',
    )

    const offline = await openSettings(browser)
    assert.match(offline, /could not read the server status: /, `offline, the server section says it could not be read\n${offline}`)
    assert.match(offline, /could not read the endpoint list: /, 'and so does the models section')
    assert.match(offline, /could not read the workspaces: /, 'and the workspaces section')
    assert.doesNotMatch(offline, /no endpoint is configured/, 'it does not claim the endpoints are gone')
    assert.doesNotMatch(offline, /no workspace root is registered yet/, 'nor the workspaces')
  } finally {
    browser.close()
    server.kill()
    await double.close()
    listeners.delete(double)
    removeDir(home)
  }
})

test('Settings lists every registered workspace, each nested one indented under its parent', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('settings-workspaces')
  /** Registered in this order: a root, a workspace inside it, one inside that, and a second root. */
  const folders = ['proj-w', 'proj-w/ws-01', 'proj-w/ws-01/deep', 'proj-v'].map((relative) => {
    mkdirSync(join(home, relative), { recursive: true })
    return realpathSync(join(home, relative))
  })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') },
  })
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.getElementById('settings-open') !== null`, 20_000), 'the page is up')
    const registered = await browser.evaluate(`(async () => {
      for (const path of ${JSON.stringify(folders)}) {
        const response = await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
        if (!response.ok) return path + ': ' + response.status + ' ' + (await response.text())
      }
      return (await (await fetch('/api/workspaces')).json()).workspaces.length
    })()`)
    assert.equal(typeof registered, 'number', `the four folders register as workspaces\n${registered}`)

    const text = await openSettings(browser)
    const rows = await browser.evaluate(`[...document.querySelectorAll('#settings-workspaces .settings-workspace')].map((item) => ({
      path: item.querySelector('.path').textContent,
      depth: Number(item.dataset.depth),
      left: item.getBoundingClientRect().left,
    }))`)
    assert.equal(rows.length, registered, `Settings lists every workspace the server has registered (${registered})\n${text}`)
    const at = (path) => rows.findIndex((row) => row.path === path)
    const [w, nested, deep, v] = folders.map((path) => rows[at(path)])
    assert.ok(w && nested && deep && v, `all four registered folders are listed\n${text}`)
    /** The roots keep the server's record order; what is judged is that a nested workspace follows its parent. */
    assert.deepEqual(
      [at(folders[1]) - at(folders[0]), at(folders[2]) - at(folders[0])],
      [1, 2],
      `each nested workspace follows its parent directly\n${text}`,
    )
    assert.deepEqual(
      [nested.depth - w.depth, deep.depth - w.depth, v.depth - w.depth],
      [1, 2, 0],
      `one level deeper per nesting, and the second root at the first one's level\n${JSON.stringify(rows)}`,
    )
    assert.ok(w.left < nested.left && nested.left < deep.left, `a nested workspace is drawn indented under its parent\n${JSON.stringify(rows)}`)
    assert.equal(v.left, w.left, 'the second root is drawn at the first one\'s level')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
