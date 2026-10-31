import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The page's Browser tab (#86), after DSH's `ui-sidebar-browser` on Web.
 *
 * Four claims, each judged where it lives:
 *
 * 1. **Opt-in.** DSH's Web profile ships its Browser disabled; here the operator enables it with `HEDDLE_WEB_BROWSER=1`.
 *    A default server's `/api/status` carries no `browser` key and its page shows no entry point.
 * 2. **The address is checked before anything is framed.** `javascript:`, `file:`, `data:` and `blob:` input, a user
 *    name or password, and this application's own origin are refused with DSH's sentences, and nothing reaches the
 *    network. A bare host becomes HTTPS.
 * 3. **The frame is contained.** It carries DSH's default sandbox and no referrer; a framed script runs but cannot
 *    navigate the application; the page's own history drives Back and Forward; and a page that moves itself is marked
 *    unknown, with Back, Forward and Open in system browser disabled and Reload returning to the last known address.
 * 4. **The pane does not squeeze the conversation.** DSH's column budget holds beside any left-sidebar width and in any
 *    window: a 400-pixel conversation beside a track of at least 300, or a pane that covers the conversation column.
 *
 * The server never fetches or proxies a page, so the framed pages here come from a loopback double this check owns,
 * which also records every request it was sent — the evidence that a refused address loaded nothing and that no
 * request carried a referrer.
 */

const CAPABILITY = 'the Web UI'
const SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'
const REFUSED = {
  empty: 'Enter an address.',
  invalid: 'That address is invalid or too long.',
  protocol: 'Only HTTP and HTTPS addresses are supported; open local files from the workspace tree.',
  credentials: 'Addresses cannot contain a username or password.',
  origin: 'The browser tab cannot open this application itself.',
}
const UNKNOWN = 'The page navigated; this tab cannot read its new URL.'

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
        resolvePromise({ child, url: match[1] })
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

/** A `heddle web` on a free port; `browser` sets `HEDDLE_WEB_BROWSER=1`, and anything else leaves it unset. */
async function startServer(label, browser) {
  const home = isolatedHome(`browser-tab-${label}`)
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const env = { HEDDLE_HOME: home, HEDDLE_CONFIG: config }
  // An inherited value must not decide the default case.
  if (browser) env.HEDDLE_WEB_BROWSER = '1'
  else env.HEDDLE_WEB_BROWSER = ''
  const { child, url } = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    env,
  )
  return {
    url,
    close: () => {
      child.kill('SIGKILL')
      removeDir(home)
    },
  }
}

async function status(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
  const response = await fetch(new URL('/api/status', url), { headers: { cookie } })
  return { code: response.status, body: await response.json() }
}

/** The loopback pages the tab frames, and the log of what was asked of them. */
async function startPages() {
  const requests = []
  const page = (title, body = '') => `<!doctype html><title>${title}</title><p>${title}</p>${body}`
  const server = createServer((request, response) => {
    requests.push({ path: request.url, referer: request.headers.referer ?? null })
    const path = new URL(request.url, 'http://x').pathname
    const send = (html) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
    }
    if (path === '/one') return send(page('one'))
    if (path === '/two') return send(page('two'))
    // A page that moves itself once it has loaded: the second `load` the tab sees.
    if (path === '/moves') return send(page('moves', `<script>setTimeout(() => { location.href = '/moved' }, 50)</script>`))
    if (path === '/moved') return send(page('moved'))
    // A framed script that tries to take over the application, then reports what happened.
    if (path === '/escape') {
      return send(page('escape', `<script>
        let outcome = 'navigated'
        try { top.location.href = 'about:blank#escaped' } catch (error) { outcome = 'refused-' + error.name }
        fetch('/report?outcome=' + encodeURIComponent(outcome))
      </script>`))
    }
    if (path === '/report') return send('ok')
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, requests, close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())) }
}

/** Type into the active tab's address bar and submit it, as Enter does. */
function submit(browser, address) {
  return browser.evaluate(`(() => {
    const panel = document.querySelector('#rs-body .browser-tab:not([hidden])')
    const input = panel.querySelector('[data-browser="address"]')
    input.value = ${JSON.stringify(address)}
    panel.querySelector('form').requestSubmit()
    return true
  })()`)
}

