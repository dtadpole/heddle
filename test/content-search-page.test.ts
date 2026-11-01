import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Content search's page half (R-developer-eight-19), judged out of the page that runs it.
 *
 * DSH's sidebar search shows the local name matches at once and merges in what the host found **inside** the
 * conversations once its debounced query answers (dsh-client-ui-workspace `lib/client.js:1169-1221`, `:2843-2855`,
 * `:3727-3767`). The pure rules live in `page.html` between `content-search` markers, on top of the workspace tree's
 * block, and both are loaded here.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const block = (name: string): string => {
  const begin = page.indexOf(`/* ${name}:begin */`)
  const end = page.indexOf(`/* ${name}:end */`)
  assert.ok(begin > 0 && end > begin, `the ${name} block is in the page, between its markers`)
  return page.slice(begin, end)
}

interface Hit {
  meta: { id: string }
  workspace: string
  snippet?: string
}

interface ContentSearch {
  DEBOUNCE_MS: number
  QUERY_MAX_CODE_UNITS: number
  sanitizeQuery: (value: unknown) => string
  merge: (
    workspaces: unknown[],
    sessions: unknown[],
    query: string,
    content: { items: { sessionId: string; snippet: string }[]; hasMore: boolean } | undefined,
    options?: Record<string, unknown>,
  ) => { items: Hit[]; hasMore: boolean }
}

const search = new Function(`${block('workspace-tree')}\n${block('content-search')}\nreturn ContentSearch`)() as ContentSearch

