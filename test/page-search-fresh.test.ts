import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * #163: the sidebar search follows the live list, as DSH's does. DSH derives its rows from the list on every change
 * (`deriveSearchResults` is a `useMemo` over the session list, the workspaces, the query, the archived ids and the filter,
 * dsh-client-ui-workspace lib/client.js:3451-3460), so a rename, an archive or a workspace rename shows in a standing
 * search at once, and choosing a row checks the archived ids first (`openSearchResult`, :3664-3668). Heddle's search runs
 * over a cached index, and before this:
 * - the stream's `sessions` and `workspace` frames redrew the tree but kept the index, so another client's rename kept the
 *   old title in the hits, even after the query was typed again, and a workspace rename kept the old place label;
 * - this page's own archive, unarchive and rename dropped the index but did not redraw the search on screen;
 * - choosing a hit drawn before an archive opened the session.
 *
 * Each test runs the page's own code, cut out of `page.html` (`HEDDLE_TEST_PAGE` names another page, for the red run):
 * the search (index, `applySearch`, the host request), `refreshSessions`, the stream's list handlers and the tree's
 * debounce, `archiveSession` → `setSessionFlags`, `confirmSessionRename` and `openSearchResult`, against a small server of
 * its own that the test changes as a second client would.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

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
  parent: FakeElement | null = null
  /** How many times this element was taken out of the element holding it (#151: what loses a click). */
  detached = 0
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
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

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove()
      this.children.push(node)
      node.parent = this
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of [...this.children]) child.remove()
    this.append(...nodes)
  }

  after(node: FakeElement): void {
    if (node.id !== '') this.registry.set(node.id, node)
  }
}

interface Meta {
  id: string
  cwd: string
  created: string
  updated: string
  turns: number
  title?: string
  archived?: boolean
}

function session(id: string, minute: number, title: string): Meta {
  const at = `2026-10-31T10:${String(minute).padStart(2, '0')}:00.000Z`
  return { id, cwd: '/code/repo', created: at, updated: at, turns: 1, title }
}

interface Workspace {
  id: string
  path: string
  title: string
  origin: string
  parent: null
  createdAt: string
  updatedAt: string
  sessionIds: string[]
}

/** The server the page talks to. The test changes it as a second client would, then sends the frame that client causes. */
function server() {
  const sessions: Meta[] = [session('s-alpha', 1, 'quokka alpha'), session('s-beta', 2, 'quokka beta'), session('s-gamma', 3, 'quokka gamma'), session('s-other', 4, 'unrelated')]
  const workspaces: Workspace[] = [
    {
      id: 'w-repo',
      path: '/code/repo',
      title: 'repo',
      origin: 'added',
      parent: null,
      createdAt: '2026-10-31T00:00:00.000Z',
      updatedAt: '2026-10-31T00:00:00.000Z',
      sessionIds: sessions.map((meta) => meta.id),
    },
  ]
  const find = (id: string) => {
    const meta = sessions.find((entry) => entry.id === id)
    assert.ok(meta !== undefined, `the server holds ${id}`)
    return meta
  }
  return {
    sessions,
    workspaces,
    rename: (id: string, title: string) => {
      find(id).title = title
    },
    archive: (id: string, archived = true) => {
      find(id).archived = archived
    },
    /** Every request, by URL; a copy of each answer, so the page never holds the server's own objects. */
    asked: [] as string[],
  }
}

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> }
const answer = (body: unknown, status = 200): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) })

interface Harness {
  applySearch: () => Promise<void>
  openSearchResult: (id: string) => Promise<void>
  archiveSession: (node: unknown) => Promise<unknown>
  confirmSessionRename: () => Promise<void>
  beginRename: (node: unknown, title: string) => void
  noteSessions: (list: unknown) => void
  handlers: Map<string, (message?: unknown) => unknown>
}

/**
 * The page's search with everything around it that follows the list. `renderTree` is a stand-in that draws nothing and
 * does not re-apply the search (a redraw that reopens no group does not), so what the hits show is the search's own doing.
 */