/** What the active tab shows: its address state, notice, buttons and frame. */
function tabState(browser) {
  return browser.evaluate(`(() => {
    const panel = document.querySelector('#rs-body .browser-tab:not([hidden])')
    const frame = panel.querySelector('iframe')
    const notice = panel.querySelector('[data-browser="notice"]')
    const pick = (name) => panel.querySelector('[data-browser="' + name + '"]')
    return {
      address: pick('address').dataset.address,
      value: pick('address').value,
      invalid: pick('address').getAttribute('aria-invalid'),
      notice: notice.hidden ? '' : notice.textContent,
      back: pick('back').disabled,
      forward: pick('forward').disabled,
      reload: pick('reload').disabled,
      external: pick('external').disabled,
      frames: panel.querySelectorAll('iframe').length,
      src: frame === null ? null : frame.getAttribute('src'),
      sandbox: frame === null ? null : frame.getAttribute('sandbox'),
      referrerPolicy: frame === null ? null : frame.referrerPolicy,
    }
  })()`)
}

function waitForAddress(browser, state) {
  return browser.waitFor(`document.querySelector('#rs-body .browser-tab:not([hidden]) [data-browser="address"]')?.dataset.address === ${JSON.stringify(state)}`, 10_000)
}

test('/api/status reports the Browser tab only when the operator enabled it, on either build', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const plain = await startServer('status-off', false)
  const enabled = await startServer('status-on', true)
  try {
    const off = await status(plain.url)
    assert.equal(off.code, 200)
    assert.equal('browser' in off.body, false, `a default server says nothing about a Browser: ${JSON.stringify(off.body)}`)
    assert.equal(typeof off.body.sandbox?.mode, 'string', 'the default answer keeps its sandbox mode')
    const on = await status(enabled.url)
    assert.equal(on.code, 200)
    assert.equal(on.body.browser, true, `HEDDLE_WEB_BROWSER=1 enables it: ${JSON.stringify(on.body)}`)
  } finally {
    plain.close()
    enabled.close()
  }
})

