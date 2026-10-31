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

test('the context gauge divides by the selected model\'s window, not the endpoint\'s', () => {
  /**
   * A gateway can serve a 1M deployment beside 272k ones, so the endpoint's single number is the wrong denominator
   * for every model that is not the default — the gauge then reads as nearly full for a conversation nowhere near
   * it. Measured 2026-10-18: `meta-codex` declares 272000 for the endpoint and 1000000 for `gpt-5.6-sol-ptu`, and
   * the page divided by 272000 whichever model was selected.
   *
   * The page cannot be executed here, so this is a removal detector in the same sense as the checks around it: it
   * asserts that the window comes from a resolver that consults the model's entry, and that no reading site still
   * takes `endpoint.contextWindow` directly.
   */
  assert.match(page, /function windowFor\(option\)/, 'a resolver exists')
  assert.match(page, /modelEntryOf\(option, selectedModelId\(option\)\)/, 'and it asks about the selected model')
  const direct = [...page.matchAll(/(?:const|let)\s+window\s*=\s*endpoint\?\.contextWindow/g)]
  assert.deepEqual(direct, [], 'no reading site falls back to the endpoint window behind the resolver\'s back')
  assert.equal([...page.matchAll(/const window = windowFor\(endpoint\)/g)].length, 3, 'the gauge, its popover and the status bar all use it')
})

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
  // Below DSH's 1024-pixel breakpoint the first paint is the rail (live-testing draft developer-ten-9); wide, the panel.
  assert.match(page, /Every visit starts wide on a wide window[\s\S]*?\npaintSidebarCollapse\(\)\n/, 'a load puts the panel back on a wide window')
})