function searchPage(options: { archive?: 'hide' | 'show' } = {}) {
  const world = server()
  const registry = new Map<string, FakeElement>()
  for (const id of ['session-search', 'search-results', 'search-note', 'search-more', 'session-rename-input', 'session-rename-confirm']) {
    const made = new FakeElement(registry)
    made.id = id
    registry.set(id, made)
  }
  const document = {
    getElementById: (id: string) => registry.get(id) ?? null,
    createElement: () => new FakeElement(registry),
    createTextNode: (text: string) => Object.assign(new FakeElement(registry), { textContent: text }),
  }
  const fetch = async (url: string, init: { method?: string; body?: string } = {}): Promise<Reply> => {
    world.asked.push(url)
    const action = /^\/api\/sessions\/([^/]+)\/(flags|title)$/.exec(url)
    if (action !== null && init.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as { archived?: boolean; title?: string }
      if (action[2] === 'flags' && typeof body.archived === 'boolean') world.archive(action[1]!, body.archived)
      if (action[2] === 'title' && typeof body.title === 'string') world.rename(action[1]!, body.title)
      return answer({ ok: true })
    }
    if (url === '/api/sessions') return answer(world.sessions)
    if (url === '/api/tree') return answer({ children: [{ path: '/code/repo', label: 'repo' }] })
    if (url === '/api/workspaces') return answer({ workspaces: world.workspaces })
    if (url.startsWith('/api/sessions/search')) return answer({ items: [], hasMore: false })
    return answer(null, 404)
  }
  /** Timers by id: the host's 250 ms debounce and the tree's 400 ms one, run by `settle`. */
  const timers = new Map<number, () => void>()
  let timerId = 0
  const seen = { notices: [] as string[], shown: [] as string[], trees: 0 }
  const treeList = new FakeElement(registry)
  const env = {
    document,
    fetch,
    treeList,
    seen,
    setTimeout: (callback: () => void) => {
      timerId += 1
      timers.set(timerId, callback)
      return timerId
    },
    clearTimeout: (id: number) => {
      timers.delete(id)
    },
  }
  const run = new Function(
    'env',
    `const { document, fetch, treeList, seen, setTimeout, clearTimeout } = env
    ${block('session-rules')}
    ${block('workspace-tree')}
    ${block('content-search')}
    ${block('session-archive')}
    ${block('session-action-failure')}
    let archiveMode = ${JSON.stringify(options.archive ?? 'hide')}
    let groupingMode = 'tree'
    let treeGroups = []
    let current = null
    let runningTick = 0
    let sessionMetas = new Map()
    const listedMetas = new Map()
    const runningSessions = new Set()
    const runningMarkedAt = new Map()
    const runningSince = new Map()
    const turnRounds = new Map()
    const queues = new Map()
    const turnVerdicts = { endIdle() {} }
    const definitionOf = new Map()
    const window = { confirm: () => false }
    const relativeAge = () => '7min'
    const kindIcon = () => document.createElement('svg')
    /** Every read of the list passes through here, as the page's does: the latest list is what the page knows. */
    function noteSessions(list) {
      if (Array.isArray(list)) sessionMetas = new Map(list.map((meta) => [meta.id, meta]))
    }
    function paintComposerAccess() {}
    function paintRunningMarks() {}
    function refreshRunningStatus() {}
    function noteCompletion() {}
    function settleChat() {}
    async function renderSettledAnswers() {}
    async function pumpQueue() {}
    function renderComposerState() {}
    function paintSessionHeading() {}
    function setNote() {}
    function showSessionToast() {}
    function captureRowBoxes() { return null }
    function glideRows() {}
    function clearMain() {}
    function definitionFolder() { return undefined }
    function openStopAndArchive() {}
    async function renderTree() { seen.trees += 1 }
    function showArchiveNotice(kind) { seen.notices.push(kind) }
    async function showSession(id) { seen.shown.push(id); current = id; return true }
    async function revealSession() {}
    let sessionRenameTarget = null
    const sessionRenameDialog = { open: true, close() {} }
    function refreshSessionRename() {}
    function setSessionRenameBusy() {}
    function dialogError() {}
    const handlers = new Map()
    const events = { addEventListener: (type, listener) => handlers.set(type, listener) }
    ${region('let searchIndex = null', 'async function openSearchResult(')}
    ${source('openSearchResult')}
    ${source('notifyArchivedNotOpenable')}
    ${source('refreshSessions')}
    ${source('archiveSession')}
    ${source('setSessionFlags')}
    ${source('confirmSessionRename')}
    ${region("/**\n * Changes that never reach a session's log", "events.addEventListener('reset'")}
    let treeRefreshTimer = 0
    ${source('scheduleTreeRefresh')}
    return {
      applySearch,
      openSearchResult,
      archiveSession,
      confirmSessionRename,
      beginRename: (node, title) => {
        sessionRenameTarget = { node, busy: false }
        document.getElementById('session-rename-input').value = title
      },
      noteSessions,
      handlers,
    }`,
  )(env) as Harness

  /** Let every answer and every timer run, until nothing is left. */
  const settle = async () => {
    for (let round = 0; round < 30; round += 1) {
      await tick(2)
      const due = [...timers.entries()]
      timers.clear()
      for (const [, callback] of due) callback()
    }
  }
  const results = registry.get('search-results')!
  const field = registry.get('session-search')!
  /** Type a query, as the search box's input event does, and let everything it starts finish. */
  const search = async (query: string) => {
    field.value = query
    await run.applySearch()
    await settle()
  }
  /** What the hits show: each one's title and its place label. */
  const hits = () =>
    results.children.map((hit) => ({
      title: hit.children.find((part) => part.className === 'hit-title')?.textContent,
      place: hit.children.find((part) => part.className === 'hit-workspace')?.textContent,
      archived: hit.dataset.archived === 'true',
    }))
  const titles = () => hits().map((hit) => hit.title)
  const hitFor = (title: string) => {
    const hit = results.children.find((element) => element.children.find((part) => part.className === 'hit-title')?.textContent === title)
    assert.ok(hit !== undefined, `a hit reads ${title}; the hits read ${JSON.stringify(titles())}`)
    return hit
  }
  /** A frame from the server's stream, as `EventSource` delivers it. */
  const frame = (type: 'sessions' | 'workspace', data: unknown) => {
    const listener = run.handlers.get(type)
    assert.ok(listener !== undefined, `the page listens for ${type} frames`)
    listener({ data: JSON.stringify(data) })
  }
  const node = (id: string) => {
    const meta = world.sessions.find((entry) => entry.id === id)!
    return { kind: 'session', session: structuredClone(meta), archived: meta.archived === true, pinned: false }
  }
  const reads = () => world.asked.filter((url) => url === '/api/tree').length
  return { run, world, seen, settle, search, hits, titles, hitFor, frame, node, reads, field, results }
}

