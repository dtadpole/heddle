import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/** Executes the shipped page functions and its actual access key listener, not a copied focus algorithm. */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
function functionSource(name: string) {
  const start = page.indexOf(`function ${name}(`)
  if (start < 0) return ''
  const body = page.indexOf('{', start)
  let depth = 1, end = body + 1
  while (depth > 0) {
    if (page[end] === '{') depth++
    if (page[end] === '}') depth--
    end++
  }
  return page.slice(start, end)
}
function fixture() {
  const document = { activeElement: null as Control | null, addEventListener: (_type: string, fn: (event: Record<string, unknown>) => void) => { keydown = fn } }
  let keydown: (event: Record<string, unknown>) => void = () => {}
  class Control {
    disabled = false
    hidden = false
    inert = false
    tabIndex = 0
    checked = false
    visibility = 'visible'
    rects = 1
    focus() { document.activeElement = this }
    matches(selector: string) { return selector === ':disabled' && this.disabled }
    closest(_selector: string) { return this.hidden || this.inert ? this : null }
    getClientRects() { return Array(this.rects).fill({}) }
  }
  const close = new Control(), risk = new Control(), cancel = new Control(), enable = new Control(), chip = new Control()
  const controls = [close, risk, cancel, enable]
  const dialog = Object.assign(new Control(), { hidden: true, querySelectorAll: (_selector: string) => controls })
  const menu = { hidden: true }
  const source = page.slice(page.indexOf("document.addEventListener('keydown', (keyEvent) => {", page.indexOf('accessEnable.addEventListener')), page.indexOf("window.addEventListener('resize'", page.indexOf('accessEnable.addEventListener')))
  const context = {
    document, accessDialog: dialog, accessRisk: risk, accessEnable: enable, accessButton: chip, accessMenu: menu,
    getComputedStyle: (control: Control) => ({ visibility: control.visibility }),
    closeAccessMenu: () => { menu.hidden = true },
  }
  runInNewContext(`${functionSource('openAccessGate')}\n${functionSource('closeAccessGate')}\n${functionSource('handleAccessGateTab')}\n${source}\nthis.open = openAccessGate; this.close = closeAccessGate`, context)
  const api = context as typeof context & { open(): void, close(): void }
  function key(key = 'Tab', options: Record<string, unknown> = {}) {
    let prevented = false
    keydown({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 0, defaultPrevented: false, preventDefault: () => { prevented = true }, ...options })
    return prevented
  }
  return { ...api, controls, closeControl: close, risk, cancel, enable, chip, dialog, key }
}

test('actual risk gate cycles Tab and Shift+Tab without reaching the background', () => {
  const f = fixture()
  f.open()
  assert.equal(f.document.activeElement, f.risk, 'existing initial checkbox focus')
  assert.equal(f.enable.disabled, true)
  assert.equal(f.key(), true)
  assert.equal(f.document.activeElement, f.cancel)
  f.key()
  assert.equal(f.document.activeElement, f.closeControl, 'disabled Enable is skipped at the boundary')
  f.key('Tab', { shiftKey: true })
  assert.equal(f.document.activeElement, f.cancel)
  f.enable.disabled = false
  f.key()
  assert.equal(f.document.activeElement, f.enable, 'newly enabled controls join the cycle')
  f.key()
  assert.equal(f.document.activeElement, f.closeControl)
})

test('actual gate excludes hidden, inert, invisible, disabled and negative-tabindex controls', () => {
  const f = fixture()
  f.open()
  f.closeControl.hidden = true
  f.cancel.inert = true
  f.enable.disabled = false
  f.enable.visibility = 'hidden'
  f.key()
  assert.equal(f.document.activeElement, f.risk, 'single candidate cycles to itself')
  f.enable.visibility = 'visible'
  f.enable.tabIndex = -1
  f.key()
  assert.equal(f.document.activeElement, f.risk)
  f.risk.rects = 0
  assert.equal(f.key(), true)
  assert.equal(f.document.activeElement, f.dialog, 'empty cycle stays inside the dialog')
})

test('actual gate recovers outside focus only for plain Tab and leaves native keys and modifiers alone', () => {
  const f = fixture()
  assert.equal(f.key(), false, 'closed dialog does not trap')
  f.open()
  f.chip.focus()
  for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    assert.equal(f.key('Tab', options), false)
    assert.equal(f.document.activeElement, f.chip)
  }
  for (const key of ['Enter', ' ', 'ArrowDown']) assert.equal(f.key(key), false, 'native activation is untouched')
  f.key('Tab', { shiftKey: true })
  assert.equal(f.document.activeElement, f.cancel, 'outside reverse Tab returns to last candidate')
  f.chip.focus()
  f.key()
  assert.equal(f.document.activeElement, f.closeControl, 'outside forward Tab returns to first candidate')
})

test('actual Escape cancellation and close return focus and reopening clears acknowledgement', () => {
  const f = fixture()
  f.open()
  f.risk.checked = true
  f.enable.disabled = false
  assert.equal(f.key('Escape'), false, 'existing Escape listener semantics unchanged')
  assert.equal(f.dialog.hidden, true)
  assert.equal(f.document.activeElement, f.chip)
  f.open()
  assert.equal(f.risk.checked, false)
  assert.equal(f.enable.disabled, true)
  f.close()
  assert.equal(f.document.activeElement, f.chip)
})

test('the focus helper is wired only into the existing access listener, with a focusable empty-cycle fallback', () => {
  assert.equal(page.split('handleAccessGateTab(keyEvent)').length - 1, 2, 'definition and one access-listener call only')
  assert.match(page, /id="access-dialog"[^>]*tabindex="-1"/)
})
