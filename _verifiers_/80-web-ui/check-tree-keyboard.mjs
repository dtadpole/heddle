import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The session tree from the keyboard, driven with the browser's own key events (#98, #92, #95).
 *
 * DSH's tree rows are `role="treeitem"` elements with an `onClick` and no key handler (dsh-client-ui-workspace
 * lib/client.js:1965-1970, :2273-2282), its row controls plain `<button>`s that stop their own click (:2015-2017,
 * :2033-2035, :2323-2327), its `Show {n} more sessions` a `<button aria-expanded>` (:3309-3326), and its row and View
 * options menus the shared `Menu` primitive, whose keyboard is arrows, Home and End, Tab and Escape with focus back on
 * the trigger (dsh-web-frontend dist/assets/index-CN7NIWNw.js:129, `Menu` exported as `k_` at :188). Heddle's rows are
 * focusable, which DSH's are not, so these checks judge that each key reaches what it is pressed on.
 *
 * One server and one browser serve every test here, on one workspace of eight titled sessions.
 */

const CAPABILITY = 'the Web UI'

/** Spawn `heddle web` on a free port and resolve with its URL once it prints one. */
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
        resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL') })
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

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

/** The shared fixture: a server, a browser, a registered workspace and its sessions `tk 1` to `tk 8`, made once. */
let shared = null
function fixture() {
  shared ??= (async () => {
    const home = isolatedHome('tree-keyboard')
    const root = fixtureDir('tree-keyboard-repo')
    const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
    const server = await startCli(
      ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
      { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    )
    let browser = null
    const close = async () => {
      if (browser !== null) await browser.close()
      server.kill()
      removeDir(home)
      removeDir(root)
    }
    try {
      browser = await openBrowser()
      const handshake = await fetch(server.url, { redirect: 'manual' })
      const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
      const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: root }) })
      assert.equal(added.status, 200, `the workspace is registered (${JSON.stringify(added.body)})`)
      const ids = {}
      for (let index = 1; index <= 8; index += 1) {
        const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: root, title: `tk ${index}` }) })
        assert.equal(made.status, 200, `session tk ${index} is made`)
        ids[`tk ${index}`] = made.body.session
        /** Apart in time, so newest-first is tk 8 down to tk 1 whatever the clock's resolution. */
        await new Promise((done) => setTimeout(done, 20))
      }
      const listed = await api(server.url, cookie, '/api/workspaces')
      const entry = (Array.isArray(listed.body) ? listed.body : listed.body.workspaces ?? []).find((each) => each.path === root)
      const label = entry?.title ?? root.split('/').pop()
      return {
        home,
        root,
        server,
        browser,
        cookie,
        ids,
        label,
        api: (path, init) => api(server.url, cookie, path, init),
        close,
      }
    } catch (error) {
      /** A fixture that fails half-made still stops its server and browser, so the run can end. */
      await close()
      throw error
    }
  })()
  return shared
}
after(async () => {
  if (shared !== null) await (await shared.catch(() => ({ close: async () => {} }))).close()
})

/** Load the page afresh and wait until the workspace's session rows are drawn. */
async function load(f) {
  await f.browser.goto(f.server.url)
  await f.browser.waitFor('document.body.dataset.ready === "true"', 15_000)
  await f.browser.waitFor(`document.querySelectorAll('#tree li[data-kind="workspace"] li[data-kind="session"]').length >= 3`, 15_000)
  await quiet(f.browser)
}

/** One key the way a keyboard sends it — the protocol's key events, as check-workspace-tree.mjs's `press` does. */
async function press(browser, key, modifiers = {}) {
  const keys = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    ' ': { code: 'Space', keyCode: 32, text: ' ' },
    Escape: { code: 'Escape', keyCode: 27 },
    Tab: { code: 'Tab', keyCode: 9 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
  }
  const description = keys[key]
  const common = {
    key,
    code: description.code,
    windowsVirtualKeyCode: description.keyCode,
    nativeVirtualKeyCode: description.keyCode,
    modifiers: modifiers.shift === true ? 8 : 0,
  }
  await browser.send('Input.dispatchKeyEvent', {
    type: description.text === undefined ? 'rawKeyDown' : 'keyDown',
    ...common,
    ...(description.text === undefined ? {} : { text: description.text, unmodifiedText: description.text }),
  })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await new Promise((done) => setTimeout(done, 60))
}

