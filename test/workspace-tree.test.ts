import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The workspace tree's derivation, judged out of the page that runs it.
 *
 * The left column follows DSH's workspace browser: workspaces as groups, their sessions nested under them, child
 * workspaces before a parent's own sessions, an Ungrouped bucket last, pinned-then-recent order and a `Show more`
 * watermark. Those are decisions with traps in them, so the pure block that makes them lives in `page.html` between two
 * markers and is loaded here — the page has one copy of the rules, and this file is what fails when one of them breaks.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* workspace-tree:begin */')
const end = page.indexOf('/* workspace-tree:end */')

interface Group {
  key: string
  workspace: { id: string } | null
  label: string
  path: string
  depth: number
  children: Group[]
  sessions: { id: string }[]
}

interface Tree {
  UNGROUPED: string
  INITIAL: number
  deriveGroups: (workspaces: unknown[], sessions: unknown[], options?: Record<string, unknown>) => Group[]
  flatten: (groups: Group[]) => Group[]
  containsSession: (group: Group, id: string | null, deep?: boolean) => boolean
  shownCount: (sessions: unknown[], watermark: number, options?: Record<string, unknown>) => number
  watermarkRows: (sessions: { id: string }[], watermark: number) => { rows: { id: string }[]; hidden: number; conversations: number }
  nextWatermark: (total: number, shown: number) => number
  overflow: (total: number, shown: number, baseline?: number) => 'more' | 'less' | null
  overflowLabel: (mode: 'more' | 'less', hidden: number) => string
  sessionOrder: (left: unknown, right: unknown) => number
  SEARCH_LIMIT: number
  search: (
    workspaces: unknown[],
    sessions: unknown[],
    query: string,
    options?: Record<string, unknown>,
  ) => { items: { meta: { id: string }; workspace: string }[]; hasMore: boolean }
  chainTo: (groups: Group[], id: string) => Group[]
  revealMark: (sessions: { id: string }[], id: string, watermark?: number) => number
  hiddenBlank: (meta: unknown, current: unknown) => boolean
  withOpenBlank: (rows: { id: string }[], current: unknown) => { id: string }[]
  flatRows: (sessions: unknown[], options?: Record<string, unknown>) => { order: string[]; rows: { id: string }[] }
  accountOrders: (workspaces: unknown[], sessions: unknown[], order: OrderState) => Record<string, string[]>
  chooseOrderBy: (state: OrderState, mode: 'updated' | 'manual', shown: Record<string, string[]>) => OrderState
  withPinFronted: (state: OrderState, id: string, shown: Record<string, string[]>) => OrderState
}

interface OrderState {
  orderBy: 'updated' | 'manual'
  orders: Record<string, string[]>
}

const tree = new Function(`${page.slice(begin, end)}\nreturn WorkspaceTree`)() as Tree

/** A workspace as `/api/workspaces` answers it. */
function workspace(id: string, path: string, options: { parent?: string | null; origin?: string; sessionIds?: string[]; title?: string } = {}) {
  return {
    id,
    path,
    title: options.title ?? path.split('/').pop(),
    origin: options.origin ?? 'added',
    parent: options.parent ?? null,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    sessionIds: options.sessionIds ?? [],
  }
}

/** A session as `/api/sessions` answers it; `minute` makes `updated` sortable. */
function session(id: string, minute: number, extra: Record<string, unknown> = {}) {
  const at = `2026-10-28T10:${String(minute).padStart(2, '0')}:00.000Z`
  return { id, cwd: '/w', created: at, updated: at, turns: 1, ...extra }
}

const ids = (group: Group | undefined) => (group?.sessions ?? []).map((meta) => meta.id)

test('the block is in the page, between its markers', () => {
  assert.ok(begin > 0 && end > begin, 'both markers are present, in order')
  assert.equal(typeof tree.deriveGroups, 'function')
})

