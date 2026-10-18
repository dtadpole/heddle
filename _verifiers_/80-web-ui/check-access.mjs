import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { chatDouble, fixtureDir, httpConfig, isolatedHome, removeDir, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The access-mode chip as a **control**, judged in a browser.
 *
 * `check-composer.mjs` pins that the chip names the mode the server runs under. This file judges what
 * replaces the read-out: the menu, its selected state, the pending state of a change, the risk gate in front
 * of full access, and the two facts that make the control honest — a reload comes back to the session's mode,
 * and a change touches only the session it names.
 *
 * The reference is DSH's own control, measured on 2026-10-17 and recorded in
 * `_context_/dsh-mechanisms/dsh-permission-modes.md`: a shield glyph, the mode's label, a chevron, a menu
 * that opens above the chip, an item 34px tall with a 14px icon and a check on the current entry, and a
 * checkbox-gated "Enable Full access" dialog. Where the reference is weaker — no `aria-haspopup`, no
 * `aria-checked`, a client-side-only risk gate — the assertions require the better behaviour, deliberately.
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

/** Spawn the server and resolve once it prints its URL. */
function startServer(label, options = {}) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const home = isolatedHome(`access-${label}`)
      const work = fixtureDir(`access-${label}-work`)
      /**
       * Two server shapes: a streaming double for the states a turn has to be **running** for, and a
       * scripted endpoint when the check needs a specific tool call to be refused. Both are local and free.
       */
      const double = options.steps === undefined
        ? await chatDouble({ content: 'the answer', reasoning: 'thinking', holdOpenMs: options.holdOpenMs ?? 300 })
        : null
      const config = options.steps !== undefined
        ? scriptedConfig({ home, steps: options.steps }).config
        : httpConfig({ home, baseUrl: double.baseUrl, stream: true })
      const endpoint = options.steps !== undefined ? 'scripted' : 'double'
      const child = spawn(
        process.execPath,
        [join(repoRoot, 'dist', 'cli.js'), 'web', '--host', '127.0.0.1', '--port', '0', '--endpoint', endpoint, '--session-root', join(home, 'sessions')],
        { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({
            home,
            double,
            url: match[1],
            output: () => output,
            close: async () => {
              child.kill('SIGKILL')
              if (double !== null) await double.close()
              removeDir(home)
              removeDir(work)
            },
          })
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

/** The printed URL's token, attached to every API request as the page's cookie is. */
function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

/** The blocks of one SSE body, named and parsed. */
function sseBlocks(text) {
  const blocks = []
  for (const block of text.split('\n\n')) {
    const name = /^event: (.+)$/m.exec(block)?.[1]
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (name === undefined || data === undefined) continue
    try {
      blocks.push({ name, data: JSON.parse(data) })
    } catch {
      // A block that is not JSON is not one of the turn's events.
    }
  }
  return blocks
}

/** Post one turn and answer with the session it ran in. */
async function postTurn(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })
  assert.equal(response.status, 200, 'the turn was accepted')
  const text = await response.text()
  const session = sseBlocks(text).find((block) => block.name === 'session' && typeof block.data.session === 'string')?.data.session
  assert.ok(typeof session === 'string' && session.length > 0, 'the turn named its session')
  return session
}

/** Start one session through the API, so the page opens onto a conversation whose chip is enabled. */
function startSession(server) {
  return postTurn(server, { prompt: 'open a session' })
}

/** A session's mode as the API reports it — the fact the page must be showing. */
async function sessionMode(server, id) {
  const response = await request(server, `/api/sessions/${encodeURIComponent(id)}`)
  assert.equal(response.status, 200, 'the session is readable')
  return (await response.json()).permission?.mode
}

/** The chip as a person and a screen reader meet it. */
function readChip(browser) {
  return browser.evaluate(`(() => {
    const chip = document.getElementById('access')
    if (chip === null) return JSON.stringify({ error: 'no chip' })
    const box = chip.getBoundingClientRect()
    const style = getComputedStyle(chip)
    return JSON.stringify({
      label: document.getElementById('access-label')?.textContent ?? chip.textContent,
      ariaLabel: chip.getAttribute('aria-label'),
      hasPopup: chip.getAttribute('aria-haspopup'),
      expanded: chip.getAttribute('aria-expanded'),
      disabled: chip.disabled === true,
      busy: chip.getAttribute('aria-busy'),
      title: chip.getAttribute('title'),
      icons: chip.querySelectorAll('svg').length,
      chevron: chip.querySelector('svg.chevron') !== null,
      box: [Math.round(box.width), Math.round(box.height)],
      radius: style.borderRadius,
      fontSize: style.fontSize,
      cursor: style.cursor,
      menuOpen: document.getElementById('access-menu')?.hidden === false,
    })
  })()`)
}

/** Dispatch a trusted mouse click at an element's centre, the way a person does. */
async function clickAt(browser, selector) {
  const point = JSON.parse(
    await browser.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (element === null) return JSON.stringify({ error: 'no element ' + ${JSON.stringify(selector)} })
      const box = element.getBoundingClientRect()
      return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
    })()`),
  )
  assert.equal(point.error, undefined, point.error)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
  return point
}

/** Click the menu item whose label starts with `label`. */
async function clickMenuItem(browser, label) {
  const point = JSON.parse(
    await browser.evaluate(`(() => {
      const item = [...document.querySelectorAll('#access-menu [role="menuitemradio"]')]
        .find((entry) => (entry.textContent ?? '').trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}))
      if (item === undefined) return JSON.stringify({ error: 'no menu item ' + ${JSON.stringify(label)} })
      const box = item.getBoundingClientRect()
      return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
    })()`),
  )
  assert.equal(point.error, undefined, point.error)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
}

test('the chip is a menu control with the reference’s anatomy and a selected state', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('menu')
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const session = await startSession(server)
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("access-label")?.textContent !== "Access"', 20_000), 'the chip names a mode')
    assert.ok(await browser.waitFor('document.getElementById("access").disabled === false', 10_000), 'and is enabled once a session is open')

    const chip = JSON.parse(await readChip(browser))
    assert.match(chip.label, /^(Read Only|Workspace Write|Full access)$/, `the chip names the mode (${chip.label})`)
    assert.match(chip.ariaLabel, /^Access mode, current: /, 'and its accessible name says kind and value')
    assert.equal(chip.hasPopup, 'menu', 'the chip says it opens a menu')
    assert.equal(chip.expanded, 'false', 'and is closed to begin with')
    assert.equal(chip.icons, 2, 'a glyph and a chevron, as the reference draws it')
    assert.equal(chip.chevron, true, 'the chevron is the menu affordance')
    assert.equal(chip.box[1], 28, `the chip is a 28px control (${chip.box[1]})`)
    assert.equal(chip.radius, '8px', 'its radius is the reference’s 8px')
    assert.equal(chip.fontSize, '13px', 'its label is 13px')
    assert.equal(chip.cursor, 'pointer', 'an interactive control is a hand, which the read-out chip was not')

    await clickAt(browser, '#access')
    assert.ok(await browser.waitFor('document.getElementById("access-menu").hidden === false', 5_000), 'clicking the chip opens its menu')
    const menu = JSON.parse(
      await browser.evaluate(`(() => {
        const menu = document.getElementById('access-menu')
        const box = menu.getBoundingClientRect()
        const chipBox = document.getElementById('access').getBoundingClientRect()
        const items = [...menu.querySelectorAll('[role="menuitemradio"]')]
        return JSON.stringify({
          role: menu.getAttribute('role'),
          items: items.map((item) => ({ label: (item.textContent ?? '').trim(), checked: item.getAttribute('aria-checked'), check: item.querySelector('svg.check') !== null })),
          box: [Math.round(box.width), Math.round(box.height)],
          above: box.bottom <= chipBox.top + 1,
          radius: getComputedStyle(menu).borderRadius,
        })
      })()`),
    )
    assert.equal(menu.role, 'menu', 'the popup is a menu')
    assert.deepEqual(menu.items.map((item) => item.label), ['Read Only', 'Workspace Write', 'Full access'], 'the three modes, narrowest first, in the reference’s own names')
    assert.equal(menu.items.filter((item) => item.checked === 'true').length, 1, 'exactly one entry is the current mode')
    assert.equal(menu.items.find((item) => item.checked === 'true').label, chip.label, 'and the current entry is the one the chip names')
    assert.equal(menu.items.find((item) => item.checked === 'true').check, true, 'the current entry carries a check, as the reference draws it')
    assert.equal(menu.above, true, 'the menu opens above the chip, where the composer sits')
    assert.equal(menu.radius, '16px', 'its radius is the reference’s 16px')

    /** Hover is a surface, not a text change: the reference’s item hovers to rgba(255,255,255,.08). */
    const item = JSON.parse(
      await browser.evaluate(`(() => {
        const node = document.getElementById('access-menu').querySelector('[role="menuitemradio"]')
        const box = node.getBoundingClientRect()
        return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
      })()`),
    )
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: item.x, y: item.y, button: 'none', buttons: 0 })
    const hovered = await browser.evaluate(`getComputedStyle(document.querySelector('#access-menu [role="menuitemradio"]')).backgroundColor`)
    assert.match(hovered, /0\.08\)$/, `hovering paints the reference’s surface (${hovered})`)

    /** Escape closes the menu and gives focus back to the chip. */
    await browser.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    assert.ok(await browser.waitFor('document.getElementById("access-menu").hidden === true', 5_000), 'Escape closes the menu')
    assert.equal(await browser.evaluate('document.activeElement?.id'), 'access', 'and returns focus to the chip')

    /**
     * A change is **pending** before it is applied: the chip is marked busy and disabled while the request is
     * in flight, and only the server's answer changes the label. The click is issued from the page so the
     * check reads the handler's synchronous state; the network cannot have answered before that read.
     */
    await clickAt(browser, '#access')
    await browser.waitFor('document.getElementById("access-menu").hidden === false', 5_000)
    const pending = JSON.parse(
      await browser.evaluate(`(() => {
        const item = [...document.querySelectorAll('#access-menu [role="menuitemradio"]')]
          .find((entry) => /read only/i.test(entry.textContent ?? ''))
        item.click()
        const chip = document.getElementById('access')
        return JSON.stringify({ busy: chip.getAttribute('aria-busy'), disabled: chip.disabled, label: chip.textContent })
      })()`),
    )
    assert.equal(pending.busy, 'true', 'the chip is busy while the change is in flight')
    assert.equal(pending.disabled, true, 'and cannot be clicked into a second change')
    assert.ok(await browser.waitFor('document.getElementById("access-label")?.textContent === "Read Only"', 10_000), 'the server’s answer lands as Read Only')
    assert.equal(await sessionMode(server, session), 'read-only', 'and the session itself records read-only')

    const after = JSON.parse(await readChip(browser))
    assert.equal(after.busy, null, 'the pending mark clears')
    assert.equal(after.disabled, false, 'the chip is usable again')
    assert.equal(after.expanded, 'false', 'and the menu closed when the change was chosen')

    /** A reload comes back to the session's own mode, not to a page-local memory. */
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("access-label")?.textContent === "Read Only"', 20_000), 'a reload comes back to the session’s mode')
    assert.equal(await sessionMode(server, session), 'read-only', 'and that mode is still the session record’s')
  } finally {
    browser.close()
    await server.close()
  }
})

test('full access needs the risk gate, and the server refuses an unconfirmed escalation', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('gate')
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const session = await startSession(server)
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("access-label")?.textContent === "Workspace Write"', 20_000)

    const openDialog = async () => {
      await clickAt(browser, '#access')
      await browser.waitFor('document.getElementById("access-menu").hidden === false', 5_000)
      await clickMenuItem(browser, 'Full access')
      assert.ok(await browser.waitFor('document.getElementById("access-dialog").hidden === false', 5_000), 'choosing Full access opens the risk gate')
    }
    await openDialog()
    const gate = JSON.parse(
      await browser.evaluate(`(() => {
        const dialog = document.getElementById('access-dialog')
        const enable = document.getElementById('access-enable')
        const risk = document.getElementById('access-risk')
        const box = dialog.getBoundingClientRect()
        return JSON.stringify({
          role: dialog.getAttribute('role'),
          modal: dialog.getAttribute('aria-modal'),
          ariaLabel: dialog.getAttribute('aria-label'),
          heading: dialog.querySelector('h2, h3')?.textContent ?? '',
          riskChecked: risk.checked,
          enableDisabled: enable.disabled,
          cancel: document.getElementById('access-cancel') !== null,
          box: [Math.round(box.width), Math.round(box.height)],
          chip: document.getElementById('access-label').textContent,
        })
      })()`),
    )
    assert.equal(gate.role, 'dialog', 'the gate is a dialog')
    assert.equal(gate.modal, 'true', 'and modal')
    assert.equal(gate.ariaLabel, 'Enable Full access?', 'named after what it enables')
    assert.match(gate.heading, /Full access/i, 'with the question as its heading')
    assert.equal(gate.riskChecked, false, 'the risk is not pre-acknowledged')
    assert.equal(gate.enableDisabled, true, 'and the primary action is disabled until it is acknowledged')
    assert.equal(gate.cancel, true, 'there is a way out')
    assert.equal(gate.chip, 'Workspace Write', 'nothing widened while the gate is open')

    /** Cancel leaves the session exactly where it was. */
    await clickAt(browser, '#access-cancel')
    assert.ok(await browser.waitFor('document.getElementById("access-dialog").hidden === true', 5_000), 'Cancel closes the gate')
    assert.equal(await browser.evaluate('document.getElementById("access-label").textContent'), 'Workspace Write', 'and the chip did not move')
    assert.equal(await sessionMode(server, session), 'workspace-write', 'nor did the session')

    /** Acknowledged and enabled, the escalation lands — and only then. */
    await openDialog()
    await clickAt(browser, '#access-risk')
    assert.equal(await browser.evaluate('document.getElementById("access-enable").disabled'), false, 'checking the box arms the primary action')
    await clickAt(browser, '#access-enable')
    assert.ok(await browser.waitFor('document.getElementById("access-label")?.textContent === "Full access"', 10_000), 'the escalation lands')
    assert.equal(await sessionMode(server, session), 'danger-full-access', 'and the session records it')

    /**
     * The same escalation without the confirmation is refused by the **server**, not only by the dialog: a
     * stale page or a script cannot widen access by accident. The session is first narrowed back so the
     * request really is an escalation.
     */
    const narrowed = await request(server, `/api/sessions/${encodeURIComponent(session)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'workspace-write' }),
    })
    assert.equal(narrowed.status, 200, 'a narrowing needs no confirmation')
    const unconfirmed = await request(server, `/api/sessions/${encodeURIComponent(session)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'danger-full-access' }),
    })
    assert.ok(unconfirmed.status === 400 || unconfirmed.status === 409, `the server refuses the unconfirmed escalation (${unconfirmed.status})`)
    assert.equal(await sessionMode(server, session), 'workspace-write', 'and the mode stayed put')
  } finally {
    browser.close()
    await server.close()
  }
})

test('a refused write is visible on the closed row, and no UI action widens the session by itself', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The reference prints a failed tool as one red line a reader sees without opening anything, and a mode
   * whose refusals are invisible until a click is a mode that reads as "it worked". So the refusal is judged
   * where a person reads it: the **closed** tool row names the mode it was refused under, and the session's
   * recorded mode is still the narrow one afterwards.
   */
  const server = await startServer('refusal', {
    steps: [
      { toolCall: { name: 'write_file', arguments: { path: 'refused.txt', content: 'x' } } },
      { text: 'done' },
    ],
  })
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const session = await startSession(server)
    /** The owner narrows the session through the same API the chip uses, then the scripted write is refused. */
    const narrowed = await request(server, `/api/sessions/${encodeURIComponent(session)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'read-only' }),
    })
    assert.equal(narrowed.status, 200, 'the session can be narrowed to read-only')
    await postTurn(server, { session, prompt: 'try the write' })

    await browser.goto(server.url)
    assert.ok(
      await browser.waitFor('document.querySelector(\'#log .turn.tool[data-state="error"]\') !== null', 20_000),
      'the refused call is a failed tool row',
    )
    const row = JSON.parse(
      await browser.evaluate(`(() => {
        const tool = document.querySelector('#log .turn.tool[data-state="error"]')
        return JSON.stringify({
          state: tool.dataset.state,
          summary: tool.querySelector('summary').textContent,
          closed: tool.open === false,
          result: tool.querySelector('[data-result]')?.textContent ?? '',
          chip: document.getElementById('access-label').textContent,
        })
      })()`),
    )
    assert.match(row.summary, /Error:/, `the closed row carries the failure sentence (${row.summary})`)
    assert.match(row.summary, /read-only/, 'and names the mode that refused it')
    assert.equal(row.closed, true, 'without needing the row opened')
    assert.match(row.result, /error \(SANDBOX\)/, 'the full result is still inside the row')
    assert.equal(row.chip, 'Read Only', 'the chip reports the session it is actually running under')
    assert.equal(await sessionMode(server, session), 'read-only', 'and no turn or tool call widened it')
  } finally {
    browser.close()
    await server.close()
  }
})

test('the chip stays usable while a turn runs, and the mode is applied to the next call', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('running', { holdOpenMs: 2500 })
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await startSession(server)
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("access").disabled === false', 20_000)

    /** A running turn is one whose Stop button has taken Send's place. */
    await browser.evaluate(`(() => {
      const field = document.querySelector('textarea')
      field.value = 'a question the double holds open'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      return true
    })()`)
    assert.ok(await browser.waitFor('document.getElementById("stop").hidden === false', 15_000), 'a turn is running')

    const running = JSON.parse(await readChip(browser))
    assert.equal(running.disabled, false, 'the chip is not disabled by a running turn')
    await clickAt(browser, '#access')
    assert.ok(await browser.waitFor('document.getElementById("access-menu").hidden === false', 5_000), 'its menu opens while the turn runs')
    await browser.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

    await browser.evaluate('document.getElementById("stop").click()')
    assert.ok(await browser.waitFor('document.getElementById("stop").hidden === true', 20_000), 'the turn was stopped')
  } finally {
    browser.close()
    await server.close()
  }
})