/** Wait for an expression, answering false instead of throwing when it never holds. */
async function settle(browser, expression, timeoutMs) {
  try {
    return await browser.waitFor(expression, timeoutMs)
  } catch {
    return false
  }
}

/** Wait until the tree has drawn nothing new for 400 ms (at most 4 s), so a key is never pressed into a redraw. */
async function quiet(browser) {
  await browser.evaluate(`new Promise((done) => {
    const tree = document.getElementById('tree')
    let timer = 0
    const finish = () => {
      observer.disconnect()
      clearTimeout(timer)
      clearTimeout(cap)
      done(true)
    }
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(finish, 400)
    })
    const cap = setTimeout(finish, 4000)
    timer = setTimeout(finish, 400)
    observer.observe(tree, { childList: true, subtree: true })
  })`)
}

/** The tree item of the session row labelled `label`, as a page expression. */
const rowOf = (label) => `[...document.querySelectorAll('#tree li[data-kind="session"]')].find((li) => li.querySelector(':scope > .row > .label')?.textContent === ${JSON.stringify(label)})`

/**
 * Focus a control of a row, the way Tab reaches it: the row first, which draws its controls (`:focus-within`), then the
 * control named `name` inside it. Answers what holds focus.
 */
async function focusControl(browser, li, name) {
  return browser.evaluate(`(() => {
    const li = ${li}
    if (li === undefined || li === null) return 'no row'
    li.querySelector(':scope > .row').focus()
    const control = [...li.querySelectorAll(':scope > .row button')].find((button) => button.getAttribute('aria-label') === ${JSON.stringify(name)} || button.getAttribute('aria-label')?.startsWith(${JSON.stringify(name)}))
    if (control === undefined) return 'no control'
    control.focus()
    return document.activeElement === control ? 'focused' : 'not focused: ' + (document.activeElement?.outerHTML ?? '').slice(0, 80)
  })()`)
}

const openTitle = `document.getElementById('session-title').textContent`
const selectedLabels = `JSON.stringify([...document.querySelectorAll('#tree li[aria-selected="true"]')].map((li) => li.querySelector(':scope > .row > .label')?.textContent ?? ''))`