test('a nested workspace is the parent\'s child group, and each session lands on its nearest root', () => {
  const workspaces = [
    workspace('w-app', '/repo/packages/app', { parent: 'w-repo', sessionIds: ['s-app'] }),
    workspace('w-repo', '/repo', { sessionIds: ['s-repo-old', 's-repo-new'] }),
    workspace('w-other', '/other', { sessionIds: [] }),
  ]
  const sessions = [session('s-app', 5), session('s-repo-old', 1), session('s-repo-new', 9)]
  const groups = tree.deriveGroups(workspaces, sessions, { grouping: 'tree' })

  assert.deepEqual(groups.map((group) => group.key), ['w-repo', 'w-other'], 'only top-level workspaces at the top, in registry order')
  const repo = groups[0]
  assert.deepEqual(repo?.children.map((group) => group.key), ['w-app'], 'the nested root is the parent\'s child')
  assert.equal(repo?.children[0]?.depth, 1)
  assert.deepEqual(ids(repo), ['s-repo-new', 's-repo-old'], 'newest first')
  assert.deepEqual(ids(repo?.children[0]), ['s-app'])
  assert.equal(groups.some((group) => group.key === tree.UNGROUPED), false, 'no Ungrouped bucket when every session has a home')
})

test('the Workspace grouping draws every workspace as a sibling section', () => {
  const workspaces = [workspace('w-app', '/repo/app', { parent: 'w-repo' }), workspace('w-repo', '/repo')]
  const groups = tree.deriveGroups(workspaces, [], { grouping: 'workspace' })
  assert.deepEqual(groups.map((group) => [group.key, group.depth, group.children.length]), [['w-app', 0, 0], ['w-repo', 0, 0]])
})

test('an adopted root is not a group: its sessions go to the registered workspace above it, else to Ungrouped, which is last', () => {
  const workspaces = [
    workspace('w-auto-inner', '/repo/scratch', { origin: 'auto', parent: 'w-repo', sessionIds: ['s-scratch'] }),
    workspace('w-repo', '/repo'),
    workspace('w-auto-loose', '/tmp/loose', { origin: 'auto', sessionIds: ['s-loose'] }),
  ]
  const sessions = [session('s-scratch', 3), session('s-loose', 2), session('s-nowhere', 1)]
  const groups = tree.deriveGroups(workspaces, sessions)
  assert.deepEqual(groups.map((group) => group.key), ['w-repo', tree.UNGROUPED], 'Ungrouped trails, after every workspace')
  assert.deepEqual(ids(groups[0]), ['s-scratch'], 'the adopted folder\'s session joins the workspace above it')
  assert.deepEqual(ids(groups[1]), ['s-loose', 's-nowhere'], 'and the rest are Ungrouped, newest first')
  assert.equal(groups[1]?.workspace, null)
  assert.equal(groups[1]?.label, 'Ungrouped')
})

test('a subagent\'s session is hidden, and the archive filter has DSH\'s three states', () => {
  const workspaces = [workspace('w', '/w', { sessionIds: ['s-live', 's-archived', 's-child'] })]
  const sessions = [session('s-live', 3), session('s-archived', 2, { archived: true }), session('s-child', 1, { origin: 'subagent' })]
  assert.deepEqual(ids(tree.deriveGroups(workspaces, sessions)[0]), ['s-live'], 'hide is the default')
  assert.deepEqual(ids(tree.deriveGroups(workspaces, sessions, { archived: 'show' })[0]), ['s-live', 's-archived'])
  assert.deepEqual(ids(tree.deriveGroups(workspaces, sessions, { archived: 'only' })[0]), ['s-archived'])
})

