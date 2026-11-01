import { writeFileSync } from 'node:fs'

/**
 * Acting on a page: the calls behind click, fill, type, press, hover, drag, upload and dialogs.
 *
 * The rule the whole file follows is that an action is a **person's** action, not a script's. A click
 * is a mouse event at the element's centre after scrolling it into view, not `element.click()` — pages
 * that listen on `pointerdown`, check `event.isTrusted`, or react to hover all behave differently under
 * the two. Filling a field sets the value through the prototype's own setter and then fires the events
 * a keyboard would, because assigning `element.value` directly leaves React's state stale.
 */

/** Wait a moment, for the small settles between an event and the page's reaction to it. */
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** The element a uid names, resolved to a protocol object handle. */
export async function resolveObject(page, uid) {
  const node = page.uidToNode.get(uid)
  if (node === undefined) throw new Error(`the snapshot has no element with uid ${uid}; take a new snapshot`)
  if (node.backendNodeId === undefined) throw new Error(`the element with uid ${uid} is not a DOM node; take a new snapshot`)
  try {
    const reply = await page.send('DOM.resolveNode', { backendNodeId: node.backendNodeId })
    const objectId = reply.result?.object?.objectId
    if (objectId === undefined) throw new Error('no object')
    return { objectId, node }
  } catch {
    throw new Error(`the element with uid ${uid} is no longer on the page; take a new snapshot`)
  }
}

/** Call one function on an object handle and return its value. */
export async function callOn(page, objectId, functionDeclaration, args = [], { timeoutMs = 30_000 } = {}) {
  const reply = await page.send(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    },
    { timeoutMs },
  )
  const details = reply.result?.exceptionDetails
  if (details !== undefined) {
    throw new Error(details.exception?.description ?? details.text ?? 'the page function threw')
  }
  return reply.result?.result?.value
}

/**
 * Run an action and wait out whatever it started.
 *
 * A click that navigates is the normal case for a link, and a reader that takes a snapshot immediately
 * would photograph the page being left. A load that started during the action is therefore waited for,
 * and the new document's execution context with it.
 */
export async function actionSettle(page, action, { timeoutMs = 10_000 } = {}) {
  let loadStarted = false
  const remove = page.connection.on('Page.frameStartedLoading', (params, message) => {
    if (message.sessionId !== page.sessionId) return
    loadStarted = true
  })
  try {
    await action()
  } finally {
    remove()
  }
  await sleep(60)
  if (loadStarted) {
    await page.waitForReadyState(timeoutMs)
    await page.waitForContext(timeoutMs)
  }
}

/**
 * Dispatch one real mouse event, and come back even if the page answers it with a dialog.
 *
 * Measured: the event that opens a `confirm` leaves its own protocol call unanswered — the renderer is
 * blocked on the question — so a caller that awaits every mouse event waits for a dialog nobody can
 * answer yet, and the tool deadlocks on itself. The event is therefore raced against the dialog event,
 * and the unanswered call is allowed to expire on a short leash instead of the site's whole timeout.
 */
async function mouse(page, type, x, y, options = {}) {
  let opened
  const dialogOpened = new Promise((resolvePromise) => {
    opened = resolvePromise
  })
  const remove = page.connection.on('Page.javascriptDialogOpening', (params, message) => {
    if (message.sessionId === page.sessionId) opened(params)
  })
  try {
    const sent = page
      .send(
        'Input.dispatchMouseEvent',
        {
          type,
          x,
          y,
          button: options.button ?? 'none',
          buttons: options.buttons ?? 0,
          clickCount: options.clickCount ?? 0,
          ...(options.modifiers !== undefined ? { modifiers: options.modifiers } : {}),
        },
        { timeoutMs: 5_000 },
      )
      .then(() => ({ answered: true }))
      .catch(() => ({ answered: false }))
    return await Promise.race([sent, dialogOpened.then(() => ({ dialog: true }))])
  } finally {
    remove()
  }
}

/**
 * Click the element a uid names, or the point coordinates name.
 *
 * `option` is special: the accessibility tree's option element lives inside a closed popup that a
 * synthetic click would not select from, so the containing `<select>` is given the value instead — the
 * same correction the harness's browser makes.
 */
