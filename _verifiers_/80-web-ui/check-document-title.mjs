import assert from 'node:assert/strict'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The browser tab follows the open session: `<session title> — Heddle`, and the product name alone with nothing open
 * or an untitled session, as DSH's `DocumentTitle` (`dsh-client-ui-layout`) sets it. The page's title was the static
 * `Heddle` whatever was open (DSH parity R-developer-seven-4, row S30).
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

function startServer(label) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const home = isolatedHome(`document-title-${label}`)
      const work = fixtureDir(`document-title-${label}-work`)
      const { config } = scriptedConfig({ home, steps: [{ text: 'answer' }] })
      const child = spawn(
        ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', `${home}/sessions`]),
        { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ url: match[1], work, close: async () => { child.kill('SIGKILL'); removeDir(home); removeDir(work) } })
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
    })()
  })
}

function call(browser, method, path, body) {
  return browser.evaluate(
    `fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }${
      body === undefined ? '' : `, body: ${JSON.stringify(JSON.stringify(body))}`
    } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`,
  )
}

async function titleBecomes(browser, expected, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  let title = await browser.evaluate('document.title')
  while (title !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    title = await browser.evaluate('document.title')
  }
  return title
}

test('the browser tab names the open session, as DSH does', async (t) => {
  if (!skipUnless(t, browserAvailable(), `needs ${CAPABILITY} and a browser`)) return
  const server = await startServer('main')
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`)

    await t.test('with nothing open the tab is the product name', async () => {
      assert.equal(await browser.evaluate('document.title'), 'Heddle')
    })

    assert.ok((await call(browser, 'POST', '/api/workspaces', { path: server.work })).status < 300, 'a workspace is registered')
    const titled = (await call(browser, 'POST', '/api/sessions', { branch: server.work, title: 'fix the parser' })).json.session
    const untitled = (await call(browser, 'POST', '/api/sessions', { branch: server.work })).json.session
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`)
    const open = async (id) => {
      await browser.waitFor(`!!document.querySelector('#tree li[data-session-id="${id}"] > .row')`)
      await browser.evaluate(`document.querySelector('#tree li[data-session-id="${id}"] > .row').click()`)
    }

    await t.test('opening a titled session names the tab after it', async () => {
      await open(titled)
      assert.equal(await titleBecomes(browser, 'fix the parser — Heddle'), 'fix the parser — Heddle')
    })

    await t.test('a rename shows in the tab', async () => {
      assert.ok((await call(browser, 'POST', `/api/sessions/${titled}/title`, { title: 'parser fixed' })).status < 300, 'the rename lands')
      await open(titled)
      assert.equal(await titleBecomes(browser, 'parser fixed — Heddle'), 'parser fixed — Heddle')
    })

    await t.test('an untitled session leaves the product name', async () => {
      await open(untitled)
      assert.equal(await titleBecomes(browser, 'Heddle'), 'Heddle')
    })
  } finally {
    await browser.close()
    await server.close()
  }
})