test('the page code under test is found', () => {
  for (const name of ['applySearch', 'loadSearchIndex', 'openSearchResult', 'refreshSessions', 'archiveSession', 'setSessionFlags', 'confirmSessionRename', 'scheduleTreeRefresh']) source(name)
  region("/**\n * Changes that never reach a session's log", "events.addEventListener('reset'")
})

test('#163 (a): another client renames a session, and the sessions frame redraws a standing search with the new title, in the hit it had', async () => {
  const page = searchPage()
  await page.search('quokka')
  assert.deepEqual(page.titles(), ['quokka gamma', 'quokka beta', 'quokka alpha'], 'three hits, newest first')
  const drawn = [...page.results.children]

  page.world.rename('s-gamma', 'quokka renamed elsewhere')
  page.frame('sessions', { type: 'session/renamed', session: 's-gamma', title: 'quokka renamed elsewhere' })
  await page.settle()
  assert.deepEqual(page.titles(), ['quokka renamed elsewhere', 'quokka beta', 'quokka alpha'], 'the standing search shows the new title, without a keystroke')
  assert.deepEqual([...page.results.children], drawn, 'each hit is the element it was (#151): the title changed inside it')
  assert.deepEqual(
    drawn.map((hit) => hit.detached),
    [0, 0, 0],
    'and no hit was taken out of the list, so a press on one still lands',
  )

  /** Typed again, the query runs over the newer list too: the index was dropped, not only the hits redrawn. */
  await page.search('')
  await page.search('quokka')
  assert.deepEqual(page.titles(), ['quokka renamed elsewhere', 'quokka beta', 'quokka alpha'], 'retyping shows the new title')
})

test('#163 (a): a list change reads the index once, shared with a keystroke before the debounce, and redraws nothing when the hits did not change', async () => {
  const page = searchPage()
  await page.search('quokka')
  assert.equal(page.reads(), 1, 'the first search read the index')

  /** A session outside the hits is renamed elsewhere; a keystroke for the same query lands before the tree's debounce. */
  page.world.rename('s-other', 'still unrelated')
  page.frame('sessions', { type: 'session/renamed', session: 's-other', title: 'still unrelated' })
  page.field.value = 'quokka'
  void page.run.applySearch()
  await page.settle()
  assert.equal(page.reads(), 2, `one more read for the change: the follow shared the keystroke's (M1)\nasked: ${JSON.stringify(page.world.asked)}`)

  /** Another change that leaves the hits as they are: the newer list is read, and nothing on screen is redrawn. */
  const handlers = page.results.children.map((hit) => hit.onclick)
  const drawn = [...page.results.children]
  page.world.rename('s-other', 'unrelated again')
  page.frame('sessions', { type: 'session/renamed', session: 's-other', title: 'unrelated again' })
  await page.settle()
  assert.equal(page.reads(), 3, 'the newer list was read')
  assert.deepEqual([...page.results.children], drawn, 'the same hits')
  assert.deepEqual(
    page.results.children.map((hit) => hit.onclick),
    handlers,
    'and not one was drawn again: a redraw sets every hit\'s handler anew',
  )
})

