import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Headless functional keyboard regression for #103, serving the actual shared source page on private port 0.
 * Only authentication/API answers and session selection are fixtures. No build, model, live Settings write or
 * permission change is made. This judges cyclic focus and native keys, NOT full accessibility or both builds.
 * DSH installed reference: permission-presets/lib/client.js RiskConfirmation -> primitives Modal, shipped in
 * dsh-web-frontend/dist/assets/index-CN7NIWNw.js (uA -> S_ -> x_ focus hook).
 */
test('the actual risk card contains native Tab cycles and returns focus without changing permission', { timeout: 60000 }, async (context) => {
  if (!skipUnless(context, browserAvailable(), 'headless browser for risk-dialog focus')) return
  const writes = []
  const source = readFileSync(new URL('../../src/server/page.html', import.meta.url), 'utf8')
  // Disable only startup session/default-workspace creation; the actual control, listeners and CSS run unchanged.
  const page = source
    .replace('await restoreSelection()', '/* fixture has a selected session instead of creating one */')
    .replace('renderTree().then(() => initializeDefaultWorkspace())', 'renderTree()')
    .replace('</script>', `
window.__riskFixtureReady = () => { current = 'risk-fixture'; accessMode = 'workspace-write'; renderAccess() }
</script>`)
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.invalid').pathname
    if (request.method !== 'GET') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        writes.push({ path, body })
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'fixture refuses all writes' }))
      })
      return
    }
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(page)
    } else if (path === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': fixture\n\n')
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(path === '/api/status' ? { permission: { mode: 'workspace-write' } } : []))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.goto(`http://127.0.0.1:${server.address().port}/`)
    await browser.waitFor('typeof window.__riskFixtureReady === "function"')
    await browser.evaluate('window.__riskFixtureReady()')
    const focused = () => browser.evaluate('document.activeElement?.id')
    async function key(key, code, modifiers = 0) {
      const virtual = key === 'Tab' ? 9 : key === 'Escape' ? 27 : key === 'Enter' ? 13 : 32
      const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined
      await browser.send('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', key, code, modifiers, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, ...(text === undefined ? {} : { text, unmodifiedText: text }) })
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual })
    }
    async function open() {
      await browser.evaluate(`document.getElementById('access').click(); document.querySelector('#access-menu [data-mode="danger-full-access"]').click()`)
      assert.equal(await focused(), 'access-risk')
      assert.equal(await browser.evaluate('document.getElementById("access-enable").disabled'), true)
    }
    await open()
    // Three candidates before acknowledgement; four after. Repeated native key events cross both boundaries.
    for (const id of ['access-cancel', 'access-dialog-close', 'access-risk', 'access-cancel', 'access-dialog-close']) {
      await key('Tab', 'Tab')
      assert.equal(await focused(), id)
    }
    for (const id of ['access-cancel', 'access-risk', 'access-dialog-close', 'access-cancel']) {
      await key('Tab', 'Tab', 8)
      assert.equal(await focused(), id)
    }
    await key('Escape', 'Escape')
    assert.equal(await focused(), 'access')
    assert.equal(await browser.evaluate('document.getElementById("access-dialog").hidden'), true)
    await open()
    await key(' ', 'Space')
    assert.equal(await browser.evaluate('document.getElementById("access-risk").checked'), true, 'native Space checks acknowledgement')
    for (const id of ['access-cancel', 'access-enable', 'access-dialog-close', 'access-risk']) {
      await key('Tab', 'Tab')
      assert.equal(await focused(), id)
    }
    await key('Tab', 'Tab', 8)
    assert.equal(await focused(), 'access-dialog-close')
    await key('Enter', 'Enter')
    assert.equal(await focused(), 'access', 'native Enter closes via the existing button')
    await open()
    await browser.evaluate('document.getElementById("access-cancel").focus()')
    await key('Enter', 'Enter')
    assert.equal(await focused(), 'access')
    assert.deepEqual(writes, [], 'cancel/close/Escape/checkbox never write a permission or Settings')
    await open()
    await browser.evaluate('document.getElementById("access-risk").click(); document.getElementById("access-enable").focus()')
    await key('Enter', 'Enter')
    await browser.waitFor('document.getElementById("access").disabled === false')
    assert.equal(writes.length, 1, 'only confirmed native Enable activation attempts a request')
    assert.equal(writes[0].path, '/api/sessions/risk-fixture/permission', 'confirmation targets only the fixture session')
    assert.deepEqual(JSON.parse(writes[0].body), { mode: 'danger-full-access', confirm: 'full-access' })
    assert.equal(await browser.evaluate('document.getElementById("access-label").textContent'), 'Workspace Write', 'fixture refused the write')
  } finally {
    if (browser) await browser.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