function workspace(id: string, path: string, sessionIds: string[], title?: string) {
  return { id, path, title: title ?? path.split('/').pop(), origin: 'added', parent: null, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', sessionIds }
}

function session(id: string, minute: number, extra: Record<string, unknown> = {}) {
  const at = `2026-10-28T10:${String(minute).padStart(2, '0')}:00.000Z`
  return { id, cwd: '/w', created: at, updated: at, turns: 1, ...extra }
}

const ids = (answer: { items: Hit[] }) => answer.items.map((item) => item.meta.id)
const none = { items: [], hasMore: false }

test("the debounce and the query bound are DSH's", () => {
  assert.equal(search.DEBOUNCE_MS, 250, 'SEARCH_DEBOUNCE_MS')
  assert.equal(search.QUERY_MAX_CODE_UNITS, 500, 'SEARCH_QUERY_MAX_CODE_UNITS')
  assert.equal(search.sanitizeQuery('qu\0okka'), 'quokka', 'a NUL is removed')
  assert.equal(search.sanitizeQuery('q'.repeat(600)).length, 500, 'the query is cut at 500 units')
  const split = search.sanitizeQuery(`${'q'.repeat(499)}😀tail`)
  assert.equal(split, 'q'.repeat(499), 'without splitting a surrogate pair')
})

test('the name matches lead, newest first; then the sessions only the host found, in its order; each once', () => {
  const workspaces = [workspace('w', '/w', ['s-old', 's-new', 's-deep', 's-other', 's-third'])]
  const sessions = [
    session('s-old', 1, { title: 'ledger review' }),
    session('s-new', 9, { title: 'ledger plan' }),
    session('s-deep', 5, { title: 'something else' }),
    session('s-other', 7, { title: 'unrelated' }),
    session('s-third', 3, { title: 'third thing' }),
  ]
  const content = {
    items: [
      { sessionId: 's-other', snippet: 'the ledger is balanced twice, ledger' },
      { sessionId: 's-old', snippet: 'a ledger in the review' },
      { sessionId: 's-deep', snippet: 'deep in the ledger' },
    ],
    hasMore: false,
  }
  const answer = search.merge(workspaces, sessions, 'Ledger', content)
  assert.deepEqual(ids(answer), ['s-new', 's-old', 's-other', 's-deep'], 'local newest first, then host order, s-old not twice')
  assert.deepEqual(
    answer.items.map((item) => item.snippet ?? null),
    [null, 'a ledger in the review', 'the ledger is balanced twice, ledger', 'deep in the ledger'],
    'a row the host matched carries its snippet, local or not',
  )
  assert.equal(answer.items[2]?.workspace, 'w', 'a content-only row names its workspace too')
  assert.equal(answer.hasMore, false)

  const loading = search.merge(workspaces, sessions, 'ledger', none)
  assert.deepEqual(ids(loading), ['s-new', 's-old'], 'before the host answers, the name matches stand alone')
  assert.deepEqual(search.merge(workspaces, sessions, '   ', content), none, 'a blank query is no search')
})

test('a host hit follows the tree: a subagent never, archived per the filter, an unknown session dropped', () => {
  const sessions = [
    session('s-child', 1, { title: 'x', origin: 'subagent' }),
    session('s-arch', 2, { title: 'y', archived: true }),
    session('s-live', 3, { title: 'z' }),
  ]
  const content = {
    items: ['s-child', 's-arch', 's-gone', 's-live'].map((sessionId) => ({ sessionId, snippet: `found in ${sessionId}` })),
    hasMore: false,
  }
  assert.deepEqual(ids(search.merge([], sessions, 'found', content)), ['s-live'])
  assert.deepEqual(ids(search.merge([], sessions, 'found', content, { archived: 'show' })), ['s-arch', 's-live'])
  assert.deepEqual(ids(search.merge([], sessions, 'found', content, { archived: 'only' })), ['s-arch'])
})

test('twenty rows at most; more when twenty are shown and the host said so, or when the merge ran past twenty', () => {
  const sessions = Array.from({ length: 30 }, (_, index) => session(`s-${String(index).padStart(2, '0')}`, index, { title: index < 15 ? `capword ${index}` : `other ${index}` }))
  const content = { items: sessions.slice(10).map((meta) => ({ sessionId: meta.id, snippet: 'capword inside' })), hasMore: false }
  const merged = search.merge([], sessions, 'capword', content)
  assert.equal(merged.items.length, 20)
  assert.equal(merged.hasMore, true, '15 local plus 15 more from the host is more than twenty')
  assert.equal(merged.items[0]?.meta.id, 's-14', 'newest local first')
  const twenty = sessions.slice(0, 20).map((meta) => ({ ...meta, title: 'capword' }))
  const flagged = search.merge([], twenty, 'capword', { items: [], hasMore: true })
  assert.deepEqual([flagged.items.length, flagged.hasMore], [20, true], "the host's own hasMore carries through when twenty rows are shown")
})

/**
 * N2 (developer-ten's review of content-search-page): the host ranks every session with a `cwd`, a subagent's child and an
 * archived session included, and the page filters after the host's twenty are cut. DSH does the same — its controller
 * ranks every session with a `cwd` (dsh-api-session-controller lib/index.js:2016-2018, cut at 20 :2029-2084) and its
 * client filters after (dsh-client-ui-workspace lib/client.js:1197-1200) yet keeps the host's `hasMore` (:1219) — so the
 * wire stays DSH's. What changes is the sentence: "Showing the first 20 results" is said only when twenty are shown,
 * never beside "No matching sessions" or beside a shorter list.
 */
test('the host\'s hasMore says "Showing the first 20" only when twenty rows are shown', () => {
  const hidden = Array.from({ length: 20 }, (_, index) =>
    session(`s-h${String(index).padStart(2, '0')}`, index, index % 2 === 0 ? { title: `a ${index}`, archived: true } : { title: `c ${index}`, origin: 'subagent' }),
  )
  const live = [session('s-live', 40, { title: 'unrelated' }), session('s-kept', 41, { title: 'unrelated too' })]
  const filled = { items: hidden.map((meta) => ({ sessionId: meta.id, snippet: 'quokka' })), hasMore: true }
  const none = search.merge([], [...hidden, ...live], 'quokka', filled)
  assert.deepEqual([none.items.length, none.hasMore], [0, false], 'hidden sessions filled the twenty: nothing shown, and no "Showing the first 20" beside "No matching sessions"')
  const some = search.merge([], [...hidden, ...live], 'quokka', { items: [...filled.items.slice(0, 18), { sessionId: 's-live', snippet: 'quokka' }, { sessionId: 's-kept', snippet: 'quokka' }], hasMore: true })
  assert.deepEqual([some.items.length, some.hasMore], [2, false], 'two shown of the twenty: not "the first 20" either')
  const shown = search.merge([], [...hidden, ...live], 'quokka', filled, { archived: 'show' })
  assert.deepEqual([shown.items.length, shown.hasMore], [10, false], 'under Show archived the ten archived ones are shown, and ten is not twenty')
})

test('the page asks the host after the debounce, aborts a stale query, and shows DSH\'s pending status', () => {
  assert.match(page, /fetch\(`\/api\/sessions\/search\?q=\$\{encodeURIComponent\(query\)\}`, \{ signal: controller\.signal \}\)/, 'the host route, abortable')
  assert.match(page, /contentSearchAbort\?\.abort\(\)/, 'a newer keystroke aborts the older request')
  assert.match(page, /\}, ContentSearch\.DEBOUNCE_MS\)/, 'after the debounce')
  assert.match(page, /'aria-label', 'Searching session history…'/, "DSH's status label (search.pending)")
  assert.match(page, /note\.hidden = items\.length > 0 \|\| pending/, '"No matching sessions" waits for the host')
  assert.match(page, /quote\.className = 'hit-snippet'/, 'a hit shows its snippet')
})
