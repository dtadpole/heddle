import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { chatDouble, fixtureDir, heddleCommand, httpConfig, isolatedHome, parseJson, removeDir, runCli, runCliSource, skipUnless } from '../../_tools_/verify-runner/lib.mjs'
import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'

/**
 * The sessions a reader can click live in the left panel's workspace tree. The old "ad hoc" group was removed
 * on 2026-10-17 — the tree is the one list — so this file keeps no selector for it; the checks below open the
 * session they need through the API, which is where the store is the contract.
 */
/**
 * Verifier 9 — the Web UI.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: a **Web UI on localhost, on a documented default
 * port**, that carries the session and its **live stream**.
 *
 * The streaming claim is judged **here as well as in its own part**, and it is the same event
 * that both views read: the check opens the UI's stream endpoint, starts a turn whose double
 * holds its terminator open, and requires the main-content and reasoning deltas to arrive on
 * the stream **before** the run finishes. A UI that only showed a finished answer would pass a
 * page check and fail this one.
 *
 * The server is started on an **ephemeral** port (`--port 0`) so the check never collides with
 * a real instance; the documented default is asserted separately, from the help text and from
 * the constant the server exports, because that is where a person reads it.
 */

/**
 * Every local listener this file opens — a model double, or a server a check stands up — so a harness that fails to
 * start cannot leave one listening. A failed start rejects before the check reaches its own `finally`, the leaked
 * listener keeps this file's process alive, and the runner, which sets no test timeout, then waits forever instead of
 * reporting the failure: measured on 2026-10-22, four checks of `80-web-ui` never exited against a binary that does
 * not serve. `after` closes whatever is still open; a listener a check already closed is closed again harmlessly.
 */
const listeners = new Set()
function held(listener) {
  listeners.add(listener)
  return listener
}
after(() =>
  Promise.all(
    [...listeners].map((listener) =>
      typeof listener.close === 'function'
        ? listener.close()
        : new Promise((resolve) => listener.server.close(() => resolve())),
    ),
  ),
)

const CAPABILITY = 'a Web UI on localhost with a live stream'

/**
 * Start the server for one check and wait until its URL line appears.
 *
 * The working directory is the **repository root**, not a fixture, because that is where the
 * default profile lives: measured, running the server from a scratch directory booted an empty
 * tree, and the first request then failed with "Cannot read properties of undefined (reading
 * 'list')" — a message about nothing that named nothing, from a harness with no plugins.
 * Sessions are redirected to the fixture with `--session-root` instead, which is the supported
 * way to keep them out of the owner's store.
 */
async function startServer(label, options = {}) {
  const home = isolatedHome(`web-${label}`)
  const work = fixtureDir(`web-${label}`)
  const double = held(await chatDouble({
    content: 'live content',
    reasoning: 'live reasoning',
    holdOpenMs: options.holdOpenMs ?? 1200,
  }))
  const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'double', '--session-root', join(home, 'sessions')],
    { env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config, HEDDLE_WEB_BROWSER: options.browserFlag ?? '' } },
  )
  return { home, work, double, config, ...child, close: async () => {
    child.kill()
    await double.close()
    removeDir(home)
    removeDir(work)
  } }
}

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { join } = await import('node:path')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const child = spawn(...heddleCommand(args), {
        cwd: options.cwd ?? repoRoot,
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
      }, 15_000).unref()
    })()
  })
}

/**
 * Read an SSE body, recording **when each line arrived**.
 *
 * The arrival times are the whole point of this helper: "the UI streamed live" is a claim about
 * the order two things happened in, and a single timestamp taken when the reader finally
 * stopped cannot express it. Measured: comparing the moment the reader finished against the
 * moment the turn finished produced a four-millisecond race that failed one run in two, while
 * the deltas had plainly arrived first.
 */
async function readStream(url, predicate, cookie, timeoutMs = 12_000) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const response = await fetch(url, { signal: controller.signal, ...(cookie ? { headers: { cookie } } : {}) })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  /** The offset from the read's start to the first line matching each pattern. */
  const at = new Map()
  const mark = (chunk) => {
    for (const pattern of ['live reasoning', 'live content', 'event: done']) {
      if (!at.has(pattern) && chunk.includes(pattern)) at.set(pattern, Date.now() - startedAt)
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      text += chunk
      mark(chunk)
      if (predicate(text)) break
    }
  } catch {
    // an abort is a timeout, and the caller decides what the partial text means
  }
  clearTimeout(timer)
  controller.abort()
  return { text, at }
}