test('only the open New session placeholder is a row, and it leads; a titled, pinned or running zero-turn session stays', () => {
  /**
   * DSH's `sessionVisible` (dsh-client-ui-workspace lib/client.js:959-966): among blank sessions only the current one is
   * visible. New session makes a fresh blank on every press, so the older ones, and another client's, must not be rows.
   */
  const workspaces = [
    workspace('w', '/w', { sessionIds: ['s-talked', 's-blank-old', 's-blank-new', 's-pinned', 's-titled', 's-blank-other', 's-pinned-blank', 's-running'] }),
  ]
  const sessions = [
    session('s-blank-new', 9, { turns: 0 }),
    session('s-running', 6, { turns: 0, running: true }),
    session('s-talked', 5),
    session('s-titled', 4, { turns: 0, title: 'named on purpose' }),
    session('s-pinned', 2, { pinned: true, pinnedAt: '2026-10-28T09:00:00.000Z' }),
    session('s-pinned-blank', 2, { turns: 0, pinned: true, pinnedAt: '2026-10-28T08:00:00.000Z' }),
    session('s-blank-old', 1, { turns: 0 }),
    session('s-blank-other', 0, { turns: 0, cwd: '/w/other' }),
  ]
  assert.deepEqual(
    ids(tree.deriveGroups(workspaces, sessions, { current: 's-talked' })[0]),
    ['s-pinned', 's-pinned-blank', 's-running', 's-talked', 's-titled'],
    'with an ordinary session open, no placeholder is a row, in any folder, newest or not',
  )
  assert.deepEqual(
    ids(tree.deriveGroups(workspaces, sessions, { current: 's-blank-old' })[0]),
    ['s-blank-old', 's-pinned', 's-pinned-blank', 's-running', 's-talked', 's-titled'],
    'the open placeholder is the only one shown, and it leads, ahead of the pins',
  )
  assert.deepEqual(
    ids(tree.deriveGroups(workspaces, sessions, { current: null })[0]),
    ['s-pinned', 's-pinned-blank', 's-running', 's-talked', 's-titled'],
    'with nothing open, no placeholder is a row',
  )
  assert.equal(ids(tree.deriveGroups(workspaces, sessions)[0]).length, 8, 'a caller that names no open session sees every row, as before')
  assert.equal(tree.hiddenBlank(sessions[0], 's-talked'), true, 'the flat list asks the same rule')
  assert.equal(tree.hiddenBlank(sessions[0], 's-blank-new'), false)
})

test('archived only drops a workspace with nothing archived, and its child rises to the nearest shown level', () => {
  const workspaces = [workspace('w-child', '/r/c', { parent: 'w-root', sessionIds: ['s-old'] }), workspace('w-root', '/r', { sessionIds: ['s-live'] })]
  const sessions = [session('s-old', 1, { archived: true }), session('s-live', 2)]
  const groups = tree.deriveGroups(workspaces, sessions, { archived: 'only' })
  assert.deepEqual(groups.map((group) => [group.key, group.depth]), [['w-child', 0]])
})

test('pinned sessions lead, and each part is by last update alone: pin time does not order Last updated', () => {
  /**
   * DSH's README (*Reordering and view options*): Last updated "sorts each partition strictly by the latest user prompt or
   * steer time, newest first; pin time does not affect it" (C17, R-developer-eight-20). This test asserted newest pin
   * first until then; pin order is Manual's (test/workspace-order.test.ts).
   */
  const sessions = [
    session('s-recent', 50),
    session('s-pin-old', 1, { pinned: true, pinnedAt: '2026-10-28T09:30:00.000Z' }),
    session('s-pin-new', 2, { pinned: true, pinnedAt: '2026-10-28T09:00:00.000Z' }),
    session('s-pin-untimed', 3, { pinned: true }),
    session('s-older', 10),
    session('s-archived-pin', 60, { pinned: true, archived: true }),
  ]
  const order = [...sessions].sort(tree.sessionOrder).map((meta) => meta.id)
  /** An archived row carries no pin (DSH keeps the two sets exclusive), so it sorts by its age among the rest. */
  assert.deepEqual(order, ['s-pin-untimed', 's-pin-new', 's-pin-old', 's-archived-pin', 's-recent', 's-older'])
})

/**
 * R-developer-eight-17 (DSH parity C13): `In one list` sorted pins by creation, so two pins read one way in the tree and
 * the other way in the flat list. Since C17 (#63) the flat list is its own account in the selected order, and it follows
 * the tree's rule in both modes, as DSH's `deriveFlat` runs `sectionMembers` over the flat account's order
 * (dsh-client-ui-workspace/lib/client.js:1146-1154, 3583-3584). README *Reordering and view options*: **Last updated**
 * sorts each partition by the latest prompt, "pin time does not affect it". **Pinning** "moves the Session to the front of
 * its complete saved sequence without changing the selected mode. It leads the pinned partition in Manual but need not
 * lead it in Last updated. Unpinning leaves the saved position unchanged". DSH fronts the pin in the group's account and
 * in the flat list's (`pinSessionOrder` / `pinOrderAccounts`, client.js:1303-1309, 1343-1345).
 */
