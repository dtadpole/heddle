import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * C33, "ancestors start expanded", run out of the page: its own `renderTree`, `toggle`, `rememberExpanded` and
 * `openCurrentGroup` over its own workspace-tree block, with the two list reads answered and the rows stood in for.
 *
 * DSH's tree keeps one record per group, `groupExpansion[key]`: true, false, or absent (dsh-client-ui-workspace
 * `lib/client.js:1284-1285`). A group with no record is open when another workspace nests in it
 * (`groupExpansion[key] ?? ancestorKeys.has(key)`, `:3061-3063`), and the current session's group is opened and saved open
 * when it has no record (`:3037-3046`), so the open session's row is on screen after a reload, however deep. A record of
 * false (a person's fold) wins over both: "Ancestors start expanded unless a saved collapsed state exists. A saved
 * collapse also hides the current Session" (its README, Workspace hierarchy). Only search-result navigation opens a fold
 * (`:3080-3087`, the page's `revealSession`).
 *
 * Before (code reading on main 6a22ab76, R-developer-eight-2): heddle kept only the open groups, a first visit opened
 * `treeTops[0]`, and nothing opened the open session's workspace or its ancestors, so a reload into a nested workspace,
 * or into any workspace but the first, drew the session's row folded away.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const block = page.slice(page.indexOf('/* workspace-tree:begin */'), page.indexOf('/* workspace-tree:end */'))

/** A top-level function of the page, by name: from its line to the first line that closes it. */
function source(name: string): string {
  const start = page.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start + 1, page.indexOf('\n}\n', start) + 2)
}

/** The same function when the page has it, else nothing: a name this fix adds, which the red run predates. */
function optional(name: string): string {
  return page.search(new RegExp(`\\n(?:async )?function ${name}\\(`)) >= 0 ? source(name) : ''
}

/** The page's folded-groups memory (`COLLAPSED_KEY` and `collapsed`), else an empty set the red run never writes. */
function collapsedMemory(): string {
  const start = page.indexOf('\nconst COLLAPSED_KEY = ')
  if (start < 0) return 'const collapsed = new Set()'
  return page.slice(start + 1, page.indexOf('\n})()\n', start) + 5)
}

const EXPANDED = 'heddle.tree.expanded.v1'
const COLLAPSED = 'heddle.tree.collapsed.v1'

const workspace = (id: string, path: string, sessionIds: string[], parent: string | null = null) => ({
  id,
  path,
  title: path.split('/').pop(),
  origin: 'added',
  parent,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
  sessionIds,
})
const session = (id: string, cwd: string, minute: number) => {
  const at = `2026-10-31T17:${String(minute).padStart(2, '0')}:00.000Z`
  return { id, cwd, title: id, created: at, updated: at, turns: 1 }
}

/** `other` is drawn first (it is `treeTops[0]`), `repo` holds `app`, and the session the reader has open lives in `app`. */
const OTHER = '/w/other'
const REPO = '/w/repo'
const APP = '/w/repo/packages/app'
const WORKSPACES = [
  workspace('ws-other', OTHER, ['s-other']),
  workspace('ws-repo', REPO, ['s-repo']),
  workspace('ws-app', APP, ['s-app'], 'ws-repo'),
]
const SESSIONS = [session('s-other', OTHER, 1), session('s-repo', REPO, 2), session('s-app', APP, 3)]

interface Snapshot {
  open: string[]
  drawn: string[]
  expanded: string[] | null
  collapsed: string[] | null
}
interface Page {
  render(): Promise<string>
  fold(path: string): Promise<string>
  unfold(path: string): Promise<string>
  open(id: string): Promise<string>
}

/** One page load over `storage`, `current` already restored; each call answers a snapshot as JSON. */
function load(storage: Record<string, string>, current: string | null, grouping = 'tree'): Page {
  return runInNewContext(
    `
    ${block}
    let current = CURRENT
    let groupingMode = GROUPING
    let treeGroups = []
    let treeTops = []
    let knownWorkspaces = []
    let listedSessions = new Set()
    let childSessions = []
    let shownOrders = {}
    let selectedPath = null
    let activeFolder = null
    let heldTreeFocus = null
    let workspaceRoutes = 'unknown'
    const archiveMode = 'hide'
    const orderState = { orderBy: 'updated' }
    const NEW_CONVERSATION_NOTE = ''
    const EXPANDED_KEY = ${JSON.stringify(EXPANDED)}
    const stored = { ...STORAGE }
    const localStorage = {
      getItem: (key) => (key in stored ? stored[key] : null),
      setItem: (key, value) => { stored[key] = String(value) },
    }
    ${source('readExpanded')}
    const expanded = readExpanded()
    ${collapsedMemory()}
    const rowIndex = new Map()
    const rowEntries = new WeakMap()
    const levelsLoading = new WeakSet()
    const watermarks = new Map()
    let treeGeneration = 0
    let treeRead = 0
    let treeLanded = 0
    let treeWaiters = []
    /**
     * As much of an element as the tree's drawing touches here: a row, the list of a level, and the tree itself. Since
     * #143 a redraw draws its rows off the page and puts them in at once, so the stand-in has children and a parent.
     */
    class Item {
      constructor(tag) {
        this.tagName = tag.toUpperCase()
        this.dataset = {}
        this.attributes = {}
        this.childList = []
        this.parentElement = null
        this.isConnected = true
      }
      get children() { return [...this.childList] }
      setAttribute(name, value) { this.attributes[name] = String(value) }
      getAttribute(name) { return name in this.attributes ? this.attributes[name] : null }
      hasAttribute(name) { return name in this.attributes }
      append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.childList.push(node) } }
      replaceChildren(...nodes) { for (const child of this.children) child.remove(); this.append(...nodes) }
      remove() { if (this.parentElement !== null) this.parentElement.childList.splice(this.parentElement.childList.indexOf(this), 1); this.parentElement = null }
      querySelector(selector) {
        if (selector !== ':scope > ul[role="group"]' && selector !== 'ul[role=group]') throw new Error('unexpected selector ' + selector)
        return this.childList.find((child) => child.tagName === 'UL') ?? null
      }
      querySelectorAll(selector) {
        if (selector !== 'li[role="treeitem"]') throw new Error('unexpected selector ' + selector)
        const rows = []
        const walk = (node) => { for (const child of node.childList) { if (child.tagName === 'LI' && child.getAttribute('role') === 'treeitem') rows.push(child); walk(child) } }
        walk(this)
        return rows
      }
    }
    const document = { createElement: (tag) => new Item(tag) }
    /** A group's row: open or not, and the node the page's toggle reads. */
    function groupRow(group) {
      const node = group.workspace === null
        ? { kind: 'ungrouped', path: '#ungrouped', group }
        : { kind: 'workspace', path: group.path, group }
      const li = new Item('li')
      li.setAttribute('role', 'treeitem')
      li.dataset.open = 'false'
      const entry = { node, li }
      rowIndex.set(node.path, entry)
      rowEntries.set(li, entry)
      return li
    }
    /**
     * Opening a group draws its child groups and then reopens them, as the page's loadChildren does; a redraw off the page
     * opens them itself, all at once (#143).
     */
    async function loadChildren(node, li, offPage = false) {
      const level = new Item('ul')
      li.append(level)
      for (const child of node.group.children) level.append(groupRow(child))
      if (!offPage && typeof reopenChildGroups === 'function') await reopenChildGroups(node)
    }
    const treeList = new Item('ul')
    /** The new rows go in as drawn; which row keeps its element is test/page-tree-steady.test.ts's. */
    const placeTree = (live, fresh) => live.replaceChildren(...fresh.children)
    const paintRunningMarks = () => {}
    const fetch = async (url) => {
      if (url === '/api/workspaces') return { ok: true, status: 200, json: async () => ({ workspaces: WORKSPACES }) }
      if (url === '/api/sessions') return { ok: true, status: 200, json: async () => SESSIONS }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    const treeFocus = () => null
    const restoreTreeFocus = () => {}
    const renderFlatList = async () => {}
    const setNote = () => {}
    const paintConversationTarget = () => {}
    const forgetRemovedWorkspace = () => {}
    const noteSessions = () => {}
    const paintEmptyList = () => {}
    const newConversationTarget = () => null
    const syncSelectionToSession = () => {}
    const paintScheduleMarks = () => {}
    const markSelection = () => {}
    const kindIcon = () => null
    const resetWatermarks = () => {}
    const applySearch = () => {}
    ${source('rememberExpanded')}
    ${source('toggle')}
    ${optional('paintDisclosure')}
    ${source('renderTree')}
    ${['treeLandedAt', 'treeDrawn', 'treeOpening', 'sameMembers', 'watermarkState', 'openOffPage', 'openRowOffPage', 'repaintSessionRowsOffPage', 'rowsIn', 'indexDrawnRows'].map(optional).join('\n')}
    ${optional('openCurrentGroup')}
    ${optional('reopenChildGroups')}
    const list = (key) => (key in stored ? JSON.parse(stored[key]).sort() : null)
    const snapshot = () => JSON.stringify({
      open: [...rowIndex].filter(([, entry]) => entry.li.dataset.open === 'true').map(([key]) => key).sort(),
      drawn: [...rowIndex.keys()].sort(),
      expanded: list(${JSON.stringify(EXPANDED)}),
      collapsed: list(${JSON.stringify(COLLAPSED)}),
    })
    const row = (path) => rowIndex.get(path)
    ;({
      render: async () => { await renderTree(); return snapshot() },
      fold: async (path) => { if (row(path).li.dataset.open === 'true') await toggle(row(path).node, row(path).li); return snapshot() },
      unfold: async (path) => { if (row(path).li.dataset.open !== 'true') await toggle(row(path).node, row(path).li); return snapshot() },
      open: async (id) => {
        current = id
        if (typeof openCurrentGroup === 'function') await openCurrentGroup()
        return snapshot()
      },
      stored,
    })
    `,
    {
      STORAGE: storage,
      CURRENT: current,
      GROUPING: grouping,
      WORKSPACES,
      SESSIONS,
      JSON,
      Promise,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Array,
      Object,
      String,
      Number,
      Date,
      Math,
      Error,
      RegExp,
    },
  ) as Page
}

const read = async (answer: Promise<string>) => JSON.parse(await answer) as Snapshot
/** What the page left in storage, for the next load: the reload. */
const storageOf = (page: Page) => ({ ...(page as unknown as { stored: Record<string, string> }).stored })

test('a reload into a nested workspace draws the session: its workspace opens and is saved open, its ancestor starts open', async () => {
  const page = load({ [EXPANDED]: '[]', 'heddle.sessions.current': JSON.stringify({ sessionId: 's-app' }) }, 's-app')
  const shape = await read(page.render())
  assert.deepEqual(shape.open, [REPO, APP], `the session's workspace and its ancestor are open, and nothing else\nsaw: ${JSON.stringify(shape)}`)
  assert.deepEqual(shape.expanded, [APP], "the session's own workspace is saved open, as DSH saves it; the ancestor is derived")
  assert.equal(shape.drawn.includes(APP), true, 'so the nested workspace, and the session row in it, are drawn')
})

test('a first visit still opens the first workspace, and now the open session\'s way too', async () => {
  const shape = await read(load({}, 's-app').render())
  assert.deepEqual(shape.open, [OTHER, REPO, APP], `the first workspace (heddle's first-visit rule) and the open session's way\nsaw: ${JSON.stringify(shape)}`)
})

test('an ancestor starts open with no session open in it, and a workspace with nothing nested stays as it was left', async () => {
  const shape = await read(load({ [EXPANDED]: '[]' }, null).render())
  assert.deepEqual(shape.open, [REPO], `only the workspace another one nests in\nsaw: ${JSON.stringify(shape)}`)
  assert.deepEqual(shape.expanded, [], 'and nothing is written for it')
})

test('a fold a person made is kept: it hides the open session across a reload, and only that fold', async () => {
  const first = load({ [EXPANDED]: '[]' }, 's-app')
  await first.render()
  const folded = await read(first.fold(REPO))
  assert.deepEqual(folded.collapsed, [REPO], `folding the ancestor is saved as a fold\nsaw: ${JSON.stringify(folded)}`)
  assert.deepEqual(folded.expanded, [APP], 'the session\'s workspace stays saved open, under the fold')

  const reload = await read(load(storageOf(first), 's-app').render())
  assert.deepEqual(reload.open, [], `the folded ancestor stays folded though the open session is under it\nsaw: ${JSON.stringify(reload)}`)
  assert.equal(reload.drawn.includes(APP), false, 'so the session\'s workspace is not drawn')

  /** Opening the fold again is a person's act: it is saved open, and no longer folded. */
  const again = load(storageOf(first), 's-app')
  await again.render()
  const unfolded = await read(again.unfold(REPO))
  assert.deepEqual([unfolded.expanded, unfolded.collapsed], [[REPO, APP], []], `unfolding forgets the fold\nsaw: ${JSON.stringify(unfolded)}`)
  assert.deepEqual(unfolded.open, [REPO, APP], `and the session's workspace, saved open under the fold, opens with it, as DSH draws it\nsaw: ${JSON.stringify(unfolded)}`)
})

test('a fold of the open session\'s own workspace stays folded across a reload, and its ancestor stays open', async () => {
  const first = load({ [EXPANDED]: '[]' }, 's-app')
  await first.render()
  const folded = await read(first.fold(APP))
  assert.deepEqual([folded.expanded, folded.collapsed], [[], [APP]], `the fold replaces the saved open\nsaw: ${JSON.stringify(folded)}`)
  const reload = await read(load(storageOf(first), 's-app').render())
  assert.deepEqual(reload.open, [REPO], `the person's fold wins over the open session's default\nsaw: ${JSON.stringify(reload)}`)
})

test('a session opened from elsewhere opens its workspace when nobody folded it, and saves it open', async () => {
  const page = load({ [EXPANDED]: '[]' }, null, 'workspace')
  const before = await read(page.render())
  assert.deepEqual(before.open, [], `the Workspace grouping nests nothing, so nothing starts open\nsaw: ${JSON.stringify(before)}`)
  const after = await read(page.open('s-app'))
  assert.deepEqual([after.open, after.expanded], [[APP], [APP]], `opening a session opens its workspace, as DSH does on every change of the current session\nsaw: ${JSON.stringify(after)}`)

  const folded = load({ [EXPANDED]: '[]', [COLLAPSED]: JSON.stringify([APP]) }, null, 'workspace')
  await folded.render()
  const kept = await read(folded.open('s-app'))
  assert.deepEqual(kept.open, [], `but not one a person folded\nsaw: ${JSON.stringify(kept)}`)
})

test('the page reopens a child group where it draws one, so unfolding a parent shows its children as they were left', () => {
  const children = source('loadChildren')
  const tail = children.indexOf('if (node.group !== undefined) {')
  assert.ok(tail >= 0 && /markSelection\(\)\s*await reopenChildGroups\(node\)\s*return/.test(children.slice(tail)), 'a group level ends by reopening its children')
  assert.match(source('showSession'), /syncSelectionToSession\(\)\s*\/\*\*[^*]*\*\/\s*void openCurrentGroup\(\)/, 'and opening a session opens its workspace')
})