/**
 * Turn the printed URL into a cookie the way a browser does.
 *
 * The token is presented once, at the root, and everything after that is the cookie. The
 * redirect is followed manually because the cookie is on the 303 itself, and there is nothing
 * at the destination this check needs.
 */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('the server takes the documented default port when none is named', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  /**
   * The default is a promise to a person, and this part judges **the server's side of it**: the number it
   * chooses when no `--port` is given, and the number the documentation names. It does not bind it.
   *
   * That split is deliberate and was forced by a daemon: once `95-web-daemon` keeps a real agent on 3082,
   * a check here that tried to bind the same port failed with `EADDRINUSE` — and the failure was correct
   * behaviour, a server refusing to pretend it owns a port someone else has. Two checks cannot both own
   * the port; ownership is judged there, and the choice is judged here.
   */
  /**
   * The constant the documentation names, read from the source rather than `dist/`: a check that runs a binary
   * through `HEDDLE_BIN` has no TypeScript build to import, and `src/` is what `dist/` is compiled from.
   */
  const { DEFAULT_PORT } = await import('../../src/server/web.ts')
  assert.equal(DEFAULT_PORT, 3082, 'the server exports the documented default')
  const readme = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8'))
  const goal = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../ULTIMATE_GOAL.md', import.meta.url), 'utf8'))
  assert.ok(readme.includes('3082') || goal.includes('3082'), 'the default port is written down where a person would look for it')

  /**
   * And the choice, read from the server's own startup line with no port named. `--json` prints the same
   * URL the human-readable line carries, so the check reads a machine-readable field rather than parsing
   * prose. The port is asked for but not taken: `--dry-run` stops before binding.
   */
  const home = isolatedHome('default-port')
  const work = fixtureDir('default-port')
  const double = held(await chatDouble({ content: 'x' }))
  const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
  try {
    const run = await runCliSource(['web', '--host', '127.0.0.1', '--endpoint', 'double', '--dry-run', '--json'], {
      env: { HEDDLE_HOME: home, HOME: home, HEDDLE_CONFIG: config },
      timeoutMs: 30_000,
    })
    assert.equal(run.code, 0, `the server reported its plan without binding\n${run.stdout}${run.stderr}`)
    const plan = parseJson(run.stdout)
    assert.equal(plan?.port, 3082, `with no --port it chooses the documented default\n${run.stdout}`)
    assert.match(String(plan?.url ?? ''), /:3082\//, 'and the URL it would print names that port')
  } finally {
    await double.close()
    removeDir(home)
    removeDir(work)
  }
})

test('the server serves a page on loopback and refuses a non-loopback bind', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const server = await startServer('page')
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/, `the URL names loopback and carries a token\n${server.url}`)
    /**
     * The page is a **session**, so the first request is refused and the session is what serves it.
     *
     * This check used to fetch the bare URL and expect the page. That was the behaviour, and it was wrong:
     * the bare URL answered `200` with a whole app and an empty log, which reads as a page that lost its
     * data rather than one that was never opened with a token. Measured, and corrected — a browser that has
     * been through the printed URL keeps working because the cookie is the same credential.
     */
    const refused = await fetch(server.url)
    assert.equal(refused.status, 401, 'the bare page is refused without a session')

    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const page = await fetch(server.url, { headers: { cookie } })
    assert.equal(page.status, 200, 'the page answers with a session')
    const html = await page.text()
    /**
     * Asserted **case-insensitively**, because the title is `Heddle` and the check pinned the lowercase spelling.
     *
     * Measured: the assertion was written when the page said `heddle`; the owner then asked for the repository name in
     * lower case with the description allowed to keep its capital, and the page's own title became the capitalised
     * brand while the check still required the old spelling — so a correct page read as a failure. What this check is
     * about is that the answer is the harness page and not a stray document, which the name says either way.
     */
    /**
     * The tab's name, which is the project's **display** name: the owner renamed it to `Heddle` on GitHub on
     * 2026-10-11 and asked the UI to wear the same name, so this asserts the spelling rather than the old lowercase
     * one. What the claim is about — that these bytes are the harness page — is unchanged.
     */
    assert.match(html, /<title>Heddle<\/title>/, 'it is the harness page')
    assert.match(html, /EventSource|\/api\/events/, 'the page opens the event stream')
    assert.match(html, /id="log"|id="sessions"/, 'and it has somewhere to put what arrives')
  } finally {
    await server.close()
  }
})

