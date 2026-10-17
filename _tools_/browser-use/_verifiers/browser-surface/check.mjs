import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { fixtureDir, removeDir, skipUnless } from '../../../check-helpers/lib.mjs'
import { browserAvailable, createTools, openBrowser, TOOL_NAMES } from '../../lib.mjs'

/**
 * The browser tool's page surface, judged against a local page.
 *
 * The claims that matter are the ones a demonstration hides: that a uid from a snapshot **is** the
 * element the next click hits, that a fill reaches a framework's state through the events a keyboard
 * fires, that a dialog blocks the tools that must not run through it until it is answered, and that a
 * navigation invalidates the uids of the page it left.
 *
 * **Surface:** headless by default, so this runs unattended on a machine with no seat. Run it headed
 * (`HEDDLE_BROWSER_HEADED=1`) to watch it work; the headed run additionally judges that the browser
 * really was a visible window rather than a headless one. It spends nothing and needs only Chrome: the
 * page it drives is served by this process on loopback.
 */

/** Whether this run should open a window a person can watch. */
const headed = process.env.HEDDLE_BROWSER_HEADED === '1'

/**
 * The fixture page.
 *
 * Every behaviour is observable from outside the page — in its text, its console, or the network log —
 * because a check should not have to trust a page's private state to know an action happened. The drag
 * area is positioned in a container of its own so it cannot overlap the controls above it: measured,
 * an absolutely positioned draggable placed over the form swallowed the click meant for an input.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fixture</title>
  <style>
    body { font: 16px/1.4 system-ui, sans-serif; color: #111; background: #fff; }
    #stage { position: relative; height: 160px; margin: 8px 0; }
    #draggable { width: 80px; height: 40px; background: #4a7; position: absolute; left: 0; top: 20px; }
    #canvas { width: 200px; height: 120px; border: 2px dashed #888; position: absolute; left: 300px; top: 10px; }
    @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
  </style>
</head>
<body>
  <h1>Browser tool fixture</h1>
  <p id="intro">A page with one of everything the tool acts on.</p>
  <label>Name <input id="name" placeholder="your name"></label>
  <label><input id="agree" type="checkbox"> I agree</label>
  <label>Colour
    <select id="colour">
      <option value="red">Red</option>
      <option value="green">Green</option>
      <option value="blue">Blue</option>
    </select>
  </label>
  <textarea id="notes" rows="2" placeholder="notes"></textarea>
  <div id="rich" contenteditable="true">editable text</div>
  <div><button id="greet">Greet</button> <button id="fail">Fail</button> <button id="alert">Alert</button> <button id="confirm">Confirm</button> <button id="prompt">Prompt</button> <button id="open">Open tab</button></div>
  <div><input id="keylog" placeholder="type here"><input id="file" type="file" multiple></div>
  <div id="hoverTarget">hover target</div>
  <div id="stage">
    <div id="draggable">drag me</div>
    <div id="canvas">drop here</div>
  </div>
  <a id="next" href="/second">next page</a>
  <div id="late"></div>
  <p id="output">idle</p>
  <script>
    const output = document.getElementById('output')
    document.getElementById('greet').addEventListener('click', () => {
      const name = document.getElementById('name').value
      output.textContent = 'greeted:' + name
      console.log('greet ' + name)
      fetch('/api/data?name=' + encodeURIComponent(name)).catch(() => {})
    })
    document.getElementById('fail').addEventListener('click', () => {
      console.error('deliberate failure')
      fetch('/api/missing').catch(() => {})
    })
    document.getElementById('alert').addEventListener('click', () => { alert('alert message') })
    document.getElementById('confirm').addEventListener('click', () => {
      output.textContent = confirm('confirm message') ? 'confirmed' : 'declined'
    })
    document.getElementById('prompt').addEventListener('click', () => {
      output.textContent = 'prompt:' + prompt('prompt message', 'default answer')
    })
    document.getElementById('open').addEventListener('click', () => { window.open('/second', 'second tab') })
    document.getElementById('hoverTarget').addEventListener('mouseenter', (event) => {
      event.currentTarget.setAttribute('data-hovered', 'yes')
    })
    document.getElementById('keylog').addEventListener('keydown', (event) => {
      output.textContent = 'key:' + event.key
    })
    document.getElementById('file').addEventListener('change', (event) => {
      output.textContent = 'files:' + Array.from(event.target.files ?? []).map((file) => file.name).join(',')
    })
    const draggable = document.getElementById('draggable')
    const canvas = document.getElementById('canvas')
    let dragging = false
    draggable.addEventListener('mousedown', () => { dragging = true })
    document.addEventListener('mouseup', (event) => {
      dragging = false
      const box = canvas.getBoundingClientRect()
      if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) {
        canvas.setAttribute('data-dropped', 'yes')
        output.textContent = 'dropped'
      }
    })
    document.addEventListener('mousemove', (event) => {
      if (!dragging) return
      draggable.style.left = event.clientX - 40 + 'px'
      draggable.style.top = event.clientY - 20 + 'px'
    })
    setTimeout(() => { document.getElementById('late').textContent = 'arrived' }, 700)
  </script>
</body>
</html>`

/** The second page, so a navigation has somewhere to go. */
const SECOND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Second</title></head><body><h1>Second page</h1><a id="back" href="/">back</a></body></html>`

/** Serve the fixture on an ephemeral loopback port. */
async function startFixture() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PAGE)
    } else if (url.pathname === '/second') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(SECOND)
    } else if (url.pathname === '/api/data') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, name: url.searchParams.get('name') }))
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    }
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolvePromise) => server.close(resolvePromise)) }
}

/** Find the first node in a snapshot tree that a predicate accepts. */
function findNode(tree, predicate, found = []) {
  if (predicate(tree)) found.push(tree)
  for (const child of tree.children ?? []) findNode(child, predicate, found)
  return found[0]
}

/** Find the uid of a node in a snapshot tree; a role of `undefined` matches any role. */
function findUid(tree, role, name) {
  if ((role === undefined || tree.role === role) && (name === undefined || tree.name === name)) return tree.uid
  for (const child of tree.children ?? []) {
    const found = findUid(child, role, name)
    if (found !== undefined) return found
  }
  return undefined
}

let running
let tools
let fixture
let pageId
let work

before(async () => {
  if (!browserAvailable()) return
  work = fixtureDir('browser-surface')
  // A profile of its own: a running session host owns the shared one, and two browsers cannot share it.
  running = await openBrowser({ headless: !headed, width: 1200, height: 900, profile: join(work, 'profile'), temporaryProfile: true })
  tools = createTools(running, { stateDir: work })
  fixture = await startFixture()
  const opened = await tools.new_page({ url: fixture.url })
  pageId = opened.pageId
})

after(async () => {
  if (running !== undefined) await running.close()
  if (fixture !== undefined) await fixture.close()
  if (work !== undefined) removeDir(work)
})

test('the tool offers the harness browser surface', (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  for (const name of ['list_pages', 'new_page', 'select_page', 'close_page', 'navigate_page', 'take_snapshot', 'click', 'fill', 'fill_form', 'hover', 'drag', 'press_key', 'type_text', 'upload_file', 'handle_dialog', 'take_screenshot', 'evaluate_script', 'wait_for', 'list_console_messages', 'get_console_message', 'list_network_requests', 'get_network_request', 'emulate', 'resize_page']) {
    assert.ok(TOOL_NAMES.includes(name), `the tool offers ${name}`)
  }
})

test('a page opens, is listed, and is selected', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const listing = await tools.list_pages({})
  assert.ok(listing.pages.some((page) => page.pageId === pageId), 'the opened page is listed')
  assert.match(listing.text, /## Pages/)
  const selected = await tools.select_page({ pageId })
  assert.equal(selected.pageId, pageId, 'select_page names the page it selected')
})

test('the snapshot names the page and its elements', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const snapshot = await tools.take_snapshot({ pageId })
  assert.match(snapshot.snapshot, /uid=\d+_\d+ RootWebArea "Fixture"/, 'the snapshot starts at the root')
  assert.match(snapshot.snapshot, /heading "Browser tool fixture"/, 'a heading is named')
  assert.match(snapshot.snapshot, /button "Greet"/, 'a button is named')
  assert.match(snapshot.snapshot, /textbox "Name"/, 'an input is named by its label')
  assert.match(snapshot.snapshot, /checkbox "I agree"/, 'a checkbox is named')
  assert.ok(findUid(snapshot.tree, 'button', 'Greet') !== undefined, 'the button has a uid the next call can name')
})

test('click acts on the element the snapshot named', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const snapshot = await tools.take_snapshot({ pageId })
  const input = findUid(snapshot.tree, 'textbox', 'Name')
  const button = findUid(snapshot.tree, 'button', 'Greet')
  await tools.fill({ pageId, uid: input, value: 'Ada' })
  const clicked = await tools.click({ pageId, uid: button, includeSnapshot: true })
  assert.equal(clicked.clicked, button)
  assert.match(clicked.snapshot ?? '', /RootWebArea "Fixture"/, 'includeSnapshot returns the page again')
  const output = await tools.evaluate_script({ pageId, function: `() => document.getElementById('output').textContent` })
  assert.equal(output.value, 'greeted:Ada', 'the page reacted to the click with the filled value')
  const info = await tools.evaluate_script({ pageId, function: `(element) => ({ tag: element.tagName, value: element.value })`, args: [input] })
  assert.deepEqual(info.value, { tag: 'INPUT', value: 'Ada' }, 'a uid argument arrives as the element itself')
})

test('fill_form fills fields of every kind', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const snapshot = await tools.take_snapshot({ pageId })
  const notes = findUid(snapshot.tree, undefined, 'notes')
  const colour = findUid(snapshot.tree, 'combobox')
  const agree = findUid(snapshot.tree, 'checkbox', 'I agree')
  const rich = findNode(snapshot.tree, (node) => node.attributes?.editable === 'richtext')?.uid
  assert.ok(notes !== undefined && colour !== undefined && agree !== undefined && rich !== undefined, 'every field is named by the snapshot')
  const filled = await tools.fill_form({
    pageId,
    elements: [
      { uid: notes, value: 'some notes' },
      { uid: colour, value: 'green' },
      { uid: agree, value: true },
      { uid: rich, value: 'rich text' },
    ],
  })
  assert.equal(filled.filled, 4)
  const state = await tools.evaluate_script({
    pageId,
    function: `() => ({ notes: document.getElementById('notes').value, colour: document.getElementById('colour').value, agree: document.getElementById('agree').checked, rich: document.getElementById('rich').innerText })`,
  })
  assert.equal(state.value.notes, 'some notes')
  assert.equal(state.value.colour, 'green')
  assert.equal(state.value.agree, true, 'a checkbox is checked rather than assigned')
  assert.equal(state.value.rich, 'rich text', 'a contenteditable is filled as text')
})

test('type_text and press_key reach a keyboard listener', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const snapshot = await tools.take_snapshot({ pageId })
  const keylog = findUid(snapshot.tree, undefined, 'type here')
  await tools.click({ pageId, uid: keylog })
  await tools.type_text({ pageId, text: 'typed' })
  const typed = await tools.evaluate_script({ pageId, function: `() => document.getElementById('keylog').value` })
  assert.equal(typed.value, 'typed')
  await tools.press_key({ pageId, key: 'Enter' })
  const pressed = await tools.evaluate_script({ pageId, function: `() => document.getElementById('output').textContent` })
  assert.equal(pressed.value, 'key:Enter')
})

test('hover moves the mouse over the element', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const snapshot = await tools.take_snapshot({ pageId })
  const target = findUid(snapshot.tree, undefined, 'hover target')
  await tools.hover({ pageId, uid: target })
  const hovered = await tools.evaluate_script({ pageId, function: `() => document.getElementById('hoverTarget').getAttribute('data-hovered')` })
  assert.equal(hovered.value, 'yes')
})

test('drag moves one element onto another', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const snapshot = await tools.take_snapshot({ pageId })
  const from = findUid(snapshot.tree, undefined, 'drag me')
  const to = findUid(snapshot.tree, undefined, 'drop here')
  assert.ok(from !== undefined && to !== undefined, 'both draggable elements are in the snapshot')
  await tools.drag({ pageId, from_uid: from, to_uid: to })
  const dropped = await tools.evaluate_script({ pageId, function: `() => document.getElementById('canvas').getAttribute('data-dropped')` })
  assert.equal(dropped.value, 'yes', 'the drop target saw a drop at its coordinates')
})

test('upload_file gives a file input its files', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const upload = join(work, 'upload.txt')
  writeFileSync(upload, 'uploaded content')
  const snapshot = await tools.take_snapshot({ pageId })
  const file = findNode(snapshot.tree, (node) => node.role === 'button' && String(node.name ?? '').startsWith('Choose File'))?.uid
  assert.ok(file !== undefined, 'the file input is in the snapshot')
  const result = await tools.upload_file({ pageId, uid: file, filePaths: [upload] })
  assert.deepEqual(result.uploaded, ['upload.txt'])
  const output = await tools.evaluate_script({ pageId, function: `() => document.getElementById('output').textContent` })
  assert.equal(output.value, 'files:upload.txt')
})

test('a dialog blocks actions until it is answered', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const snapshot = await tools.take_snapshot({ pageId })
  const confirm = findUid(snapshot.tree, 'button', 'Confirm')
  const clicked = await tools.click({ pageId, uid: confirm })
  assert.ok(clicked.dialog !== undefined, 'the click reports the dialog it opened')
  await assert.rejects(() => tools.take_snapshot({ pageId }), /Blocked by a confirm dialog/)
  const handled = await tools.handle_dialog({ pageId, action: 'accept' })
  assert.equal(handled.handled, 'accepted')
  const output = await tools.evaluate_script({ pageId, function: `() => document.getElementById('output').textContent` })
  assert.equal(output.value, 'confirmed', 'accepting the dialog let the page continue')
})

test('an alert and a prompt can be answered, and a prompt carries the text given', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const opened = await tools.take_snapshot({ pageId })
  await tools.click({ pageId, uid: findUid(opened.tree, 'button', 'Alert') })
  const alert = await tools.handle_dialog({ pageId, action: 'accept' })
  assert.equal(alert.dialog.type, 'alert', 'an alert reports its own type')
  const again = await tools.take_snapshot({ pageId })
  await tools.click({ pageId, uid: findUid(again.tree, 'button', 'Prompt') })
  const prompt = await tools.handle_dialog({ pageId, action: 'accept', promptText: 'typed answer' })
  assert.equal(prompt.dialog.type, 'prompt', 'a prompt reports its own type')
  const output = await tools.evaluate_script({ pageId, function: `() => document.getElementById('output').textContent` })
  assert.equal(output.value, 'prompt:typed answer', 'the answer given replaces the prompt default')
})

test('wait_for waits for text the page renders later', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const waited = await tools.wait_for({ pageId, text: ['arrived'], timeout: 5_000 })
  assert.equal(waited.found, 'arrived')
  assert.match(waited.snapshot, /"arrived"/)
})

test('console messages are recorded and readable one at a time', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const snapshot = await tools.take_snapshot({ pageId })
  const fail = findUid(snapshot.tree, 'button', 'Fail')
  await tools.click({ pageId, uid: fail })
  const listed = await tools.list_console_messages({ pageId })
  assert.match(listed.text, /## Console messages/)
  assert.match(listed.text, /msgid=\d+ \[error\] deliberate failure/, 'an error is recorded with its text')
  const first = listed.messages.find((message) => message.text === 'deliberate failure')
  assert.ok(first !== undefined, 'the deliberate failure is the message read below')
  const one = await tools.get_console_message({ pageId, msgid: first.msgid })
  assert.match(one.text, /Message: error> deliberate failure/)
  const filtered = await tools.list_console_messages({ pageId, types: ['log'] })
  assert.ok(filtered.messages.every((message) => message.type === 'log'), 'the type filter filters')
})

test('network requests are recorded, listed and readable', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const listed = await tools.list_network_requests({ pageId })
  assert.match(listed.text, /## Network requests/)
  const data = listed.requests.find((request) => request.url.includes('/api/data'))
  assert.ok(data !== undefined, 'the fetch the click started is listed')
  const one = await tools.get_network_request({ pageId, reqid: data.reqid })
  assert.match(one.text, /### Response Headers/)
  assert.match(one.text, /"ok":true/, 'the response body is part of the reading')
})

test('emulate can take the page offline and bring it back', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  await tools.emulate({ pageId, networkConditions: 'Offline' })
  const offline = await tools.evaluate_script({ pageId, function: '() => navigator.onLine' })
  assert.equal(offline.value, false, 'the page sees the network as offline')
  await tools.emulate({ pageId })
  const online = await tools.evaluate_script({ pageId, function: '() => navigator.onLine' })
  assert.equal(online.value, true, 'and sees it again after the emulation is cleared')
})

test('take_screenshot captures the viewport, the page and one element', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const plain = await tools.take_screenshot({ pageId })
  assert.ok(existsSync(plain.path) && statSync(plain.path).size > 1_000, 'a viewport screenshot is a real image')
  const full = await tools.take_screenshot({ pageId, fullPage: true })
  assert.ok(existsSync(full.path), 'a full-page screenshot is saved')
  const snapshot = await tools.take_snapshot({ pageId })
  const canvas = findUid(snapshot.tree, undefined, 'drop here')
  const element = await tools.take_screenshot({ pageId, uid: canvas })
  assert.ok(existsSync(element.path), 'an element screenshot is saved')
  const jpeg = await tools.take_screenshot({ pageId, format: 'jpeg', quality: 70 })
  assert.match(jpeg.path, /\.jpg$/, 'a jpeg screenshot names its format')
  const webp = await tools.take_screenshot({ pageId, format: 'webp' })
  assert.match(webp.path, /\.webp$/)
})

test('evaluate_script runs a function, a script, and saves to a file', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const script = await tools.evaluate_script({ pageId, script: '1 + 1' })
  assert.equal(script.value, 2)
  const saved = join(work, 'evaluated.json')
  const toFile = await tools.evaluate_script({ pageId, function: '() => ({ saved: true })', filePath: saved })
  assert.equal(toFile.filePath, saved)
  assert.match(readFileSync(saved, 'utf8'), /"saved": true/)
})

test('navigate_page goes to a URL, back, forward and reload, and the old uids die with the document', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const before = await tools.take_snapshot({ pageId })
  const oldUid = findUid(before.tree, 'button', 'Greet')
  const second = await tools.navigate_page({ pageId, url: `${fixture.url}second` })
  assert.equal(second.title, 'Second')
  await assert.rejects(() => tools.click({ pageId, uid: oldUid }), /no longer on the page|no element with uid/, 'a uid from the previous document is refused')
  const back = await tools.navigate_page({ pageId, type: 'back' })
  assert.equal(back.title, 'Fixture')
  const forward = await tools.navigate_page({ pageId, type: 'forward' })
  assert.equal(forward.title, 'Second')
  const reload = await tools.navigate_page({ pageId, type: 'reload' })
  assert.equal(reload.title, 'Second')
  await tools.navigate_page({ pageId, url: fixture.url })
})

test('navigate_page runs an init script, and a snapshot can be saved to a file', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  await tools.navigate_page({ pageId, url: fixture.url, initScript: 'window.__injected = 42' })
  const injected = await tools.evaluate_script({ pageId, function: '() => window.__injected' })
  assert.equal(injected.value, 42, 'the script ran in the new document, before its own scripts')
  const saved = join(work, 'snapshot.txt')
  const result = await tools.take_snapshot({ pageId, filePath: saved })
  assert.equal(result.filePath, saved)
  assert.match(readFileSync(saved, 'utf8'), /RootWebArea "Fixture"/, 'the snapshot file holds the tree it printed')
})

test('a new tab is a page, and the selected page is what the tools mean', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const second = await tools.new_page({ url: `${fixture.url}second`, background: true })
  assert.notEqual(second.pageId, pageId, 'the new page has its own id')
  const listing = await tools.list_pages({})
  assert.ok(listing.pages.some((page) => page.pageId === second.pageId))
  assert.equal(listing.pages.find((page) => page.pageId === second.pageId)?.selected, false, 'a background tab is not selected')
  await tools.select_page({ pageId: second.pageId })
  const title = await tools.evaluate_script({ pageId: second.pageId, function: '() => document.title' })
  assert.equal(title.value, 'Second')
  await tools.close_page({ pageId: second.pageId })
  const after = await tools.list_pages({})
  assert.ok(!after.pages.some((page) => page.pageId === second.pageId), 'the closed page is gone')
  await tools.select_page({ pageId })
})

test('emulate changes what the page believes about its device, and resize_page changes the viewport', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  /** The host's own pixel ratio, so "cleared" is judged against what it was rather than against 1. */
  const base = await tools.evaluate_script({ pageId, function: '() => ({ dpr: window.devicePixelRatio })' })
  await tools.emulate({ pageId, viewport: '800x600x2', colorScheme: 'dark' })
  const emulated = await tools.evaluate_script({
    pageId,
    function: `() => ({ width: window.innerWidth, height: window.innerHeight, dark: window.matchMedia('(prefers-color-scheme: dark)').matches })`,
  })
  assert.equal(emulated.value.width, 800)
  assert.equal(emulated.value.height, 600)
  assert.equal(emulated.value.dark, true, 'the page sees the emulated colour scheme')
  await tools.emulate({ pageId, viewport: '800x600x2,mobile,touch' })
  const touch = await tools.evaluate_script({ pageId, function: `() => ({ touchPoints: navigator.maxTouchPoints, coarse: window.matchMedia('(pointer: coarse)').matches })` })
  assert.ok(touch.value.touchPoints > 0, 'the emulated device has a touch screen')
  assert.equal(touch.value.coarse, true, 'and its pointer is coarse')
  await tools.emulate({ pageId, viewport: '800x600x2,mobile,touch', colorScheme: 'light' })
  const light = await tools.evaluate_script({ pageId, function: `() => window.matchMedia('(prefers-color-scheme: dark)').matches` })
  assert.equal(light.value, false, 'a second call replaces the scheme rather than adding to it')
  await tools.resize_page({ pageId, width: 1024, height: 700 })
  const resized = await tools.evaluate_script({ pageId, function: '() => window.innerWidth' })
  assert.equal(resized.value, 1024)
  /**
   * An omitted field turns an emulation off rather than leaving the previous call's value in place.
   * `777` is a width no real window here has, and `forced-colors` is a media feature the host's own
   * settings do not turn on — so both readings below say what the emulation did, not what the machine
   * happened to be set to.
   */
  await tools.emulate({ pageId, viewport: '777x555x3', forcedColors: 'active' })
  const scaled = await tools.evaluate_script({ pageId, function: '() => window.devicePixelRatio' })
  assert.equal(scaled.value, 3, 'the emulated pixel ratio is what the page sees')
  const cleared = await tools.emulate({ pageId })
  assert.deepEqual(cleared.applied, [], 'a call with no settings clears the emulation record')
  const afterClear = await tools.evaluate_script({
    pageId,
    function: `() => ({ dpr: window.devicePixelRatio, forced: window.matchMedia('(forced-colors: active)').matches })`,
  })
  /**
   * The pixel ratio is the honest signal: clearing restores the host's own ratio, whereas
   * `innerWidth` keeps the size the emulation resized the window to and so would read as unchanged.
   */
  assert.equal(afterClear.value.dpr, base.value.dpr, 'omitting the viewport restores the real pixel ratio')
  assert.equal(afterClear.value.forced, false, 'and omitting forcedColors clears that too')
})

test('the last page cannot be closed', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const listing = await tools.list_pages({})
  for (const page of listing.pages) {
    if (page.pageId !== pageId) await tools.close_page({ pageId: page.pageId })
  }
  const result = await tools.close_page({ pageId })
  assert.match(result.note ?? '', /last open page cannot be closed/)
})

test('the browser used the surface this run asked for', (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  /**
   * Both answers are claims, so neither run is unjudged: a headless run must not have opened a window,
   * and a headed run must have. The headed one is also the claim a demonstration cannot make — that
   * the window a person is watching is the browser the tools are acting on.
   */
  assert.equal(running.running.headless, !headed, headed ? 'a window was opened, not a headless browser' : 'the unattended run opened no window')
})