test('a default server shows no Browser entry point and no right sidebar', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('page-off', false)
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`, 15_000)
    const seen = await browser.evaluate(`(() => {
      const open = document.getElementById('browser-open')
      return { exists: open !== null, hidden: open?.hidden ?? null, sidebar: document.getElementById('right-sidebar')?.hidden ?? null }
    })()`)
    assert.deepEqual(seen, { exists: true, hidden: true, sidebar: true }, 'the entry point exists but stays hidden, and so does the sidebar')
  } finally {
    await browser.close()
    server.close()
  }
})

test('an enabled Browser tab refuses unsafe addresses and frames HTTP(S) pages in DSH\'s sandbox', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('page-on', true)
  const pages = await startPages()
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`, 15_000)
    await browser.waitFor(`document.getElementById('browser-open').hidden === false`, 5_000)
    await browser.evaluate(`document.getElementById('browser-open').click()`)
    await browser.waitFor(`document.getElementById('right-sidebar').hidden === false && document.querySelectorAll('#rs-tabs [role="tab"]').length === 1`, 5_000)
    const opened = await browser.evaluate(`({
      expanded: document.getElementById('browser-open').getAttribute('aria-expanded'),
      focused: document.activeElement?.dataset?.browser ?? null,
    })`)
    assert.deepEqual(opened, { expanded: 'true', focused: 'address' }, 'the globe opens the sidebar with the cursor in a new tab\'s address bar')
    // The toolbar is one row: the page's `form` rule stacked it into a column once (measured in a screenshot).
    const row = await browser.evaluate(`(() => {
      const panel = document.querySelector('#rs-body .browser-tab:not([hidden])')
      const top = (name) => Math.round(panel.querySelector('[data-browser="' + name + '"]').getBoundingClientRect().top)
      const height = (name) => Math.round(panel.querySelector('[data-browser="' + name + '"]').getBoundingClientRect().height)
      return { back: top('back') + height('back') / 2, address: top('address') + height('address') / 2, external: top('external') + height('external') / 2 }
    })()`)
    assert.ok(Math.abs(row.back - row.address) <= 2 && Math.abs(row.external - row.address) <= 2, `Back, the address and Open share one row: ${JSON.stringify(row)}`)

    // 2. Refusals: each leaves the tab without a frame and sends nothing anywhere.
    const app = new URL(server.url)
    const refusals = [
      ['', REFUSED.empty],
      ['   ', REFUSED.empty],
      ['javascript:alert(1)', REFUSED.protocol],
      ['file:///etc/passwd', REFUSED.protocol],
      ['data:text/html,<b>hi</b>', REFUSED.protocol],
      [`blob:${pages.base}/0`, REFUSED.protocol],
      [`http://user:secret@${new URL(pages.base).host}/one`, REFUSED.credentials],
      [`${app.origin}/`, REFUSED.origin],
      [`http://localhost:${app.port}/`, REFUSED.origin],
      // Chrome's parser takes a space in a host, so the malformed case is one every parser refuses.
      ['http://[::1', REFUSED.invalid],
      [`${pages.base}/${'x'.repeat(16_400)}`, REFUSED.invalid],
    ]
    for (const [address, sentence] of refusals) {
      await submit(browser, address)
      const state = await tabState(browser)
      assert.equal(state.notice, sentence, `${JSON.stringify(address.slice(0, 60))} is refused with DSH's sentence`)
      assert.equal(state.invalid, 'true', `${JSON.stringify(address.slice(0, 60))} marks the address invalid`)
      assert.equal(state.frames, 0, `${JSON.stringify(address.slice(0, 60))} frames nothing`)
    }
    assert.deepEqual(pages.requests, [], 'no refused address reached the network')

    // 3. A loopback page is framed with DSH's sandbox and no referrer.
    await submit(browser, `${pages.base}/one`)
    await waitForAddress(browser, 'known')
    let state = await tabState(browser)
    assert.equal(state.src, `${pages.base}/one`)
    assert.equal(state.sandbox, SANDBOX, 'the frame carries DSH\'s default sandbox, unchanged')
    assert.equal(state.referrerPolicy, 'no-referrer')
    assert.equal(state.notice, '', 'a good address clears the refusal')
    assert.equal(state.invalid, 'false')
    assert.deepEqual([state.back, state.forward, state.reload, state.external], [true, true, false, false], 'one entry: Reload and Open, no Back or Forward')
    const tabLabel = await browser.evaluate(`document.querySelector('#rs-tabs [role="tab"][aria-selected="true"]').textContent`)
    assert.equal(tabLabel, '127.0.0.1', 'the tab is named for the page\'s host')

    // History is this page's: Back and Forward re-frame the entries it asked for.
    await submit(browser, `${pages.base}/two`)
    await waitForAddress(browser, 'known')
    state = await tabState(browser)
    assert.deepEqual([state.src, state.back, state.forward], [`${pages.base}/two`, false, true])
    await browser.evaluate(`document.querySelector('#rs-body .browser-tab:not([hidden]) [data-browser="back"]').click()`)
    await waitForAddress(browser, 'known')
    state = await tabState(browser)
    assert.deepEqual([state.src, state.value, state.back, state.forward], [`${pages.base}/one`, `${pages.base}/one`, true, false], 'Back returns to the first page')
    await browser.evaluate(`document.querySelector('#rs-body .browser-tab:not([hidden]) [data-browser="forward"]').click()`)
    await waitForAddress(browser, 'known')
    state = await tabState(browser)
    assert.equal(state.src, `${pages.base}/two`, 'Forward returns to the second')

    // A framed script runs, and cannot navigate the application.
    const before = await browser.evaluate('location.href')
    await submit(browser, `${pages.base}/escape`)
    const reported = async () => pages.requests.find((entry) => entry.path.startsWith('/report?'))
    for (let attempt = 0; attempt < 50 && (await reported()) === undefined; attempt += 1) await new Promise((r) => setTimeout(r, 100))
    const report = await reported()
    assert.ok(report !== undefined, 'the framed script ran (allow-scripts) and reported')
    await new Promise((r) => setTimeout(r, 300))
    const outcome = new URL(report.path, 'http://x').searchParams.get('outcome')
    assert.equal(await browser.evaluate('location.href'), before, `the application did not move (the frame saw: ${outcome})`)

    // A page that moves itself is marked unknown; Reload returns to the last known address.
    await submit(browser, `${pages.base}/moves`)
    await waitForAddress(browser, 'unknown')
    state = await tabState(browser)
    assert.equal(state.notice, UNKNOWN)
    assert.deepEqual([state.back, state.forward, state.external, state.reload], [true, true, true, false], 'unknown: no Back, Forward or Open; Reload stays')
    const movesBefore = pages.requests.filter((entry) => entry.path === '/moves').length
    await browser.evaluate(`document.querySelector('#rs-body .browser-tab:not([hidden]) [data-browser="reload"]').click()`)
    await browser.waitFor(`document.querySelector('#rs-body .browser-tab:not([hidden]) iframe') !== null`, 5_000)
    for (let attempt = 0; attempt < 50 && pages.requests.filter((entry) => entry.path === '/moves').length === movesBefore; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(pages.requests.filter((entry) => entry.path === '/moves').length, movesBefore + 1, 'Reload framed the last known address again')
    assert.equal((await tabState(browser)).src, `${pages.base}/moves`)

    // A bare host becomes HTTPS, and `localhost:<port>` is a host, not a scheme.
    await submit(browser, `localhost:${new URL(pages.base).port}/one`)
    state = await tabState(browser)
    assert.equal(state.src, `https://localhost:${new URL(pages.base).port}/one`, 'a bare host is framed over HTTPS')

    // The frame's own loads carry no referrer; a framed page's own fetch may name that page, never the application.
    const framed = new Set(['/one', '/two', '/moves', '/escape'])
    assert.deepEqual(pages.requests.filter((entry) => framed.has(entry.path) && entry.referer !== null), [], 'no frame load carried a referrer')
    assert.deepEqual(pages.requests.filter((entry) => (entry.referer ?? '').startsWith(app.origin)), [], 'no request named the application')

    // A second tab, then closing both, hides the sidebar again.
    await browser.evaluate(`document.getElementById('rs-new').click()`)
    assert.equal(await browser.evaluate(`document.querySelectorAll('#rs-tabs [role="tab"]').length`), 2)
    await browser.evaluate(`document.querySelectorAll('#rs-tabs .rs-tab-close').forEach((button) => button.click())`)
    const closed = await browser.evaluate(`({
      sidebar: document.getElementById('right-sidebar').hidden,
      expanded: document.getElementById('browser-open').getAttribute('aria-expanded'),
      frames: document.querySelectorAll('#right-sidebar iframe').length,
    })`)
    assert.deepEqual(closed, { sidebar: true, expanded: 'false', frames: 0 }, 'closing the last tab hides the sidebar and drops its frames')
  } finally {
    await browser.close()
    await pages.close()
    server.close()
  }
})