test('the flat list orders like the tree in either mode: Last updated by prompt time, Manual with the later pin first', () => {
  const sessions = [
    /** Created first, prompted last: an unpinned row that leads the rest by its prompt, not by its creation. */
    { ...session('s-written-last', 1), updated: '2026-10-28T10:59:00.000Z' },
    /** Pinned after s-pin-earlier, but prompted before it. */
    session('s-pin-later', 2, { pinned: true, pinnedAt: '2026-10-28T11:30:00.000Z' }),
    session('s-pin-earlier', 3, { pinned: true, pinnedAt: '2026-10-28T11:00:00.000Z' }),
    /** The oldest prompt: it is pinned under Manual below. */
    session('s-quiet', 0),
    session('s-archived', 5, { archived: true }),
  ]
  const workspaces = [workspace('w', '/w', { sessionIds: sessions.map((meta) => meta.id) })]
  const lastUpdated: OrderState = { orderBy: 'updated', orders: {} }
  const treeRows = (metas: unknown[], order: OrderState, archived?: string) => ids(tree.deriveGroups(workspaces, metas, { order, archived })[0])
  const flatRows = (metas: unknown[], order: OrderState, archived?: string) => tree.flatRows(metas, { order, archived }).rows.map((meta) => meta.id)

  /** Last updated: the pinned part by prompt time, so the later pin does not lead. */
  assert.deepEqual(flatRows(sessions, lastUpdated), ['s-pin-earlier', 's-pin-later', 's-written-last', 's-quiet'], 'pins by prompt time, then the rest by prompt time; archived hidden')
  assert.deepEqual(flatRows(sessions, lastUpdated), treeRows(sessions, lastUpdated), 'and the same order the tree draws')
  assert.deepEqual(flatRows(sessions, lastUpdated, 'show'), ['s-pin-earlier', 's-pin-later', 's-written-last', 's-archived', 's-quiet'], 'show lists the archived row by its age among the rest')
  assert.deepEqual(flatRows(sessions, lastUpdated, 'show'), treeRows(sessions, lastUpdated, 'show'))
  assert.deepEqual(flatRows(sessions, lastUpdated, 'only'), ['s-archived'], 'only lists the archived rows')

  /** Manual freezes what Last updated showed, in both accounts. */
  const manual = tree.chooseOrderBy(lastUpdated, 'manual', tree.accountOrders(workspaces, sessions, lastUpdated))
  assert.deepEqual(treeRows(sessions, manual), ['s-pin-earlier', 's-pin-later', 's-written-last', 's-quiet'], 'entering Manual keeps the order on screen')
  assert.deepEqual(flatRows(sessions, manual), treeRows(sessions, manual))

  /** A pin under Manual fronts the session in the group and in the flat list: the latest pin leads, oldest prompt or not. */
  const pinned = sessions.map((meta) => (meta.id === 's-quiet' ? { ...meta, pinned: true, pinnedAt: '2026-10-28T12:00:00.000Z' } : meta))
  const fronted = tree.withPinFronted(manual, 's-quiet', tree.accountOrders(workspaces, sessions, manual))
  assert.deepEqual(treeRows(pinned, fronted), ['s-quiet', 's-pin-earlier', 's-pin-later', 's-written-last'], 'under Manual the latest pin leads the pinned part')
  assert.deepEqual(flatRows(pinned, fronted), treeRows(pinned, fronted), 'and leads the flat list alike')

  /** Under Last updated the same pins go by prompt time again, in both views. */
  assert.deepEqual(treeRows(pinned, lastUpdated), ['s-pin-earlier', 's-pin-later', 's-quiet', 's-written-last'], 'Last updated: the latest pin need not lead')
  assert.deepEqual(flatRows(pinned, lastUpdated), treeRows(pinned, lastUpdated))

  /** Unpinning under Manual leaves the saved position: the row heads the ordinary part, ahead of a later prompt. */
  const unpinned = pinned.map((meta) => (meta.id === 's-quiet' ? { ...meta, pinned: false, pinnedAt: undefined } : meta))
  assert.deepEqual(treeRows(unpinned, fronted), ['s-pin-earlier', 's-pin-later', 's-quiet', 's-written-last'], 'an unpin moves nothing in the saved sequence')
  assert.deepEqual(flatRows(unpinned, fronted), treeRows(unpinned, fronted))
})