test("the collapse chord is DSH's Alt+Meta+B, and the search chord opens the panel first", () => {
  /**
   * The chord is read from a table rather than inferred from control flow, which is what makes it assertable here.
   * The search field is put away while the sidebar is a rail, so its chord has to open the panel before focusing —
   * otherwise `Alt+Meta+K` focuses something a reader cannot see and appears to do nothing.
   */
  assert.match(page, /\{ key: 'b', alt: true, action: 'sidebar' \}/, 'the chord is in the table')
  assert.match(page, /if \(action === 'sidebar'\) \{/, 'and the handler acts on it')
  assert.match(page, /if \(sidebarCollapsed\(\)\) openSidebar\(\)/, 'search opens the panel first')
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
  /** The workspace tree (G2): the first registered workspace is opened, as DSH's browser arrives with one open. */
  assert.match(page, /if \(firstVisit && treeTops\.length > 0\) \{\s*expanded\.add\(treeTops\[0\]\.path\)\s*rememberExpanded\(\)/, 'it opens the first workspace, writing the choice like any other')
})

test('the panel has DSH\'s primary action, and it starts a session where the reader is', () => {
  /**
   * Measured from DSH's sidebar on 2026-10-17: a full-width `New session` control between the brand row and the
   * workspace list, 252x38 inside its 280-pixel panel, 12-pixel radius, a 1-pixel 16%-white border, 14-pixel text at
   * weight 500, and the chord `Alt+Meta+N`. Its collapsed rail carries the same action as its **second icon**, on the
   * 48-pixel pitch that begins with the control which opens the panel.
   */
  assert.match(page, /<button id="new-session" type="button" title="New session \(⌥⌘N\)"[^>]*>/, 'the control exists, named with its chord')
  assert.match(page, /<span id="new-session-label"[^>]*>New session<\/span>/, 'and says what it does')
  assert.match(page, /#new-session \{[\s\S]*?border-radius: var\(--radius-md\);/, 'rounded by the panel\'s own rule')
  assert.match(page, /#new-session \{[\s\S]*?font-size: \.875rem;[\s\S]*?font-weight: 500;/, 'at DSH\'s 14-pixel medium')
  assert.match(page, /body\[data-sidebar='collapsed'\] #new-session \{[\s\S]*?width: 36px;[\s\S]*?height: 36px;/, 'and it becomes a 36-pixel icon in the rail')
  assert.match(page, /let treeTops = \[\]/, 'the tree keeps the workspace rows the action needs')
  assert.match(page, /function newSessionWorkspace\(/, 'the target is chosen in one place')
  assert.match(
    page,
    /if \(chosenWorkspace !== null && chosenWorkspace\.during === current\) \{[\s\S]*?const byChoice = treeTops\.find[\s\S]*?if \(current !== null\) \{[\s\S]*?const byCurrent = treeTops\.find/,
    'from the workspace the person opened or added since the open session was chosen, then the open session\'s workspace',
  )
  assert.match(page, /if \(selectedPath !== null && !selectedPath\.startsWith\('session:'\)\) \{[\s\S]*?const bySelection = owner\(selectedPath\)/, 'then from the selected row\'s workspace')
  assert.match(page, /await startSessionAt\(workspace\)/, 'and the act is the same path a workspace row uses')
  assert.match(page, /\{ key: 'n', alt: true, action: 'new-session' \}/, 'with DSH\'s chord in the table')
  assert.match(page, /if \(action === 'new-session'\) \{/, 'and a handler that acts on it')
})

test('New session asks for a new session every time and names none it found in the list', () => {
  /**
   * DSH's sidebar `New session` and its chord create a fresh Session on each press (`startSession` with no options, then
   * `connectBlank` with no reuse: dsh-client-ui-workspace lib/client.js:1403-1406, 1520). A page that named an empty
   * session from the shared list put a second client into the first one's conversation (coordinator, 2026-10-29). The
   * browser check is 70's "two clients pressing New session..."; this detects the request regaining a session field.
   */
  const start = page.indexOf('async function startSessionAt(node) {')
  assert.ok(start > 0, 'the one New session path is in the page')
  const body = page.slice(start, page.indexOf('\n}\n', start))
  assert.match(body, /body: JSON\.stringify\(\{ branch: node\.path \}\)/, 'the request names the folder and nothing else')
  assert.doesNotMatch(body, /session: |blankToReuse\(/, 'no session id, found or remembered, rides along')
})

test('New session starts in the workspace row the person opened or added, not the open session\'s (#25)', () => {
  /**
   * DSH starts a session in the workspace a person acted on: a row's `+` names it (dsh-client-ui-workspace
   * lib/client.js:3233-3236, and a named workspace wins at :1508), and Add workspace starts one there at once
   * (:3936-3938). The Session Intent hero picker (C36) changes only a blank session's target, so for the panel's button
   * and chord, opening workspace B's row after a session in A must make B the target; the browser check is 80's "New session starts in the workspace row the
   * person opened". This detects the choice no longer being recorded where the person acts.
   */
  assert.match(page, /function chooseWorkspace\(path\) \{\s*chosenWorkspace = path === null \? null : \{ path, during: current \}/, 'a choice remembers the session it was made beside')
  assert.match(page, /if \(node\.kind === 'workspace'\) \{\s*if \(li\.dataset\.open !== 'true'\) chooseWorkspace\(node\.path\)/, 'opening a workspace row chooses it')
  const show = page.slice(page.indexOf('async function showSession(id) {'))
  assert.match(show.slice(0, show.indexOf('\n}\n')), /if \(current !== id\) chooseWorkspace\(null\)\s*current = id/, 'and opening another session forgets the choice')
  /**
   * Add workspace shows what it registered through showNewWorkspace, which first use's default workspace shares (C39);
   * only Add workspace then opens a session there (#22), and first use opens none (D-056).
   */
  const adopt = page.slice(page.indexOf('async function adoptWorkspace(path) {'))
  assert.match(adopt.slice(0, adopt.indexOf('\n}\n')), /await showNewWorkspace\([^\n]*\{ openSession: true \}\)/, 'adding one shows the workspace it registered and opens a session')
  const shown = page.slice(page.indexOf('async function showNewWorkspace(added, '))
  const shownBody = shown.slice(0, shown.indexOf('\n}\n'))
  assert.match(shownBody, /chooseWorkspace\(added\)/, 'and so does adding one')
  assert.match(shownBody, /if \(openSession\) await startSessionAt\(\{ path: added \}\)\s*else chooseSelected\(added\)/, 'a session only when asked')
  const first = page.slice(page.indexOf('async function initializeDefaultWorkspace() {'))
  assert.doesNotMatch(first.slice(0, first.indexOf('\n}\n')), /openSession/, 'first use opens no session')
  const select = page.slice(page.indexOf('async function selectSession(node) {'))
  assert.match(
    select.slice(0, select.indexOf('\n}\n')),
    /if \(current === node\.session\.id\) chooseSelected\(node\.path\)/,
    'a session row\'s slow load does not take the mark back from a session opened meanwhile',
  )
})

test('Add workspace and New session say when their request fails, instead of leaving a rejection in the console (#59)', () => {
  /**
   * DSH reports a failed session creation as `New session failed: {message}` (dsh-client-ui-workspace lib/client.js:4957,
   * from openWorkspaceSession's catch, :1476-1487) and an adoption failure's message in its folder dialog's alert
   * (:2603-2611). On main both requests were unguarded `fetch` calls, so an offline press changed nothing on screen; the
   * browser check is 80's "Add workspace and New session say they failed". This detects a guard being dropped.
   */
  const body = (start: string) => {
    const from = page.indexOf(start)
    assert.ok(from > 0, `${start} is in the page`)
    return page.slice(from, page.indexOf('\n}\n', from))
  }
  const start = body('async function startSessionAt(node) {')
  assert.match(start, /try \{\s*response = await fetch\('\/api\/sessions'/, 'the session request is guarded')
  assert.match(start, /const failed = \(message\) => setNote\('New session failed: ' \+ message\)/, 'and a failure is said in DSH\'s words')
  const adopt = body('async function adoptWorkspace(path) {')
  assert.match(adopt, /try \{\s*response = await fetch\('\/api\/workspaces'/, 'the registration request is guarded')
  assert.match(adopt, /return 'could not register that folder: ' \+/, 'and its failure is a refusal the dialog shows')
})

test('a panel with nothing open shows an invitation, and gives way when something opens', () => {
  /**
   * DSH's home centres a mark, a heading and the composer; Heddle showed an empty column under a header that said
   * "No session". The invitation is painted from the panel's own state — the chat view with no session in it — rather
   * than from a flag someone has to remember, and the conversation's column is put away beneath it.
   */
  assert.match(page, /<section id="empty-state" hidden>/, 'the invitation exists and starts hidden')
  assert.match(page, /<h3[^>]*>Start a conversation<\/h3>/, 'with a heading that says what to do')
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

test('the panel ends with a Settings entry, and the Settings surface never renders a credential', () => {
  /**
   * The reference's bottom area is a launcher (`settingsArea` 256×50 at y=757 in an 813-tall column, measured
   * 2026-10-17) and its `Settings` opens a dialog. Heddle had no bottom area; this cycle added one entry and a
   * read-only dialog. The page must state what the machine is configured with and must not print a credential: the
   * endpoint file holds one, and `/api/endpoints` answers `credential: "set"` rather than a value.
   */
  assert.match(page, /<div id="panel-foot">/, 'the panel ends with a foot')
  assert.match(page, /<button id="settings-open" type="button" aria-label="Settings"/, 'holding the Settings entry')
  assert.match(page, /#panel-foot \{[\s\S]*?flex: none;/, 'which is anchored rather than in flow with the list')
  assert.match(page, /<dialog id="settings-dialog" aria-labelledby="settings-title">/, 'and it opens a real dialog')
  assert.match(page, /<h3[^>]*>Server<\/h3>/, 'with a Server section')
  assert.match(page, /<h3[^>]*>Models<\/h3>/, 'a Models section')
  assert.match(page, /<h3[^>]*>Workspaces<\/h3>/, 'and the workspace roots')
  assert.match(page, /Credentials are never shown here/, 'and the line that says credentials are never rendered')
  assert.match(page, /settingsDialog\.showModal\(\)/, 'shown modally, so Escape and focus containment are the platform\'s')
  assert.match(page, /if \(clickEvent\.target === settingsDialog\) settingsDialog\.close\(\)/, 'and the backdrop dismisses it')
  assert.match(page, /\{ key: ',', alt: true, action: 'settings' \}/, 'with the reference\'s chord in the table')
  assert.match(page, /endpoint\.credential === 'set' \? t\('settings\.credentialSet'\) : t\('settings\.noCredential'\)/, 'the credential is reported as set or not, never printed')
  assert.match(page, /'settings\.credentialSet': 'credential set'/, 'in words that name only its presence')
})

test('the workspaces region spans the panel and carries the reference\'s scrollbar and end padding', () => {
  /**
   * Measured from DSH on 2026-10-17: its list reports a 5-pixel scrollbar (`offsetWidth - clientWidth`),
   * `scrollbar-gutter: stable` and `padding-bottom: 16px`. Heddle measured 0 and 0, and its first attempt reserved
   * nothing because `scrollbar-width: thin` stops `::-webkit-scrollbar` from applying at all. Part 11 measures the
   * result; these contracts catch the CSS being dropped.
   */
  assert.match(page, /#workspace-scroll \{[\s\S]*?margin-inline: -.75rem;/, 'the region breaks out of the panel\'s padding')
  assert.match(page, /#workspace-scroll \{[\s\S]*?padding-inline: 0;/, 'and leaves the inline inset to the rows, so their paint reaches the edges')
  assert.match(page, /--tree-depth/, 'the indentation travels with the row as a depth')
  assert.match(page, /padding: 0 .5rem 0 calc\(\.5rem \+ var\(--tree-depth, 0\) \* 14px\);/, 'whose content starts 8px inside the inset row and indents 14 pixels per level')
  assert.match(page, /#tree \{ padding-inline: 12px calc\(12px - 5px\); \}/, 'the rows are inset inside the pane, which keeps the scrollbar at the panel edge')
  assert.match(page, /#search-results \{ padding-inline: 12px calc\(12px - 5px\); \}/, 'and the search results take the same inset, so a search does not shift the list edges')
  assert.match(page, /#search-results \.hit \{[^}]*padding: \.3rem \.5rem;[^}]*border-radius: 12px;/s, 'with each hit using the row padding and rounding')
  assert.match(page, /#tree \.row:focus-visible \{[^}]*outline: 2px solid color-mix\(in oklab, var\(--text\) 45%, transparent\);[^}]*outline-offset: -2px;/s, 'and a focused row draws its ring inside its own box, in the panel ink')

  /**
   * **The hover surface names its lists.** `li:hover` unscoped also matched tree items, and a tree `li` holds its whole
   * subtree — hovering a child row painted an opaque surface behind the entire section. The rule names the changed-files
   * list and the settings lists; the tree's row carries its own tint.
   */
  assert.doesNotMatch(page, /^\s*li:hover \{ background: var\(--surface\); \}/m, 'no unscoped list-item hover surface')
  assert.match(page, /\.changed-list > li:hover,\s*\n\s*\.settings-endpoint:hover,\s*\n\s*\.settings-workspace:hover \{ background: var\(--surface\); \}/, 'the surface is scoped to the lists that want it')
  assert.match(page, /#tree ul\[role='group'\] \{ padding-left: 0; \}/, 'while a group no longer narrows the rows below it')
  assert.match(page, /function nodeRow\(node, depth = 0\)/, 'nodeRow carries the depth')
  assert.match(page, /group.append\(nodeRow\(child, depth \+ 1\)\)/, 'and passes one more to each child')
  assert.match(page, /#workspace-scroll \{[\s\S]*?padding-bottom: 1rem;/, 'the region ends with the reference\'s 16 pixels')
  assert.match(page, /#workspace-scroll \{[\s\S]*?scrollbar-gutter: stable;/, 'and reserves its scrollbar gutter')
  assert.match(page, /#workspace-scroll::-webkit-scrollbar \{ width: 5px; \}/, 'with the reference\'s 5-pixel bar')
  assert.doesNotMatch(page, /#workspace-scroll \{[\s\S]*?scrollbar-width: thin;/, 'and not the property that would disable it')
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
  const module = extracted[1]
  assert.ok(module !== undefined, 'the module script has a body')
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

test('the model seat keeps the two tiers, the effort caption and the record that make it DSH’s control', () => {
  /**
   * Removal detectors for the parts a rewrite silently drops. The behaviour — the two-level menu, the keyboard, the
   * record and its reload — is judged in `_verifiers_/80-web-ui/check-model-switcher.mjs`; a page whose markup lost
   * one of these still renders and stops being the control the check names:
   *
   * - the trigger's **two spans**, because the effort is a caption beside the model, not a joined string;
   * - the menu's name, because `Model and reasoning effort` is what announces the two rows;
   * - the **reasoning effort sent with a turn**, because a level that is displayed and not posted is the
   *   unenforced value the owner forbade;
   * - the **effort row built only for a model that declares levels**, because a control there would offer a value
   *   the adapter refuses to send.
   */
  assert.match(page, /id="model-seat"/, 'the seat exists')
  assert.match(page, /id="model-trigger"[^>]*aria-haspopup="menu"[^>]*aria-controls="model-menu"/, 'the trigger is a menu button that names its menu')
  assert.match(page, /<span id="model-label">/, 'the model label is its own span')
  assert.match(page, /<span id="model-effort" hidden>/, 'and the effort is a second, hidden-until-declared span')
  assert.match(page, /<span id="model-spinner" hidden>/, 'with a pending marker for a selection being recorded')
  assert.match(page, /id="model-menu" role="menu" aria-label="Model and reasoning effort"/, 'the menu names both tiers')
  assert.match(page, /function buildRootPane\(\)/, 'the root pane is built where the two levels are drawn')
  assert.match(page, /if \(effort\.name !== undefined\) modelMenu\.append/, 'the Effort row exists only for a model that declares levels')
  assert.match(page, /function buildModelPane\(\)/, 'the model tier is its own pane')
  assert.match(page, /function buildEffortPane\(\)/, 'and the effort tier is its own pane')
  assert.match(page, /\.model-group-heading/, 'the model pane groups by endpoint, as DSH groups by provider')
  assert.match(page, /reasoningEffort: effort\.id/, 'a turn sends the level the seat shows')
  assert.match(
    page,
    /applySessionModel\(body\.endpoint \?\? null, body\.model \?\? null, body\.reasoningEffort \?\? null\)/,
    'a reload reads the recorded level with the endpoint and model',
  )
  assert.match(page, /placeModelMenu\(\)/, 'the menu is placed by script rather than by a css ancestor')
})

test('the + menu carries the computer-side File action and the input it drives', () => {
  /**
   * The Add File gesture is three pieces that a rewrite can silently drop while the page still looks
   * right: the menu item that names DSH's own label (`File`), the hidden input the item invokes (a
   * browser only reveals a chosen file through that input's change event), and the route that stores
   * the bytes and answers with the path. The browser check in `_verifiers_/80-web-ui/check-composer.mjs`
   * judges the gesture end to end; this is the removal detector underneath it.
   */
  assert.match(page, /<input type="file" id="attach-file" multiple hidden>/, 'the picker input exists')
  assert.match(page, /file\.textContent = 'File'/, 'the menu item is labelled File, as DSH labels it')
  assert.match(page, /`\/api\/uploads\?name=\$\{encodeURIComponent\(file\.name\)\}`/, 'the bytes go to the upload route')
  assert.match(page, /id="attach-cards"/, 'the composer draws pending attachment cards')
  assert.match(page, /saved\.path, name: file\.name, bytes: saved\.bytes/, 'the stored reference waits as a pending attachment')
  assert.match(page, /pendingAttachments = \[\.\.\.pendingAttachments, \.\.\.added\]/, 'and it is kept with the draft, not typed into it')
})

test("a session is renamed in DSH's Rename session dialog, opened by the menu, the chord and a double-click on its title", () => {
  /**
   * DSH (`dsh-client-ui-workspace`, `RenameSession.js`) opens one dialog from three places: the row menu's `Rename`,
   * the `session.rename` chord (`Mod+Alt+G`), and a double-click on the row's title (`onDoubleClick` →
   * `onRenameRequest`). The dialog is titled `Rename session`, its field is `Session name` and starts with the stored
   * title, and `Rename` is disabled only while the trimmed draft is empty — an unchanged title is accepted, which is
   * how it pins the automatic one. The browser check in `_verifiers_/70-workspaces-sessions/` judges the gestures; this
   * is the removal detector underneath it.
   */
  assert.match(page, /<dialog id="session-rename" class="ws-dialog" aria-labelledby="session-rename-title">/, 'the dialog exists')
  assert.match(page, /<h2 id="session-rename-title">Rename session<\/h2>/, "and carries DSH's title")
  assert.match(page, /<input type="text" id="session-rename-input" aria-label="Session name"/, "with DSH's field name")
  assert.match(page, /<button type="button" id="session-rename-confirm" class="ws-primary" disabled>Rename<\/button>/, 'and its Rename button')
  assert.match(page, /input\.value = node\.session\.title \?\? ''/, 'the field starts with the stored title, empty for an unnamed session')
  assert.match(page, /\.disabled = sessionRenameTarget\.busy \|\| trimmed === ''/, 'only an empty draft (or one in flight) is refused, so an unchanged title can pin')
  assert.match(page, /label\.addEventListener\('dblclick', \(event\) => \{\s*event\.stopPropagation\(\)\s*renameSession\(node\)/, 'a double-click on the title opens it')
  assert.match(page, /items\.push\(\{ label: 'Rename', glyph: 'rename', run: \(\) => renameSession\(node\) \}\)/, 'and so does the menu item')
  assert.match(page, /else if \(action === 'rename'\) renameSession\(node\)/, 'and the chord')
  assert.doesNotMatch(page, /window\.prompt\('Rename this session'/, 'the native prompt is gone')
})
