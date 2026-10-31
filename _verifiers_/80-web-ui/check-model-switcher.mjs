import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, isolatedHome, removeDir, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The model selector, judged in a browser against DSH's measured control.
 *
 * The owner's claim (2026-10-17) has three parts, and each is judged here where a screenshot cannot:
 *
 * - **two tiers, configured by the user in `~/.heddle/`**: an endpoint, and the model types it offers. The page
 *   only draws what `/api/endpoints` describes, so the menu's groups are endpoints and its options are models;
 * - **the reference is DSH's `conversation.input.model`**, measured on 2026-10-17: a 28px two-span trigger
 *   (model + effort caption), a two-level menu (root `Model`/`Effort` rows; model list grouped with sticky
 *   headings and search above four entries), fixed placement above and right-aligned with a 12px clamp, keyboard
 *   roving and Escape/back, focus restored without a ring after a selection;
 * - **a reasoning level is shown only when it is enforced**: the level exists only where the endpoint's model
 *   declares it, its wire value is what the adapter sends, and the turn's request body is where that is measured.
 *
 * The two endpoints are local doubles so "which backend answered" and "what effort was sent" are countable facts.
 * Every number in an assertion below is a `getBoundingClientRect`/`getComputedStyle` reading of the served page;
 * the reference numbers and the fields this check deliberately does not judge are in
 * `_context_/dsh-mechanisms/dsh-model-selector.md`.
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

const CAPABILITY = 'the model selector in the Web UI'

/** Two endpoints whose answers are distinguishable, and which record what they were asked. */
async function startServer(label, options = {}) {
  const home = isolatedHome(`model-switcher-${label}`)
  const work = fixtureDir(`model-switcher-${label}-work`)
  const one = options.toolFirst === true
    ? held(await toolThenPlainDouble('answer from one'))
    : held(await plainDouble('answer from one'))
  const two = held(await plainDouble('answer from two'))
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'double-one',
    endpoints: [
      {
        name: 'double-one',
        kind: 'openai-chat',
        baseUrl: one.baseUrl,
        model: 'model-one',
        capabilities: ['chat', 'stream'],
        models: [
          { id: 'model-one', name: 'Model One' },
          { id: 'model-one-pro', name: 'Model One Pro' },
        ],
      },
      {
        name: 'double-two',
        kind: 'openai-chat',
        baseUrl: two.baseUrl,
        model: 'model-two',
        capabilities: ['chat', 'stream'],
        models: [
          {
            id: 'model-two',
            name: 'Model Two',
            reasoning: {
              default: 'high',
              levels: [
                { id: 'low', name: 'Low', value: 'low' },
                { id: 'high', name: 'High', value: 'high' },
                { id: 'max', name: 'Max', value: 'max' },
              ],
            },
          },
          { id: 'model-two-lite', name: 'Model Two Lite' },
          ...(options.extraModels ?? []),
        ],
      },
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
    work,
    close: async () => {
      child.kill()
      await one.close()
      await two.close()
      removeDir(home)
      removeDir(work)
    },
  }
}

/**
 * An SSE chat double that records each completion request and answers with one text delta.
 *
 * `GET /models` is answered separately: the merged main discovers a model's context window from the provider's
 * own model list (`src/llm/model-info.ts`), so a double that answered the discovery with an event stream would be
 * judged as a broken endpoint. The `requests` array stays every call; `turns` is the completion calls only, which
 * is what "how many turns did this endpoint answer" means.
 */
async function plainDouble(content) {
  const { createServer } = await import('node:http')
  const requests = []
  const turns = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push({ url: request.url ?? '', body })
      if ((request.url ?? '').endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'model-one', object: 'model', context_window: 128000 }] }))
        return
      }
      turns.push({ url: request.url ?? '', body })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/d`,
    requests,
    turns,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  }
}

/**
 * A double whose **first** answer is a tool call, held until `releaseFirst()`, and whose later answers are text.
 *
 * The hold is what makes a turn observably running while a person switches the model: a tool round gives the
 * loop a second model call, and that second call is where "the switch landed on the turn's next step" is measured
 * rather than assumed.
 */
async function toolThenPlainDouble(content) {
  const { createServer } = await import('node:http')
  const requests = []
  const turns = []
  let count = 0
  let finishFirst
  let firstReleased = false
  const releaseFirst = () => {
    firstReleased = true
    finishFirst?.()
    finishFirst = undefined
  }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push({ url: request.url ?? '', body, at: Date.now() })
      if ((request.url ?? '').endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'model-one', object: 'model', context_window: 128000 }] }))
        return
      }
      count += 1
      turns.push({ url: request.url ?? '', body, at: Date.now() })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const first = count === 1
      const finish = () => {
        if (first) {
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call-1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            })}\n\n`,
          )
        } else {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`)
        }
        response.write('data: [DONE]\n\n')
        response.end()
      }
      if (first && !firstReleased) {
        // Keep this step pending until the browser has recorded its model switch. No timing race.
        response.flushHeaders()
        finishFirst = finish
      } else finish()
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/d`,
    requests,
    turns,
    releaseFirst,
    close: () => {
      releaseFirst()
      return new Promise((resolvePromise) => server.close(() => resolvePromise()))
    },
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
          reject(new Error(`the server printed no URL within 20s\n${output}`))
        }
      }, 20_000).unref()
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