test('Show more: five rows, raised to the last running or open session within fifty, five more per click', () => {
  const rows = Array.from({ length: 60 }, (_, index) => session(`s-${index}`, index % 60))
  assert.equal(tree.shownCount(rows, tree.INITIAL), 5)
  assert.equal(tree.shownCount(rows.slice(0, 3), tree.INITIAL), 3, 'never more than there are')
  assert.equal(tree.shownCount(rows, 5, { running: new Set(['s-12']) }), 13, 'a running session is kept in view')
  assert.equal(tree.shownCount(rows, 5, { current: 's-30' }), 31, 'and so is the open one')
  assert.equal(tree.shownCount(rows, 5, { current: 's-55' }), 5, 'but only within the first fifty')
  assert.equal(tree.nextWatermark(60, 5), 10)
  assert.equal(tree.nextWatermark(12, 10), 12, 'the last batch reveals the rest')
  assert.equal(tree.overflow(4, 4), null, 'a short list has no control')
  assert.equal(tree.overflow(12, 5), 'more')
  assert.equal(tree.overflow(12, 12), 'less', 'after the last batch the control folds it back')
})

test('Show more counts conversations: the open New session is drawn on top of five, and the control names how many it hides', () => {
  /**
   * DSH's `watermarkRows` (dsh-client-ui-workspace lib/client.js:2807-2819) shows every blank row plus the first
   * `watermark` non-blank rows, and its control reads `Show {n} more sessions` with the hidden count (`:3325`, `:4897`).
   * #54: the page took the five places over the whole list, blank or not, and its control said only `Show more`.
   */
  const blank = session('s-blank', 59, { turns: 0 })
  const talked = Array.from({ length: 12 }, (_, index) => session(`s-${12 - index}`, 40 - index))
  const list = [blank, ...talked]
  const mark = tree.shownCount(list, tree.INITIAL, { current: 's-blank' })
  assert.equal(mark, 5, 'the open placeholder does not raise the watermark, nor take a place under it')
  const drawn = tree.watermarkRows(list, mark)
  assert.deepEqual(
    drawn.rows.map((meta) => meta.id),
    ['s-blank', 's-12', 's-11', 's-10', 's-9', 's-8'],
    'the placeholder and the five newest conversations',
  )
  assert.equal(drawn.hidden, 7, 'seven conversations stay behind the control')
  assert.equal(drawn.conversations, 12)
  assert.equal(tree.overflow(drawn.conversations, mark), 'more')
  assert.equal(tree.overflowLabel('more', drawn.hidden), 'Show 7 more sessions', "DSH's words, with the count")
  const next = tree.nextWatermark(drawn.conversations, mark)
  assert.equal(tree.watermarkRows(list, next).hidden, 2, 'a click shows five more')
  const all = tree.nextWatermark(drawn.conversations, next)
  assert.equal(tree.watermarkRows(list, all).hidden, 0, 'and the last batch shows the rest')
  assert.equal(tree.overflow(drawn.conversations, all), 'less')
  assert.equal(tree.overflowLabel('less', 0), 'Show less')
  assert.equal(tree.overflow(5, 5), null, 'five conversations and a placeholder need no control')
  assert.equal(tree.overflow(12, 12, 12), null, 'nor do rows the open conversation already raised into view')
  const raised = tree.shownCount(talked, tree.INITIAL, { current: 's-2' })
  assert.equal(raised, 11, 'an open conversation further down still raises the watermark to itself')
})

test('a group knows whether it, or a group under it, holds the open session', () => {
  const workspaces = [workspace('w-child', '/r/c', { parent: 'w-root', sessionIds: ['s-in-child'] }), workspace('w-root', '/r', { sessionIds: ['s-in-root'] })]
  const [root] = tree.deriveGroups(workspaces, [session('s-in-child', 1), session('s-in-root', 2)])
  assert.ok(root !== undefined)
  assert.equal(tree.containsSession(root, 's-in-child'), true, 'a folded ancestor still lights its folder')
  assert.equal(tree.containsSession(root, 's-in-child', false), false, 'but does not own the row')
  assert.equal(tree.containsSession(root, 's-in-root', false), true)
  assert.equal(tree.containsSession(root, null), false)
  assert.deepEqual(tree.flatten([root]).map((group) => group.key), ['w-root', 'w-child'], 'flatten lists parents before children')
})

/**
 * The sidebar search, DSH's local half (`deriveSearchResults`, dsh-client-ui-workspace `lib/client.js:1169`): a
 * case-insensitive substring of the session's **title or its workspace's name**, newest first, at most
 * `SESSION_SEARCH_RESULT_LIMIT` = 20 rows (dsh-api-session-controller `lib/client.js:357`) with a bit saying more matched.
 */
