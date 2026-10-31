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
 * The code from `let searchIndex = null` up to `openSearchResult` is cut out of `page.html` and run against a small
 * stand-in for the document and for `fetch`, with the workspace tree's real block, so this fails when the page's own
 * functions do.
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

interface Group {
  sessions: { id: string }[]
}

interface Tree {
  deriveGroups: (workspaces: unknown[], sessions: unknown[], options?: Record<string, unknown>) => Group[]
}

const pureBlocks = `${block('workspace-tree')}\n${block('content-search')}`
const libraries = new Function(`${pureBlocks}\nreturn { WorkspaceTree, ContentSearch: typeof ContentSearch === 'undefined' ? undefined : ContentSearch }`)() as {
  WorkspaceTree: Tree
  ContentSearch: unknown
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
  onclick: unknown = null
  children: FakeElement[] = []
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
  const body = page.slice(searchBegin, searchEnd)
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
    `${body}\nreturn { applySearch }`,
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
  ) as { applySearch: () => Promise<void> }

  /** Type a query, then let every pending answer and debounce run, as a person waiting a moment would. */
  const search = async (query: string) => {
    registry.get('session-search')!.value = query
    await run.applySearch()
    for (let round = 0; round < 20; round += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      for (const due of timers.splice(0)) due()
    }
    const note = registry.get('search-note')!
    return {
      hits: registry.get('search-results')!.children.map((hit) => hit.children[0]?.textContent),
      note: note.hidden ? null : note.textContent,
      treeHidden: treeList.hidden,
    }
  }
  return { search, requests }
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
  down = false
  const second = await view.search('kestrel')
  assert.deepEqual(
    { offline: first, online: second },
    {
      /** Offline: the matching rows the tree holds, with no "No matching sessions" beside them and no other warning. */
      offline: { hits: ['Kestrel notes', 'Kestrel plan'], note: null, treeHidden: true },
      /** Back online: the same query reads the sessions again and finds them all, the one the tree never drew included. */
      online: { hits: ['Kestrel retro', 'Kestrel notes', 'Kestrel plan'], note: null, treeHidden: true },
    },
    'the search during the failure and the same search after it',
  )
  assert.equal(view.requests.filter((url) => url === '/api/sessions').length, 2, 'the failed read was not kept: the second search asked again')

  const third = await view.search('retro')
  assert.deepEqual(third.hits, ['Kestrel retro'], 'and an answer that arrived is kept for the next keystroke')
  assert.equal(view.requests.filter((url) => url === '/api/sessions').length, 2, 'without a third read')
})

test('with no rows to fall back to, a failed read says the search could not run, and an error answer is not kept either', async () => {
  let reads = 0
  const view = loadPage({
    treeGroups: [],
    route: server(
      () => {
        reads += 1
        return reads === 1 ? offline() : reads === 2 ? answer({ error: 'unavailable' }, 503) : answer(after)
      },
      () => workspacesAfter,
    ),
  })

  const first = await view.search('kestrel')
  assert.deepEqual(first.hits, [], 'nothing to list')
  assert.ok(first.note !== null && /could not/i.test(first.note), `the note says the search could not run\nsaw: ${JSON.stringify(first)}`)
  assert.doesNotMatch(first.note ?? '', /no (matching sessions|session matches)/i, 'rather than that nothing matched')

  const second = await view.search('kestrel')
  assert.ok(second.note !== null && /could not/i.test(second.note), `a 503 from /api/sessions is a failed read too\nsaw: ${JSON.stringify(second)}`)

  const third = await view.search('kestrel')
  assert.deepEqual(third.hits, ['Kestrel retro', 'Kestrel notes', 'Kestrel plan'], `once the sessions arrive, the search finds them\nsaw: ${JSON.stringify(third)}`)
  assert.equal(third.note, null)
  assert.equal(reads, 3, 'each failed read was asked again, not kept')
})
