import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The sidebar search when a read fails (#58), judged by running the page's own search code.
 *
 * DSH computes the title and workspace matches over the session list the client already holds, so they appear even when
 * the network does not (dsh-client-ui-workspace `deriveSearchResults`, `lib/client.js:1169-1187`); only the content
 * request can fail, and "a failed content search leaves metadata matches visible without an additional warning" (its
 * README, Search). The page used to keep a failed `/api/sessions` read as an empty index: the search said
 * `No matching sessions` beside a tree full of them, and kept saying it after the network was back.
 *
 * The code from `let searchIndex = null` up to `openSearchResult`, and the one-column list (`renderFlatList`), are cut
 * out of `page.html` and run against a small stand-in for the document and for `fetch`, with the workspace tree's real
 * block, so this fails when the page's own functions do.
 *
 * The same code also says which workspace a session is in (#57), which is judged at the end: a session in a workspace
 * registered inside another one is named after that nested workspace, not the top-level root.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

/** A marked block of the page, or nothing when the page has no such block (content search is a later branch). */
const block = (name: string): string => {
  const begin = page.indexOf(`/* ${name}:begin */`)
  const end = page.indexOf(`/* ${name}:end */`)
  return begin > 0 && end > begin ? page.slice(begin, end) : ''
}

const searchBegin = page.indexOf('let searchIndex = null')
const searchEnd = page.indexOf('async function openSearchResult(')
const flatBegin = page.indexOf('async function renderFlatList(')
const flatEnd = page.indexOf('async function renderTree(')

interface Group {
  sessions: { id: string }[]
}

interface Tree {
  deriveGroups: (workspaces: unknown[], sessions: unknown[], options?: Record<string, unknown>) => Group[]
}

const pureBlocks = `${block('workspace-tree')}\n${block('content-search')}`
const libraries = new Function(
  `${pureBlocks}\nreturn { WorkspaceTree, ContentSearch: typeof ContentSearch === 'undefined' ? undefined : ContentSearch, workspaceDisplayTitle: typeof workspaceDisplayTitle === 'undefined' ? (title) => title : workspaceDisplayTitle }`,
)() as {
  WorkspaceTree: Tree
  ContentSearch: unknown
  workspaceDisplayTitle: (title: string) => string
}

/** As much of an element as the search code touches. */
class FakeElement {
  id = ''
  hidden = false
  textContent = ''
  value = ''
  className = ''
  type = ''
  maxLength = 0
  tabIndex = -1
  onclick: unknown = null
  children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
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

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> }
type Route = (url: string) => Reply | Promise<Reply>

const answer = (body: unknown, status = 200): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const offline = (): Promise<Reply> => Promise.reject(new TypeError('Failed to fetch'))

/** A page with its search code loaded: the tree it drew, and a network the test controls request by request. */
function loadPage(options: { treeGroups: Group[]; route: Route; grouping?: string }) {
  const registry = new Map<string, FakeElement>()
  const element = (id: string) => {
    const made = new FakeElement(registry)
    made.id = id
    registry.set(id, made)
    return made
  }
  for (const id of ['session-search', 'search-results', 'search-note', 'search-more']) element(id)
  const document = {
    getElementById: (id: string) => registry.get(id) ?? null,
    createElement: () => new FakeElement(registry),
  }
  const requests: string[] = []
  const fetch = (url: string) => {
    requests.push(url)
    try {
      return Promise.resolve(options.route(url))
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const timers: (() => void)[] = []
  const treeList = new FakeElement(registry)
  const body = `${page.slice(searchBegin, searchEnd)}\n${page.slice(flatBegin, flatEnd)}`
  const run = new Function(
    'document',
    'fetch',
    'treeList',
    'WorkspaceTree',
    'ContentSearch',
    'archiveMode',
    'groupingMode',
    'treeGroups',
    'sessionLabel',
    'relativeAge',
    'openSearchResult',
    'setTimeout',
    'clearTimeout',
    'rowIndex',
    'setNote',
    'kindIcon',
    'current',
    'showSession',
    'orderState',
    'shownOrders',
    'wireSessionDrag',
    'workspaceDisplayTitle',
    `${body}\nreturn { applySearch, renderFlatList }`,
  )(
    document,
    fetch,
    treeList,
    libraries.WorkspaceTree,
    libraries.ContentSearch,
    'hide',
    options.grouping ?? 'tree',
    options.treeGroups,
    (meta: { title?: string; id: string }) => meta.title ?? meta.id,
    () => '',
    () => undefined,
    (callback: () => void) => {
      timers.push(callback)
      return timers.length
    },
    () => undefined,
    new Map(),
    () => undefined,
    () => new FakeElement(registry),
    null,
    async () => undefined,
    /** The one-column list draws in the chosen order (C17, order-modes): Last updated here; a row drag is not judged. */
    { orderBy: 'updated', orders: {} },
    {},
    () => undefined,
    libraries.workspaceDisplayTitle,
  ) as { applySearch: () => Promise<void>; renderFlatList: () => Promise<void> }

  /** Type a query, then let every pending answer and debounce run, as a person waiting a moment would. */
  const search = async (query: string) => {
    registry.get('session-search')!.value = query
    await run.applySearch()
    for (let round = 0; round < 20; round += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      for (const due of timers.splice(0)) due()
    }
    const note = registry.get('search-note')!
    const pending = registry.get('search-pending')
    return {
      hits: registry.get('search-results')!.children.map((hit) => hit.children[0]?.textContent),
      note: note.hidden ? null : note.textContent,
      /** The skeleton rows still waiting on the host; `null` when none are shown (or the page has no content search). */
      pending: pending === undefined || pending.hidden ? null : pending.children.length,
      treeHidden: treeList.hidden,
    }
  }
  /** Each search hit as it reads: its title, and the line under it naming the workspace (the age is stubbed out). */
  const hitLines = () => registry.get('search-results')!.children.map((hit) => `${hit.children[0]?.textContent} | ${hit.children[1]?.textContent}`)
  /** Draw the one-column list (`In one list`) and read each row the same way: its title, and where it lives. */
  const flatRows = async () => {
    await run.renderFlatList()
    return treeList.children.map((li) => {
      const [, label, place] = li.children[0]?.children ?? []
      return `${label?.textContent} | ${place?.textContent}`
    })
  }
  return { search, requests, hitLines, flatRows }
}

function workspace(id: string, path: string, sessionIds: string[]) {
  return { id, path, title: path.split('/').pop(), origin: 'added', parent: null, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', sessionIds }
}

function session(id: string, minute: number, title: string) {
  const at = `2026-10-28T10:${String(minute).padStart(2, '0')}:00.000Z`
  return { id, cwd: '/code/repo', created: at, updated: at, turns: 1, title }
}

const before = [session('s-plan', 1, 'Kestrel plan'), session('s-notes', 2, 'Kestrel notes'), session('s-sync', 3, 'weekly sync')]
/** What the server holds once the network is back: one session more than the tree drew, so a fresh read can be told from a held one. */
const after = [...before, session('s-retro', 4, 'Kestrel retro')]
const workspacesBefore = [workspace('w-repo', '/code/repo', before.map((meta) => meta.id))]
const workspacesAfter = [workspace('w-repo', '/code/repo', after.map((meta) => meta.id))]

/** The server's other answers; `/api/sessions` is the one each test breaks. */
function server(sessions: () => Reply | Promise<Reply>, workspaces: () => unknown[]): Route {
  return (url) => {
    if (url === '/api/sessions') return sessions()
    if (url === '/api/tree') return answer({ children: [{ path: '/code/repo', label: 'repo' }] })
    if (url === '/api/workspaces') return answer({ workspaces: workspaces() })
    if (url.startsWith('/api/sessions/search')) return answer({ items: [], hasMore: false })
    return answer(null, 404)
  }
}

test('the page code under test is found', () => {
  assert.ok(searchBegin > 0 && searchEnd > searchBegin, 'the search index and applySearch are in the page, in that order')
  assert.ok(flatBegin > searchEnd && flatEnd > flatBegin, 'and the one-column list after them, before renderTree')
})

test('a failed sessions read searches the rows the tree holds, is not kept, and the next search reads again', async () => {
  const treeGroups = libraries.WorkspaceTree.deriveGroups(workspacesBefore, before, { grouping: 'tree', archived: 'hide' })
  let down = true
  const view = loadPage({
    treeGroups,
    route: server(
      () => (down ? offline() : answer(after)),
      () => (down ? workspacesBefore : workspacesAfter),
    ),
  })

  const first = await view.search('kestrel')
  const readsWhileDown = view.requests.filter((url) => url === '/api/sessions').length
  down = false
  const second = await view.search('kestrel')
  assert.deepEqual(
    { offline: first, online: second },
    {
      /** Offline: the matching rows the tree holds, with no "No matching sessions" beside them and no other warning. */
      offline: { hits: ['Kestrel notes', 'Kestrel plan'], note: null, pending: null, treeHidden: true },
      /** Back online: the same query reads the sessions again and finds them all, the one the tree never drew included. */
      online: { hits: ['Kestrel retro', 'Kestrel notes', 'Kestrel plan'], note: null, pending: null, treeHidden: true },
    },
    'the search during the failure and the same search after it',
  )
  const readsAfter = view.requests.filter((url) => url === '/api/sessions').length
  assert.ok(readsWhileDown >= 1 && readsAfter > readsWhileDown, `the failed read was not kept: the second search asked again (${readsWhileDown}, then ${readsAfter})`)

  const third = await view.search('retro')
  assert.deepEqual(third.hits, ['Kestrel retro'], 'and an answer that arrived is kept for the next keystroke')
  assert.equal(view.requests.filter((url) => url === '/api/sessions').length, readsAfter, 'without another read')
})

test('with no rows to fall back to, a failed read says the search could not run, and an error answer is not kept either', async () => {
  let state: 'offline' | 'error' | 'up' = 'offline'
  let reads = 0
  const view = loadPage({
    treeGroups: [],
    route: server(
      () => {
        reads += 1
        return state === 'offline' ? offline() : state === 'error' ? answer({ error: 'unavailable' }, 503) : answer(after)
      },
      () => workspacesAfter,
    ),
  })

  const first = await view.search('kestrel')
  assert.deepEqual(first.hits, [], 'nothing to list')
  assert.ok(first.note !== null && /could not/i.test(first.note), `the note says the search could not run\nsaw: ${JSON.stringify(first)}`)
  assert.doesNotMatch(first.note ?? '', /no (matching sessions|session matches)/i, 'rather than that nothing matched')

  state = 'error'
  const second = await view.search('kestrel')
  assert.ok(second.note !== null && /could not/i.test(second.note), `a 503 from /api/sessions is a failed read too\nsaw: ${JSON.stringify(second)}`)

  state = 'up'
  const readsBefore = reads
  const third = await view.search('kestrel')
  assert.deepEqual(third.hits, ['Kestrel retro', 'Kestrel notes', 'Kestrel plan'], `once the sessions arrive, the search finds them\nsaw: ${JSON.stringify(third)}`)
  assert.equal(third.note, null)
  assert.ok(readsBefore >= 2 && reads > readsBefore, `each failed read was asked again, not kept (${readsBefore}, then ${reads})`)
})

/**
 * The content half (R-developer-eight-19) fails on its own: DSH's README, Search — "a failed content search leaves metadata
 * matches visible without an additional warning" (the error state draws the name matches and no sentence,
 * dsh-client-ui-workspace `lib/client.js:3753-3760`, `:3492`). And a failure is not the query's answer: the next search
 * for the same query asks the host again (#58).
 */
test('a failed content request leaves the name matches with no warning of their own, and the same query asks the host again', async () => {
  const treeGroups = libraries.WorkspaceTree.deriveGroups(workspacesAfter, after, { grouping: 'tree', archived: 'hide' })
  let hostDown = true
  const asked: string[] = []
  const names = server(
    () => answer(after),
    () => workspacesAfter,
  )
  const view = loadPage({
    treeGroups,
    route: (url) => {
      if (!url.startsWith('/api/sessions/search')) return names(url)
      asked.push(url)
      return hostDown ? offline() : answer({ items: [{ sessionId: 's-sync', snippet: 'the kestrel came up in the sync' }], hasMore: false })
    },
  })

  const failed = await view.search('kestrel')
  const askedWhileDown = asked.length
  hostDown = false
  const again = await view.search('kestrel')
  assert.deepEqual(
    { failed, again },
    {
      /** The name matches, the status gone, and no sentence added for the failure. */
      failed: { hits: ['Kestrel retro', 'Kestrel notes', 'Kestrel plan'], note: null, pending: null, treeHidden: true },
      /** The same query again: the host is asked, and the session it found inside a conversation joins after the names. */
      again: { hits: ['Kestrel retro', 'Kestrel notes', 'Kestrel plan', 'weekly sync'], note: null, pending: null, treeHidden: true },
    },
    'the search when the content request fails and the same search after it',
  )
  assert.equal(askedWhileDown, 1, 'one content request for the first search, which failed, and the redraw reporting it asked nothing more')
  assert.equal(asked.length, 2, 'the failure was not kept: the same query asked the host again')
})

/**
 * Which workspace a session is in (#57): the **nearest registered** workspace that holds its folder, by its title — the
 * group the tree files it under — and the top-level root only when no registered workspace holds it.
 *
 * DSH's search result names the workspace whose `sessionIds` holds the session, by its title, else the folder's name
 * (`deriveSearchResults`, dsh-client-ui-workspace `lib/client.js:1182-1183`, `workspaceLabel` `:875-879`). The search hit
 * has done that since the search matched workspaces; the one-column list (`In one list`) named every row after the
 * longest **root** path, and `/api/tree`'s roots are the top-level workspaces only, so all of `nest`'s sessions read
 * `team`. DSH's flat rows carry no workspace (`sessionNode`, `lib/client.js:1059-1073`); heddle's does, and it has to be
 * the right one.
 */
function registeredAt(id: string, path: string, title: string, parent: string | null, sessionIds: string[], origin = 'added') {
  return { id, path, title, origin, parent, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', sessionIds }
}

function sessionAt(id: string, minute: number, title: string, cwd: string, extra: Record<string, unknown> = {}) {
  const at = `2026-10-28T11:${String(minute).padStart(2, '0')}:00.000Z`
  return { id, cwd, created: at, updated: at, turns: 1, title, ...extra }
}

/**
 * `team` registered, `nest` registered inside it under a title that is not its folder's name, and an automatic
 * workspace inside `nest`. `/api/workspaces` files each session under its nearest root (`workspaceViews`), so `nest`
 * holds its own sessions and the one reached through a symlink the server resolved; the automatic one holds `scratch`.
 */
const nested = {
  workspaces: [
    registeredAt('w-team', '/code/team', 'team', null, ['s-top']),
    registeredAt('w-nest', '/code/team/nest', 'Nest desk', 'w-team', ['s-nest', 's-deep', 's-link', 's-child']),
    registeredAt('w-scratch', '/code/team/nest/scratch', 'scratch', 'w-nest', ['s-scratch'], 'auto'),
  ],
  sessions: [
    sessionAt('s-top', 1, 'Heron top', '/code/team'),
    sessionAt('s-nest', 2, 'Heron draft', '/code/team/nest'),
    sessionAt('s-deep', 3, 'Heron deep', '/code/team/nest/src'),
    sessionAt('s-scratch', 4, 'Heron scratch', '/code/team/nest/scratch'),
    /** Listed under `nest` by the server, which compares canonical paths; its own `cwd` is the link's. */
    sessionAt('s-link', 5, 'Heron link', '/links/nest'),
    /**
     * A subagent's session: never a hit, a tree row or a row of the one-column list, which since order-modes (C17) draws
     * the tree's rows (`WorkspaceTree.flatRows`).
     */
    sessionAt('s-child', 6, 'Heron child', '/code/team/nest/src', { origin: 'subagent' }),
  ],
}

/**
 * A session `/api/workspaces` does not list (one made between the page's two reads, say): no membership, so the
 * one-column list names it by the longest registered path that holds its folder.
 */
const unlisted = sessionAt('s-unlisted', 0, 'Heron unlisted', '/code/team/nest/src')

function nestedServer(workspaces: () => Reply, sessions: unknown[] = nested.sessions): Route {
  return (url) => {
    if (url === '/api/sessions') return answer(sessions)
    /** The roots the tree draws at the top: `team` only, as `/api/tree` lists them. */
    if (url === '/api/tree') return answer({ children: [{ path: '/code/team', label: 'team' }] })
    if (url === '/api/workspaces') return workspaces()
    if (url.startsWith('/api/sessions/search')) return answer({ items: [], hasMore: false })
    return answer(null, 404)
  }
}

test('a search hit for a session in a nested registered workspace names that workspace, by its title (#57)', async () => {
  const treeGroups = libraries.WorkspaceTree.deriveGroups(nested.workspaces, nested.sessions, { grouping: 'tree', archived: 'hide' })
  const view = loadPage({ treeGroups, route: nestedServer(() => answer({ workspaces: nested.workspaces })) })
  const result = await view.search('heron')
  assert.equal(result.note, null)
  assert.deepEqual(
    view.hitLines(),
    ['Heron link | Nest desk', 'Heron scratch | Nest desk', 'Heron deep | Nest desk', 'Heron draft | Nest desk', 'Heron top | team'],
    'each hit names the workspace the tree files it under: nest by its title, the automatic one inside it included, and team only for its own',
  )
})

test('a row of the one-column list names the nearest registered workspace that holds its session, not the top-level root (#57)', async () => {
  const view = loadPage({ treeGroups: [], grouping: 'list', route: nestedServer(() => answer({ workspaces: nested.workspaces }), [...nested.sessions, unlisted]) })
  assert.deepEqual(
    await view.flatRows(),
    [
      /** Membership: the server filed it under nest, though its own path is the link's. */
      'Heron link | Nest desk',
      /** Filed under the automatic workspace, which the tree climbs past to nest. */
      'Heron scratch | Nest desk',
      'Heron deep | Nest desk',
      'Heron draft | Nest desk',
      'Heron top | team',
      /** No membership, so the longest registered path that holds its folder. */
      'Heron unlisted | Nest desk',
    ],
    'each row names the workspace the tree files it under, by its title',
  )
})

test('with no workspace list, a row of the one-column list falls back to the top-level root that holds it (#57)', async () => {
  const view = loadPage({ treeGroups: [], grouping: 'list', route: nestedServer(() => answer({ error: 'unavailable' }, 503), [...nested.sessions, unlisted]) })
  assert.deepEqual(
    await view.flatRows(),
    ['Heron link | ', 'Heron scratch | team', 'Heron deep | team', 'Heron draft | team', 'Heron top | team', 'Heron unlisted | team'],
    'the root, the last resort, names what it holds, and a folder nothing holds names no workspace',
  )
})