test('Enter or Space on a row control acts on the control and never opens the row (#98)', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const f = await fixture()
  const { browser } = f
  await load(f)
  /** tk 8 open, so every row the keys are pressed on is a row that is not open. */
  await browser.evaluate(`${rowOf('tk 8')}.querySelector(':scope > .row').click()`)
  await browser.waitFor(`${openTitle}.includes('tk 8')`, 10_000)
  await quiet(browser)
  const sessions = async () => (await f.api('/api/sessions')).body
  const flags = async (label) => (await sessions()).find((meta) => meta.id === f.ids[label]) ?? {}

  /** Enter on `Pin session` pins that row; the open session stays the one it was. */
  assert.equal(await focusControl(browser, rowOf('tk 5'), 'Pin session'), 'focused', 'the keyboard reaches tk 5\'s Pin session')
  await press(browser, 'Enter')
  await settle(browser, `${rowOf('tk 5')}?.dataset.pinned === 'true' || ${openTitle}.includes('tk 5')`, 5_000)
  await quiet(browser)
  const afterEnter = { title: await browser.evaluate(openTitle), selected: JSON.parse(await browser.evaluate(selectedLabels)), pinned: (await flags('tk 5')).pinned === true }
  assert.ok(!afterEnter.title.includes('tk 5') && !afterEnter.selected.includes('tk 5'), `Enter on Pin does not open the row\nsaw: ${JSON.stringify(afterEnter)}`)
  assert.equal(afterEnter.pinned, true, `Enter on Pin pins the session\nsaw: ${JSON.stringify(afterEnter)}`)

  /** Space on `Pin session` does the same. */
  assert.equal(await focusControl(browser, rowOf('tk 6'), 'Pin session'), 'focused', 'the keyboard reaches tk 6\'s Pin session')
  await press(browser, ' ')
  await settle(browser, `${rowOf('tk 6')}?.dataset.pinned === 'true' || ${openTitle}.includes('tk 6')`, 5_000)
  await quiet(browser)
  const afterSpace = { title: await browser.evaluate(openTitle), selected: JSON.parse(await browser.evaluate(selectedLabels)), pinned: (await flags('tk 6')).pinned === true }
  assert.ok(!afterSpace.title.includes('tk 6') && !afterSpace.selected.includes('tk 6'), `Space on Pin does not open the row\nsaw: ${JSON.stringify(afterSpace)}`)
  assert.equal(afterSpace.pinned, true, `Space on Pin pins the session\nsaw: ${JSON.stringify(afterSpace)}`)

  /** Space on the `…` opens the row's menu, not the session. */
  assert.equal(await focusControl(browser, rowOf('tk 7'), 'actions for'), 'focused', 'the keyboard reaches tk 7\'s actions button')
  await press(browser, ' ')
  await settle(browser, `${rowOf('tk 7')}.querySelector('.menu-wrap > .menu:not([hidden])') !== null || ${openTitle}.includes('tk 7')`, 5_000)
  const menu = JSON.parse(
    await browser.evaluate(`JSON.stringify({
      open: ${rowOf('tk 7')}.querySelector('.menu-wrap > .menu:not([hidden])') !== null,
      expanded: ${rowOf('tk 7')}.querySelector('.menu-wrap > button').getAttribute('aria-expanded'),
      title: ${openTitle},
    })`),
  )
  assert.deepEqual({ open: menu.open, expanded: menu.expanded, opened: menu.title.includes('tk 7') }, { open: true, expanded: 'true', opened: false }, `Space on the … opens its menu and not the session\nsaw: ${JSON.stringify(menu)}`)
  await browser.evaluate(`document.body.click()`)
  await quiet(browser)

  /** Enter on `Archive session` archives that row. */
  assert.equal(await focusControl(browser, rowOf('tk 4'), 'Archive session'), 'focused', 'the keyboard reaches tk 4\'s Archive session')
  await press(browser, 'Enter')
  await settle(browser, `${rowOf('tk 4')} === undefined || ${openTitle}.includes('tk 4')`, 5_000)
  await quiet(browser)
  const archived = { title: await browser.evaluate(openTitle), archived: (await flags('tk 4')).archived === true }
  assert.ok(!archived.title.includes('tk 4'), `Enter on Archive does not open the row\nsaw: ${JSON.stringify(archived)}`)
  assert.equal(archived.archived, true, `Enter on Archive archives the session\nsaw: ${JSON.stringify(archived)}`)

  /** Enter on `New session in <workspace>` starts a session there, and leaves the workspace open. */
  const before = (await sessions()).length
  const workspaceRow = `document.querySelector('#tree > li[data-kind="workspace"]')`
  assert.equal(await focusControl(browser, workspaceRow, 'New session in'), 'focused', 'the keyboard reaches New session in the workspace')
  await press(browser, 'Enter')
  for (let waited = 0; waited < 5_000 && (await sessions()).length === before; waited += 250) await new Promise((done) => setTimeout(done, 250))
  await quiet(browser)
  const started = { count: (await sessions()).length, expanded: await browser.evaluate(`${workspaceRow}.getAttribute('aria-expanded')`) }
  assert.deepEqual(started, { count: before + 1, expanded: 'true' }, 'Enter on New session in starts a session and does not fold the workspace')
})

/** What holds focus, as a short name: `row:<label>` for a tree row, `li:<label>` for a list item, else the control's name. */
const focusName = `(() => {
  const active = document.activeElement
  if (active === null || active === document.body) return 'body'
  const label = (li) => li?.querySelector(':scope > .row > .label')?.textContent ?? ''
  if (active.matches('#tree .row')) return 'row:' + (active.querySelector(':scope > .label')?.textContent ?? '')
  if (active.matches('#tree li')) return 'li:' + label(active)
  return active.tagName + ':' + (active.getAttribute('aria-label') ?? active.textContent.trim())
})()`