test('#163 (b): this page archives a hit under Hide archived, and the standing search drops it; unarchiving brings it back', async () => {
  const page = searchPage({ archive: 'hide' })
  await page.search('quokka')
  assert.deepEqual(page.titles(), ['quokka gamma', 'quokka beta', 'quokka alpha'])

  await page.run.archiveSession(page.node('s-beta'))
  await page.settle()
  assert.deepEqual(page.seen.notices, ['archived'], 'the archive notice shows')
  assert.equal(page.world.sessions.find((meta) => meta.id === 's-beta')?.archived, true, 'the server archived it')
  assert.deepEqual(page.titles(), ['quokka gamma', 'quokka alpha'], 'and the archived session left the hits, without a keystroke')

  await page.run.archiveSession(page.node('s-beta'))
  await page.settle()
  assert.equal(page.world.sessions.find((meta) => meta.id === 's-beta')?.archived, false, 'the server unarchived it')
  assert.deepEqual(page.titles(), ['quokka gamma', 'quokka beta', 'quokka alpha'], 'and it is a hit again')
})

test('#163 (b): this page renames a hit, and the standing search shows the new title', async () => {
  const page = searchPage()
  await page.search('quokka')
  page.run.beginRename(page.node('s-alpha'), 'quokka renamed here')
  await page.run.confirmSessionRename()
  await page.settle()
  assert.equal(page.world.sessions.find((meta) => meta.id === 's-alpha')?.title, 'quokka renamed here', 'the server renamed it')
  assert.deepEqual(page.titles(), ['quokka gamma', 'quokka beta', 'quokka renamed here'])
})

test('#163 (c): choosing a hit whose session the latest list says is archived shows the not-openable notice and opens nothing', async () => {
  const page = searchPage({ archive: 'hide' })
  await page.search('quokka')
  const stale = page.hitFor('quokka beta')
  assert.equal(stale.dataset.archived, undefined, 'the hit was drawn as an ordinary one')

  /** The session was archived, and the page has read the list since (the tree's read), but the hit is still on screen. */
  page.world.archive('s-beta')
  page.run.noteSessions(structuredClone(page.world.sessions))
  await (stale.onclick as () => Promise<void>)()
  await page.settle()
  assert.deepEqual(page.seen.notices, ['archivedNotOpenable'], 'DSH\'s "Archived sessions cannot be opened" notice')
  assert.deepEqual(page.seen.shown, [], 'nothing was opened')
  assert.equal(page.field.value, 'quokka', 'the query stays, as DSH keeps it')
  assert.equal(page.results.hidden, false, 'and so do the results')

  /** A live hit still opens: the query is put away and the session is shown. */
  await (page.hitFor('quokka alpha').onclick as () => Promise<void>)()
  await page.settle()
  assert.deepEqual(page.seen.shown, ['s-alpha'])
  assert.equal(page.field.value, '')
})

test('#163 (d): another client renames the workspace, and the workspace frame redraws the hits\' place label', async () => {
  const page = searchPage()
  await page.search('quokka')
  assert.deepEqual(
    page.hits().map((hit) => hit.place),
    ['repo · 7min', 'repo · 7min', 'repo · 7min'],
    'each hit names its workspace',
  )
  const drawn = [...page.results.children]

  page.world.workspaces[0]!.title = 'Garden'
  page.frame('workspace', { type: 'workspace/renamed', workspace: page.world.workspaces[0] })
  await page.settle()
  assert.deepEqual(
    page.hits().map((hit) => hit.place),
    ['Garden · 7min', 'Garden · 7min', 'Garden · 7min'],
    'the standing search names the workspace by its new name',
  )
  assert.deepEqual([...page.results.children], drawn, 'in the hits it had')

  await page.search('')
  await page.search('quokka')
  assert.deepEqual(
    page.hits().map((hit) => hit.place),
    ['Garden · 7min', 'Garden · 7min', 'Garden · 7min'],
    'and so does the query typed again',
  )
})
