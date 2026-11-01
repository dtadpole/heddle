import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Follow-ups to the sidebar search (#57 #58), from developer-ten's review of content-search-page. Each test runs the
 * page's own functions, cut out of `page.html`, against small stand-ins for the document, `fetch` and the tree.
 *
 * - N1: an index read that a session refresh overtook neither replaces the newer index nor repaints the header with
 *   the older list.
 * - N2: when hidden sessions fill the host's twenty rows, the page does not say "No matching sessions" beside
 *   "Showing the first 20 results". DSH has the same latent outcome (dsh-api-session-controller lib/index.js:2016-2084
 *   ranks every session with a `cwd`; dsh-client-ui-workspace lib/client.js:1197-1219 filters after that cut and keeps
 *   the host's `hasMore`), so DSH's wire is kept and the page says "Showing the first 20" only when it shows twenty.
 * - N3: revealing a search hit stops once another session became the open one during any of its awaits.
 * - N4: a one-column list that could not read the sessions still ends its redraw: the held keyboard place is let go.
 * - N5: the archive notice's "filter archived sessions" redraws a standing search under the filter it switched to.
 * - #151: a redraw of the hits keeps each hit's element (DSH's keyed list), so a press that straddles it still lands.
 * - M1: a read the refresh overtook shares the read in flight for the newer list instead of starting another.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

/** A top-level function of the page: from its `function` line to the first line that is a lone `}`. */
function source(name: string): string {
  const start = page.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start + 1)
  return page.slice(start + 1, end + 2)
}

/** A marked block of the page, between its `begin` and `end` comments. */
function block(name: string): string {
  const begin = page.indexOf(`/* ${name}:begin */`)
  const end = page.indexOf(`/* ${name}:end */`)
  assert.ok(begin > 0 && end > begin, `the ${name} block is in the page`)
  return page.slice(begin, end)
}

/** The page from the first `from` up to the first `to` after it. */
function region(from: string, to: string): string {
  const begin = page.indexOf(from)
  const end = page.indexOf(to, begin)
  assert.ok(begin > 0 && end > begin, `the page holds ${JSON.stringify(from)} before ${JSON.stringify(to)}`)
  return page.slice(begin, end)
}

const pure = `${block('session-rules')}\n${block('workspace-tree')}\n${block('content-search')}\n${block('session-archive')}`

const tick = async (rounds = 10) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** As much of an element as the code under test touches. */
class FakeElement {
  id = ''
  hidden = false
  textContent = ''
  value = ''
  className = ''
  type = ''
  title = ''
  maxLength = 0
  tabIndex = -1
  onclick: unknown = null
  onkeydown: unknown = null
  children: FakeElement[] = []
  /** The element holding this one, as the DOM's `parentNode`. */
  parent: FakeElement | null = null
  /** How many times this element was taken out of the element holding it: removed, moved, or replaced with its siblings. */
  detached = 0
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, (event?: unknown) => unknown>()
  readonly registry: Map<string, FakeElement>

  constructor(registry: Map<string, FakeElement>) {
    this.registry = registry
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null
  }

  get nextElementSibling(): FakeElement | null {
    if (this.parent === null) return null
    return this.parent.children[this.parent.children.indexOf(this) + 1] ?? null
  }

  /** Take this element out of the one holding it, as the DOM's `remove()` (and every move) does. */
  remove(): void {
    if (this.parent === null) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
    this.detached += 1
  }

  insertBefore(node: FakeElement, reference: FakeElement | null): void {
    node.remove()
    const at = reference === null ? -1 : this.children.indexOf(reference)
    if (at === -1) this.children.push(node)
    else this.children.splice(at, 0, node)
    node.parent = this
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value))
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  addEventListener(type: string, listener: (event?: unknown) => unknown): void {
    this.listeners.set(type, listener)
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove()
      this.children.push(node)
      node.parent = this
    }
  }

  /** Every child is taken out first, the ones put back too, as the DOM's `replaceChildren` does. */
  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of [...this.children]) child.remove()
    this.append(...nodes)
  }

  after(node: FakeElement): void {
    if (node.id !== '') this.registry.set(node.id, node)
  }
}