test('the API answers with the token and refuses without it', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const server = await startServer('api')
  try {
    const denied = await fetch(`http://127.0.0.1:${new URL(server.url).port}/api/sessions`)
    assert.equal(denied.status, 401, 'a request without the token is refused')

    /**
     * The token in the URL is a **handshake at the root only**, and that is the design rather
     * than a limitation: a token repeated on every API call would sit in server logs and
     * browser history for no gain. So the check does what a browser does — presents the token
     * at the root, takes the cookie it sets, and uses the cookie from then on.
     *
     * Measured the wrong way first: fetching `/api/sessions?token=...` answers 401, which
     * looked like a broken token check until the handshake shape was read back.
     */
    const handshake = await fetch(server.url, { redirect: 'manual' })
    assert.equal(handshake.status, 303, `the root exchanges the token for a cookie
${handshake.status}`)
    const cookie = handshake.headers.get('set-cookie')
    assert.ok(cookie, 'the handshake set a cookie')
    assert.match(cookie, /HttpOnly/, 'the cookie is not readable by script')
    assert.match(cookie, /SameSite=Strict/, 'and it is not sent cross-site')

    const allowed = await fetch(new URL('/api/sessions', server.url), { headers: { cookie: cookie.split(';')[0] } })
    assert.equal(allowed.status, 200, 'the cookie is accepted')
    const sessions = await allowed.json()
    assert.ok(Array.isArray(sessions), 'and the answer is the session list')
  } finally {
    await server.close()
  }
})

test('main content and reasoning reach the stream while the model is still writing', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const server = await startServer('stream', { holdOpenMs: 1500 })
  try {
    const started = Date.now()
    // Open the stream, then start a turn, and require both deltas to arrive **before the
    // turn's own response closes**. That comparison is the claim: the turn writes everything
    // when it ends, so a client that saw the deltas first saw them live.
    //
    // Measured, and worth keeping in mind for anyone reading a timing number here: an absolute
    // deadline against the double's `holdOpenMs` is not the test, because a small event can sit
    // in a socket buffer for tens of milliseconds and reading it depends on scheduling. The
    // ordering against the turn's completion is a property of the code; the wall clock is a
    // property of the machine.
    let turnDoneAt = 0
    const cookie = await cookieFor(server.url)
    const streamPromise = readStream(new URL('/api/events', server.url).href, (text) => text.includes('live reasoning') && text.includes('live content'), cookie)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))

    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ prompt: 'say something' }),
    })
    // The turn finished when its body has been read, not when the headers arrived.
    assert.equal(turn.status, 200, 'the turn was accepted')
    // Read the turn's own body only if the stream disappoints, so a failure says whether the
    // turn errored rather than making the reader guess from an empty stream.
    const turnBody = await turn.text()
    turnDoneAt = Date.now() - started

    const { text: stream, at } = await streamPromise
    assert.match(stream, /event: session/, `the stream carried session events\n${stream.slice(0, 400)}`)
    assert.match(stream, /live reasoning/, `a reasoning delta reached the stream\nturn said: ${turnBody.split('\n').filter((line) => line.startsWith('event:') || line.includes('message')).join(' | ')}\nstream: ${stream.slice(0, 400)}`)
    assert.match(stream, /live content/, `a content delta reached the stream\n${stream.slice(0, 600)}`)
    assert.ok(turnDoneAt > 0, 'the turn finished')
    /**
     * The claim, stated as the two arrival times: each delta reached the client **before** the
     * turn's own response completed. The turn writes its whole body when it ends, so a client
     * that saw a delta first saw it live rather than at the end.
     */
    const reasoningAt = at.get('live reasoning')
    const contentAt = at.get('live content')
    assert.ok(
      reasoningAt !== undefined && reasoningAt < turnDoneAt,
      `the reasoning delta arrived at ${reasoningAt}ms and the turn finished at ${turnDoneAt}ms`,
    )
    assert.ok(
      contentAt !== undefined && contentAt < turnDoneAt,
      `the content delta arrived at ${contentAt}ms and the turn finished at ${turnDoneAt}ms`,
    )
  } finally {
    await server.close()
  }
})