const hits = (answer: { items: { meta: { id: string } }[] }) => answer.items.map((item) => item.meta.id)

test('search matches a title or a workspace name, case-insensitively, and never the id', () => {
  const workspaces = [
    workspace('w-alpha', '/code/alphaproj', { sessionIds: ['s-kestrel', 's-notes'] }),
    workspace('w-beta', '/code/b', { title: 'Beta Project', sessionIds: ['s-beta'] }),
  ]
  const sessions = [
    session('s-kestrel', 3, { title: 'Kestrel migration plan', cwd: '/code/alphaproj' }),
    session('s-notes', 2, { title: 'notes', cwd: '/code/alphaproj' }),
    session('s-beta', 1, { title: 'Weekly sync', cwd: '/code/b' }),
    session('s-loose', 4, { title: 'loose ends', cwd: '/tmp/scratchpad' }),
  ]
  assert.deepEqual(hits(tree.search(workspaces, sessions, 'KESTREL')), ['s-kestrel'], 'a title fragment, in any case')
  assert.deepEqual(hits(tree.search(workspaces, sessions, '  alphaPROJ ')), ['s-kestrel', 's-notes'], 'a workspace name finds every session in it')
  assert.deepEqual(hits(tree.search(workspaces, sessions, 'beta project')), ['s-beta'], 'by the workspace title, not its folder')
  assert.deepEqual(hits(tree.search(workspaces, sessions, 'scratchpad')), ['s-loose'], 'a session outside every workspace reads as its folder name')
  assert.deepEqual(hits(tree.search(workspaces, sessions, 's-kestrel')), [], 'the id is not a name')
  assert.deepEqual(tree.search(workspaces, sessions, '   '), { items: [], hasMore: false }, 'a blank query is no search')
  const [first] = tree.search(workspaces, sessions, 'kestrel').items
  assert.equal(first?.workspace, 'alphaproj', 'and each hit says which workspace it is in')
  assert.equal(tree.search(workspaces, sessions, 'beta').items[0]?.workspace, 'Beta Project')
})

test('search follows the tree: subagent sessions never, archived per the filter, newest first', () => {
  const workspaces = [workspace('w', '/w', { sessionIds: ['s-old', 's-new', 's-arch', 's-child'] })]
  const sessions = [
    session('s-old', 1, { title: 'plan a' }),
    session('s-new', 9, { title: 'plan b' }),
    session('s-arch', 5, { title: 'plan c', archived: true }),
    session('s-child', 7, { title: 'plan d', origin: 'subagent' }),
  ]
  assert.deepEqual(hits(tree.search(workspaces, sessions, 'plan')), ['s-new', 's-old'], 'hide is the default, and a child is never a hit')
  assert.deepEqual(hits(tree.search(workspaces, sessions, 'plan', { archived: 'show' })), ['s-new', 's-arch', 's-old'])
  assert.deepEqual(hits(tree.search(workspaces, sessions, 'plan', { archived: 'only' })), ['s-arch'])
  const pinned = [session('s-pin', 1, { title: 'plan p', pinned: true }), session('s-late', 2, { title: 'plan q' })]
  assert.deepEqual(hits(tree.search([], pinned, 'plan')), ['s-late', 's-pin'], 'recency alone orders hits; a pin does not lead them')
})

test('search lists at most twenty hits, and says when more matched', () => {
  assert.equal(tree.SEARCH_LIMIT, 20)
  const many = Array.from({ length: 22 }, (_, index) => session(`s-${String(index).padStart(2, '0')}`, index, { title: `capword item ${index + 1}` }))
  const answer = tree.search([], many, 'capword')
  assert.equal(answer.items.length, 20, 'capped at twenty')
  assert.equal(answer.hasMore, true, 'with the bit that asks for a narrower query')
  assert.equal(answer.items[0]?.meta.id, 's-21', 'the newest first')
  const exact = tree.search([], many.slice(0, 20), 'capword')
  assert.deepEqual([exact.items.length, exact.hasMore], [20, false], 'twenty matches exactly is not more')
})