function fakeDocument(ids: string[]) {
  const registry = new Map<string, FakeElement>()
  for (const id of ids) {
    const made = new FakeElement(registry)
    made.id = id
    registry.set(id, made)
  }
  return {
    registry,
    document: {
      getElementById: (id: string) => registry.get(id) ?? null,
      createElement: () => new FakeElement(registry),
      createTextNode: (text: string) => Object.assign(new FakeElement(registry), { textContent: text }),
    },
  }
}

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> }
const answer = (body: unknown, status = 200): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => body })

interface Meta {
  id: string
  cwd: string
  created: string
  updated: string
  turns: number
  title?: string
  archived?: boolean
  origin?: string
}

function session(id: string, minute: number, extra: Partial<Meta> = {}): Meta {
  const at = `2026-10-31T10:${String(minute).padStart(2, '0')}:00.000Z`
  return { id, cwd: '/code/repo', created: at, updated: at, turns: 1, ...extra }
}

function workspace(path: string, sessionIds: string[]) {
  return { id: 'w-repo', path, title: path.split('/').pop(), origin: 'added', parent: null, createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:00.000Z', sessionIds }
}

interface Index {
  sessions: Meta[]
}

interface SearchPage {
  applySearch: () => Promise<void>
  loadSearchIndex: () => Promise<Index | null>
  refreshSessions: () => Promise<void>
  held: () => { searchIndex: Index | null; heldIndex: Index | null }
}

/**
 * The search's own code — from `let searchIndex = null` to `openSearchResult`, which holds the index, `applySearch` and
 * the host request — and `refreshSessions`, which is where the index goes stale. `fetch` is the test's.
 */
function searchPage(fetch: (url: string) => Promise<Reply>, noted: Meta[][], options: { archive?: string } = {}) {
  const { registry, document } = fakeDocument(['session-search', 'search-results', 'search-note', 'search-more'])
  const timers: (() => void)[] = []
  const treeList = new FakeElement(registry)
  const env = {
    document,
    fetch,
    treeList,
    noteSessions: (list: Meta[]) => noted.push(list),
    setTimeout: (callback: () => void) => timers.push(callback),
    clearTimeout: () => undefined,
  }
  const run = new Function(
    'env',
    `const { document, fetch, treeList, noteSessions, setTimeout, clearTimeout } = env
    ${pure}
    let archiveMode = ${JSON.stringify(options.archive ?? 'hide')}
    let groupingMode = 'tree'
    let treeGroups = []
    let current = null
    let runningTick = 0
    const relativeAge = () => ''
    const openSearchResult = () => undefined
    const kindIcon = () => document.createElement('svg')
    const definitionOf = new Map()
    async function setSessionFlags() { return { ok: true } }
    function showArchiveNotice() {}
    ${region('let searchIndex = null', 'async function openSearchResult(')}
    ${source('refreshSessions')}
    return { applySearch, loadSearchIndex, refreshSessions, held: () => ({ searchIndex, heldIndex }) }`,
  )(env) as SearchPage
  /** Type a query, then let every answer and the debounce run. */
  const search = async (query: string) => {
    registry.get('session-search')!.value = query
    await run.applySearch()
    for (let round = 0; round < 20; round += 1) {
      await tick(1)
      for (const due of timers.splice(0)) due()
    }
    const note = registry.get('search-note')!
    const more = registry.get('search-more')!
    return {
      hits: registry.get('search-results')!.children.length,
      note: note.hidden ? null : note.textContent,
      more: more.hidden ? null : more.textContent,
    }
  }
  /** Let every answer and the debounce run, without typing anything. */
  const settle = async () => {
    for (let round = 0; round < 20; round += 1) {
      await tick(1)
      for (const due of timers.splice(0)) due()
    }
  }
  return { run, search, settle, registry }
}

/** A network whose every request waits until the test answers it. */
function heldNetwork() {
  const waiting: { url: string; resolve: (reply: Reply) => void; done: boolean }[] = []
  return {
    fetch: (url: string) => new Promise<Reply>((resolve) => waiting.push({ url, resolve, done: false })),
    waiting: () => waiting.filter((request) => !request.done).map((request) => request.url),
    /** Answer the oldest (or, with `newest`, the latest) request for `url` still waiting. */
    release(url: string, reply: Reply, newest = false) {
      const open = waiting.filter((request) => !request.done && request.url === url)
      const request = newest ? open[open.length - 1] : open[0]
      assert.ok(request !== undefined, `a request for ${url} is waiting`)
      request.done = true
      request.resolve(reply)
    },
  }
}

const before = [session('s-plan', 1, { title: 'Kestrel plan' }), session('s-old', 2, { title: 'Kestrel old' })]
/** The same sessions once `s-old` was archived: what the server answers after the refresh. */
const after = [before[0]!, { ...before[1]!, archived: true }]
const tree = answer({ children: [{ path: '/code/repo', label: 'repo' }] })
const workspaces = answer({ workspaces: [workspace('/code/repo', ['s-plan', 's-old'])] })
const archivedIn = (index: Index | null) => index?.sessions.find((meta) => meta.id === 's-old')?.archived === true

/** Answer one index read — its three requests — with `sessions`; `newest` picks the latest read still waiting. */
function answerRead(network: ReturnType<typeof heldNetwork>, sessions: Meta[], newest = false) {
  network.release('/api/sessions', answer(sessions), newest)
  network.release('/api/tree', tree, newest)
  network.release('/api/workspaces', workspaces, newest)
}

test('the page code under test is found', () => {
  for (const name of ['loadSearchIndex', 'refreshSessions', 'applySearch', 'openSearchResult', 'revealSession', 'renderFlatList', 'restoreTreeFocus', 'showArchiveNotice']) source(name)
  region('let searchIndex = null', 'async function openSearchResult(')
})

test('N1: an index read the refresh overtook does not replace the newer index, or repaint the header with its older list', async () => {
  const network = heldNetwork()
  const noted: Meta[][] = []
  const { run } = searchPage(network.fetch, noted)

  /** L1: a keystroke reads the index. */
  const first = run.loadSearchIndex()
  await tick()
  /** Then `s-old` is archived, and the refresh after it says the index is stale (its own read is not judged here). */
  const refresh = run.refreshSessions()
  await tick()
  network.release('/api/sessions', answer(null, 500), true)
  await refresh
  /** L2: the next keystroke reads again, and its answer lands first. */
  const second = run.loadSearchIndex()
  await tick()
  answerRead(network, after, true)
  assert.equal(archivedIn(await second), true, 'the newer read sees the archive')
  /** L1 lands last, with the list from before the archive. */
  answerRead(network, before)
  const late = await first

  const held = run.held()
  assert.deepEqual(
    { searchIndex: archivedIn(held.searchIndex), heldIndex: archivedIn(held.heldIndex), answered: archivedIn(late) },
    { searchIndex: true, heldIndex: true, answered: true },
    'the index, the held index and the late caller all keep the archive; the older read replaced nothing',
  )
  assert.deepEqual(
    noted.map((list) => list.some((meta) => meta.archived === true)),
    [true],
    'the header was painted from the newer list only, never from the older one after it',
  )
})

test('N1: a read the refresh overtook, with no newer one, reads again rather than answering the list from before', async () => {
  const network = heldNetwork()
  const noted: Meta[][] = []
  const { run } = searchPage(network.fetch, noted)

  const first = run.loadSearchIndex()
  await tick()
  const refresh = run.refreshSessions()
  await tick()
  network.release('/api/sessions', answer(null, 500), true)
  await refresh
  /** The read from before the refresh lands. */
  answerRead(network, before)
  await tick()
  /** It is stale, so the index is read again; the server now answers with the archive. */
  if (network.waiting().length > 0) answerRead(network, after)
  const index = await first

  assert.equal(archivedIn(index), true, 'the caller gets the list from after the refresh')
  assert.equal(archivedIn(run.held().searchIndex), true, 'and that is the index kept')
  assert.ok(
    noted.every((list) => list.some((meta) => meta.archived === true)),
    `the header was never painted from the list from before the refresh\nsaw: ${JSON.stringify(noted.map((list) => list.map((meta) => meta.archived === true)))}`,
  )
})

/**
 * N2: the host ranks every session with a `cwd`, subagent children and archived ones included, and the page filters
 * after its twenty are cut. When hidden sessions fill those twenty, nothing is listed: "No matching sessions" is right,
 * and "Showing the first 20 results" beside it was not.
 */
test('N2: hidden sessions that fill the host\'s twenty rows leave "No matching sessions" alone, without "Showing the first 20"', async () => {
  const hidden = Array.from({ length: 20 }, (_, index) =>
    session(`s-hidden-${String(index).padStart(2, '0')}`, index + 1, index % 2 === 0 ? { title: `archived ${index}`, archived: true } : { title: `child ${index}`, origin: 'subagent' }),
  )
  const visible = session('s-visible', 30, { title: 'unrelated' })
  const sessions = [...hidden, visible]
  const route = (url: string): Reply => {
    if (url === '/api/sessions') return answer(sessions)
    if (url === '/api/tree') return tree
    if (url === '/api/workspaces') return answer({ workspaces: [workspace('/code/repo', sessions.map((meta) => meta.id))] })
    /** The host's first twenty are the hidden ones; a lower-ranked one, beyond them, is why it says more. */
    if (url.startsWith('/api/sessions/search')) return answer({ items: hidden.map((meta) => ({ sessionId: meta.id, snippet: 'the quokka ledger' })), hasMore: true })
    return answer(null, 404)
  }
  const { search } = searchPage(async (url) => route(url), [])
  assert.deepEqual(await search('quokka'), { hits: 0, note: 'No matching sessions', more: null })
})

test('N2: twenty rows shown and more found still say "Showing the first 20"', async () => {
  const shown = Array.from({ length: 20 }, (_, index) => session(`s-${String(index).padStart(2, '0')}`, index + 1, { title: `other ${index}` }))
  const route = (url: string): Reply => {
    if (url === '/api/sessions') return answer(shown)
    if (url === '/api/tree') return tree
    if (url === '/api/workspaces') return answer({ workspaces: [workspace('/code/repo', shown.map((meta) => meta.id))] })
    if (url.startsWith('/api/sessions/search')) return answer({ items: shown.map((meta) => ({ sessionId: meta.id, snippet: 'the quokka ledger' })), hasMore: true })
    return answer(null, 404)
  }
  const { search } = searchPage(async (url) => route(url), [])
  assert.deepEqual(await search('quokka'), { hits: 20, note: null, more: 'Showing the first 20 results. Narrow your search.' })
})

interface Reveal {
  open: (id: string) => Promise<void>
  reveal: (id: string) => Promise<void>
  setCurrent: (id: string) => void
  setTree: (groups: unknown[]) => void
  selected: () => string[]
  scrolled: () => string[]
}

/**
 * `openSearchResult` and `revealSession` with the tree's real rules (`chainTo`, `revealMark`). Every await they make —
 * the search redraw, `showSession`, `renderTree`, `toggle` — waits on the test, so another open can land inside it.
 */
function revealPage(options: { grouping: 'tree' | 'list'; groupOpen: boolean; drawnAfterRender?: string }) {
  const holds: { what: string; resolve: (value: unknown) => void }[] = []
  const hold = (what: string) => new Promise((resolve) => holds.push({ what, resolve }))
  const selected: string[] = []
  const scrolled: string[] = []
  const row = (id: string) => ({ scrollIntoView: () => scrolled.push(id) })
  const env = { hold, selected, scrolled, row, options }
  const page = new Function(
    'env',
    `const { hold, selected, scrolled, row, options } = env
    ${pure}
    let current = null
    let groupingMode = options.grouping
    let treeGroups = []
    let drawn = []
    const watermarks = new Map()
    const rowIndex = new Map()
    /** The latest list read, which \`openSearchResult\` asks whether a session is archived (#163): none is here. */
    const sessionMetas = new Map()
    const document = { getElementById: () => ({ value: '' }) }
    async function applySearch() {}
    async function showSession(id) { return hold('show:' + id) }
    async function renderTree() {
      await hold('renderTree')
      if (options.drawnAfterRender !== undefined) drawn = [options.drawnAfterRender]
      index()
    }
    async function toggle(node, li) {
      await hold('toggle')
      li.dataset.open = 'true'
    }
    function chooseSelected(path) { selected.push(path) }
    function paintSessionRows() {}
    const treeList = {
      querySelectorAll: () => drawn.map((id) => ({ dataset: { sessionId: id }, querySelector: () => row(id) })),
    }
    /** The rows drawn for the current groups: each group's row (open or closed), and each session's. */
    function index() {
      rowIndex.clear()
      for (const group of WorkspaceTree.flatten(treeGroups)) {
        rowIndex.set(group.workspace === null ? '#ungrouped' : group.path, {
          node: { path: group.path },
          li: { dataset: { open: options.groupOpen ? 'true' : 'false' }, querySelector: () => null, style: { getPropertyValue: () => '' } },
        })
        for (const meta of group.sessions) rowIndex.set('session:' + meta.id, { li: { querySelector: () => row(meta.id) } })
      }
    }
    ${source('openSearchResult')}
    ${source('revealSession')}
    return {
      open: openSearchResult,
      reveal: revealSession,
      setCurrent: (id) => { current = id },
      setTree: (groups) => { treeGroups = groups; index() },
      selected: () => [...selected],
      scrolled: () => [...scrolled],
      WorkspaceTree,
    }`,
  )(env) as Reveal & { WorkspaceTree: { deriveGroups: (workspaces: unknown[], sessions: unknown[], options?: unknown) => unknown[] } }
  /** Answer the oldest hold on `what`. */
  const release = async (what: string, value?: unknown) => {
    await tick()
    const at = holds.findIndex((entry) => entry.what === what)
    assert.ok(at >= 0, `something waits on ${what}; waiting: ${holds.map((entry) => entry.what).join(', ')}`)
    holds.splice(at, 1)[0]!.resolve(value)
    await tick()
  }
  const groups = page.WorkspaceTree.deriveGroups([workspace('/code/repo', ['s-a', 's-b'])], [session('s-a', 1, { title: 'A' }), session('s-b', 2, { title: 'B' })], {
    grouping: 'tree',
    archived: 'hide',
  })
  return { page, release, groups }
}

test('N3: a reveal whose group opens over an await stops when another session was opened meanwhile', async () => {
  const { page, release, groups } = revealPage({ grouping: 'tree', groupOpen: false })
  page.setTree(groups)
  page.setCurrent('s-a')
  const reveal = page.reveal('s-a')
  /** The group is opening (`toggle` → `loadChildren`); the reader clicks B's row in the tree. */
  page.setCurrent('s-b')
  await release('toggle')
  await reveal
  assert.deepEqual(page.selected(), [], "A's row is not selected while B is open")
  assert.deepEqual(page.scrolled(), [], 'nor scrolled to')
})

test('N3: a reveal that re-reads the tree stops when another session was opened meanwhile', async () => {
  const { page, release, groups } = revealPage({ grouping: 'tree', groupOpen: true })
  page.setCurrent('s-a')
  /** The tree does not draw A yet, so the reveal re-reads it; B opens during that read. */
  const reveal = page.reveal('s-a')
  page.setCurrent('s-b')
  page.setTree(groups)
  await release('renderTree')
  await reveal
  assert.deepEqual(page.selected(), [], "A's row is not selected while B is open")
})

test('N3: an open the next one replaced after it drew reveals nothing, though showSession answered true', async () => {
  const { page, release, groups } = revealPage({ grouping: 'tree', groupOpen: true })
  page.setTree(groups)
  const open = page.open('s-a')
  await tick()
  /** `showSession` drew A, then B's open took over before it returned (no generation check after its last reads). */
  page.setCurrent('s-b')
  await release('show:s-a', true)
  await open
  assert.deepEqual(page.selected(), [], "A's row is not selected while B is open")
})

test('N3: in the one-column list, a reveal that redraws the list stops when another session was opened meanwhile', async () => {
  const { page, release } = revealPage({ grouping: 'list', groupOpen: true, drawnAfterRender: 's-a' })
  page.setCurrent('s-a')
  const reveal = page.reveal('s-a')
  page.setCurrent('s-b')
  await release('renderTree')
  await reveal
  assert.deepEqual(page.scrolled(), [], "the list is not scrolled to A's row while B is open")
})

test('N3: with nothing in between, the reveal selects and scrolls to the row', async () => {
  const { page, release, groups } = revealPage({ grouping: 'tree', groupOpen: false })
  page.setTree(groups)
  const open = page.open('s-a')
  await tick()
  page.setCurrent('s-a')
  await release('show:s-a', true)
  await release('toggle')
  await open
  assert.deepEqual(page.selected(), ['session:s-a'], 'the opened row is selected')
  assert.deepEqual(page.scrolled(), ['s-a'], 'and scrolled into view')
})

test('N4: a one-column list that could not read the sessions still lets go of the keyboard place it held', async () => {
  const notes: string[] = []
  const painted: string[] = []
  const body = {}
  const place = { row: 'session:s-a', control: 'row' }
  const env = { notes, painted, body, place }
  const page = new Function(
    'env',
    `const { notes, painted, body, place } = env
    let heldTreeFocus = null
    let treeGeneration = 0
    let treeLanded = 0
    let archiveMode = 'hide'
    let current = null
    const document = { activeElement: body, body }
    const CSS = { escape: (text) => text }
    const treeList = { replaceChildren() {}, querySelector: () => null }
    const rowIndex = new Map()
    function treeFocus() { return place }
    async function loadSearchIndex() { return null }
    function setNote(text) { notes.push(text) }
    function paintEmptyList(empty) { painted.push('empty:' + JSON.stringify(empty)) }
    function paintConversationTarget() { painted.push('target') }
    ${source('restoreTreeFocus')}
    ${source('renderFlatList')}
    return { renderFlatList, held: () => heldTreeFocus }`,
  )(env) as { renderFlatList: () => Promise<void>; held: () => unknown }
  await page.renderFlatList()
  assert.equal(page.held(), null, 'the redraw ended, so no later redraw gives back its stale place')
  assert.deepEqual(notes, ['could not read the sessions'], 'the list says it could not read them')
  assert.deepEqual(painted, ['target'], 'the new conversation\'s place is repainted, and no empty-list placeholder claims there are no sessions')
})

test('N5: "filter archived sessions" in the archive notice redraws a standing search under the filter it switched to', async () => {
  const { document } = fakeDocument(['archive-notice'])
  const log: string[] = []
  const env = { document, log }
  const page = new Function(
    'env',
    `const { document, log } = env
    ${pure}
    let archiveMode = 'hide'
    const archiveNotice = document.getElementById('archive-notice')
    let archiveNoticeTimer = null
    const setTimeout = () => 1
    const clearTimeout = () => undefined
    function rememberArchived() { log.push('remember ' + archiveMode) }
    async function renderTree() { log.push('renderTree ' + archiveMode) }
    async function applySearch() { log.push('applySearch ' + archiveMode) }
    async function setSessionFlags() { log.push('flags') ; return { ok: true } }
    ${source('showArchiveNotice')}
    return { showArchiveNotice, archiveNotice, mode: () => archiveMode }`,
  )(env) as { showArchiveNotice: (kind: string, node?: unknown) => void; archiveNotice: FakeElement; mode: () => string }
  page.showArchiveNotice('archived', { kind: 'session', session: { id: 's-old' } })
  const filter = page.archiveNotice.children.find((part) => part.dataset.action === 'filter')
  assert.ok(filter !== undefined, 'under Hide archived the notice offers the filter')
  await filter.listeners.get('click')!()
  assert.equal(page.mode(), 'show', 'the filter now shows archived sessions')
  assert.deepEqual(log, ['remember show', 'renderTree show', 'applySearch show'], 'the tree is redrawn, then the search, both under the new filter')
})

test('M1: a read the refresh overtook shares the read in flight for the newer list, and no third set of requests starts', async () => {
  const network = heldNetwork()
  const noted: Meta[][] = []
  const { run } = searchPage(network.fetch, noted)
  const asked = (url: string) => network.waiting().filter((waiting) => waiting === url).length

  /** L1 reads the index; a refresh makes it stale; L2, the next keystroke, reads the newer list. */
  const first = run.loadSearchIndex()
  await tick()
  const refresh = run.refreshSessions()
  await tick()
  network.release('/api/sessions', answer(null, 500), true)
  await refresh
  const second = run.loadSearchIndex()
  await tick()
  assert.equal(asked('/api/tree'), 2, 'two reads are out: L1, from before the refresh, and L2')

  /** L1 lands, stale, while L2 is still out: it waits for L2 rather than asking a third time. */
  answerRead(network, before)
  await tick()
  assert.equal(asked('/api/tree'), 1, `L1 asked nothing more; only L2 is still out\nwaiting: ${JSON.stringify(network.waiting())}`)
  answerRead(network, after)
  const [late, fresh] = await Promise.all([first, second])
  assert.equal(archivedIn(fresh), true, 'L2 answers the newer list')
  assert.equal(late, fresh, 'and L1 answers the same index, not one of its own')
  assert.deepEqual(network.waiting(), [], 'nothing is left waiting')

  /** Two keystrokes in one refresh share one read too. */
  const refreshAgain = run.refreshSessions()
  await tick()
  network.release('/api/sessions', answer(null, 500), true)
  await refreshAgain
  const third = run.loadSearchIndex()
  const fourth = run.loadSearchIndex()
  await tick()
  assert.equal(asked('/api/tree'), 1, 'one read for both')
  answerRead(network, after)
  assert.equal(await third, await fourth)
})

/**
 * #151: the hits were rebuilt with `replaceChildren` on every redraw — the host's content answer 250 ms after the last
 * keystroke, and the tree's `toggle` re-applying a standing search — so a press on a hit (or its Unarchive button) and its
 * release landed on two different elements, and the browser fired no click. DSH's result list is keyed by session
 * (dsh-client-ui-workspace, a React list), so its rows survive the update. The fake document counts every time an element
 * is taken out of the list, which is what loses the click.
 */
const kestrel = [session('s-plan', 1, { title: 'Kestrel plan' }), session('s-old', 2, { title: 'Kestrel old', archived: true })]
function kestrelRoute(contentItems: { sessionId: string; snippet: string }[]) {
  return async (url: string): Promise<Reply> => {
    if (url === '/api/sessions') return answer(kestrel)
    if (url === '/api/tree') return tree
    if (url === '/api/workspaces') return answer({ workspaces: [workspace('/code/repo', kestrel.map((meta) => meta.id))] })
    if (url.startsWith('/api/sessions/search')) return answer({ items: contentItems, hasMore: false })
    return answer(null, 404)
  }
}

test('#151: the content answer redraws the hits in place: each hit, and an archived hit\'s Unarchive button, is the element it was', async () => {
  const { run, settle, registry } = searchPage(kestrelRoute([{ sessionId: 's-plan', snippet: 'the Kestrel plan, revised' }]), [], { archive: 'show' })
  const results = registry.get('search-results')!
  registry.get('session-search')!.value = 'Kestrel'
  await run.applySearch()
  const drawn = [...results.children]
  assert.deepEqual(
    drawn.map((hit) => hit.children[0]?.textContent),
    ['Kestrel old', 'Kestrel plan'],
    'the name matches are drawn at once, newest first',
  )
  const restore = drawn[0]!.children.find((part) => part.className === 'hit-unarchive')
  assert.ok(restore !== undefined, 'the archived hit carries its Unarchive button')

  /** A press goes down on the hit and on the button here; the host answers 250 ms later and the hits redraw. */
  await settle()
  assert.deepEqual([...results.children], drawn, 'the same elements, in the same places')
  assert.deepEqual(
    drawn.map((hit) => hit.detached),
    [0, 0],
    'neither hit was ever taken out of the list, so a release on it is a click on it',
  )
  assert.equal(drawn[0]!.children.includes(restore), true, 'the Unarchive button is the one the press went down on')
  assert.equal(restore.detached, 0)
  const snippet = drawn[1]!.children.find((part) => part.className === 'hit-snippet')
  assert.equal(snippet?.textContent, 'the Kestrel plan, revised', 'and the host\'s snippet joins the hit it belongs to')

  /** The tree's toggle re-applies a standing search: one more redraw, the same elements again. */
  await run.applySearch()
  assert.deepEqual([...results.children], drawn)
  assert.deepEqual(drawn.map((hit) => hit.detached), [0, 0])
  assert.equal(drawn[1]!.children.filter((part) => part.className === 'hit-snippet').length, 1, 'the snippet is not added twice')
})

test('#151: a hit that leaves is taken out, a new one comes in, and the hits that stay are not moved', async () => {
  const { run, settle, registry } = searchPage(kestrelRoute([]), [], { archive: 'show' })
  const results = registry.get('search-results')!
  registry.get('session-search')!.value = 'Kestrel'
  await run.applySearch()
  await settle()
  const [old, plan] = [...results.children]
  registry.get('session-search')!.value = 'Kestrel plan'
  await run.applySearch()
  await settle()
  assert.deepEqual([...results.children], [plan], 'only the plan is left, and it is the element it was')
  assert.equal(plan!.detached, 0, 'never taken out')
  assert.equal(old!.parent, null, 'the old hit is gone from the list')
  registry.get('session-search')!.value = 'Kestrel'
  await run.applySearch()
  await settle()
  const again = [...results.children]
  assert.equal(again[1], plan, 'the plan keeps its element when the old one comes back above it')
  assert.equal(plan!.detached, 0, 'and is not moved for it')
  assert.deepEqual(again.map((hit) => hit.children[0]?.textContent), ['Kestrel old', 'Kestrel plan'])

  /** An empty query puts the search away; the next one draws fresh elements. */
  registry.get('session-search')!.value = ''
  await run.applySearch()
  assert.equal(results.children.length, 0)
})

/**
 * #151's check found the archived hit's Unarchive button laid out past its row's right edge (the row 12-340, the button
 * at 342-362), so the point at its centre was another element and no press reached it. The workspace label was
 * `flex: none` with no cap, so a long workspace name — the verifiers' fixture folders are `<label>-<pid>-<token>-<n>` —
 * pushed the row's controls out; main has had that rule since the search first named its hits. DSH caps its label
 * (`searchResultWorkspace`: one line, `max-width: 40%`, cut with an ellipsis, dsh-client-ui-workspace lib/client.js:1741)
 * and keeps its row actions `flex: none`, so they stay inside the row.
 */
test('#151: a search hit keeps its Unarchive button inside the row: the workspace label is capped and cut as DSH cuts it', () => {
  const rule = (selector: string) => {
    const at = page.indexOf(`${selector} {`)
    assert.ok(at > 0, `the page styles ${selector}`)
    const body = page.slice(page.indexOf('{', at) + 1, page.indexOf('}', at))
    return Object.fromEntries(
      body
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.includes(':'))
        .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]),
    ) as Record<string, string>
  }
  const label = rule('#search-results .hit-workspace')
  assert.equal(label['max-width'], '40%', "DSH's cap on the workspace label")
  assert.deepEqual([label.overflow, label['text-overflow'], label['white-space']], ['hidden', 'ellipsis', 'nowrap'], 'one line, cut with an ellipsis')
  const title = rule('#search-results .hit-title')
  assert.equal(title['min-width'], '0', 'the title gives way first')
  assert.match(String(title.flex), /^1 1 /, 'and shrinks')
  assert.equal(rule('#search-results .hit-unarchive').flex, 'none', 'the button keeps its size, so it stays whole inside the row')
})
