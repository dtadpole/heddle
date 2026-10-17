import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { repoRoot } from '../_tools_/check-helpers/lib.mjs'

/**
 * Contract tests for the page's own wiring.
 *
 * The page is one HTML file whose script runs only in a browser, so its **behaviour** is judged where it runs: the
 * browser checks in `_verifiers_/87-resizable-panels/` for the sidebar and
 * `_verifiers_/85-trajectory-view/` for the view ring. What is left for a unit test is the part a rewrite silently
 * drops — the attributes and the storage key that make the behaviour possible at all. A toggle that loses its
 * `aria-controls`, or a rail whose width drifts, still "works" on screen and stops being the control it claims to be.
 *
 * These tests are therefore **removal detectors**, and they say so rather than pretending to exercise the code.
 */

const page = readFileSync(join(repoRoot, 'src', 'server', 'page.html'), 'utf8')

test('the sidebar toggle names the panel it controls and states both of its names', () => {
  /**
   * Measured from DSH on 2026-10-17: its control is at the top of the panel, its label is `Collapse sidebar` /
   * `Open sidebar`, and its chord is `Alt+Meta+B`. A toggle whose name does not change with its state tells a reader
   * to do something that is already done, which is why both names are asserted here.
   */
  assert.match(page, /id="sidebar-toggle"/, 'the control exists')
  assert.match(page, /aria-controls="workspace-sidebar"/, 'and names the panel it collapses')
  assert.match(page, /aria-label="Collapse sidebar"/, 'with the expanded name')
  assert.match(page, /aria-expanded="true"/, 'and the expanded state')
  assert.match(page, /<aside id="workspace-sidebar">/, 'the panel it names exists')
  assert.match(page, /'Open sidebar' : 'Collapse sidebar'/, 'and the script swaps the name when the state changes')
})

test("the rail has one width, and it is DSH's 56 pixels", () => {
  /**
   * The width is a fact about the gesture, not a preference: DSH's sidebar measured 280 expanded and 56 collapsed, and
   * a rail that drifts is a panel that is neither. Asserted with the `px` unit so a change to `rem` has to be a
   * decision rather than a typo.
   */
  assert.match(page, /body\[data-sidebar='collapsed'\] #workspace-sidebar \{ width: 56px;/, 'the rail is 56 pixels')
  assert.match(page, /body\[data-sidebar='collapsed'\] #gutter-left \{ display: none; \}/, 'and the divider goes with it')
  assert.match(page, /body\[data-sidebar='collapsed'\] #tree,/, 'while the tree is put away')
  assert.match(page, /body\[data-sidebar='collapsed'\] #sidebar-search \{ display: inline-flex; \}/, 'and the rail keeps a search control')
})

test('the rail\'s top control is the Heddle icon, and the wide panel\'s panel glyph is not', () => {
  /**
   * The owner asked for the app's own icon while the panel is collapsed, and DSH is the reason it belongs there: its
   * rail's first control measures 36×36 at (10, 18), is named `Open sidebar`, and contains the **brand mark**, not a
   * generic panel glyph. A rail whose top control says nothing about which app it is loses the one identifier the rail
   * has left.
   *
   * The control therefore carries two glyphs and shows one at a time: the panel-with-a-divider while it says "collapse",
   * the Heddle mark while it says "open".
   */
  assert.match(page, /<img id="sidebar-toggle-mark" src="\/favicon\.svg"/, 'the toggle carries the app icon')
  assert.match(page, /<svg id="sidebar-toggle-glyph"/, 'and the panel glyph it shows while expanded')
  assert.match(page, /#sidebar-toggle-mark \{ display: none; width: 24px; height: 24px; \}/, 'the icon is hidden while the panel is wide')
  assert.match(page, /body\[data-sidebar='collapsed'\] #sidebar-toggle-mark \{ display: block; width: 24px; height: 24px; \}/, 'and shown at 24 pixels when the panel is a rail')
  assert.match(page, /body\[data-sidebar='collapsed'\] #sidebar-toggle-glyph \{ display: none; \}/, 'with the panel glyph put away')
})

test('the collapsed state is remembered under one key, and restored before the first paint of the tree', () => {
  /** A panel a reader put away that comes back by itself is the kind of forgetfulness a reader stops trusting. */
  assert.match(page, /const SIDEBAR_COLLAPSED_KEY = 'heddle\.layout\.collapsed\.v1'/, 'the key is stable and versioned')
  assert.match(page, /localStorage\.setItem\(SIDEBAR_COLLAPSED_KEY/, 'the state is written')
  assert.match(page, /localStorage\.getItem\(SIDEBAR_COLLAPSED_KEY\)/, 'and read back on load')
  assert.match(page, /setSidebarCollapsed\(localStorage\.getItem\(SIDEBAR_COLLAPSED_KEY\) === 'true', \{ persist: false \}\)/, 'without writing on the read')
})

test("the collapse chord is DSH's Alt+Meta+B, and the search chord opens the panel first", () => {
  /**
   * The chord is read from a table rather than inferred from control flow, which is what makes it assertable here.
   * The search field is put away while the sidebar is a rail, so its chord has to open the panel before focusing —
   * otherwise `Alt+Meta+K` focuses something a reader cannot see and appears to do nothing.
   */
  assert.match(page, /\{ key: 'b', alt: true, action: 'sidebar' \}/, 'the chord is in the table')
  assert.match(page, /if \(action === 'sidebar'\) \{/, 'and the handler acts on it')
  assert.match(page, /if \(sidebarCollapsed\(\)\) setSidebarCollapsed\(false\)/, 'search opens the panel first')
})

test('the right panel is a tablist, with a tab and a panel for each view', () => {
  /**
   * DSH's ring is `role=tab` with `aria-selected`; this page said `aria-current`, which means "the current one" and not
   * "one of a set of alternatives". The count is asserted because a tablist with a tab whose panel is missing is worse
   * than no tablist: a reader is offered a control that leads nowhere.
   */
  assert.match(page, /<nav id="views" role="tablist"/, 'the ring is a tablist')
  const tabs = page.match(/role="tab"/g) ?? []
  const panels = page.match(/role="tabpanel"/g) ?? []
  assert.ok(tabs.length >= 2, `at least two tabs (${tabs.length})`)
  assert.ok(panels.length >= 2, `and a panel for each (${panels.length})`)
  assert.match(page, /role="tab" id="tab-chat"[^>]*aria-selected="true"[^>]*aria-controls="log"/, 'the chat tab names its panel')
  assert.match(page, /role="tab" id="tab-trajectory"[^>]*aria-controls="ledger"/, 'and the trajectory tab names its own')
  assert.match(page, /id="log"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-chat"/, 'the panel names its tab back')
  assert.match(page, /id="ledger"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-trajectory"/, 'both ways, as the pattern asks')
})

test('crossing the tablist is an arrow-key gesture, and only inside the ring', () => {
  /**
   * `role=tab` promises that the arrow keys move between the tabs; a handler bound to the document instead would move
   * the view whenever a reader pressed an arrow anywhere, which fights someone scrolling a conversation.
   */
  assert.match(page, /getElementById\('views'\)\.addEventListener\('keydown'/, 'the handler is on the ring')
  assert.match(page, /keyEvent\.key === 'ArrowRight'/, 'right crosses')
  assert.match(page, /keyEvent\.key === 'ArrowLeft'/, 'and left crosses back')
  assert.match(page, /button\.tabIndex = button\.dataset\.view === view \? 0 : -1/, 'with one tab in the Tab order')
})