/**
 * The columns as the reader sees them, for DSH's budget (`dsh-client-ui-layout` `computeColumns`): beside a right track
 * the conversation keeps 400 pixels and the track 300, or there is no track.
 */
const COLUMNS = `(() => {
  const pane = document.getElementById('right-sidebar')
  const main = document.querySelector('main').getBoundingClientRect()
  const rect = pane.getBoundingClientRect()
  return {
    fixed: getComputedStyle(pane).position === 'fixed',
    main: Math.round(main.width),
    mainLeft: Math.round(main.left),
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
    viewport: document.documentElement.clientWidth,
    sidebar: document.body.dataset.sidebar,
  }
})()`

/** A track leaves the conversation its minimum; a pane with no room for a track covers the whole conversation column. */
function assertBudget(columns, label) {
  const seen = JSON.stringify(columns)
  if (columns.fixed) {
    assert.ok(columns.left <= columns.mainLeft && columns.right >= columns.viewport, `${label}: a pane without room covers the conversation column, not part of it ${seen}`)
    return
  }
  assert.ok(columns.main >= 400, `${label}: the conversation keeps DSH's 400-pixel minimum beside the track ${seen}`)
  assert.ok(columns.width >= 300, `${label}: the track keeps DSH's 300-pixel minimum ${seen}`)
  assert.ok(columns.mainLeft + columns.main + columns.width <= columns.viewport + 1, `${label}: the columns fit the window ${seen}`)
}