test('a tree row is one Tab stop that opens on Enter, and Show more is a button with aria-expanded (#92)', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const f = await fixture()
  const { browser } = f
  await load(f)

  /**
   * From a session row, Tab visits its three controls — the `…`, Archive, Pin — and the fourth Tab is the next row,
   * which Enter opens. The list item around a row is no stop of its own (it was, and Enter on it did nothing).
   */
  const pair = JSON.parse(
    await browser.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#tree > li[data-kind="workspace"] > ul > li[data-kind="session"]')]
      for (const li of rows) {
        const next = li.nextElementSibling
        const controls = li.querySelectorAll(':scope > .row .row-tools > .menu-wrap > button, :scope > .row .row-tools > .session-actions > button').length
        if (controls !== 3 || next?.dataset.kind !== 'session' || next.getAttribute('aria-selected') === 'true') continue
        const label = (each) => each.querySelector(':scope > .row > .label').textContent
        return JSON.stringify({ from: label(li), to: label(next) })
      }
      return 'null'
    })()`),
  )
  assert.notEqual(pair, null, 'the workspace draws a session row with its three controls followed by a session row that is not open')
  await browser.evaluate(`${rowOf(pair.from)}.querySelector(':scope > .row').focus()`)
  assert.equal(await browser.evaluate(focusName), `row:${pair.from}`, 'the walk starts on a session row')
  const stops = []
  for (let index = 0; index < 4; index += 1) {
    await press(browser, 'Tab')
    stops.push(await browser.evaluate(focusName))
  }
  assert.match(stops[0] ?? '', /^BUTTON:actions for /, `Tab 1 is the row's …\nsaw: ${JSON.stringify(stops)}`)
  assert.match(stops[1] ?? '', /^BUTTON:(Un)?[Aa]rchive session$/, `Tab 2 is Archive session\nsaw: ${JSON.stringify(stops)}`)
  assert.match(stops[2] ?? '', /^BUTTON:(Un)?[Pp]in session$/, `Tab 3 is Pin session\nsaw: ${JSON.stringify(stops)}`)
  assert.equal(stops[3], `row:${pair.to}`, `one stop per row: Tab 4 is the next row itself, not its list item\nsaw: ${JSON.stringify(stops)}`)
  await press(browser, 'Enter')
  assert.ok(await settle(browser, `${openTitle}.includes(${JSON.stringify(pair.to)})`, 10_000), `Enter on that stop opens its session\nsaw: ${await browser.evaluate(openTitle)}`)
  await quiet(browser)

  /** A workspace row: the row, its `…`, New session in, then the first row inside it. */
  await browser.evaluate(`document.querySelector('#tree > li[data-kind="workspace"] > .row').focus()`)
  const workspaceStops = []
  for (let index = 0; index < 3; index += 1) {
    await press(browser, 'Tab')
    workspaceStops.push(await browser.evaluate(focusName))
  }
  const first = await browser.evaluate(`document.querySelector('#tree > li[data-kind="workspace"] > ul > li')?.querySelector(':scope > .row > .label')?.textContent ?? ''`)
  assert.match(workspaceStops[0] ?? '', /^BUTTON:actions for /, `a workspace row's Tab 1 is its …\nsaw: ${JSON.stringify(workspaceStops)}`)
  assert.match(workspaceStops[1] ?? '', /^BUTTON:New session in /, `Tab 2 is New session in\nsaw: ${JSON.stringify(workspaceStops)}`)
  assert.equal(workspaceStops[2], `row:${first}`, `Tab 3 is the first row inside it\nsaw: ${JSON.stringify(workspaceStops)}`)

  /** Show more is a real button whose aria-expanded follows it, and the keyboard keeps its place on it. */
  const more = `document.querySelector('#tree > li[data-kind="workspace"] > ul > li[data-kind="more"] > .row')`
  const shape = () =>
    browser.evaluate(`JSON.stringify((() => {
      const control = ${more}
      return control === null ? null : { tag: control.tagName, role: control.getAttribute('role'), expanded: control.getAttribute('aria-expanded'), label: control.querySelector('.label')?.textContent ?? '', focused: document.activeElement === control }
    })())`).then(JSON.parse)
  const folded = await shape()
  assert.notEqual(folded, null, 'the workspace has more sessions than it shows')
  assert.deepEqual({ tag: folded.tag, role: folded.role, expanded: folded.expanded }, { tag: 'BUTTON', role: null, expanded: 'false' }, `Show more is a button, not expanded\nsaw: ${JSON.stringify(folded)}`)
  assert.match(folded.label, /^Show \d+ more sessions$/)
  await browser.evaluate(`${more}.focus()`)
  await press(browser, 'Enter')
  await settle(browser, `${more}?.getAttribute('aria-expanded') === 'true'`, 5_000)
  await quiet(browser)
  const opened = await shape()
  assert.deepEqual({ expanded: opened.expanded, label: opened.label, focused: opened.focused }, { expanded: 'true', label: 'Show less', focused: true }, `Enter shows every session, says so, and keeps focus on the control\nsaw: ${JSON.stringify(opened)}`)
  await press(browser, ' ')
  await settle(browser, `${more}?.getAttribute('aria-expanded') === 'false'`, 5_000)
  const again = await shape()
  assert.deepEqual({ expanded: again.expanded, focused: again.focused }, { expanded: 'false', focused: true }, `Space folds them back\nsaw: ${JSON.stringify(again)}`)
})