/**
 * One trusted key event the page can act on, through the protocol the browser wrapper exposes.
 *
 * `Enter` carries its carriage-return text, because a `rawKeyDown` with no text does not run a focused button's
 * default activation — measured while writing this check: the drill never happened and focus stayed on the row.
 */
async function press(browser, key) {
  const descriptions = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  }
  const description = descriptions[key]
  if (description === undefined) throw new Error(`no key description for ${key}`)
  const common = {
    key: description.key,
    code: description.code,
    windowsVirtualKeyCode: description.keyCode,
    nativeVirtualKeyCode: description.keyCode,
  }
  await browser.send('Input.dispatchKeyEvent', {
    type: description.text === undefined ? 'rawKeyDown' : 'keyDown',
    ...common,
    ...(description.text === undefined ? {} : { text: description.text, unmodifiedText: description.text }),
  })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

/** Type text into whatever holds page focus, the way a keyboard would. */
async function typeText(browser, text) {
  await browser.send('Input.insertText', { text })
}

/**
 * Collect the page's own errors from the moment the document is created.
 *
 * Installed before `goto` because a module that throws on load leaves a page that still renders markup — measured
 * on 2026-10-17, when a concurrent edit left every behaviour missing while the screen looked like a page.
 */
async function watchErrors(browser) {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__pageErrors = []
      addEventListener('error', (event) => window.__pageErrors.push(String(event.message)))
      addEventListener('unhandledrejection', (event) => window.__pageErrors.push(String(event.reason)))`,
  })
}

/** The page's own errors, as the injected watcher recorded them. */
async function pageErrors(browser) {
  const collected = await browser.evaluate(`JSON.stringify(window.__pageErrors ?? [])`)
  return JSON.parse(collected)
}

/** Wait for a node-side fact (a double's request, usually) to become true. */
async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  return predicate()
}

/** The page-side readings this check asserts on, named once so every test reads the same surface. */
const SEAT = `document.getElementById('model-trigger')`
const SEAT_READ = `(() => {
  const trigger = ${SEAT}
  const style = getComputedStyle(trigger)
  const rect = trigger.getBoundingClientRect()
  return {
    aria: trigger.getAttribute('aria-label'),
    title: trigger.getAttribute('title'),
    text: trigger.innerText.replace(/\\n/g, '|'),
    spans: [...trigger.querySelectorAll('span')].map((node) => ({
      id: node.id,
      text: node.innerText,
      hidden: node.hidden === true,
      color: getComputedStyle(node).color,
    })),
    box: [Math.round(rect.width), Math.round(rect.height)],
    font: style.fontSize + '/' + style.lineHeight,
    padding: style.padding,
    gap: style.gap,
    radius: style.borderRadius,
    color: style.color,
    cursor: style.cursor,
    background: style.backgroundColor,
    boxShadow: style.boxShadow,
    disabled: trigger.disabled,
    expanded: trigger.getAttribute('aria-expanded'),
    busy: trigger.getAttribute('aria-busy'),
    selectionFocus: trigger.hasAttribute('data-selection-focus'),
  }
})()`
const MENU_READ = `(() => {
  const menu = document.getElementById('model-menu')
  const rect = menu.getBoundingClientRect()
  const trigger = ${SEAT}.getBoundingClientRect()
  const style = getComputedStyle(menu)
  return {
    hidden: menu.hidden,
    role: menu.getAttribute('role'),
    aria: menu.getAttribute('aria-label'),
    box: [Math.round(rect.width), Math.round(rect.height)],
    at: [Math.round(rect.left), Math.round(rect.top)],
    rightAligned: Math.abs(rect.right - trigger.right) <= 1,
    above: Math.round(trigger.top - rect.bottom),
    position: style.position,
    radius: style.borderRadius,
    padding: style.padding,
    maxHeight: style.maxHeight,
    zIndex: style.zIndex,
    shadow: style.boxShadow,
    cells: [...menu.querySelectorAll('[role="menuitem"]')].map((cell) => {
      const cellRect = cell.getBoundingClientRect()
      return {
        text: cell.innerText.replace(/\\n/g, '|'),
        box: [Math.round(cellRect.width), Math.round(cellRect.height)],
        font: getComputedStyle(cell).fontSize + '/' + getComputedStyle(cell).lineHeight,
        radius: getComputedStyle(cell).borderRadius,
        valueColor: getComputedStyle(cell.querySelector('.cell-value')).color,
      }
    }),
    headings: [...menu.querySelectorAll('.model-group-heading')].map((heading) => ({
      text: heading.innerText,
      font: getComputedStyle(heading).fontSize + '/' + getComputedStyle(heading).lineHeight,
      weight: getComputedStyle(heading).fontWeight,
      color: getComputedStyle(heading).color,
      box: [Math.round(heading.getBoundingClientRect().width), Math.round(heading.getBoundingClientRect().height)],
    })),
    options: [...menu.querySelectorAll('[role="menuitemradio"]')].map((option) => ({
      text: option.innerText,
      checked: option.getAttribute('aria-checked'),
      disabled: option.disabled,
      box: [Math.round(option.getBoundingClientRect().width), Math.round(option.getBoundingClientRect().height)],
      font: getComputedStyle(option).fontSize + '/' + getComputedStyle(option).lineHeight,
      radius: getComputedStyle(option).borderRadius,
      padding: getComputedStyle(option).padding,
      check: option.querySelector('.option-check svg') === null
        ? null
        : (() => {
            const box = option.querySelector('.option-check svg').getBoundingClientRect()
            return [Math.round(box.width), Math.round(box.height)]
          })(),
    })),
    search: menu.querySelector('input[role="searchbox"]') === null
      ? null
      : (() => {
          const input = menu.querySelector('input[role="searchbox"]')
          return { placeholder: input.placeholder, font: getComputedStyle(input).fontSize }
        })(),
    active: document.activeElement === null ? null : document.activeElement.getAttribute('role') ?? document.activeElement.id,
  }
})()`

/**
 * A **trusted** pointer click on the element an expression names.
 *
 * The check's first version opened, drilled and chose with `element.click()`, and it was green while the deployed
 * selector closed itself on every real click: a synthetic click does not run the focus default action, so the
 * focus-loss path a mouse exercises never ran. The deployed page was measured with `Input.dispatchMouseEvent` on
 * 2026-10-17 and the bug (`focusout` decided on a microtask, before the focus default action had handed focus to
 * the clicked row) was fixed — but only because a person clicked it. Every interaction in this file is a
 * protocol-level press/release now, and an option is scrolled into view first, because a person cannot click a row
 * outside the menu's clipped area either.
 */
async function trustedClick(browser, expression, label) {
  const raw = await browser.evaluate(`(() => {
    const node = ${expression}
    if (node === null || node === undefined) return null
    node.scrollIntoView({ block: 'nearest' })
    const rect = node.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    return JSON.stringify({ x, y, reaches: hit !== null && node.contains(hit) })
  })()`)
  assert.ok(raw !== null, `the element to click exists (${label})`)
  const target = JSON.parse(raw)
  assert.ok(target.reaches, `the element is hit-testable at its centre (${label})`)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, label.startsWith('option') || label.startsWith('cell') ? 500 : 300))
}

/**
 * Open the menu from the seat with a real click on the trigger; the open seat owns focus, as DSH's does.
 *
 * The click is retried **once** at a freshly measured position when the first one does not open the menu. That is
 * not a leniency for a broken control: the merged main paints its statistics dock when the first turn's figures
 * arrive, so during a running turn the composer — and the seat with it — shifts a few pixels while the pointer is
 * down. A person clicks again at where the seat now is; the instrument does the same instead of demanding that a
 * moving target stay still.
 */
async function openMenu(browser) {
  await trustedClick(browser, SEAT, 'seat')
  try {
    await browser.waitFor(`document.getElementById('model-menu').hidden === false`, 1200)
  } catch (error) {
    // waitFor throws on timeout; the historical false-return branch was unreachable.
    if (!(error instanceof Error) || !error.message.startsWith('timed out after 1200ms waiting for:')) throw error
    await trustedClick(browser, SEAT, 'seat (retry after layout shift)')
  }
  await browser.waitFor(`document.getElementById('model-menu').hidden === false`, 5000)
  assert.ok(await browser.waitFor(`document.activeElement === ${SEAT}`, 3000), 'the opened menu leaves focus on the seat')
}

/** Click one of the menu's root cells (`Model` or `Effort`) with a real click. */
async function drill(browser, label) {
  await trustedClick(
    browser,
    `[...document.querySelectorAll('#model-menu [role="menuitem"]')].find((cell) => cell.innerText.startsWith(${JSON.stringify(label)}))`,
    `cell ${label}`,
  )
}

/** Click one of the open pane's options by its visible name with a real click. */
async function choose(browser, text) {
  await trustedClick(
    browser,
    `[...document.querySelectorAll('#model-menu [role="menuitemradio"]')].find((option) => option.innerText === ${JSON.stringify(text)})`,
    `option ${text}`,
  )
}

/** The session records the server would hand a reload. */
async function sessionsOf(server) {
  const cookie = await cookieFor(server.url)
  return (await (await fetch(new URL('/api/sessions', server.url), { headers: { cookie } })).json())
}

test('the seat and its two-level menu are DSH’s measured control', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const server = await startServer('anatomy')
  const browser = await openBrowser({ width: 1280, height: 1000 })
  try {
    await watchErrors(browser)
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.getElementById('model-trigger') !== null`, 20_000), 'the composer is up')
    assert.ok(
      await browser.waitFor(`document.getElementById('model-trigger').getAttribute('aria-label').includes('Model One')`, 10_000),
      'the endpoint catalogue reached the seat',
    )

    /**
     * The trigger: DSH measured 189x28 at 13px/20px, padding 0 4px 0 8px, gap 4, radius 8, `#cfd3d6` text, and a
     * second span for the effort in `rgb(129,133,140)`. The width follows the label; the rest is the control.
     */
    const seat = await browser.evaluate(SEAT_READ)
    assert.equal(seat.aria, 'Select model, current Model One', 'the accessible name carries the control and its value')
    assert.equal(seat.title, 'Model One', 'and the title is the visible label')
    assert.equal(seat.text, 'Model One', 'no effort span for a model that declares no levels')
    assert.deepEqual(seat.box, [94, 28], 'DSH’s 28px-tall trigger')
    assert.equal(seat.font, '13px/20px', 'DSH’s trigger type')
    assert.equal(seat.padding, '0px 4px 0px 8px', 'DSH’s trigger inset')
    assert.equal(seat.gap, '4px', 'and its span gap')
    assert.equal(seat.radius, '8px', 'and its radius')
    assert.equal(seat.color, 'rgb(207, 211, 214)', 'the model span is the secondary text colour')
    assert.equal(seat.cursor, 'pointer', 'the trigger is a control, so its cursor is a hand')
    assert.equal(seat.spans.find((span) => span.id === 'model-effort').hidden, true, 'the effort span exists but is hidden')

    /**
     * Hover paints DSH's 8% surface and clearing the pointer removes it.
     *
     * The pointer is parked away first and the state is **waited for** rather than read after a fixed delay: one
     * run of this check read the background before the hover had been applied and called the surface missing — a
     * flake in the instrument, measured while re-running it, not a UI defect. A hover is a state to wait for, not
     * a race to sample.
     */
    const at = await browser.evaluate(
      `(() => { const r = ${SEAT}.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`,
    )
    const point = JSON.parse(at)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none' })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
    assert.ok(
      await browser.waitFor(`getComputedStyle(${SEAT}).backgroundColor !== 'rgba(0, 0, 0, 0)'`, 5000),
      'moving onto the seat reaches the hover state',
    )
    const hover = await browser.evaluate(`getComputedStyle(${SEAT}).backgroundColor`)
    assert.match(hover, /0\.08/, 'hover shows the reference’s 8% surface')
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none' })
    assert.ok(
      await browser.waitFor(`getComputedStyle(${SEAT}).backgroundColor === 'rgba(0, 0, 0, 0)'`, 5000),
      'and leaving the seat clears it',
    )

    /** Focus draws DSH's 2px ring in this theme's accent, as a box-shadow and not an outline. */
    await browser.evaluate(`${SEAT}.focus()`)
    const ring = await browser.evaluate(`getComputedStyle(${SEAT}).boxShadow`)
    assert.match(ring, /0px 0px 0px 2px/, 'focus-visible is a 2px box-shadow ring')
    assert.match(ring, /rgb\(38, 148, 254\)/, 'in the page’s accent colour (this theme’s blue, not DSH’s)')

    await openMenu(browser)
    const menu = await browser.evaluate(MENU_READ)
    assert.equal(menu.role, 'menu', 'the root pane is a menu')
    assert.equal(menu.aria, 'Model and reasoning effort', 'and says what the two rows are for')
    assert.equal(menu.position, 'fixed', 'the menu is in viewport coordinates, so no scrolling ancestor can clip it')
    assert.equal(menu.radius, '16px', 'DSH’s menu radius')
    assert.equal(menu.padding, '4px', 'and its 4px inset')
    assert.notEqual(menu.shadow, 'none', 'and its elevation')
    assert.ok(menu.rightAligned, 'the menu is right-aligned to the trigger')
    assert.equal(menu.above, 8, 'and opens 8px above it, as DSH places it')
    assert.equal(menu.cells.length, 1, 'a model without levels has no Effort row')
    assert.equal(menu.cells[0].text, 'Model|Model One', 'the Model row shows the current model')
    assert.deepEqual(menu.cells[0].box, [232, 34], 'a root row is 34px tall')
    assert.equal(menu.cells[0].font, '13px/20px', 'and DSH’s row type')
    assert.equal(menu.cells[0].radius, '12px', 'and its 12px radius')
    assert.equal(menu.cells[0].valueColor, 'rgb(173, 178, 184)', 'the value is the muted colour DSH uses')

    await drill(browser, 'Model')
    const modelPane = await browser.evaluate(MENU_READ)
    assert.equal(modelPane.role, 'group', 'the model pane is a group of grouped lists, as DSH’s is')
    assert.equal(modelPane.search.placeholder, 'Search models…', 'more than four models shows search')
    assert.equal(modelPane.search.font, '12px', 'the search field is DSH’s 12px')
    const headingTexts = modelPane.headings.map((heading) => heading.text)
    assert.ok(headingTexts.includes('double-one'), `the first endpoint heads its group (${headingTexts.join(', ')})`)
    assert.ok(headingTexts.includes('double-two'), 'and so does the second — that is the second tier')
    assert.equal(modelPane.headings[0].font, '11px/16px', 'a group heading is DSH’s 11/16')
    assert.equal(modelPane.headings[0].weight, '500', 'at weight 500')
    assert.equal(modelPane.headings[0].color, 'rgb(173, 178, 184)', 'in the muted colour')
    assert.deepEqual(modelPane.headings[0].box, [232, 22], 'and 22px tall')
    const names = modelPane.options.map((option) => option.text)
    for (const name of ['Model One', 'Model One Pro', 'Model Two', 'Model Two Lite']) {
      assert.ok(names.includes(name), `the pane offers ${name} (${names.join(', ')})`)
    }
    const checked = modelPane.options.filter((option) => option.checked === 'true')
    assert.deepEqual(checked.map((option) => option.text), ['Model One'], 'exactly the current model is marked')
    assert.ok(checked[0].check !== null, 'and it carries a check')
    assert.deepEqual(checked[0].check, [14, 14], 'DSH’s 14px check')
    const option = modelPane.options.find((entry) => entry.text === 'Model One Pro')
    assert.deepEqual(option.box, [232, 34], 'an option is 34px tall')
    assert.equal(option.font, '13px/18px', 'and DSH’s 13/18 type')
    assert.equal(option.radius, '12px', 'with a 12px radius')
    assert.equal(option.padding, '5px 7px', 'and DSH’s 5/7 inset')
    await browser.screenshot(join(server.work, 'model-switcher-model-pane.png'))

    /** Escape leaves the drilled pane first, then closes; focus returns to the trigger. */
    await press(browser, 'Escape')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    assert.equal(await browser.evaluate(`${SEAT}.getAttribute('aria-expanded')`), 'true', 'the first Escape goes back to the root pane')
    await press(browser, 'Escape')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    assert.equal(await browser.evaluate(`document.getElementById('model-menu').hidden`), true, 'the second closes')
    assert.equal(await browser.evaluate(`document.activeElement === ${SEAT}`), true, 'and focus returns to the seat')

    assert.deepEqual(await pageErrors(browser), [], 'the page raised no errors')
  } finally {
    browser.close()
    await server.close()
  }
})