export async function click(page, { uid, x, y, dblClick = false } = {}) {
  if (uid !== undefined) {
    const node = page.uidToNode.get(uid)
    if (node === undefined) throw new Error(`the snapshot has no element with uid ${uid}; take a new snapshot`)
    if (node.role === 'option' && dblClick !== true) {
      const { objectId } = await resolveObject(page, uid)
      const selected = await callOn(
        page,
        objectId,
        `function () {
          const option = this
          const select = option.closest('select')
          if (select === null || select.multiple) return null
          select.value = option.value
          select.dispatchEvent(new Event('input', { bubbles: true }))
          select.dispatchEvent(new Event('change', { bubbles: true }))
          return select.value
        }`,
      )
      if (selected !== null) return { clicked: uid, via: 'select', value: selected }
    }
    const box = await page.elementBox(uid)
    x = box.centerX
    y = box.centerY
  }
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('click needs an element uid or a point')
  await actionSettle(page, async () => {
    await mouse(page, 'mouseMoved', x, y, { buttons: 0 })
    if (dblClick) {
      await mouse(page, 'mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
      await mouse(page, 'mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 })
      await mouse(page, 'mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 2 })
      await mouse(page, 'mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 2 })
    } else {
      await mouse(page, 'mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
      await mouse(page, 'mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 })
    }
  })
  return { clicked: uid ?? { x, y }, via: 'mouse', ...(page.dialog !== undefined ? { dialog: page.dialog } : {}) }
}

/**
 * Put a value into a field.
 *
 * The setter is taken from the prototype rather than assigned, and the two events are fired by hand:
 * that is the difference between a field that *looks* filled and a framework that knows it was.
 */
export async function fill(page, { uid, value }) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error('fill needs a string, number or boolean value')
  }
  const text = String(value)
  const { objectId } = await resolveObject(page, uid)
  await page.send('DOM.focus', { backendNodeId: page.uidToNode.get(uid).backendNodeId }).catch(() => {})
  const result = await callOn(
    page,
    objectId,
    `function (value) {
      /** A uid may name a text node inside a contenteditable; its element is the one to fill. */
      const element = this instanceof Element ? this : this?.parentElement
      if (!(element instanceof Element)) throw new Error('the uid does not name an element')
      const tag = element.tagName
      if (tag === 'INPUT' && element.type === 'file') throw new Error('a file input is filled with upload_file')
      if (tag === 'INPUT' && (element.type === 'checkbox' || element.type === 'radio')) {
        const wanted = value === 'true' || value === 'checked' || value === element.value
        if (element.checked !== wanted) element.click()
        return { kind: 'check', checked: element.checked, value: element.value }
      }
      if (tag === 'SELECT') {
        element.focus()
        const wanted = value.trim()
        const option = Array.from(element.options).find((candidate) =>
          candidate.value === wanted || candidate.label.trim() === wanted || candidate.text.trim() === wanted)
        if (option === undefined) throw new Error('the select has no option named ' + JSON.stringify(value))
        element.value = option.value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
        return { kind: 'select', value: element.value, label: option.text }
      }
      if (element.isContentEditable) {
        element.focus()
        const selection = window.getSelection()
        selection.removeAllRanges()
        const range = document.createRange()
        range.selectNodeContents(element)
        selection.addRange(range)
        document.execCommand('insertText', false, value)
        return { kind: 'contenteditable', value: element.innerText }
      }
      const prototype = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
      if (descriptor === undefined || descriptor.set === undefined) {
        throw new Error('this element has no settable value')
      }
      element.focus()
      descriptor.set.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { kind: 'value', value: element.value }
    }`,
    [text],
  )
  return { filled: uid, ...(result ?? {}) }
}

/** Fill several fields in one call. */
export async function fillForm(page, { elements = [] }) {
  if (!Array.isArray(elements) || elements.length === 0) throw new Error('fill_form needs a non-empty list of elements')
  const results = []
  for (const element of elements) {
    if (element?.uid === undefined) throw new Error('every fill_form element needs a uid')
    results.push(await fill(page, { uid: String(element.uid), value: element.value }))
  }
  return { filled: results.length, results }
}

/** Move the mouse over an element. */
export async function hover(page, { uid }) {
  const box = await page.elementBox(uid)
  await actionSettle(page, () => mouse(page, 'mouseMoved', box.centerX, box.centerY, { buttons: 0 }))
  return { hovered: uid }
}

/** Drag one element onto another with the mouse, in a few steps so the target sees a drag. */
export async function drag(page, { fromUid, toUid }) {
  const from = await page.elementBox(fromUid)
  const to = await page.elementBox(toUid)
  await actionSettle(page, async () => {
    await mouse(page, 'mouseMoved', from.centerX, from.centerY, { buttons: 0 })
    await mouse(page, 'mousePressed', from.centerX, from.centerY, { button: 'left', buttons: 1, clickCount: 1 })
    const steps = 8
    for (let step = 1; step <= steps; step += 1) {
      const x = from.centerX + ((to.centerX - from.centerX) * step) / steps
      const y = from.centerY + ((to.centerY - from.centerY) * step) / steps
      await mouse(page, 'mouseMoved', x, y, { button: 'left', buttons: 1 })
      await sleep(20)
    }
    await mouse(page, 'mouseReleased', to.centerX, to.centerY, { button: 'left', buttons: 0, clickCount: 1 })
  })
  return { dragged: fromUid, to: toUid }
}

/**
 * The protocol's key codes for the keys that are not a character.
 *
 * A row's `key`, when present, is the DOM `KeyboardEvent.key` value and overrides the name. Only the
 * space bar needs one: its name is `Space` but its `key` is a literal space, and Chrome activates a
 * focused native button only for that value. Sent as `key: 'Space'`, the page saw a keydown that no
 * button answered (developer-five, 2026-10-31).
 */
const KEY_CODES = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Escape: { code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Insert: { code: 'Insert', keyCode: 45 },
}

/** The punctuation a keyboard can produce, with its physical code. */
const PUNCTUATION_CODES = {
  ' ': { code: 'Space', keyCode: 32 },
  '-': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ';': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 },
  ',': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 },
}

/** The modifier bits the protocol uses. */
const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

/** Split `Control+Shift+A` into its modifiers and its key. */
export function parseKey(combination) {
  if (typeof combination !== 'string' || combination.length === 0) throw new Error('press_key needs a key name')
  const parts = combination.split('+')
  const key = parts.pop()
  let modifiers = 0
  for (const part of parts) {
    const bit = MODIFIERS[part]
    if (bit === undefined) throw new Error(`unknown modifier '${part}' in '${combination}'`)
    modifiers |= bit
  }
  return { key, modifiers }
}

/** The protocol parameters for one key, without the modifiers. */
export function keyDescription(key) {
  const named = KEY_CODES[key]
  if (named !== undefined) return { key, ...named }
  const functionKey = /^F([1-9]|1[0-2])$/.exec(key)
  if (functionKey !== null) return { key, code: key, keyCode: 111 + Number(functionKey[1]) }
  if (/^[a-zA-Z]$/.test(key)) {
    return { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key }
  }
  if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key }
  const punctuation = PUNCTUATION_CODES[key]
  if (punctuation !== undefined) return { key, code: punctuation.code, keyCode: punctuation.keyCode, text: key }
  throw new Error(`press_key does not know the key '${key}'`)
}

/** Press one key, or a chord such as `Control+A`. */
export async function pressKey(page, { key }) {
  const { key: name, modifiers } = parseKey(key)
  const description = keyDescription(name)
  /** A chord is a command, not text: `Control+A` must not insert the letter `a`. */
  const text = (modifiers & (MODIFIERS.Control | MODIFIERS.Meta | MODIFIERS.Alt)) !== 0 ? undefined : description.text
  const common = {
    key: description.key ?? name,
    code: description.code,
    windowsVirtualKeyCode: description.keyCode,
    nativeVirtualKeyCode: description.keyCode,
    modifiers,
  }
  await actionSettle(page, async () => {
    await page.send('Input.dispatchKeyEvent', {
      type: text !== undefined ? 'keyDown' : 'rawKeyDown',
      ...common,
      ...(text !== undefined ? { text, unmodifiedText: text } : {}),
    })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  })
  return { pressed: key }
}

/** Type text into whatever is focused. */
export async function typeText(page, { text, submitKey }) {
  if (typeof text !== 'string') throw new Error('type_text needs text')
  await page.send('Input.insertText', { text })
  if (submitKey !== undefined) await pressKey(page, { key: submitKey })
  return { typed: text.length, ...(submitKey !== undefined ? { submitted: submitKey } : {}) }
}

/** Give a file input files by path. */
export async function uploadFile(page, { uid, filePaths }) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) throw new Error('upload_file needs at least one file path')
  const node = page.uidToNode.get(uid)
  if (node === undefined) throw new Error(`the snapshot has no element with uid ${uid}; take a new snapshot`)
  if (node.backendNodeId === undefined) throw new Error(`the element with uid ${uid} is not a DOM node`)
  const { objectId } = await resolveObject(page, uid)
  const kind = await callOn(page, objectId, `function () { return { tag: this.tagName, type: this.type } }`)
  if (kind?.tag !== 'INPUT' || kind?.type !== 'file') {
    throw new Error(`the element with uid ${uid} is not a file input`)
  }
  await page.send('DOM.setFileInputFiles', { files: filePaths, backendNodeId: node.backendNodeId })
  const names = await callOn(page, objectId, 'function () { return Array.from(this.files ?? []).map((file) => file.name) }')
  return { uploaded: names ?? [], uid }
}

