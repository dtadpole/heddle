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
  hiddenBlank: (meta: unknown, current: unknown) => boolean
  SELECTION_KEY: string
  selectionRecord: (id: string | null) => string
  savedSelection: (raw: unknown) => string | null
  recentWorkspace: (workspaces: unknown[], sessions: unknown[]) => { id: string; path: string } | undefined
  restoreChoice: (saved: string | null, workspaces: unknown[], sessions: unknown[]) => { kind: 'saved' | 'start' | 'newest' | 'none'; id?: string; path?: string; forget?: boolean }
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

test('pinned sessions lead, the newest pin first, then the most recently updated', () => {
  const sessions = [
    session('s-recent', 50),
    session('s-pin-old', 1, { pinned: true, pinnedAt: '2026-10-28T09:00:00.000Z' }),
    session('s-pin-new', 2, { pinned: true, pinnedAt: '2026-10-28T09:30:00.000Z' }),
    session('s-pin-untimed', 3, { pinned: true }),
    session('s-older', 10),
    session('s-archived-pin', 60, { pinned: true, archived: true }),
  ]
  const order = [...sessions].sort(tree.sessionOrder).map((meta) => meta.id)
  /** An archived row carries no pin (DSH keeps the two sets exclusive), so it sorts by its age among the rest. */
  assert.deepEqual(order, ['s-pin-new', 's-pin-old', 's-pin-untimed', 's-archived-pin', 's-recent', 's-older'])
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

test('the open session is kept the way DSH keeps it, and only an entry this page wrote is read back', () => {
  /**
   * DSH persists its main-view selection as `{ sessionId }` in one localStorage entry and empties it to `{}` when the
   * view is cleared (dsh-client-ui-workspace lib/client.js:1369, :1644-1650, :1662-1665). C28: the page kept nothing.
   */
  assert.equal(tree.SELECTION_KEY, 'heddle.sessions.current')
  assert.equal(tree.selectionRecord('session-a'), '{"sessionId":"session-a"}')
  assert.equal(tree.selectionRecord(null), '{}', 'nothing open is an empty record, not a missing one')
  assert.equal(tree.savedSelection(tree.selectionRecord('session-a')), 'session-a')
  assert.equal(tree.savedSelection('{}'), null)
  assert.equal(tree.savedSelection(null), null, 'a first visit has no entry')
  assert.equal(tree.savedSelection('not json'), null, 'a damaged entry is no selection rather than an error')
  assert.equal(tree.savedSelection('{"sessionId":7}'), null)
  assert.equal(tree.savedSelection('"session-a"'), null)
})

test('a reload reopens the saved session, and with nothing saved never opens a hidden subagent child (C28)', () => {
  /**
   * DSH's restoreSelection (lib/client.js:1605-1628) reopens the saved session. C28 measured a reload opening
   * `/api/sessions`[0] instead — the newest session, there a subagent's child the tree hides.
   */
  const workspaces = [workspace('w', '/w', { sessionIds: ['s-child', 's-archived', 's-beta', 's-alpha'] })]
  const sessions = [
    session('s-child', 9, { origin: 'subagent', parentSession: 's-alpha', title: 'child task' }),
    session('s-archived', 8, { archived: true }),
    session('s-beta', 5, { title: 'beta notes' }),
    session('s-alpha', 3, { title: 'alpha notes' }),
  ]
  assert.deepEqual(tree.restoreChoice('s-alpha', workspaces, sessions), { kind: 'saved', id: 's-alpha' }, 'the saved session, though three are newer')
  assert.deepEqual(
    tree.restoreChoice(null, workspaces, sessions),
    { kind: 'newest', id: 's-beta' },
    'with nothing saved, the newest row: not the hidden child, not the archived session',
  )
  assert.deepEqual(tree.restoreChoice('s-child', workspaces, sessions), { kind: 'saved', id: 's-child' }, 'a child the person opened is theirs to come back to (DSH restores a saved subagent view, :1607-1609)')
  assert.deepEqual(tree.restoreChoice(null, workspaces, [sessions[0]]), { kind: 'none' }, 'a store holding only a child opens nothing')
  assert.deepEqual(tree.restoreChoice(null, workspaces, []), { kind: 'none' })
})

test('a saved New session placeholder is reopened by its own id, never replaced by a fresh one', () => {
  /** DSH's restoreBlank reloads the saved blank's projections and reconnects the same id (lib/client.js:1451-1458, :1619). */
  const workspaces = [workspace('w', '/w', { sessionIds: ['s-blank', 's-talked'] })]
  const sessions = [session('s-talked', 5), session('s-blank', 3, { turns: 0 })]
  assert.deepEqual(tree.restoreChoice('s-blank', workspaces, sessions), { kind: 'saved', id: 's-blank' })
})

test('a saved session that is gone starts a fresh one in the most recently active workspace; an archived one is not reopened', () => {
  /**
   * DSH: no listed summary, so no workspace of its own; the target is recentWorkspace and connectWorkspace creates a
   * session there (lib/client.js:1620, :1626, :1406). An archived current is cleared at once (:1578, :1638-1650), which
   * leaves the load with nothing saved.
   */
  const workspaces = [
    workspace('w-old', '/old', { sessionIds: ['s-old'] }),
    workspace('w-recent', '/recent', { sessionIds: ['s-recent'] }),
    workspace('w-empty', '/empty'),
  ]
  const sessions = [session('s-recent', 30, { title: 'recent' }), session('s-old', 10, { title: 'old', archived: true })]
  assert.deepEqual(tree.restoreChoice('session-gone', workspaces, sessions), { kind: 'start', path: '/recent', forget: true })
  assert.deepEqual(tree.restoreChoice('s-old', workspaces, sessions), { kind: 'newest', id: 's-recent', forget: true }, 'archived: forgotten, then as a load with nothing saved')
  assert.deepEqual(tree.restoreChoice('session-gone', [], sessions), { kind: 'newest', id: 's-recent', forget: true }, 'no registered workspace to start in')
  assert.deepEqual(
    tree.restoreChoice('session-gone', [workspace('w-auto', '/auto', { origin: 'auto', sessionIds: ['s-recent'] })], sessions),
    { kind: 'newest', id: 's-recent', forget: true },
    'an adopted root is not a place a session starts',
  )
})

test('the most recently active workspace is DSH\'s recentWorkspace', () => {
  /** lib/client.js:1694-1710: the latest session update, else the workspace's creation, a tie kept in registry order. */
  const made = (id: string, path: string, createdAt: string, options: Parameters<typeof workspace>[2] = {}) => ({ ...workspace(id, path, options), createdAt })
  const sessions = [session('s-a', 20), session('s-b', 40), session('s-in-auto', 50)]
  assert.equal(
    tree.recentWorkspace([made('w-a', '/a', '2026-10-28T00:00:00.000Z', { sessionIds: ['s-a'] }), made('w-b', '/b', '2026-10-28T00:00:00.000Z', { sessionIds: ['s-b'] })], sessions)?.id,
    'w-b',
    'the workspace written last',
  )
  assert.equal(
    tree.recentWorkspace(
      [made('w-a', '/a', '2026-10-28T00:00:00.000Z', { sessionIds: ['s-a'] }), made('w-new', '/new', '2026-10-28T11:00:00.000Z')],
      sessions,
    )?.id,
    'w-new',
    'a workspace with no session counts from its creation',
  )
  assert.equal(
    tree.recentWorkspace(
      [
        made('w-b', '/b', '2026-10-28T00:00:00.000Z', { sessionIds: ['s-b'] }),
        made('w-a', '/a', '2026-10-28T00:00:00.000Z', { sessionIds: ['s-a'] }),
        made('w-auto', '/a/scratch', '2026-10-28T00:00:00.000Z', { origin: 'auto', parent: 'w-a', sessionIds: ['s-in-auto'] }),
      ],
      sessions,
    )?.id,
    'w-a',
    'an adopted root\'s session counts for the registered workspace above it',
  )
  assert.equal(
    tree.recentWorkspace([made('w-1', '/1', '2026-10-28T00:00:00.000Z'), made('w-2', '/2', '2026-10-28T00:00:00.000Z')], [])?.id,
    'w-1',
    'a tie keeps registry order',
  )
  assert.equal(tree.recentWorkspace([], sessions), undefined)
})
