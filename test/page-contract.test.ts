import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { repoRoot } from '../_tools_/verify-runner/lib.mjs'

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

test('the collapsed state is not remembered, so a reload cannot hide the tree', () => {
  /**
   * The owner's report decided this: the state *was* remembered, and a reader who collapsed the panel once came back
   * to a rail with no tree and nothing on screen to say the tree had been put away rather than lost. DSH does not
   * remember it either, and the measurement is in SESSION_UI.md. The width is the preference; the collapse is a look.
   */
  assert.doesNotMatch(page, /heddle\.layout\.collapsed/, 'no storage key for the collapsed state')
  assert.doesNotMatch(page, /setItem\(SIDEBAR_COLLAPSED_KEY/, 'and nothing written when it changes')
  assert.match(page, /\/\*\* Every visit starts wide[\s\S]*?setSidebarCollapsed\(false\)/, 'a load puts the panel back')
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

test('a first visit opens a workspace, so the tree arrives with its sessions on screen', () => {
  /**
   * DSH's tree arrives with a workspace's sessions showing, not with a list of closed folder names — measured on its
   * sidebar on 2026-10-17. Heddle arrived closed for a reader with no history, and the owner read that as the tree no
   * longer showing. The default is written down like any other expansion, so closing it is remembered as a choice.
   */
  assert.match(page, /const firstVisit = \(\(\) => \{/, 'the page asks whether this is a first visit')
  assert.match(page, /localStorage\.getItem\(EXPANDED_KEY\) === null/, 'by there being no remembered expansion')
  assert.match(page, /const firstBranch = tops\.find\(\(node\) => Array\.isArray\(node\.children\) && node\.children\.length > 0\)/, 'and it opens the first branch that has something in it')
  assert.match(page, /if \(firstBranch !== undefined\) \{\s*expanded\.add\(firstBranch\.path\)\s*rememberExpanded\(\)/, 'writing the choice like any other')
})

test('the panel has DSH\'s primary action, and it starts a session where the reader is', () => {
  /**
   * Measured from DSH's sidebar on 2026-10-17: a full-width `New session` control between the brand row and the
   * workspace list, 252x38 inside its 280-pixel panel, 12-pixel radius, a 1-pixel 16%-white border, 14-pixel text at
   * weight 500, and the chord `Alt+Meta+N`. Its collapsed rail carries the same action as its **second icon**, on the
   * 48-pixel pitch that begins with the control which opens the panel.
   */
  assert.match(page, /<button id="new-session" type="button" title="New session \(⌥⌘N\)">/, 'the control exists, named with its chord')
  assert.match(page, /<span id="new-session-label">New session<\/span>/, 'and says what it does')
  assert.match(page, /#new-session \{[\s\S]*?border-radius: var\(--radius-md\);/, 'rounded by the panel\'s own rule')
  assert.match(page, /#new-session \{[\s\S]*?font-size: \.875rem;[\s\S]*?font-weight: 500;/, 'at DSH\'s 14-pixel medium')
  assert.match(page, /body\[data-sidebar='collapsed'\] #new-session \{[\s\S]*?width: 36px;[\s\S]*?height: 36px;/, 'and it becomes a 36-pixel icon in the rail')
  assert.match(page, /let treeTops = \[\]/, 'the tree keeps the workspace rows the action needs')
  assert.match(page, /function newSessionWorkspace\(/, 'the target is chosen in one place')
  assert.match(page, /if \(selectedPath !== null\) \{[\s\S]*?const bySelection = owner\(selectedPath\)/, 'from the selected row\'s workspace first')
  assert.match(page, /await startSessionAt\(workspace\)/, 'and the act is the same path a workspace row uses')
  assert.match(page, /\{ key: 'n', alt: true, action: 'new-session' \}/, 'with DSH\'s chord in the table')
  assert.match(page, /if \(action === 'new-session'\) \{/, 'and a handler that acts on it')
})

test('a panel with nothing open shows an invitation, and gives way when something opens', () => {
  /**
   * DSH's home centres a mark, a heading and the composer; Heddle showed an empty column under a header that said
   * "No session". The invitation is painted from the panel's own state — the chat view with no session in it — rather
   * than from a flag someone has to remember, and the conversation's column is put away beneath it.
   */
  assert.match(page, /<section id="empty-state" hidden>/, 'the invitation exists and starts hidden')
  assert.match(page, /<h3>Start a conversation<\/h3>/, 'with a heading that says what to do')
  assert.match(page, /<kbd>⌥⌘N<\/kbd>/, 'and the chord that does it')
  assert.match(page, /function paintEmptyState\(\)/, 'one painter decides when it is shown')
  assert.match(page, /const nothingOpen = view === 'chat' && current === null/, 'from the panel\'s own state')
  assert.ok(page.includes('paintEmptyState()\n}'), 'the view switch ends by painting it')
  assert.ok(page.includes('current = id\n  paintEmptyState()'), 'opening a session paints it')
  assert.ok(page.includes("document.body.dataset.ready = 'true'\n</script>"), 'and boot ends by announcing that it finished')
  assert.match(page, /paintEmptyState\(\)\n\/\*\*[\s\S]*?document\.body\.dataset\.ready/, 'which happens after the invitation is painted')
  /** A session that no longer exists must not keep the invitation hidden. */
  assert.ok(page.includes('current = null\n      const title'), 'a vanished session releases the pointer')
})

test('the navigation panel is a fixed column, and only its workspaces region scrolls', () => {
  /**
   * Measured from DSH on 2026-10-17: its sidebar column is `overflow: hidden` (813/813) with exactly one inner
   * scroller — the workspace list — while the brand, the primary action, the workspaces header and the search stay
   * above it. Heddle scrolled the whole pane (1233/813), which is the owner's report. The browser check in part 11
   * judges the behaviour; these contracts catch a rewrite that drops the structure the behaviour needs.
   */
  assert.match(page, /<div id="workspace-scroll">/, 'the variable-length region has its own wrapper')
  assert.match(page, /<div id="workspace-scroll">\s*<ul id="tree"/, 'the tree lives inside it')
  assert.match(page, /aside \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/, 'the panel is a fixed column that cannot scroll')
  assert.match(page, /#workspace-scroll \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto;/, 'the region carries the scroll')
  assert.match(page, /aside > header,\s*aside > button,\s*aside > h1,\s*aside > input,\s*aside > p \{ flex: none; \}/, 'and the chrome above it keeps its height')
  assert.match(page, /body\[data-sidebar='collapsed'\] #workspace-scroll \{ display: none; \}/, 'a rail has no region to scroll')
})

test("the page's module parses, because one syntax error leaves the whole UI without behaviour", () => {
  /**
   * Measured on 2026-10-17: a concurrent edit split a function signature from its body, and the page then loaded as
   * static markup — no tree, no listeners, every browser check failing on a page that looked like a page. The build
   * copies the file and the daemon serves it, so nothing between the editor and the browser parses it. This does: it
   * is the cheapest possible guard on the one file whose syntax failure takes everything with it.
   */
  const extracted = /<script type="module">([\s\S]*?)<\/script>/.exec(page)
  assert.ok(extracted !== null, 'the page has a module script')
  const directory = join(repoRoot, '.heddle-tmp')
  mkdirSync(directory, { recursive: true })
  const scratch = join(directory, 'page-module-guard.mjs')
  writeFileSync(scratch, extracted[1] ?? '')
  try {
    execFileSync(process.execPath, ['--check', scratch], { stdio: 'pipe' })
  } finally {
    rmSync(scratch, { force: true })
  }
})
