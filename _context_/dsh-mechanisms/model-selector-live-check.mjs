import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openPage } from '../../_tools_/browser-use/lib.mjs'

/**
 * The deployed-surface probe for the model selector: it drives the **owner's URL** (8082 by default), not a
 * server it starts itself. Every assertion below is a reading of the page that address serves, after the launchd
 * agent behind it was restarted on the branch build.
 *
 * Usage: node model-selector-live-check.mjs [url]
 * Exit 0 = every measured claim held; 1 = at least one did not (the failing sentence is printed).
 *
 * Screenshots of the states are written beside this file as `heddle-live-*.png`.
 */

const url = process.argv[2] ?? 'http://127.0.0.1:8082/'
const out = new URL('.', import.meta.url).pathname
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SEAT = `document.getElementById('model-trigger')`
const read = (browser, expression) => browser.evaluate(expression)
let checks = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
  console.log(`PASS ${message}`)
}

/**
 * A **trusted** pointer click at an element's centre, the way a person clicks.
 *
 * The first version of this probe used `element.click()` and passed 51 checks while the deployed selector closed
 * itself on every real click: a synthetic click does not run the focus default action, so the focus-loss path a
 * mouse exercises never executed. Every interaction below is a protocol-level mouse press/release now, and the
 * options are scrolled into view first because a real person cannot click a row that is outside the menu's
 * clipped scroll area either.
 */
async function trustedClick(browser, expression, label) {
  const raw = await browser.evaluate(`(() => {
    const node = ${expression}
    if (node === null || node === undefined) return null
    node.scrollIntoView({ block: 'nearest' })
    const r = node.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return JSON.stringify({ x, y, reaches: hit !== null && node.contains(hit) })
  })()`)
  assert.ok(raw !== null, `the element to click exists (${label})`)
  const point = JSON.parse(raw)
  assert.ok(point.reaches, `the element is hit-testable at its centre (${label})`)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await sleep(50)
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(40)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(label.startsWith('option') || label.startsWith('cell') ? 500 : 300)
}

async function openMenu(browser) {
  await trustedClick(browser, `${SEAT}`, 'seat')
  /**
   * One retry at a freshly measured position: the merged main paints its statistics dock as the first turn reports
   * figures, so during a running turn the composer — and the seat — shifts a few pixels under the pointer. A person
   * clicks again where the seat now is; the probe does the same.
   */
  if (!(await browser.waitFor(`document.getElementById('model-menu').hidden === false`, 1200))) {
    await trustedClick(browser, `${SEAT}`, 'seat (retry after layout shift)')
  }
  await browser.waitFor(`document.getElementById('model-menu').hidden === false`, 5000)
}
async function drill(browser, label) {
  await trustedClick(
    browser,
    `[...document.querySelectorAll('#model-menu [role="menuitem"]')].find((cell) => cell.innerText.startsWith(${JSON.stringify(label)}))`,
    `cell ${label}`,
  )
}
async function choose(browser, text) {
  await trustedClick(
    browser,
    `[...document.querySelectorAll('#model-menu [role="menuitemradio"]')].find((option) => option.innerText === ${JSON.stringify(text)})`,
    `option ${text}`,
  )
}
async function press(browser, key) {
  const known = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  }
  const d = known[key]
  const common = { key: d.code, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode }
  await browser.send('Input.dispatchKeyEvent', { type: d.text === undefined ? 'rawKeyDown' : 'keyDown', ...common, ...(d.text === undefined ? {} : { text: d.text, unmodifiedText: d.text }) })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(150)
}
const seat = (browser) => read(browser, `JSON.stringify((() => {
  const t = ${SEAT}
  const s = getComputedStyle(t)
  const r = t.getBoundingClientRect()
  return {
    aria: t.getAttribute('aria-label'), title: t.getAttribute('title'), text: t.innerText.replace(/\\n/g, '|'),
    box: [Math.round(r.width), Math.round(r.height)], font: s.fontSize + '/' + s.lineHeight,
    padding: s.padding, gap: s.gap, radius: s.borderRadius, background: s.backgroundColor, boxShadow: s.boxShadow,
    effortHidden: document.getElementById('model-effort').hidden,
    effortText: document.getElementById('model-effort').innerText,
    expanded: t.getAttribute('aria-expanded'), busy: t.getAttribute('aria-busy'), disabled: t.disabled,
  }
})())`).then(JSON.parse)
const menu = (browser) => read(browser, `JSON.stringify((() => {
  const m = document.getElementById('model-menu')
  const r = m.getBoundingClientRect()
  const t = ${SEAT}.getBoundingClientRect()
  const s = getComputedStyle(m)
  return {
    hidden: m.hidden, role: m.getAttribute('role'), aria: m.getAttribute('aria-label'),
    box: [Math.round(r.width), Math.round(r.height)], at: [Math.round(r.left), Math.round(r.top)],
    rightAligned: Math.abs(r.right - t.right) <= 1, aboveGap: Math.round(t.top - r.bottom),
    position: s.position, radius: s.borderRadius, padding: s.padding,
    cells: [...m.querySelectorAll('[role="menuitem"]')].map((c) => c.innerText.replace(/\\n/g, '|')),
    headings: [...m.querySelectorAll('.model-group-heading')].map((h) => h.innerText),
    options: [...m.querySelectorAll('[role="menuitemradio"]')].map((o) => ({ text: o.innerText, checked: o.getAttribute('aria-checked'), disabled: o.disabled })),
    search: m.querySelector('input[role="searchbox"]')?.placeholder ?? null,
    active: document.activeElement === null ? null : (document.activeElement.getAttribute('role') ?? document.activeElement.id),
    withinViewport: r.left >= 11 && r.top >= 11 && r.right <= innerWidth - 11 && r.bottom <= innerHeight - 11,
  }
})())`).then(JSON.parse)
const options = (browser) => read(browser, `JSON.stringify([...document.querySelectorAll('#model-menu [role="menuitemradio"]')].map((o) => o.innerText))`).then(JSON.parse)
const pageErrors = (browser) => read(browser, `JSON.stringify(window.__pageErrors ?? [])`).then(JSON.parse)