test('a row menu, a workspace menu and View options have DSH\'s menu keyboard, and Escape gives focus back to the trigger (#95)', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const f = await fixture()
  const { browser } = f
  await load(f)

  /** The state of the menu whose trigger is `trigger`: open, its trigger's aria-expanded, and what holds focus. */
  const state = (trigger) =>
    browser.evaluate(`JSON.stringify((() => {
      const button = ${trigger}
      const list = button.parentElement.querySelector(':scope > .menu')
      const active = document.activeElement
      return {
        open: list.hidden === false,
        expanded: button.getAttribute('aria-expanded'),
        focus: active === button ? 'trigger' : list.contains(active) ? 'item:' + active.textContent.trim() : active === document.body ? 'body' : active.tagName,
        items: [...list.querySelectorAll('button:not(:disabled)')].map((item) => item.textContent.trim()),
      }
    })())`).then(JSON.parse)

  /** A session row's `…`: Enter opens it with focus left on the trigger, as DSH's row menu opens without autoFocus. */
  const label = await browser.evaluate(`[...document.querySelectorAll('#tree > li[data-kind="workspace"] > ul > li[data-kind="session"]')].find((li) => li.querySelector('.menu-wrap') !== null).querySelector(':scope > .row > .label').textContent`)
  const trigger = `${rowOf(label)}.querySelector('.menu-wrap > button')`
  assert.equal(await focusControl(browser, rowOf(label), 'actions for'), 'focused', `the keyboard reaches the … of ${label}`)
  await press(browser, 'Enter')
  await settle(browser, `${trigger}.getAttribute('aria-expanded') === 'true'`, 5_000)
  const opened = await state(trigger)
  assert.deepEqual({ open: opened.open, expanded: opened.expanded, focus: opened.focus }, { open: true, expanded: 'true', focus: 'trigger' }, `Enter on the … opens its menu\nsaw: ${JSON.stringify(opened)}`)
  const items = opened.items
  assert.ok(items.length >= 3, `the row menu has items to rove\nsaw: ${JSON.stringify(items)}`)

  /** ArrowDown moves into the menu; the arrows rove and wrap; Home and End jump. */
  const walk = []
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'Home', 'End', 'ArrowDown']) {
    await press(browser, key)
    walk.push((await state(trigger)).focus)
  }
  const at = (index) => `item:${items[index]}`
  assert.deepEqual(
    walk,
    [at(0), at(1), at(0), at(items.length - 1), at(0), at(items.length - 1), at(0)],
    `ArrowDown enters the menu at its first item, the arrows rove and wrap, Home and End jump\nsaw: ${JSON.stringify(walk)}`,
  )

  /** Escape closes the menu and gives focus back to its trigger. */
  await press(browser, 'Escape')
  const escaped = await state(trigger)
  assert.deepEqual({ open: escaped.open, expanded: escaped.expanded, focus: escaped.focus }, { open: false, expanded: 'false', focus: 'trigger' }, `Escape closes the menu and returns focus to the …\nsaw: ${JSON.stringify(escaped)}`)

  /** Tab from the open trigger enters the list; Shift+Tab closes it onto the trigger. */
  await press(browser, 'Enter')
  await settle(browser, `${trigger}.getAttribute('aria-expanded') === 'true'`, 5_000)
  await press(browser, 'Tab')
  const tabbed = await state(trigger)
  assert.equal(tabbed.focus, at(0), `Tab from the open trigger lands on the first item\nsaw: ${JSON.stringify(tabbed)}`)
  await press(browser, 'Tab', { shift: true })
  const back = await state(trigger)
  assert.deepEqual({ open: back.open, focus: back.focus }, { open: false, focus: 'trigger' }, `Shift+Tab closes the menu onto its trigger\nsaw: ${JSON.stringify(back)}`)

  /** A workspace row's `…`: the same keys. */
  const workspaceTrigger = `document.querySelector('#tree > li[data-kind="workspace"] > .row .menu-wrap > button')`
  assert.equal(await focusControl(browser, `document.querySelector('#tree > li[data-kind="workspace"]')`, 'actions for'), 'focused', 'the keyboard reaches the workspace row\'s …')
  await press(browser, 'Enter')
  await settle(browser, `${workspaceTrigger}.getAttribute('aria-expanded') === 'true'`, 5_000)
  await press(browser, 'ArrowDown')
  const workspaceMenu = await state(workspaceTrigger)
  assert.equal(workspaceMenu.focus, `item:${workspaceMenu.items[0]}`, `ArrowDown moves into the workspace menu\nsaw: ${JSON.stringify(workspaceMenu)}`)
  await press(browser, 'Escape')
  const workspaceEscaped = await state(workspaceTrigger)
  assert.deepEqual({ open: workspaceEscaped.open, focus: workspaceEscaped.focus }, { open: false, focus: 'trigger' }, `Escape closes it and returns focus to its …\nsaw: ${JSON.stringify(workspaceEscaped)}`)

  /** View options: the same keys, and a choice made from the keyboard gives focus back to the trigger. */
  const viewTrigger = `document.querySelector('#view-options .menu-wrap > button')`
  await browser.evaluate(`${viewTrigger}.focus()`)
  await press(browser, 'Enter')
  await settle(browser, `${viewTrigger}.getAttribute('aria-expanded') === 'true'`, 5_000)
  await press(browser, 'ArrowDown')
  const view = await state(viewTrigger)
  assert.equal(view.focus, `item:${view.items[0]}`, `ArrowDown moves into View options\nsaw: ${JSON.stringify(view)}`)
  await press(browser, 'Escape')
  const viewEscaped = await state(viewTrigger)
  assert.deepEqual({ open: viewEscaped.open, focus: viewEscaped.focus }, { open: false, focus: 'trigger' }, `Escape closes View options and returns focus to it\nsaw: ${JSON.stringify(viewEscaped)}`)
  await press(browser, 'Enter')
  await settle(browser, `${viewTrigger}.getAttribute('aria-expanded') === 'true'`, 5_000)
  await press(browser, 'ArrowDown')
  /** The first item is the grouping already in use, so choosing it changes nothing but the menu. */
  await press(browser, 'Enter')
  await settle(browser, `document.activeElement === ${viewTrigger}`, 3_000)
  const chosen = await state(viewTrigger)
  assert.deepEqual({ open: chosen.open, focus: chosen.focus }, { open: false, focus: 'trigger' }, `a choice made with Enter closes the menu and gives focus back to its trigger\nsaw: ${JSON.stringify(chosen)}`)
})
