import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

/**
 * The left sidebar keeps DSH's width contract: 264 to 420 pixels, 280 by default (`dsh-client-ui-layout`,
 * `computeColumns`: `clampWidth(sidebar, 264, 420)`, and `sidebar: 280` for a first visit and for a reopened panel).
 * Phase A measured heddle at 192 to 768 pixels with a 352-pixel default (S48, R-developer-seven-13). The page keeps
 * its bounds in rem, so at the 16-pixel root they are DSH's pixels and a reader with larger text gets a proportionally
 * wider panel. The width block's own code is run here, cut from the page, against a stand-in window.
 */

const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')

function load(innerWidth: number, stored: string | null = null) {
  const start = page.indexOf("const SIDEBAR_KEY = 'heddle.layout.sidebar.v1'")
  const end = page.indexOf("const gutterLeft = document.getElementById('gutter-left')", start)
  assert.ok(start > 0 && end > start, 'the page has the width block before the divider wiring')
  const property: Record<string, string> = {}
  const attributes: Record<string, string> = {}
  const storage: Record<string, string> = stored === null ? {} : { 'heddle.layout.sidebar.v1': stored }
  const context = vm.createContext({
    window: { innerWidth },
    document: { documentElement: { style: { setProperty: (name: string, value: string) => { property[name] = value } } } },
    getComputedStyle: () => ({ fontSize: '16px' }),
    localStorage: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => { storage[key] = value },
    },
  })
  vm.runInContext(page.slice(start, end), context)
  context.gutterLeft = { setAttribute: (name: string, value: string) => { attributes[name] = value } }
  const api = vm.runInContext(
    `({ clamp: clampSidebar, set: setSidebarWidth, stored: storedSidebarWidth,
        min: SIDEBAR_MIN_REM, max: SIDEBAR_MAX_REM, fallback: DEFAULT_SIDEBAR_REM })`,
    context,
  ) as {
    clamp: (rem: number) => number
    set: (rem: number, options?: { persist?: boolean }) => number
    stored: () => number | null
    min: number
    max: number
    fallback: number
  }
  return { ...api, property, attributes, storage }
}

test('the bounds and the default are DSH\'s pixels at the 16-pixel root', () => {
  const view = load(1400)
  assert.equal(view.min * 16, 264, 'DSH\'s minimum')
  assert.equal(view.max * 16, 420, 'DSH\'s maximum')
  assert.equal(view.fallback * 16, 280, 'DSH\'s default')
})

test('a drag or a stored width is clamped into 264 to 420 pixels', () => {
  const view = load(1400)
  assert.equal(view.clamp(0) * 16, 264, 'dragged away, the panel stops at 264')
  assert.equal(view.clamp(100) * 16, 420, 'dragged across the window, it stops at 420')
  assert.equal(view.clamp(20) * 16, 320, 'in between, the width is the one asked for')
  assert.equal(view.set(30), 26.25, 'a width past the maximum is drawn at it')
  assert.equal(view.property['--sidebar-width'], '26.25rem')
  assert.equal(view.storage['heddle.layout.sidebar.v1'], '26.25', 'and remembered as drawn')
  assert.equal(view.attributes['aria-valuenow'], '26')
})

test('a width remembered under the old bounds comes back inside the new ones without being rewritten', () => {
  const view = load(1400, '30')
  const remembered = view.stored()
  assert.equal(remembered, 30)
  assert.equal(view.set(remembered as number, { persist: false }), 26.25)
  assert.equal(view.storage['heddle.layout.sidebar.v1'], '30', 'a load does not rewrite the stored choice')
})

test('a narrow window still caps the panel at four fifths of it, never below the minimum', () => {
  assert.equal(load(400).clamp(100), 20, '400 pixels leave a 320-pixel panel at most')
  assert.equal(load(300).clamp(100), 16.5, 'a window too narrow for the minimum keeps the minimum')
})

test('the stylesheet\'s first paint and the divider\'s markup agree with the script', () => {
  const view = load(1400)
  assert.match(page, new RegExp(`--sidebar-width: ${view.fallback}rem;`), 'the first paint uses the default')
  const divider = /<div id="gutter-left"[^>]*>/.exec(page)?.[0] ?? ''
  assert.match(divider, new RegExp(`aria-valuemin="${view.min}"`), divider)
  assert.match(divider, new RegExp(`aria-valuemax="${view.max}"`), divider)
  assert.match(divider, new RegExp(`aria-valuenow="${Math.round(view.fallback)}"`), divider)
  assert.doesNotMatch(page, /getPropertyValue\('--sidebar-width'\)\) \|\| 22\b/, 'no fallback to the old default')
})