const browser = await openPage({ width: 1280, height: 950 })
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__pageErrors = []; addEventListener('error', (e) => window.__pageErrors.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__pageErrors.push(String(e.reason)))`,
  })
  await browser.goto(url)
  await browser.waitFor(`${SEAT} !== null`, 20_000)
  await browser.waitFor(`${SEAT}.getAttribute('aria-label') !== null`, 10_000)
  await sleep(800)

  /** 1. The delivered build is the branch build, pinned by markers in the served page. */
  const markers = JSON.parse(await read(browser, `JSON.stringify({ modelEffort: document.getElementById('model-effort') !== null, twoLevel: document.getElementById('model-menu').getAttribute('aria-label') === 'Model and reasoning effort', groupHeadingRule: [...document.styleSheets].some((sheet) => { try { return [...sheet.cssRules].some((rule) => String(rule.cssText).includes('.model-group-heading')) } catch { return false } }) })`))
  ok(markers.modelEffort, 'the served page carries the effort span (branch build marker)')
  ok(markers.twoLevel, 'the served menu is named "Model and reasoning effort"')
  ok(markers.groupHeadingRule, 'the served stylesheet carries the endpoint-group heading rule')

  /** 2. The seat, as DSH measures it: two spans, 28px, 13/20, 0 4 0 8, gap 4, radius 8. */
  const idle = await seat(browser)
  ok(/^Select model, current .+, reasoning effort .+$/.test(idle.aria), `seat aria carries model and effort (${idle.aria})`)
  ok(/ · /.test(idle.title), `seat title joins the two with DSH's separator (${idle.title})`)
  ok(idle.box[1] === 28, `seat is 28px tall (${idle.box.join('x')})`)
  ok(idle.font === '13px/20px', `seat type is DSH's (${idle.font})`)
  ok(idle.padding === '0px 4px 0px 8px', `seat inset is DSH's (${idle.padding})`)
  ok(idle.gap === '4px' && idle.radius === '8px', 'seat gap/radius are DSH\'s')
  ok(idle.effortHidden === false && idle.effortText.length > 0, `effort span is visible (${idle.effortText})`)
  console.log('INFO seat', JSON.stringify(idle))

  /** 3. Hover and focus, with a trusted pointer. */
  const point = JSON.parse(await read(browser, `(() => { const r = ${SEAT}.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`))
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await sleep(250)
  const hover = await read(browser, `getComputedStyle(${SEAT}).backgroundColor`)
  ok(/0\.08/.test(hover), `hover paints the 8% surface (${hover})`)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await sleep(250)
  ok((await read(browser, `getComputedStyle(${SEAT}).backgroundColor`)) === 'rgba(0, 0, 0, 0)', 'hover clears on leave')
  await browser.evaluate(`${SEAT}.focus()`)
  ok(/0px 0px 0px 2px/.test(await read(browser, `getComputedStyle(${SEAT}).boxShadow`)), 'focus draws the 2px ring')

  /**
   * The catalogue the server actually serves, read once: its order is what the model pane must show, its model
   * count is what the search row is about, and one of its models is allowed to declare no levels.
   */
  const catalogue = JSON.parse(await read(browser, `fetch('/api/endpoints').then((r) => r.json()).then((body) => JSON.stringify(body.endpoints.map((endpoint) => ({ name: endpoint.name, models: (endpoint.models ?? []).map((model) => ({ id: model.id, name: model.name ?? model.id, levels: (model.reasoning?.levels ?? []).length })) }))))`))
  const endpointNames = catalogue.map((endpoint) => endpoint.name)
  const allModels = catalogue.flatMap((endpoint) => endpoint.models)
  ok(endpointNames.length > 0 && allModels.length > 0, `the served catalogue is non-empty (${endpointNames.length} endpoints, ${allModels.length} models)`)
  /**
   * The endpoint order is **served**, not declared: `resolveEndpoints` sorts by name, so the pane's group order is
   * an end-to-end statement that the sorting reached the browser. A code-unit order is asserted rather than a
   * locale order for the same reason the implementation uses one.
   */
  ok(JSON.stringify([...endpointNames].sort()) === JSON.stringify(endpointNames), `the served endpoint order is by name (${endpointNames.join(', ')})`)

  /** 4. The root pane: two rows, fixed placement above and right-aligned. */
  await openMenu(browser)
  const root = await menu(browser)
  ok(root.position === 'fixed', 'the menu is fixed (viewport coordinates)')
  ok(root.rightAligned, 'the menu is right-aligned to the seat')
  ok(root.aboveGap === 8, `the menu opens 8px above the seat (${root.aboveGap})`)
  ok(root.radius === '16px' && root.padding === '4px', 'menu radius/inset are DSH\'s')
  ok(root.cells.length === 2 && root.cells[0].startsWith('Model') && root.cells[1].startsWith('Effort'), `root pane has the Model and Effort rows (${root.cells.join(' / ')})`)
  await browser.screenshot(join(out, 'heddle-live-root.png'))

  /** 5. The model tier: grouped by configured endpoint, search above four entries. */
  await drill(browser, 'Model')
  const pane = await menu(browser)
  ok(pane.role === 'group', 'the model pane is a group of grouped lists')
  ok(pane.search === 'Search models…', `search appears for this catalogue (${allModels.length} models)`)
  ok(JSON.stringify(pane.headings) === JSON.stringify(endpointNames), `the pane groups are the served endpoints, in their served order (${pane.headings.join(', ')})`)
  ok(pane.options.some((option) => option.text === 'GPT-6.1-Sol'), 'the plugboard-x model types are offered')
  ok(pane.options.filter((option) => option.checked === 'true').length >= 1, 'exactly the current selection is marked')
  await browser.screenshot(join(out, 'heddle-live-models.png'))

  /** 6. Search filtering and its highlight. */
  await browser.send('Input.insertText', { text: 'gpt-6.1' })
  await sleep(300)
  const filtered = await options(browser)
  ok(filtered.length === 2 && filtered.every((text) => /gpt-6\.1/i.test(text)), `typing filters the catalogue to the two 6.1 families (${filtered.join(', ')})`)
  ok((await read(browser, `document.querySelectorAll('#model-menu [role="menuitemradio"][data-highlighted]').length`)) === 1, 'the first match is highlighted')
  await browser.screenshot(join(out, 'heddle-live-search.png'))
  await press(browser, 'Escape')
  await press(browser, 'Escape')

  /** 7. Choose a model type from the second endpoint, then its effort level. */
  await openMenu(browser)
  await drill(browser, 'Model')
  await choose(browser, 'GPT-6.1-Sol')
  const afterModel = await seat(browser)
  ok(afterModel.aria === 'Select model, current GPT-6.1-Sol, reasoning effort High', `selection updates the seat (${afterModel.aria})`)
  ok(afterModel.text === 'GPT-6.1-Sol|High', 'the label is two spans, model then effort')
  ok(afterModel.expanded === 'false', 'the menu closed on selection')
  ok((await read(browser, `document.activeElement === ${SEAT}`)) === true, 'focus returned to the seat')
  ok((await read(browser, `getComputedStyle(${SEAT}).boxShadow`)) === 'none', 'and no ring is painted')
  await openMenu(browser)
  await drill(browser, 'Effort')
  const levels = (await menu(browser)).options.map((option) => option.text)
  ok(JSON.stringify(levels) === JSON.stringify(['Low', 'Medium', 'High', 'Extra high', 'Max']), `the effort pane is the declared ladder (${levels.join(', ')})`)
  await browser.screenshot(join(out, 'heddle-live-effort.png'))
  await choose(browser, 'Low')
  ok((await seat(browser)).aria === 'Select model, current GPT-6.1-Sol, reasoning effort Low', 'choosing an effort updates the seat')

  /**
   * 8. A model that declares no levels has no effort: the span is hidden, and the root pane has no Effort row.
   *
   * The catalogue now carries such models (the Meta Codex endpoint's `gpt-5.5` and `gpt-5.6-sol-ptu` declare no
   * reasoning levels), so the state the isolated contract covers with doubles is exercised on the deployed build
   * too. The selection is then restored to a model with levels, so the rest of the probe still has an effort.
   */
  const noLevels = allModels.find((model) => model.levels === 0)
  ok(noLevels !== undefined, `the catalogue has a model without declared levels (${noLevels?.name ?? 'none'})`)
  if (noLevels !== undefined) {
    await openMenu(browser)
    await drill(browser, 'Model')
    await choose(browser, noLevels.name)
    const plain = await seat(browser)
    ok(plain.aria === `Select model, current ${noLevels.name}`, `a model without levels shows no effort in the name (${plain.aria})`)
    ok(plain.effortHidden === true, 'and the effort span is hidden')
    await openMenu(browser)
    ok((await menu(browser)).cells.length === 1, 'the root pane has no Effort row for it')
    await press(browser, 'Escape')
    await openMenu(browser)
    await drill(browser, 'Model')
    await choose(browser, 'GPT-6.1-Sol')
    ok((await seat(browser)).aria === 'Select model, current GPT-6.1-Sol, reasoning effort High', 'and a model with levels restores both spans')
  }

  /** 9. Keyboard: Tab enters the rows, Enter drills to search, Escape walks back out. */
  await openMenu(browser)
  await press(browser, 'Tab')
  ok((await read(browser, `document.activeElement.getAttribute('role')`)) === 'menuitem', 'Tab enters the root rows')
  await press(browser, 'Enter')
  ok((await read(browser, `document.activeElement.getAttribute('role')`)) === 'searchbox', 'Enter drills into the model list and focuses search')
  await press(browser, 'Escape')
  ok((await read(browser, `document.activeElement.getAttribute('role')`)) === 'menuitem', 'Escape hands focus back to the row')
  await press(browser, 'Escape')
  ok((await read(browser, `document.getElementById('model-menu').hidden`)) === true, 'the second Escape closes')
  ok((await read(browser, `document.activeElement === ${SEAT}`)) === true, 'and focus lands on the seat')

  /** 10. Choose a DeepSeek model and level, then send a turn — the selection creates the session and is recorded. */
  await openMenu(browser)
  await drill(browser, 'Model')
  await choose(browser, 'DeepSeek V4 Pro')
  await openMenu(browser)
  await drill(browser, 'Effort')
  await choose(browser, 'Low')
  const beforeTurn = await seat(browser)
  ok(beforeTurn.aria === 'Select model, current DeepSeek V4 Pro, reasoning effort Low', 'the pre-session choice is in the seat')
  await browser.evaluate(`(() => { const field = document.querySelector('#prompt textarea'); field.value = 'Count from 1 to 80 in words, one number per line, with no introduction.'; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  await browser.waitFor(`document.getElementById('stop').hidden === false`, 15_000)
  const running = await seat(browser)
  console.log('INFO running seat', JSON.stringify(running))
  /**
   * DSH sets `aria-busy="false"` on the seat when nothing is pending, so absence and the literal `false` both mean
   * "not busy". The first run of this probe required `null` and failed on the literal — an instrument bug, not a seat
   * bug, measured here rather than assumed.
   */
  ok(running.disabled === false && (running.busy === null || running.busy === 'false'), `the seat stays enabled during a running turn (disabled=${running.disabled}, aria-busy=${running.busy})`)
  await openMenu(browser)
  const runningMenu = await menu(browser)
  ok(runningMenu.hidden === false && runningMenu.cells.length >= 1, 'the menu opens while the turn runs')
  await browser.screenshot(join(out, 'heddle-live-running.png'))
  await drill(browser, 'Model')
  await choose(browser, 'Claude Sonnet 5.5')
  ok((await seat(browser)).aria === 'Select model, current Claude Sonnet 5.5, reasoning effort High', 'a switch during the running turn reaches the seat')
  await browser.evaluate(`document.getElementById('stop').click()`)
  await browser.waitFor(`document.getElementById('stop').hidden === true`, 20_000)

  /** 11. The record: the switch is on the session, and a reload comes back to it. */
  const record = JSON.parse(await read(browser, `fetch('/api/sessions').then((r) => r.json()).then((list) => JSON.stringify({ total: list.length, newest: list[0] ? { id: list[0].id, endpoint: list[0].endpoint, model: list[0].model, reasoningEffort: list[0].reasoningEffort } : null }))`))
  ok(record.newest !== null, `the session exists (${record.total} sessions)`)
  ok(record.newest.endpoint === 'meta-claude' && record.newest.model === 'claude-sonnet-5-5', `the running-turn switch is recorded (${record.newest.endpoint}/${record.newest.model})`)
  ok(record.newest.reasoningEffort === 'high', `with the model's declared default level (${record.newest.reasoningEffort})`)
  await browser.goto(url)
  await browser.waitFor(`${SEAT} !== null`, 20_000)
  await browser.waitFor(`${SEAT}.getAttribute('aria-label').includes('Claude Sonnet 5.5')`, 15_000)
  const reloaded = await seat(browser)
  ok(reloaded.aria === 'Select model, current Claude Sonnet 5.5, reasoning effort High', `a reload restores the recorded selection (${reloaded.aria})`)
  await browser.screenshot(join(out, 'heddle-live-reload.png'))

  /** 12. Small viewport: the fixed menu stays inside a 12px margin on both axes. */
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false })
  await sleep(300)
  await openMenu(browser)
  const clamped = await menu(browser)
  ok(clamped.withinViewport, `the menu is clamped inside the 900x620 viewport (${clamped.at.join(',')})`)
  await browser.screenshot(join(out, 'heddle-live-clamp.png'))
  await browser.send('Emulation.clearDeviceMetricsOverride')
  await press(browser, 'Escape')

  /** 13. Outside click dismisses, and the page raised no errors of its own. */
  await openMenu(browser)
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 40, button: 'left', clickCount: 1 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 40, button: 'left', clickCount: 1 })
  await sleep(300)
  ok((await read(browser, `document.getElementById('model-menu').hidden`)) === true, 'a mousedown outside closes the menu')
  const errors = await pageErrors(browser)
  ok(errors.length === 0, `the page raised no errors (${errors.join('; ') || 'none'})`)

  console.log(`\nLIVE CHECK PASSED ${checks} checks against ${url}`)
} catch (error) {
  console.error(`\nLIVE CHECK FAILED against ${url}\n  ${error.message}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