test('on a desktop the right sidebar never squeezes the conversation, whatever the left sidebar\'s width', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('page-budget', true)
  const browser = await openBrowser({ width: 1280, height: 800 })
  const settle = () => browser.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))))`)
  const key = (name) => browser.evaluate(`document.getElementById('gutter-left').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true }))`)
  const resize = (width) => browser.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
  try {
    // 1100 pixels: the widest left sidebar leaves no room for a 300-pixel track beside 400 of conversation, whether it
    // stops at the page's 48rem or at DSH's 420 pixels (1100 - 420 - 400 = 280), and the default and the minimum do.
    await resize(1100)
    // A reader who once dragged the left sidebar to its widest: the page restores that width on every visit.
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`, 15_000)
    await browser.evaluate(`localStorage.setItem('heddle.layout.sidebar.v1', '48')`)
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`, 15_000)
    await browser.waitFor(`document.getElementById('browser-open').hidden === false`, 5_000)
    await browser.evaluate(`document.getElementById('browser-open').click()`)
    await settle()
    const widest = await browser.evaluate(COLUMNS)
    assertBudget(widest, 'opened beside the widest left sidebar at 1100 pixels')
    assert.equal(widest.fixed, true, `with no room for a 300-pixel track beside 400 of conversation, the pane covers ${JSON.stringify(widest)}`)

    await key('Home')
    await settle()
    const narrowest = await browser.evaluate(COLUMNS)
    assertBudget(narrowest, 'after the left sidebar shrank to its minimum')
    assert.equal(narrowest.fixed, false, `room made by the left sidebar turns the pane back into a track ${JSON.stringify(narrowest)}`)

    await key('End')
    await settle()
    assertBudget(await browser.evaluate(COLUMNS), 'after the left sidebar grew to its maximum with the pane open')

    await browser.evaluate(`document.getElementById('gutter-left').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await settle()
    const standard = await browser.evaluate(COLUMNS)
    assertBudget(standard, 'beside the default left sidebar')
    assert.equal(standard.fixed, false, `the default left sidebar leaves room for a track at 1100 pixels ${JSON.stringify(standard)}`)

    for (const width of [1280, 1000, 800]) {
      await resize(width)
      await settle()
      assertBudget(await browser.evaluate(COLUMNS), `in a window resized to ${width} pixels`)
    }

    // DSH's `openRightbar`: opening below 1024 pixels puts a narrow opening of the left sidebar back to its rail.
    await resize(1000)
    await browser.evaluate(`document.getElementById('rs-close').click()`)
    await browser.evaluate(`document.getElementById('sidebar-toggle').click()`)
    await settle()
    assert.equal(await browser.evaluate(`document.body.dataset.sidebar`), 'expanded', 'the narrow toggle opened the left sidebar')
    await browser.evaluate(`document.getElementById('browser-open').click()`)
    await settle()
    const reopened = await browser.evaluate(COLUMNS)
    assert.equal(reopened.sidebar, 'collapsed', `opening the pane below 1024 pixels returns the left sidebar to its rail ${JSON.stringify(reopened)}`)
    assertBudget(reopened, 'reopened below 1024 pixels')
  } finally {
    await browser.close()
    server.close()
  }
})

test('at phone width the right sidebar covers the window instead of squeezing the conversation', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('page-narrow', true)
  const browser = await openBrowser({ width: 390, height: 844 })
  try {
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`, 15_000)
    await browser.waitFor(`document.getElementById('browser-open').hidden === false`, 5_000)
    await browser.evaluate(`document.getElementById('browser-open').click()`)
    const box = await browser.evaluate(`(() => {
      const rect = document.getElementById('right-sidebar').getBoundingClientRect()
      return { position: getComputedStyle(document.getElementById('right-sidebar')).position, left: rect.left, width: rect.width, viewport: innerWidth }
    })()`)
    assert.equal(box.position, 'fixed')
    assert.equal(box.left, 0)
    assert.equal(box.width, box.viewport, 'the sidebar takes the whole width')
    await browser.evaluate(`document.getElementById('rs-close').click()`)
    assert.equal(await browser.evaluate(`document.getElementById('right-sidebar').hidden`), true, 'its close control puts it away')
  } finally {
    await browser.close()
    server.close()
  }
})