test('the composer fills the panel and does not run off the screen', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  /**
   * The prompt box is the control a person uses most, and nothing judged its **width** — measured, after an
   * edit that inserted the ledger's styles used the composer's CSS block as its anchor and replaced it
   * without restoring it: the form fell back to `display: block`, the textarea became an inline-level box,
   * and the prompt occupied 181px of a 1046px panel with the run button beside it.
   *
   * A screenshot would not have caught it either, which is why the claim is arithmetic: the input is the
   * panel minus the button and the padding, and nothing overflows the viewport horizontally.
   */
  const server = await startServer('composer')
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) {
    await server.close()
    return
  }
  const browser = await openBrowser({ width: 1400, height: 800 })
  try {
      await browser.goto(server.url)
        assert.ok(await browser.waitFor('document.getElementById("prompt") !== null', 20_000), 'the composer is there')
        const box = JSON.parse(
          await browser.evaluate(`(() => {
            const form = document.getElementById('prompt')
            const field = document.querySelector('textarea')
            const panel = document.querySelector('main')
            const card = document.getElementById('composer-card')
            const column = Number.parseFloat(getComputedStyle(panel).getPropertyValue('--chat-column'))
            const cardBox = card.getBoundingClientRect()
            return JSON.stringify({
              formDisplay: getComputedStyle(form).display,
              formWidth: Math.round(form.getBoundingClientRect().width),
              cardWidth: Math.round(cardBox.width),
              cardLeft: Math.round(cardBox.left - panel.getBoundingClientRect().left),
              cardRight: Math.round(panel.getBoundingClientRect().right - cardBox.right),
              column: Math.round(column),
              fieldWidth: Math.round(field.getBoundingClientRect().width),
              panelWidth: Math.round(panel.getBoundingClientRect().width),
              fieldRight: Math.round(field.getBoundingClientRect().right),
              viewport: window.innerWidth
            })
          })()`),
        )
        assert.equal(box.formDisplay, 'flex', 'the composer is a flex row')
        /**
         * DSH's composer is the **reading column plus 32px** - 16px on each side - centred in the panel, and the
         * editor fills that card. Measured on DSH's session view: a 680px column with a 712px card. The claim is
         * still arithmetic, because the failure it guards against is a textarea that collapses to 181px; it just
         * measures against the card rather than the panel, since the panel is deliberately wider.
         */
        assert.ok(
          Math.abs(box.cardWidth - (box.column + 32)) <= 1,
          `the card is DSH column plus 32px (${box.cardWidth}px for a ${box.column}px column)`,
        )
        assert.ok(box.fieldWidth >= box.cardWidth - 160, `the input fills its card rather than a fraction (${box.fieldWidth}px of ${box.cardWidth}px)`)
        assert.ok(Math.abs(box.cardLeft - box.cardRight) <= 1, `and the card is centred in the panel (${box.cardLeft}px left, ${box.cardRight}px right)`)
        assert.ok(box.fieldRight <= box.viewport, `and nothing runs off the screen (right edge ${box.fieldRight} of ${box.viewport})`)
  } finally {
    browser.close()
    await server.close()
  }
})

