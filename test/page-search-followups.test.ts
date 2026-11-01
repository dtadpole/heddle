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
 *   #189 (J170) revised it: that left a cut list looking complete. The page now sends its archive filter so the host
 *   skips hidden sessions before its cut, and a list the host still cut says so whatever its length — never beside
 *   "No matching sessions", which stays alone when the host found no more.
 * - N3: revealing a search hit stops once another session became the open one during any of its awaits.
 * - N4: a one-column list that could not read the sessions still ends its redraw: the held keyboard place is let go.
 * - N5: the archive notice's "filter archived sessions" redraws a standing search under the filter it switched to.
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
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, (event?: unknown) => unknown>()
  readonly registry: Map<string, FakeElement>

  constructor(registry: Map<string, FakeElement>) {
    this.registry = registry
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
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = nodes
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
  /** Choose the archive filter, as View options does before it redraws a standing search. */
  setArchived: (mode: string) => void
}

/**
 * The search's own code — from `let searchIndex = null` to `openSearchResult`, which holds the index, `applySearch` and
 * the host request — and `refreshSessions`, which is where the index goes stale. `fetch` is the test's.
 */
function searchPage(fetch: (url: string) => Promise<Reply>, noted: Meta[][]) {
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
    let archiveMode = 'hide'
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
    return { applySearch, loadSearchIndex, refreshSessions, held: () => ({ searchIndex, heldIndex }), setArchived: (mode) => { archiveMode = mode } }`,
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
  return { run, search }
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
 * #189 (J170), after N2. A host that ranks every session with a `cwd` and fills its twenty with hidden ones — DSH's
 * host, or this one asked without the filter — cuts a visible match before the page sees it. N2 had this list say
 * "No matching sessions" alone, which read as complete; it was cut, and now says so with DSH's sentence instead.
 */
test('#189: hidden sessions that fill the host\'s twenty, with more found, say the list was cut rather than "No matching sessions"', async () => {
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
  assert.deepEqual(await search('quokka'), { hits: 0, note: null, more: 'Showing the first 20 results. Narrow your search.' })
})

test('N2 kept: hidden hits and no more found leave "No matching sessions" alone, with no "Showing the first 20" beside it', async () => {
  const hidden = Array.from({ length: 5 }, (_, index) => session(`s-hidden-${index}`, index + 1, { title: `archived ${index}`, archived: true }))
  const route = (url: string): Reply => {
    if (url === '/api/sessions') return answer(hidden)
    if (url === '/api/tree') return tree
    if (url === '/api/workspaces') return answer({ workspaces: [workspace('/code/repo', hidden.map((meta) => meta.id))] })
    if (url.startsWith('/api/sessions/search')) return answer({ items: hidden.map((meta) => ({ sessionId: meta.id, snippet: 'the quokka ledger' })), hasMore: false })
    return answer(null, 404)
  }
  const { search } = searchPage(async (url) => route(url), [])
  assert.deepEqual(await search('quokka'), { hits: 0, note: 'No matching sessions', more: null })
})

/**
 * #189: the request carries the archive filter, and the host answers only the rows it shows — so another filter is
 * another question. One visible match and 21 archived ones that outrank it, answered the way the host now answers.
 */
test('#189: the search asks with the archive filter, and choosing another filter asks the host again', async () => {
  const visible = session('s-visible', 30, { title: 'plain note 0' })
  const archived = Array.from({ length: 21 }, (_, index) => session(`s-archived-${String(index).padStart(2, '0')}`, index + 1, { title: `plain note ${index + 1}`, archived: true }))
  const sessions = [visible, ...archived]
  const asked: string[] = []
  const route = (url: string): Reply => {
    if (url === '/api/sessions') return answer(sessions)
    if (url === '/api/tree') return tree
    if (url === '/api/workspaces') return answer({ workspaces: [workspace('/code/repo', sessions.map((meta) => meta.id))] })
    if (url.startsWith('/api/sessions/search')) {
      asked.push(url)
      const filter = new URL(url, 'http://page.test').searchParams.get('archived')
      const rows = filter === 'show' ? [...archived, visible] : filter === 'only' ? archived : filter === 'hide' ? [visible] : archived
      return answer({ items: rows.slice(0, 20).map((meta) => ({ sessionId: meta.id, snippet: 'zorbliquant noted' })), hasMore: rows.length > 20 })
    }
    return answer(null, 404)
  }
  const { run, search } = searchPage(async (url) => route(url), [])
  assert.deepEqual(await search('zorbliquant'), { hits: 1, note: null, more: null }, 'Hide archived: the visible match, and nothing more')
  assert.deepEqual(asked, ['/api/sessions/search?q=zorbliquant&archived=hide'])
  assert.deepEqual(await search('zorbliquant'), { hits: 1, note: null, more: null }, 'the same query under the same filter asks nothing')
  assert.equal(asked.length, 1)
  run.setArchived('show')
  assert.deepEqual(await search('zorbliquant'), { hits: 20, note: null, more: 'Showing the first 20 results. Narrow your search.' }, 'Show archived: twenty rows, and the list was cut')
  assert.deepEqual(asked, ['/api/sessions/search?q=zorbliquant&archived=hide', '/api/sessions/search?q=zorbliquant&archived=show'])
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
