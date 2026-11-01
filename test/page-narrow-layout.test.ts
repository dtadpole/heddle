import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

/**
 * Below 1024 pixels the page collapses its sidebar to the rail, as DSH's does (`dsh-client-ui-layout`,
 * `SIDEBAR_AUTO_COLLAPSE = 1024`); live-testing draft developer-ten-9 found a 390-pixel window with the panel at most of
 * the width and the composer off the screen. The rule's own code is run here, cut from the page, against a stand-in
 * window: DSH's two facts (the wide preference, the narrow opening), the breakpoint, and the reset on crossing it.
 */

const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')

function load(innerWidth: number) {
  const start = page.indexOf('const SIDEBAR_AUTO_COLLAPSE_PX = 1024')
  const end = page.indexOf("sidebarToggle.addEventListener('click'", start)
  assert.ok(start > 0 && end > start, 'the page has the breakpoint block before the toggle wiring')
  const painted: boolean[] = []
  const listeners: Record<string, () => void> = {}
  const window = {
    innerWidth,
    addEventListener: (type: string, listener: () => void) => {
      listeners[type] = listener
    },
  }
  const context = vm.createContext({ window, setSidebarCollapsed: (collapsed: boolean) => painted.push(collapsed) })
  vm.runInContext(page.slice(start, end), context)
  const api = vm.runInContext(
    `({ collapsedFor: sidebarCollapsedFor, toggle: toggleSidebarCollapse, open: openSidebar, paint: paintSidebarCollapse,
        facts: () => JSON.stringify({ wide: sidebarWideCollapsed, narrow: sidebarNarrowExpanded }) })`,
    context,
  ) as {
    collapsedFor: (width: number, wide: boolean, narrow: boolean) => boolean
    toggle: () => void
    open: () => void
    paint: () => void
    facts: () => string
  }
  return {
    ...api,
    painted,
    last: () => painted.at(-1),
    resize: (width: number) => {
      window.innerWidth = width
      listeners.resize?.()
    },
  }
}

test('narrow means the rail unless opened; wide means the preference, as DSH computes sidebarCollapsed', () => {
  const { collapsedFor } = load(1280)
  assert.equal(collapsedFor(390, false, false), true, 'a phone-width window gets the rail')
  assert.equal(collapsedFor(1023, false, false), true, 'just below the breakpoint too')
  assert.equal(collapsedFor(1023, false, true), false, 'opened while narrow, it shows the panel')
  assert.equal(collapsedFor(1024, false, false), false, 'at the breakpoint the wide default is the open panel')
  assert.equal(collapsedFor(1280, true, true), true, 'wide, only the wide preference counts')
})

test('a visit starts on the rail in a narrow window and wide in a wide one', () => {
  const narrow = load(390)
  narrow.paint()
  assert.equal(narrow.last(), true)
  const wide = load(1280)
  wide.paint()
  assert.equal(wide.last(), false)
})

test('the toggle opens and closes the panel while narrow without touching the wide preference', () => {
  const view = load(390)
  view.toggle()
  assert.equal(view.last(), false, 'opened over the squeezed conversation')
  view.toggle()
  assert.equal(view.last(), true, 'back to the rail')
  assert.equal(view.facts(), JSON.stringify({ wide: false, narrow: false }))
  view.open()
  assert.equal(view.last(), false, 'the search gesture opens it')
})

test('crossing the breakpoint forgets the narrow opening, and the wide preference survives a trip to narrow', () => {
  const view = load(1280)
  view.toggle()
  assert.equal(view.last(), true, 'collapsed by preference while wide')
  view.resize(600)
  assert.equal(view.last(), true, 'narrow: the rail')
  view.toggle()
  assert.equal(view.last(), false, 'opened while narrow')
  view.resize(700)
  assert.equal(view.last(), false, 'a resize that stays narrow keeps it open')
  view.resize(1280)
  assert.equal(view.last(), true, 'wide again: the wide preference, still collapsed')
  view.resize(500)
  assert.equal(view.last(), true, 'narrow again: the opening was forgotten')
})