test('the page is served under a strict script policy that allows its own inline scripts and nothing injected', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The page-level Content-Security-Policy (defence in depth behind the sanitizer, live issues developer-two-6 and -7),
   * approved by the coordinator as option (1). Both builds compute it from the page as served: 'self' and the sha256
   * of each inline script for scripts; https: for images, styles, fonts and media only because the HTML preview's
   * srcdoc frame inherits the policy (issue #50).
   */
  const server = await startServer('csp')
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const cookie = await cookieFor(server.url)
    const page = await fetch(server.url, { headers: { cookie } })
    assert.equal(page.status, 200)
    const html = await page.text()
    const policy = page.headers.get('content-security-policy')
    assert.notEqual(policy, null, 'the page carries a Content-Security-Policy')
    const { createHash } = await import('node:crypto')
    const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => match[1] ?? '')
    const expected = [
      "default-src 'self'",
      ["script-src 'self'", ...scripts.map((code) => `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`)].join(' '),
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https:",
      "media-src 'self' https:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; ')
    assert.equal(policy, expected, 'the approved policy, with the hash of each inline script the served page carries')

    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "window.__csp = []; document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(event.violatedDirective + ' ' + (event.blockedURI || 'inline')))",
    })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("model-trigger") !== null', 20_000), 'the page runs under the policy')
    assert.deepEqual(JSON.parse(await browser.evaluate('JSON.stringify(window.__csp ?? null)')), [], 'and loading it breaks no directive')

    /**
     * developer-eleven's request: the policy must hold while the page is used, not only while it loads, so a later page
     * change that adds an inline script, a handler or an eval fails here instead of being blocked silently. A turn
     * streams, then a markdown file and an HTML preview open from the tree.
     */
    mkdirSync(server.work, { recursive: true })
    writeFileSync(join(server.work, 'notes.md'), '# Notes\n\nSome *text*, a list:\n\n- one\n- two\n\n```js\nconst a = 1\n```\n')
    writeFileSync(join(server.work, 'page.html'), '<!doctype html><html><head><style>h1 { color: teal }</style></head><body><h1>Preview</h1><p>static</p></body></html>')
    await fetch(new URL('/api/workspaces', server.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ path: server.work }) })
    await browser.evaluate(`(() => { const field = document.querySelector('textarea'); field.value = 'say something'; field.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('send').click() })()`)
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("live content")', 20_000), 'a turn streams under the policy')
    /** Read before the reload: the listener installed on every new document starts its list again. */
    assert.deepEqual(JSON.parse(await browser.evaluate('JSON.stringify(window.__csp ?? null)')), [], 'and the turn breaks no directive')
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.querySelector("#tree .row") !== null', 15_000), 'the workspace row is drawn')
    await browser.evaluate(`(() => { const row = document.querySelector('#tree .row'); if (row.closest('li').dataset.open === 'false') row.click(); return true })()`)
    const fileRow = (name) => `Array.from(document.querySelectorAll('#tree .row')).find((row) => (row.dataset.path ?? '').endsWith(${JSON.stringify(name)}))`
    assert.ok(await browser.waitFor(`${fileRow('notes.md')} !== undefined && ${fileRow('page.html')} !== undefined`, 15_000), "the workspace's files are drawn")
    await browser.evaluate(`${fileRow('notes.md')}.click()`)
    /** textContent, not innerText: the document's heading is drawn in capitals, and innerText reads what is drawn. */
    assert.ok(await browser.waitFor('document.getElementById("file-body")?.textContent.includes("Notes")', 15_000), 'a markdown file opens')
    await browser.evaluate(`${fileRow('page.html')}.click()`)
    assert.ok(await browser.waitFor('document.getElementById("html-view") !== null && !document.getElementById("html-view").hidden && (document.getElementById("html-view").srcdoc ?? "").includes("Preview")', 15_000), 'and an HTML preview')
    assert.deepEqual(JSON.parse(await browser.evaluate('JSON.stringify(window.__csp ?? null)')), [], 'a turn, a file and a preview break no directive')
    await browser.evaluate(`(() => { const element = document.createElement('script'); element.textContent = 'window.__injected = true'; document.body.append(element) })()`)
    await browser.waitFor('Array.isArray(window.__csp) && window.__csp.length > 0', 5_000)
    assert.equal(await browser.evaluate('window.__injected === true'), false, 'a script injected into the page does not run')
    assert.match(JSON.parse(await browser.evaluate('JSON.stringify(window.__csp)')).join('\n'), /script-src/, 'script-src refuses it')
  } finally {
    browser.close()
    await server.close()
  }
})


test('D-068 page framing allowance is opt-in and changes no script directive', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  let strict = null
  for (const flag of ['', 'true', '1']) {
    const server = await startServer('csp-frame-' + (flag || 'default'), { browserFlag: flag })
    try {
      const cookie = await cookieFor(server.url)
      const response = await fetch(server.url, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
      assert.equal(response.status, 200)
      const policy = response.headers.get('content-security-policy')
      assert.ok(policy !== null)
      if (flag === '') strict = policy
      if (flag === '1') assert.equal(policy, strict.replace("frame-src 'self'", 'frame-src http: https:'))
      else assert.equal(policy, strict)
      assert.ok(policy.includes("object-src 'none'") && policy.includes("frame-ancestors 'none'"))
    } finally { await server.close() }
  }
})