test('opening a hit reveals its row: the groups down to it, and a watermark that reaches it', () => {
  const workspaces = [workspace('w-child', '/r/c', { parent: 'w-root', sessionIds: ['s-deep'] }), workspace('w-root', '/r', { sessionIds: ['s-top'] })]
  const groups = tree.deriveGroups(workspaces, [session('s-deep', 1), session('s-top', 2)])
  assert.deepEqual(tree.chainTo(groups, 's-deep').map((group) => group.key), ['w-root', 'w-child'], 'every group from the top to the owner')
  assert.deepEqual(tree.chainTo(groups, 's-top').map((group) => group.key), ['w-root'])
  assert.deepEqual(tree.chainTo(groups, 's-missing'), [], 'nothing when no group draws it')
  const rows = Array.from({ length: 60 }, (_, index) => session(`s-${index}`, index))
  assert.equal(tree.revealMark(rows, 's-2', undefined), tree.INITIAL, 'a row already in view keeps the watermark')
  assert.equal(tree.revealMark(rows, 's-57', 5), 58, 'a reveal reaches past fifty, which the automatic raise does not')
  assert.equal(tree.revealMark(rows, 's-7', 15), 15, 'and never lowers a watermark a reader raised')
  /** The watermark counts conversations (#54): an open New session placeholder ahead of the row takes none of its places. */
  const behindBlank = [session('s-blank', 59, { turns: 0 }), ...rows]
  assert.equal(tree.revealMark(behindBlank, 's-57', 5), 58, 'the placeholder ahead of it adds nothing to the reveal')
  assert.equal(tree.revealMark(behindBlank, 's-blank', 5), 5, 'and a placeholder, drawn whatever the watermark, raises nothing')
})

test('a hit on a New session placeholder that is not open is drawn once it is opened, first in its group', () => {
  /**
   * The tree leaves out a placeholder that is not the open session (`withOpenBlank`, DSH `sessionVisible`), so the reveal
   * finds no row for it until the session is opened; opened, it is the open blank, which leads its group (DSH
   * `pinCurrentBlank`), and the reveal's one re-read of the tree finds it there.
   */
  const sessions = [session('s-talked', 3), session('s-blank-a', 2, { turns: 0 }), session('s-blank-b', 1, { turns: 0 })]
  const workspaces = [workspace('w', '/w', { sessionIds: sessions.map((meta) => meta.id) })]
  const before = tree.deriveGroups(workspaces, sessions, { current: 's-talked' })
  assert.deepEqual(ids(before[0]), ['s-talked'], 'while another session is open, neither placeholder is a row')
  assert.deepEqual(tree.chainTo(before, 's-blank-b'), [], 'so the reveal has no row to find yet')
  const after = tree.deriveGroups(workspaces, sessions, { current: 's-blank-b' })
  assert.deepEqual(ids(after[0]), ['s-blank-b', 's-talked'], 'opened, it is a row, first in its group, and the other placeholder stays out')
  assert.deepEqual(tree.chainTo(after, 's-blank-b').map((group) => group.key), ['w'], 'and the re-read tree leads the reveal to it')
  assert.equal(tree.revealMark(after[0]?.sessions ?? [], 's-blank-b', tree.INITIAL), tree.INITIAL, 'drawn without raising the watermark')
})

test('the first-use workspace reads as Default workspace while it keeps its automatic title', () => {
  /**
   * DSH's workspaceDisplayTitle (dsh-api-workspace-controller lib/types/default-workspace.js): the stored title stays
   * the folder name, default-workspace, and the browser labels it with the default name; any other title, including
   * one a person typed, reads verbatim.
   */
  const label = new Function(`${page.slice(begin, end)}\nreturn typeof workspaceDisplayTitle === 'function' ? workspaceDisplayTitle : undefined`)() as
    | ((title: string) => string)
    | undefined
  assert.equal(typeof label, 'function', 'the block carries the label rule')
  assert.equal(label?.('default-workspace'), 'Default workspace')
  assert.equal(label?.('Default workspace'), 'Default workspace')
  assert.equal(label?.('notes'), 'notes')
  const [group] = tree.deriveGroups([workspace('w-default', '/h/default-workspace', { title: 'default-workspace' })], [])
  assert.equal(group?.label, 'Default workspace', 'the row shows the default name')
  const [renamed] = tree.deriveGroups([workspace('w-default', '/h/default-workspace', { title: 'Mine' })], [])
  assert.equal(renamed?.label, 'Mine', 'and a rename wins')
})