/** Answer the dialog the page is showing. */
export async function handleDialog(page, { action, promptText }) {
  if (page.dialog === undefined) throw new Error('no dialog is open on this page')
  const accept = action !== 'dismiss'
  /** Read before answering: accepting fires `javascriptDialogClosed`, which clears the record. */
  const dialog = page.dialog
  await page.send('Page.handleJavaScriptDialog', {
    accept,
    ...(promptText !== undefined ? { promptText } : {}),
  })
  page.dialog = undefined
  return { handled: accept ? 'accepted' : 'dismissed', dialog: { type: dialog.type, message: dialog.message } }
}

/**
 * Evaluate a function in the page, with snapshot uids passed through as elements.
 *
 * The function is declared by the caller as source; uid arguments are resolved to the elements' own
 * handles, so the function receives DOM nodes rather than a selector to look up — which is what makes
 * it the same element the snapshot named.
 */
export async function evaluateScript(page, { function: functionSource, script, args = [], filePath, dialogAction }) {
  const removeDialog = dialogAction === undefined ? undefined : installDialogAnswer(page, dialogAction)
  try {
    const contextId = await page.waitForContext(15_000)
    let value
    if (typeof functionSource === 'string' && functionSource.length > 0) {
      const objectIds = []
      for (const arg of args) {
        if (typeof arg === 'string') {
          const { objectId } = await resolveObject(page, arg)
          objectIds.push(objectId)
        }
      }
      const reply = await page.send(
        'Runtime.callFunctionOn',
        {
          functionDeclaration: `async (...__heddleArgs) => { const __heddleFunction = (${functionSource}); return await __heddleFunction(...__heddleArgs) }`,
          executionContextId: contextId,
          arguments: objectIds.map((objectId) => ({ objectId })),
          returnByValue: true,
          awaitPromise: true,
        },
        { timeoutMs: 60_000 },
      )
      const details = reply.result?.exceptionDetails
      if (details !== undefined) throw new Error(details.exception?.description ?? details.text ?? 'the function threw')
      value = reply.result?.result?.value
    } else if (typeof script === 'string') {
      value = await page.evaluate(script, { timeoutMs: 60_000 })
    } else {
      throw new Error('evaluate_script needs a function or a script')
    }
    if (filePath !== undefined) {
      writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
      return { filePath, value }
    }
    return { value }
  } finally {
    removeDialog?.()
  }
}

/**
 * Answer any dialog that opens while a script runs.
 *
 * `evaluate` on a statement that opens an `alert` waits for the dialog; answering it from the protocol
 * side is what lets the call finish. This is the `dialogAction` parameter's whole purpose.
 */
function installDialogAnswer(page, dialogAction) {
  return page.connection.on('Page.javascriptDialogOpening', (params, message) => {
    if (message.sessionId !== page.sessionId) return
    void page.send('Page.handleJavaScriptDialog', {
      accept: dialogAction !== 'dismiss',
      ...(typeof dialogAction === 'string' && dialogAction !== 'accept' && dialogAction !== 'dismiss' ? { promptText: dialogAction } : {}),
    }).catch(() => {})
    page.dialog = undefined
  })
}

/** Wait for the page's text to include one of several strings. */
export async function waitFor(page, { text, timeoutMs = 15_000 }) {
  const needles = Array.isArray(text) ? text.filter((entry) => typeof entry === 'string' && entry.length > 0) : []
  if (needles.length === 0) throw new Error('wait_for needs a non-empty list of texts')
  return { found: await page.waitForText(needles, timeoutMs) }
}