test('choosing a model type and an effort is recorded, sent, and survives a reload', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const server = await startServer('record')
  const browser = await openBrowser({ width: 1280, height: 1000 })
  try {
    await watchErrors(browser)
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.getElementById('model-trigger') !== null`, 20_000), 'the composer is up')
    assert.ok(await browser.waitFor(`${SEAT}.getAttribute('aria-label').includes('Model One')`, 10_000), 'the catalogue arrived')

    /**
     * A first turn creates the session, because a choice made before one exists travels with the turn that creates
     * it rather than being posted — the model seat is a per-session record, and there is no session to record on
     * yet. Everything after this is a switch on a session that exists.
     */
    await browser.evaluate(`(() => { const field = document.querySelector('#prompt textarea'); field.value = 'first'; field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('log').innerText.includes('answer from one')`, 20_000), 'the first endpoint answered')
    assert.ok(await until(() => server.one.turns.length === 1), 'the session exists and has a record')

    /**
     * Select the second endpoint's reasoning-capable model. DSH records the model's **default effort** with the
     * model, so the seat immediately reads model + effort and the record names both.
     */
    await openMenu(browser)
    await drill(browser, 'Model')
    await choose(browser, 'Model Two')
    const afterModel = await browser.evaluate(SEAT_READ)
    assert.equal(afterModel.aria, 'Select model, current Model Two, reasoning effort High', 'the seat shows the new model and its default effort')
    assert.equal(afterModel.title, 'Model Two · High', 'the title joins the two with DSH’s separator')
    assert.equal(afterModel.text, 'Model Two|High', 'the label is two spans, not one joined string')
    assert.equal(afterModel.expanded, 'false', 'the menu closed on the selection')
    assert.equal(await browser.evaluate(`document.activeElement === ${SEAT}`), true, 'and focus came back to the seat')
    assert.equal(await browser.evaluate(`getComputedStyle(${SEAT}).boxShadow`), 'none', 'without a focus ring')
    const effortSpan = afterModel.spans.find((span) => span.id === 'model-effort')
    assert.equal(effortSpan.hidden, false, 'the effort span is visible')
    assert.equal(effortSpan.color, 'rgb(129, 133, 140)', 'and painted in DSH’s caption tone')
    const record = (await sessionsOf(server))[0]
    assert.equal(record?.endpoint, 'double-two', 'the session records the endpoint')
    assert.equal(record?.model, 'model-two', 'and the model type')
    assert.equal(record?.reasoningEffort, 'high', 'and the level it shows, so a reload re-derives the same seat')

    /** The Effort row appears for a model that declares levels, and its pane is the declared ladder. */
    await openMenu(browser)
    const root = await browser.evaluate(MENU_READ)
    assert.deepEqual(root.cells.map((cell) => cell.text), ['Model|Model Two', 'Effort|High'], 'the root pane now has both rows')
    await drill(browser, 'Effort')
    const effortPane = await browser.evaluate(MENU_READ)
    assert.deepEqual(effortPane.options.map((option) => option.text), ['Low', 'High', 'Max'], 'the pane offers exactly the declared levels')
    assert.deepEqual(effortPane.options.filter((option) => option.checked === 'true').map((option) => option.text), ['High'], 'with the current one marked')
    await browser.screenshot(join(server.work, 'model-switcher-effort-pane.png'))
    await choose(browser, 'Low')
    const afterEffort = await browser.evaluate(SEAT_READ)
    assert.equal(afterEffort.aria, 'Select model, current Model Two, reasoning effort Low', 'the seat follows the level at once')
    assert.equal((await sessionsOf(server))[0]?.reasoningEffort, 'low', 'and the session records it')

    /** A turn is answered by the chosen endpoint with the chosen model and the declared wire value. */
    await browser.evaluate(`(() => { const field = document.querySelector('#prompt textarea'); field.value = 'who answers?'; field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('log').innerText.includes('answer from two')`, 20_000), 'the chosen endpoint answered')
    assert.ok(await until(() => server.two.turns.length === 1), 'the chosen double was asked once')
    assert.equal(server.one.turns.length, 1, 'and the previous endpoint was asked only for the creating turn')
    const asked = JSON.parse(server.two.turns[0].body)
    assert.equal(asked.model, 'model-two', 'the request names the chosen model')
    assert.equal(asked.reasoning_effort, 'low', 'and sends the level’s wire value, which is what “shown” has to mean')

    /**
     * Reload, which throws every variable on the page away: the seat has to come back from the server's record
     * alone. This is the same claim the API-level assertion makes, read through the control this time.
     */
    await watchErrors(browser)
    await browser.goto(server.url)
    assert.ok(
      await browser.waitFor(`document.getElementById('model-trigger').getAttribute('aria-label').includes('Model Two, reasoning effort Low')`, 10_000),
      'the seat came back to the recorded model and level',
    )
    assert.deepEqual(await pageErrors(browser), [], 'the page raised no errors')
  } finally {
    browser.close()
    await server.close()
  }
})

test('the menu is keyboard-operable and a selection restores focus without a ring', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const server = await startServer('keyboard')
  const browser = await openBrowser({ width: 1280, height: 1000 })
  try {
    await watchErrors(browser)
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`${SEAT} !== null`, 20_000), 'the composer is up')
    assert.ok(await browser.waitFor(`${SEAT}.getAttribute('aria-label').includes('Model One')`, 10_000), 'the catalogue arrived')
    await browser.evaluate(`${SEAT}.focus()`)
    await openMenu(browser)

    /** Tab from the trigger enters the root pane; Enter drills; the model pane focuses its search field. */
    await press(browser, 'Tab')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    assert.equal(await browser.evaluate(`document.activeElement.getAttribute('role')`), 'menuitem', 'Tab enters the root rows')
    await press(browser, 'Enter')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    assert.equal(await browser.evaluate(`document.activeElement.getAttribute('role')`), 'searchbox', 'Enter drills into the model list and focuses search')
    await typeText(browser, 'pro')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    assert.deepEqual(
      await browser.evaluate(`JSON.parse(JSON.stringify([...document.querySelectorAll('#model-menu [role="menuitemradio"]')].map((option) => option.innerText)))`),
      ['Model One Pro'],
      'typing filters the list',
    )
    assert.equal(
      await browser.evaluate(`document.querySelectorAll('#model-menu [role="menuitemradio"][data-highlighted]').length`),
      1,
      'with the first result highlighted',
    )
    await press(browser, 'ArrowDown')
    await press(browser, 'Enter')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
    const picked = await browser.evaluate(SEAT_READ)
    assert.equal(picked.aria, 'Select model, current Model One Pro', 'the highlighted result is selected by Enter')
    assert.equal(picked.selectionFocus, true, 'selection focus is marked, so the ring stays off until blur')
    assert.equal(picked.boxShadow, 'none', 'and no ring is painted')

    /** Escape in a drilled pane goes back; Escape on the root closes; focus stays on the seat. */
    await openMenu(browser)
    await press(browser, 'Tab')
    await press(browser, 'Enter')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    await press(browser, 'Escape')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    assert.equal(await browser.evaluate(`${SEAT}.getAttribute('aria-expanded')`), 'true', 'Escape leaves the drilled pane')
    assert.equal(await browser.evaluate(`document.activeElement.getAttribute('role')`), 'menuitem', 'handing focus back to the root row')
    await press(browser, 'Escape')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    assert.equal(await browser.evaluate(`document.getElementById('model-menu').hidden`), true, 'Escape on the root closes')
    assert.equal(await browser.evaluate(`document.activeElement === ${SEAT}`), true, 'and focus lands on the seat')

    /** Choosing an effort from the keyboard: Tab to the Effort row, Enter, arrow, Enter. */
    await openMenu(browser)
    await drill(browser, 'Model')
    await choose(browser, 'Model Two')
    await openMenu(browser)
    await press(browser, 'Tab')
    await press(browser, 'ArrowDown')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    assert.equal(await browser.evaluate(`document.activeElement.innerText.startsWith('Effort')`), true, 'arrows reach the Effort row')
    await press(browser, 'Enter')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    assert.equal(await browser.evaluate(`document.activeElement.getAttribute('role')`), 'menuitemradio', 'Enter drills into the levels')
    assert.equal(await browser.evaluate(`document.activeElement.getAttribute('aria-checked')`), 'true', 'with the current level focused')
    await press(browser, 'ArrowDown')
    await press(browser, 'Enter')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
    assert.equal(
      await browser.evaluate(`${SEAT}.getAttribute('aria-label')`),
      'Select model, current Model Two, reasoning effort Max',
      'arrows move the level and Enter selects it',
    )

    /** A mousedown outside closes the menu, which is DSH's dismissal rule. */
    await openMenu(browser)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 40, y: 40, button: 'none' })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 40, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 40, button: 'left', clickCount: 1 })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    assert.equal(await browser.evaluate(`document.getElementById('model-menu').hidden`), true, 'a click outside dismisses the menu')
    assert.deepEqual(await pageErrors(browser), [], 'the page raised no errors')
  } finally {
    browser.close()
    await server.close()
  }
})

test('the model search matches characters in order, prefix first, and opening highlights the current model', async (context) => {
  /**
   * DSH's search (issue #51), dsh-client-ui-model-selection: names match case-insensitively "including nonconsecutive
   * characters in order"; "within each provider, prefix matches come first, followed by alignment score and then
   * catalog order"; and "opening highlights the current model or the first available row". The page matched only
   * contiguous text over the name, id and endpoint, in catalogue order, and opened with nothing highlighted.
   * `Lite Two` is listed **after** `Model Two Lite`, so a prefix-first order is told apart from catalogue order.
   */
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const server = await startServer('search', { extraModels: [{ id: 'lite-two', name: 'Lite Two' }] })
  const browser = await openBrowser({ width: 1280, height: 1000 })
  const shown = `JSON.parse(JSON.stringify([...document.querySelectorAll('#model-menu [role="menuitemradio"]')].map((option) => option.innerText)))`
  const highlighted = `(() => { const row = document.querySelector('#model-menu [role="menuitemradio"][data-highlighted]'); return row === null ? null : row.innerText })()`
  try {
    await watchErrors(browser)
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`${SEAT} !== null`, 20_000), 'the composer is up')
    assert.ok(await browser.waitFor(`${SEAT}.getAttribute('aria-label').includes('Model One')`, 10_000), 'the catalogue arrived')
    await openMenu(browser)
    await drill(browser, 'Model')
    assert.equal(await browser.evaluate(`document.activeElement.getAttribute('role')`), 'searchbox', 'the model pane focuses its search')
    assert.equal(await browser.evaluate(highlighted), 'Model One', 'opening highlights the current model')

    await typeText(browser, 'mtl')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    const ordered = await browser.evaluate(shown)
    assert.ok(ordered.includes('Model Two Lite'), `characters in order match across words (mtl: ${ordered.join(', ')})`)
    assert.ok(!ordered.includes('Model One'), 'and a name without them in order does not')

    await browser.evaluate(`(() => { const field = document.querySelector('#model-menu input[role="searchbox"]'); field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await typeText(browser, 'lite')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    assert.deepEqual(await browser.evaluate(shown), ['Lite Two', 'Model Two Lite'], 'a prefix match comes before an earlier catalogue entry')
    assert.equal(await browser.evaluate(highlighted), 'Lite Two', 'editing the query highlights the first result')
    await press(browser, 'Enter')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
    assert.equal(await browser.evaluate(`${SEAT}.getAttribute('aria-label')`), 'Select model, current Lite Two', 'Enter selects it')

    await openMenu(browser)
    await drill(browser, 'Model')
    assert.equal(await browser.evaluate(highlighted), 'Lite Two', 'reopening highlights the model just chosen')
    assert.deepEqual(await pageErrors(browser), [], 'the page raised no errors')
  } finally {
    browser.close()
    await server.close()
  }
})

test('a switch made while a turn runs lands on that turn’s next step', async (context) => {
  /**
   * DSH's running-turn rule, measured on 2026-10-17: the seat stays enabled while a turn streams, and the switch
   * takes effect on a later step of the same turn (not merely on the next turn). The first double holds its
   * tool call until the browser confirms the switch; releasing it must route the next call to the second
   * endpoint. A fixed 3.2-second delay raced against layout changes and browser instrumentation.
   */
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const server = await startServer('running', { toolFirst: true })
  const browser = await openBrowser({ width: 1280, height: 1000 })
  try {
    await watchErrors(browser)
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`${SEAT} !== null`, 20_000), 'the composer is up')
    await browser.evaluate(`(() => { const field = document.querySelector('#prompt textarea'); field.value = 'do it'; field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('stop').hidden === false`, 10_000), 'the turn is running')
    const running = await browser.evaluate(SEAT_READ)
    assert.equal(running.disabled, false, 'the seat stays enabled during a running turn, as DSH’s does')
    assert.equal(running.busy, null, 'and is not marked busy: only a pending selection is')

    await openMenu(browser)
    const menu = await browser.evaluate(MENU_READ)
    assert.equal(menu.hidden, false, 'the menu opens while the turn runs')
    assert.equal(menu.cells.every((cell) => cell.text.length > 0), true, 'with its rows drawn')
    await browser.screenshot(join(server.work, 'model-switcher-running-menu.png'))
    await drill(browser, 'Model')
    await choose(browser, 'Model Two')
    assert.equal(
      await browser.evaluate(`${SEAT}.getAttribute('aria-label')`),
      'Select model, current Model Two, reasoning effort High',
      'the seat answers the switch at once',
    )
    assert.equal(server.one.turns.length, 1, 'the first request stays pending until the switch is made')
    assert.equal(server.two.turns.length, 0, 'no next-step request has escaped before release')
    server.one.releaseFirst()
    assert.ok(await browser.waitFor(`document.getElementById('log').innerText.includes('answer from two')`, 20_000), 'the same turn ends with the new endpoint’s answer')
    assert.ok(await until(() => server.one.turns.length === 1), 'the first step asked the first endpoint')
    assert.ok(await until(() => server.two.turns.length === 1), 'the next step asked the second')
    assert.equal(JSON.parse(server.two.turns[0].body).model, 'model-two', 'with the newly chosen model')
    assert.equal((await sessionsOf(server))[0]?.endpoint, 'double-two', 'and the session records the switch')
    assert.deepEqual(await pageErrors(browser), [], 'the page raised no errors')
  } finally {
    browser.close()
    await server.close()
  }
})

test('a model or a level the endpoint does not declare is refused, and nothing is recorded', async (context) => {
  /**
   * The route is the only place a name from a browser reaches the store, so it is validated there rather than
   * trusted. The refusals are distinct: an unconfigured endpoint, a model the endpoint does not offer, a level the
   * model does not declare, and a level on a model that offers none. Recorded instead, each would fail every
   * following turn of the session with a name nobody chose — and the seat would have shown a control for a value
   * the provider never receives.
   */
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const server = await startServer('refuse')
  try {
    const cookie = await cookieFor(server.url)
    /**
     * A scratch home has no registered workspace root, so the folder route cannot mint a session here — a turn
     * does, and it is the same session the panel would show afterwards.
     */
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ prompt: 'a session to switch' }),
    })
    assert.equal(turn.status, 200, 'a turn starts a session')
    await turn.text()
    const sessions = await sessionsOf(server)
    const id = sessions[0]?.id
    assert.ok(typeof id === 'string' && id.length > 0, `a session exists to switch (${JSON.stringify(sessions[0] ?? null)})`)
    const switchTo = (body) =>
      fetch(new URL(`/api/sessions/${encodeURIComponent(id)}/model`, server.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      })

    const unknownEndpoint = await switchTo({ endpoint: 'no-such-endpoint' })
    assert.equal(unknownEndpoint.status, 400, 'an endpoint the run does not have is refused')
    const unknownModel = await switchTo({ endpoint: 'double-two', model: 'model-z' })
    assert.equal(unknownModel.status, 400, 'a model the endpoint does not offer is refused')
    assert.match((await unknownModel.json()).error, /model-z/, 'naming the model that was asked for')
    const unknownEffort = await switchTo({ endpoint: 'double-two', model: 'model-two', reasoningEffort: 'ghost' })
    assert.equal(unknownEffort.status, 400, 'a level the model does not declare is refused')
    assert.match((await unknownEffort.json()).error, /ghost/, 'naming the level that was asked for')
    const noLevels = await switchTo({ endpoint: 'double-one', model: 'model-one-pro', reasoningEffort: 'low' })
    assert.equal(noLevels.status, 400, 'a model that declares no levels cannot be given one')
    assert.match((await noLevels.json()).error, /no reasoning/i, 'in a sentence that says why')
    const after = await sessionsOf(server)
    const session = after.find((entry) => entry.id === id)
    assert.notEqual(session?.endpoint, 'no-such-endpoint', 'and nothing invalid was recorded')
    assert.equal(session?.reasoningEffort, undefined, 'including the refused level')

    const accepted = await switchTo({ endpoint: 'double-two', model: 'model-two', reasoningEffort: 'max' })
    assert.equal(accepted.status, 200, 'a declared selection is accepted')
    const record = await accepted.json()
    assert.equal(record.endpoint, 'double-two', 'and the answer is the session record')
    assert.equal(record.model, 'model-two', 'with the model')
    assert.equal(record.reasoningEffort, 'max', 'and the level')
  } finally {
    await server.close()
  }
})
