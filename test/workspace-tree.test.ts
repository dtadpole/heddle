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
  raisedWatermark: (stored: number | undefined, sessions: unknown[], options?: Record<string, unknown>) => number
  parentsRunning: (sessions: unknown[], running?: Set<string>) => Set<string>
  watermarkRows: (sessions: { id: string }[], watermark: number) => { rows: { id: string }[]; hidden: number; conversations: number }
  nextWatermark: (total: number, shown: number) => number
  overflow: (total: number, shown: number, baseline?: number) => 'more' | 'less' | null
  overflowLabel: (mode: 'more' | 'less', hidden: number) => string
  sessionOrder: (left: unknown, right: unknown) => number
  hiddenBlank: (meta: unknown, current: unknown) => boolean
  placeholder: (meta: unknown) => boolean
  rowOffersActions: (meta: unknown) => boolean
  NO_COMPLETED_TURN: string
  FORK_FAILED: string
  forkBlocked: (meta: unknown) => string | null
  forkRefusal: (body: unknown) => string
  ARCHIVED_NOT_OPENABLE: string
  opensOnClick: (node: unknown) => boolean
  rowStatus: (facts?: { pending?: string; running?: boolean; completed?: boolean }) => { state: string; label: string; trailingLabel?: string }
  completionUnread: (unread: boolean, change: { wasRunning?: boolean; running?: boolean; viewing?: boolean }) => boolean
  storedTitle: (meta: unknown) => string | undefined
  sessionLabel: (meta: unknown) => string
  rowLabel: (node: unknown) => string
  rowTooltip: (node: unknown) => string | undefined
  headerTitle: (meta: unknown) => string | null
  documentTitle: (meta: unknown, product?: string) => string
  workspaceRefusal: (status: number, body: unknown, fallback: string) => { gone: boolean; text: string }
  SELECTION_KEY: string
  selectionRecord: (id: string | null) => string
  savedSelection: (raw: unknown) => string | null
  recentWorkspace: (workspaces: unknown[], sessions: unknown[]) => { id: string; path: string } | undefined
  restoreChoice: (saved: string | null, workspaces: unknown[], sessions: unknown[]) => { kind: 'saved' | 'start' | 'none'; id?: string; path?: string; forget?: boolean }
  EMPTY_TEXT: { none: string; noneArchived: string; viewOthers: string; noRoots: string }
  emptyList: (archived: string, grouping: string, count: number) => { kind: 'placeholder' | 'note'; text: string; glyph?: string; action?: string } | null
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

/**
 * DSH's `requiredWatermark` (dsh-client-ui-workspace lib/client.js:2820-2833): the watermark rises to the last conversation
 * within the first fifty that is running, has a running child, **awaits the person** (`pendingInteraction`, one of the
 * three kinds `visiblePendingKind` keeps, `:1048-1055`), **carries an unread completion** (`completed`, `:1068`), or is
 * open. #62: the page raised it for running and open rows only, so a waiting or unread row could sit below the fold.
 */
test('Show more: a row awaiting a person, an unread completion or a running child raises the watermark to it, within fifty', () => {
  const rows = Array.from({ length: 60 }, (_, index) => session(`s-${index}`, index % 60))
  assert.equal(tree.shownCount(rows, 5, { pending: new Map([['s-7', 'approval']]) }), 8, 'a row waiting for approval is kept in view')
  assert.equal(tree.shownCount(rows, 5, { pending: new Map([['s-9', 'plan-review']]) }), 10, 'so is one whose plan awaits review')
  assert.equal(tree.shownCount(rows, 5, { pending: new Map([['s-11', 'question']]) }), 12, 'and one waiting for an answer')
  assert.equal(tree.shownCount(rows, 5, { pending: new Map([['s-11', 'toString']]) }), 5, 'an unknown kind is no interaction')
  assert.equal(tree.shownCount(rows, 5, { unread: new Set(['s-20']) }), 21, 'an unread completion is kept in view')
  assert.equal(tree.shownCount(rows, 5, { runningChildren: new Set(['s-14']) }), 15, 'and a session whose subagent is running')
  assert.equal(
    tree.shownCount(rows, 5, { pending: new Map([['s-7', 'approval']]), unread: new Set(['s-25']), current: 's-3' }),
    26,
    'the last of them sets the count',
  )
  assert.equal(tree.shownCount(rows, 5, { unread: new Set(['s-49']) }), 50, 'the fiftieth conversation is within reach')
  assert.equal(tree.shownCount(rows, 5, { pending: new Map([['s-52', 'approval']]), unread: new Set(['s-55']) }), 5, 'a later one is not')
  const blank = session('s-blank', 59, { turns: 0 })
  assert.equal(
    tree.shownCount([blank, ...rows.slice(0, 10)], 5, { unread: new Set(['s-6']), current: 's-blank' }),
    7,
    'the open New session takes no place in the count',
  )
})

/** DSH's `runningChildCount` (`lib/client.js:1056-1058`): a subagent child's run counts for its parent's row, a fork's does not. */
test('a session whose subagent is running is one with a running child; a fork names its source but is no child', () => {
  const metas = [
    session('s-parent', 1),
    session('s-child', 2, { origin: 'subagent', parentSession: 's-parent', running: true }),
    session('s-fork', 3, { parentSession: 's-source', running: true }),
    session('s-idle-child', 4, { origin: 'subagent', parentSession: 's-quiet' }),
    session('s-live-child', 5, { origin: 'subagent', parentSession: 's-third' }),
  ]
  assert.deepEqual([...tree.parentsRunning(metas, new Set(['s-live-child']))].sort(), ['s-parent', 's-third'])
  assert.deepEqual([...tree.parentsRunning(metas)], ['s-parent'], 'the list\'s own running flag counts without the stream')
})

/**
 * DSH keeps the raise (`raiseWatermarks` and the stored marks, `lib/client.js:2834-2842`, `:3088`, `:3095-3096`; README:
 * "a row count that never falls on its own, so the rows stay visible after a run or notification ends"). Only Show less and
 * folding the workspace lower it, and the page does both by forgetting the stored mark.
 */
test('a raised watermark never falls on its own: the row stays in view after its question is answered and read', () => {
  const rows = Array.from({ length: 12 }, (_, index) => session(`s-${index}`, 40 - index))
  let mark = tree.raisedWatermark(undefined, rows, {})
  assert.equal(mark, 5, 'nothing to raise: the first five')
  mark = tree.raisedWatermark(mark, rows, { pending: new Map([['s-8', 'approval']]) })
  assert.equal(mark, 9, 'a question at the ninth row raises it to nine')
  mark = tree.raisedWatermark(mark, rows, { unread: new Set(['s-8']) })
  assert.equal(mark, 9, 'the turn ends off screen: still nine')
  mark = tree.raisedWatermark(mark, rows, {})
  assert.equal(mark, 9, 'read and quiet: still nine')
  assert.equal(tree.shownCount(rows, mark, {}), 9, 'so the row stays drawn')
  assert.equal(tree.raisedWatermark(10, rows, { unread: new Set(['s-3']) }), 10, 'a Show more past the requirement is kept')
  assert.equal(tree.raisedWatermark(undefined, rows, { unread: new Set(['s-3']) }), 5, 'a row already in view raises nothing')
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

test('an archived session row does not open, and says why in DSH\'s words', () => {
  /**
   * DSH's workspace browser guards opening (dsh-client-ui-workspace lib/client.js:3532-3538, guardedOpen): an archived
   * session's row raises "Archived sessions cannot be opened. Unarchive it to view." (toast.archivedNotOpenable,
   * :4934) and opens nothing, and the row carries that sentence as its aria-description (:2279). Measured before (live-
   * testing draft developer-six-7): clicking an archived row opened it with a working composer.
   */
  assert.equal(tree.ARCHIVED_NOT_OPENABLE, 'Archived sessions cannot be opened. Unarchive it to view.')
  const live = { kind: 'session', path: 'session:s-1', session: { id: 's-1' } }
  assert.equal(tree.opensOnClick(live), true, 'a live session opens')
  assert.equal(tree.opensOnClick({ ...live, archived: true }), false, 'an archived one does not')
  assert.equal(tree.opensOnClick({ kind: 'folder', path: '/w/a', archived: true }), true, 'only a session row is guarded')
})

/**
 * A session row's status is DSH's `sessionStatuses` (dsh-client-ui-workspace `client.js:2068-2117`, words from its
 * `en` locale at `client.js:4970-4980`): a pending interaction first, as a warning whose short word replaces the time;
 * then running; then a completion nobody has seen; else idle, which draws no mark.
 */
test('a row awaiting a person says Approval, Plan review or Answer, and outranks running and an unread completion', () => {
  assert.equal(typeof tree.rowStatus, 'function', 'the block derives a row status')
  assert.deepEqual(tree.rowStatus({ pending: 'approval', running: true, completed: true }), { state: 'warning', label: 'Waiting for approval', trailingLabel: 'Approval' })
  assert.deepEqual(tree.rowStatus({ pending: 'plan-review' }), { state: 'warning', label: 'Plan awaiting review', trailingLabel: 'Plan review' })
  assert.deepEqual(tree.rowStatus({ pending: 'question' }), { state: 'warning', label: 'Waiting for answer', trailingLabel: 'Answer' })
  assert.deepEqual(tree.rowStatus({ running: true, completed: true }), { state: 'ongoing', label: 'Running' }, 'live activity outranks a completion reminder')
  assert.deepEqual(tree.rowStatus({ completed: true }), { state: 'done', label: 'Completed' })
  assert.deepEqual(tree.rowStatus({}), { state: 'idle', label: 'Idle' })
  assert.deepEqual(tree.rowStatus({ pending: 'toString' }), { state: 'idle', label: 'Idle' }, 'an unknown kind is no interaction')
})

/** DSH's completion reminder (dsh-client-ui-session `client.js:948-965`): set by a turn ending off screen, read by opening. */
test('a turn that ends while its session is off screen stays unread until the session is opened or runs again', () => {
  assert.equal(typeof tree.completionUnread, 'function', 'the block decides the completion reminder')
  assert.equal(tree.completionUnread(false, { wasRunning: true, running: false, viewing: false }), true, 'ended off screen: unread')
  assert.equal(tree.completionUnread(false, { wasRunning: true, running: false, viewing: true }), false, 'ended on screen: already seen')
  assert.equal(tree.completionUnread(false, { wasRunning: false, running: false, viewing: false }), false, 'no running edge, no reminder')
  assert.equal(tree.completionUnread(true, { wasRunning: false, running: false, viewing: false }), true, 'a reminder stays while nothing changes')
  assert.equal(tree.completionUnread(true, { wasRunning: false, running: false, viewing: true }), false, 'opening the session reads it')
  assert.equal(tree.completionUnread(true, { wasRunning: false, running: true, viewing: false }), false, 'running again clears it')
})

test('a session row reads New Session while it is the open blank, its title once it has one, else Untitled — never a folder name (#24)', () => {
  /**
   * DSH's row title (`displayTitle`, dsh-client-ui-workspace lib/client.js:1801-1804): `blank ? "New Session" : title ||
   * "Untitled"` (`session.new` and `session.untitled`, :4876-4877), "rather than a directory name" (README.md:32). The page
   * labelled an unnamed session with its definition folder's `session-<yyyymmdd>-<hhmm>` name (#24).
   */
  assert.equal(tree.sessionLabel(session('s-blank', 1, { turns: 0 })), 'New Session', 'the blank reads New Session')
  assert.equal(tree.sessionLabel(session('s-told', 1, { title: 'Why Rivers Meander' })), 'Why Rivers Meander', 'a titled row its title')
  assert.equal(tree.sessionLabel(session('s-untitled', 1)), 'Untitled', 'a started session with no title reads Untitled')
  assert.equal(tree.sessionLabel(session('s-spaces', 1, { title: '   ' })), 'Untitled', 'a blank title is no title')
  assert.equal(tree.sessionLabel(session('s-running', 1, { turns: 0, running: true })), 'Untitled', 'a first turn in flight is no longer the blank')
  assert.equal(tree.sessionLabel(session('s-named-blank', 1, { turns: 0, title: 'named on purpose' })), 'named on purpose', 'a blank a person named keeps the name')
  assert.equal(tree.sessionLabel(session('s-pinned-blank', 1, { turns: 0, pinned: true })), 'Untitled', 'a pinned blank is a row a person acted on, not the New Session')
  for (const meta of [session('s-a', 1, { turns: 0, cwd: '/w/_sessions_/session-dated-folder' }), session('s-b', 1, { cwd: '/w/_sessions_/session-dated-folder' })]) {
    assert.doesNotMatch(tree.sessionLabel(meta), /session-|\//, 'no internal folder name and no path, whatever the folder')
  }
  assert.equal(tree.storedTitle({ id: 'x', title: 'kept' }), 'kept')
  assert.equal(tree.storedTitle({ id: 'x' }), undefined)
  assert.equal(tree.storedTitle(null), undefined)
})

test('a session row\'s tooltip is its display title and no other row has one — never its definition folder or the home directory (#109)', () => {
  /**
   * DSH's rows carry no `title` and no `aria-label` (dsh-client-ui-workspace lib/client.js:2273-2280 for `SessionNodeItem`,
   * :1965-1971 for `ProjectRowItem`); the full title and folder are on the pointer's hover card (`copyText`, :2364, :2055).
   * The page's session row carried its definition folder (`<home>/…/_sessions_/session-<date>-<time>`) as its `title`, which
   * a keyboard or screen-reader user still heard once the hover card took the tooltip away from the pointer (#109).
   */
  assert.equal(typeof tree.rowTooltip, 'function', 'the block decides a row\'s tooltip')
  const home = '/Users/someone'
  const work = `${home}/repo`
  const definition = `${work}/_sessions_/session-dated-folder`
  const row = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, path: kind === 'session' ? 'session:s-1' : work, cwd: work, label: 'repo', ...extra })
  const titled = row('session', { label: 'Why Rivers Meander', session: { id: 's-1', title: 'Why Rivers Meander', cwd: work } })
  const blank = row('session', { label: tree.sessionLabel({ id: 's-2', turns: 0 }), session: { id: 's-2', turns: 0, cwd: work } })
  const untitled = row('session', { label: tree.sessionLabel({ id: 's-3', turns: 2 }), session: { id: 's-3', turns: 2, cwd: work } })
  /** A session drawn from a folder listing (one `/api/sessions` does not list): its node's path is its definition folder. */
  const listed = { kind: 'session', path: definition, cwd: work, label: 'session-dated-folder', session: { id: 's-4', cwd: work } }
  assert.equal(tree.rowTooltip(titled), 'Why Rivers Meander', 'a titled row: its title, which the row may clip')
  assert.equal(tree.rowTooltip(blank), 'New Session', 'the open blank: what its label reads')
  assert.equal(tree.rowTooltip(untitled), 'Untitled', 'an untitled row: what its label reads')
  for (const node of [titled, blank, untitled, listed]) {
    assert.equal(tree.rowTooltip(node), tree.rowLabel(node), 'the tooltip is the label, the name the hover card shows')
    assert.doesNotMatch(String(tree.rowTooltip(node)), /_sessions_|\//, 'never a path: no definition folder, no working folder')
    assert.ok(!String(tree.rowTooltip(node)).includes(home), 'and never the home directory')
  }
  for (const kind of ['workspace', 'ungrouped', 'type', 'instance', 'folder', 'file']) {
    assert.equal(tree.rowTooltip(row(kind)), undefined, `a ${kind} row has no tooltip, as DSH's rows have none`)
  }
  assert.equal(tree.rowLabel(row('workspace')), 'repo', 'a workspace row reads its label')
  assert.equal(tree.rowTooltip(null), undefined)
})

test('the header hides its title while the session is blank and then follows its title; the window title is DSH\'s (#24)', () => {
  /**
   * DSH's header (dsh-client-ui-conversation lib/client.js:17897-17908, :17994; README.md:87): no title while blank, then
   * `displayTitleOf(title, cwd, id)` — the title, else the folder's name, else the id (dsh-api-session-controller
   * lib/client.js:3696-3707). Its window title (dsh-client-ui-layout lib/client.js:57-68): `<title> — <product>`, or the
   * product alone. The page printed the raw session id in the header, before and after the first prompt titled it (#24).
   */
  const id = 'session-raw-id-for-this-test'
  assert.equal(tree.headerTitle({ id, cwd: '/home/me/repo', turns: 0 }), null, 'a blank session shows no title in the header')
  assert.equal(tree.headerTitle({ id, cwd: '/home/me/repo', turns: 1, title: 'Why rivers meander, in one…' }), 'Why rivers meander, in one…', 'the first prompt\'s title, once written')
  assert.equal(tree.headerTitle({ id, cwd: '/home/me/repo', turns: 1, title: 'Why Rivers Meander' }), 'Why Rivers Meander', 'then the generated one')
  assert.equal(tree.headerTitle({ id, cwd: '/home/me/repo/', turns: 1 }), 'repo', 'an untitled conversation is named by its folder, as DSH\'s is')
  assert.equal(tree.headerTitle({ id, turns: 1 }), id, 'and by its id only when there is no folder at all')
  assert.equal(tree.headerTitle({ id, cwd: '/home/me/repo', turns: 0, running: true }), 'repo', 'a first turn in flight ends the blank')
  assert.equal(tree.documentTitle(null), 'Heddle', 'nothing open: the product')
  assert.equal(tree.documentTitle({ id, turns: 0 }), 'Heddle', 'a blank session: the product')
  assert.equal(tree.documentTitle({ id, turns: 1, title: 'Why Rivers Meander' }), 'Why Rivers Meander — Heddle', 'a titled one: its title, then the product')
  assert.equal(tree.documentTitle({ id, turns: 1 }, 'Product'), 'Product', 'an untitled one: the product, which the caller may name')
})

test('a Rename or Delete refused with 404 says the workspace was already removed, never the server\'s path (#49)', () => {
  /**
   * Both servers answer a stale `PATCH` or `DELETE /api/workspaces/<path>` with `404 {"error":"no workspace <absolute
   * path>"}`, and the dialogs printed that text, home directory included (#49). DSH's own refusal names a workspace by id
   * (dsh-api-workspace-controller lib/index.js:359), and its live list never offers a removed workspace.
   */
  const stale = { error: 'no workspace /Users/someone/work/scratch' }
  for (const fallback of ['could not rename that workspace', 'could not delete that workspace']) {
    const refusal = tree.workspaceRefusal(404, stale, fallback)
    assert.deepEqual(refusal, { gone: true, text: 'This workspace was already removed.' })
    assert.doesNotMatch(refusal.text, /\//, 'no path in the words')
  }
  const clash = { error: 'A workspace named “other” already exists.', code: 'workspace/name-conflict' }
  assert.deepEqual(tree.workspaceRefusal(409, clash, 'could not rename that workspace'), { gone: false, text: clash.error }, 'another refusal is the server\'s own sentence')
  assert.deepEqual(tree.workspaceRefusal(500, {}, 'could not delete that workspace'), { gone: false, text: 'could not delete that workspace' }, 'or the fallback')
  assert.deepEqual(tree.workspaceRefusal(400, null, 'could not rename that workspace'), { gone: false, text: 'could not rename that workspace' })
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
    { kind: 'start', path: '/w' },
    'with nothing saved, a fresh session in the workspace: not the hidden child, not the archived session, not the newest row (#17)',
  )
  assert.deepEqual(tree.restoreChoice('s-child', workspaces, sessions), { kind: 'saved', id: 's-child' }, 'a child the person opened is theirs to come back to (DSH restores a saved subagent view, :1607-1609)')
  assert.deepEqual(tree.restoreChoice(null, workspaces, [sessions[0]]), { kind: 'start', path: '/w' }, 'a store holding only a child opens none of it')
  assert.deepEqual(tree.restoreChoice(null, workspaces, []), { kind: 'start', path: '/w' })
  assert.deepEqual(tree.restoreChoice(null, [], sessions), { kind: 'none' }, 'with no registered workspace to start in, nothing opens')
})

test('with nothing saved a load starts a fresh session in the most recently active workspace, and never opens one already there (#17)', () => {
  /**
   * DSH's restoreSelection with no saved session: no summary, so the target is recentWorkspace and connectWorkspace
   * creates a fresh Session there (dsh-client-ui-workspace lib/client.js:1611-1613, :1620, :1626, :1406, :1694-1710). It
   * never opens an existing session on its own. #17: on a shared server the page opened the newest session in the store,
   * another person's, and a message sent without looking went into their conversation.
   */
  const workspaces = [
    workspace('w-mine', '/mine', { sessionIds: ['s-mine'] }),
    workspace('w-theirs', '/theirs', { sessionIds: ['s-theirs', 's-their-blank'] }),
  ]
  const sessions = [
    session('s-their-blank', 50, { turns: 0 }),
    session('s-theirs', 40, { title: 'their running work', running: true }),
    session('s-mine', 10, { title: 'my notes' }),
  ]
  for (const saved of [null, '']) {
    const choice = tree.restoreChoice(saved, workspaces, sessions)
    assert.deepEqual(choice, { kind: 'start', path: '/theirs' }, `a first visit (${JSON.stringify(saved)}) starts a fresh session, as DSH's does`)
    assert.equal(choice.id, undefined, 'and names no existing session to open: not the newest, not another client\'s blank')
  }
  assert.deepEqual(tree.restoreChoice('s-mine', workspaces, sessions), { kind: 'saved', id: 's-mine' }, 'a saved session is still reopened')
  assert.deepEqual(
    tree.restoreChoice('s-gone', workspaces, sessions),
    { kind: 'start', path: '/theirs', forget: true },
    'a saved one that is gone starts fresh the same way, and the stale entry is emptied',
  )
})

test('a New session placeholder offers no row actions, and Fork without a completed turn says so in DSH\'s words, never with an id (#79)', () => {
  /**
   * DSH's blank row draws no `rowActions` (the menu and the hover buttons) and no double-click rename (SessionNodeItem,
   * dsh-client-ui-workspace lib/client.js:2311, :2317-2323), by the rule that hides every other blank (`hiddenBlank`).
   * Its fork shortcut is blocked on a blank with `shortcut.noCompletedTurn` (:161-164, :4881), and a fork the host refuses
   * as unavailable is reported in the same sentence (:169-170, :4647); any other refusal is `shortcut.forkFailed` (:4882).
   */
  const blank = session('s-blank', 9, { turns: 0 })
  assert.equal(tree.rowOffersActions(blank), false, 'the open blank offers nothing to act on')
  assert.equal(tree.rowOffersActions(blank), !tree.placeholder(blank), 'by the placeholder predicate hiddenBlank uses')
  for (const [what, meta] of [
    ['a session that ran a turn', session('s-talked', 5)],
    ['a titled zero-turn session', session('s-titled', 4, { turns: 0, title: 'named on purpose' })],
    ['a pinned zero-turn session', session('s-pinned', 3, { turns: 0, pinned: true })],
    ['an archived zero-turn session', session('s-archived', 2, { turns: 0, archived: true })],
    ['a running first turn', session('s-running', 1, { turns: 0, running: true })],
  ] as const) {
    assert.equal(tree.rowOffersActions(meta), true, `${what} is a row a person acted on, with its actions`)
  }
  assert.equal(tree.rowOffersActions(null), false)

  assert.equal(tree.NO_COMPLETED_TURN, 'This session has no completed turn')
  assert.equal(tree.FORK_FAILED, 'Could not fork the session. Try again.')
  assert.equal(tree.forkBlocked(blank), tree.NO_COMPLETED_TURN, 'a blank is blocked before any request')
  assert.equal(tree.forkBlocked(session('s-titled', 4, { turns: 0, title: 'named on purpose' })), tree.NO_COMPLETED_TURN, 'so is a titled session that never ran a turn')
  assert.equal(tree.forkBlocked({ id: 's-unknown' }), tree.NO_COMPLETED_TURN)
  assert.equal(tree.forkBlocked(session('s-talked', 5)), null, 'a session that ran a turn may be forked')

  /** A session id in the server's shape, put together here so no id-shaped literal sits in the repository. */
  const raw = ['session', 'f'.repeat(8), 'f'.repeat(4), '4fff', '8fff', 'f'.repeat(12)].join('-')
  const refused = { error: `session ${raw} has no completed turn to fork from`, code: 'unavailable' }
  assert.equal(tree.forkRefusal(refused), tree.NO_COMPLETED_TURN, 'the server\'s unavailable is DSH\'s sentence')
  for (const body of [refused, { error: `no session ${raw}` }, {}, null]) {
    assert.doesNotMatch(tree.forkRefusal(body), /session-|[0-9a-f]{8}-/, `no refusal shows a raw session id (${JSON.stringify(body)})`)
  }
  assert.equal(tree.forkRefusal({ error: 'no session session-x' }), tree.FORK_FAILED, 'any other refusal is DSH\'s fork failure')
  assert.equal(tree.forkRefusal(null), tree.FORK_FAILED)
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
   * leaves the load with nothing saved, and that starts fresh too (#17).
   */
  const workspaces = [
    workspace('w-old', '/old', { sessionIds: ['s-old'] }),
    workspace('w-recent', '/recent', { sessionIds: ['s-recent'] }),
    workspace('w-empty', '/empty'),
  ]
  const sessions = [session('s-recent', 30, { title: 'recent' }), session('s-old', 10, { title: 'old', archived: true })]
  assert.deepEqual(tree.restoreChoice('session-gone', workspaces, sessions), { kind: 'start', path: '/recent', forget: true })
  assert.deepEqual(tree.restoreChoice('s-old', workspaces, sessions), { kind: 'start', path: '/recent', forget: true }, 'archived: forgotten, then as a load with nothing saved')
  assert.deepEqual(tree.restoreChoice('session-gone', [], sessions), { kind: 'none', forget: true }, 'no registered workspace to start in, and still no session opened on its own')
  assert.deepEqual(
    tree.restoreChoice('session-gone', [workspace('w-auto', '/auto', { origin: 'auto', sessionIds: ['s-recent'] })], sessions),
    { kind: 'none', forget: true },
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

test('the page asks those rules where it acts: a load opens no session on its own, and the blank row and Fork follow DSH (#17, #79)', () => {
  /**
   * The rules above are pure; this pins the page to them, because the defects were in the wiring: `refreshSessions` opened
   * the newest session whenever nothing was open (#17), and `nodeRow`, `menuItemsFor` and `forkSession` drew every action on
   * the blank and printed the server's refusal (#79). The browser check is 80's check-workspace-tree.mjs, "a first visit…".
   */
  const body = (start: string) => {
    const from = page.indexOf(start)
    assert.ok(from > 0, `${start} is in the page`)
    return page.slice(from, page.indexOf('\n}\n', from))
  }
  assert.doesNotMatch(body('async function refreshSessions() {'), /showSession\(|restoreChoice\(/, 'refreshing the list opens nothing')
  const restore = body('async function restoreSelection() {')
  assert.doesNotMatch(restore, /'newest'/, 'a load has no newest-session branch left')
  assert.match(restore, /if \(choice\.kind === 'saved'\) \{\s*await showSession\(choice\.id\)/, 'it reopens only what was saved')
  assert.match(restore, /startSessionAt\(\{ path: choice\.path, reveal: false, boot: true \}\)/, 'and otherwise starts a fresh session, keeping the folds')
  assert.match(body('function sessionNode(meta) {'), /WorkspaceTree\.rowOffersActions\(meta\) \? \{\} : \{ blank: true \}/, 'a session node knows it is the blank')
  assert.match(body('function menuItemsFor(node) {'), /if \(node\.kind === 'session' && node\.session && node\.blank !== true\) \{/, 'the blank gets no menu')
  assert.equal((body('function nodeRow(node, depth = 0) {').match(/node\.kind === 'session' && node\.session && node\.blank !== true/g) ?? []).length, 2, 'nor a double-click rename or the hover buttons')
  const fork = body('async function forkSession(node) {')
  assert.match(fork, /const blocked = WorkspaceTree\.forkBlocked\(node\.session\)/, 'Fork is refused before the request when there is no turn')
  assert.match(fork, /setNote\(WorkspaceTree\.forkRefusal\(body\)\)/, 'and a refusal is said in DSH\'s words')
  assert.doesNotMatch(fork, /body\.error/, 'never the server\'s, which names the raw id')
})

test('Archived only with nothing archived says DSH\'s "No archived sessions yet" and offers View other sessions, not the no-roots note (#107)', () => {
  /**
   * DSH's EmptySessions (dsh-client-ui-workspace lib/client.js:3005-3021, words at :4899-4901): "No sessions yet", and under
   * Archived only "No archived sessions yet" with a "View other sessions" text action. #107: with a workspace registered and
   * nothing archived, Archived only drops every workspace, and the page said "no workspace root yet — register one with the
   * + above"; the flat list said "no sessions to list".
   */
  assert.deepEqual(tree.EMPTY_TEXT, {
    none: 'No sessions yet',
    noneArchived: 'No archived sessions yet',
    viewOthers: 'View other sessions',
    noRoots: 'no workspace root yet — register one with the + above',
  })
  const workspaces = [workspace('w-repo', '/repo', { sessionIds: ['s-1', 's-2'] })]
  const sessions = [session('s-1', 1), session('s-2', 2)]
  const archivedOnly = tree.deriveGroups(workspaces, sessions, { grouping: 'tree', archived: 'only' })
  assert.equal(archivedOnly.length, 0, 'Archived only with nothing archived draws no group although a workspace is registered')
  const archivedEmpty = { kind: 'placeholder', glyph: 'archive', text: 'No archived sessions yet', action: 'View other sessions' }
  for (const grouping of ['tree', 'workspace', 'list']) {
    assert.deepEqual(tree.emptyList('only', grouping, 0), archivedEmpty, `${grouping}: the archived view names its own emptiness and the way back`)
  }
  assert.deepEqual(tree.emptyList('hide', 'list', 0), { kind: 'placeholder', glyph: 'list', text: 'No sessions yet' }, 'an empty flat list is DSH\'s No sessions yet')
  assert.deepEqual(tree.emptyList('show', 'list', 0), { kind: 'placeholder', glyph: 'list', text: 'No sessions yet' })
  assert.deepEqual(tree.emptyList('hide', 'tree', 0), { kind: 'note', text: tree.EMPTY_TEXT.noRoots }, 'an empty registry keeps heddle\'s note: register a folder')
  assert.deepEqual(tree.emptyList('show', 'workspace', 0), { kind: 'note', text: tree.EMPTY_TEXT.noRoots })
  for (const archived of ['hide', 'show', 'only']) {
    for (const grouping of ['tree', 'workspace', 'list']) assert.equal(tree.emptyList(archived, grouping, 1), null, `${archived}/${grouping}: a list with something in it says nothing`)
  }
})

test('the page draws the empty list from those rules, and the action goes back to Hide archived (#107)', () => {
  const body = (start: string) => {
    const from = page.indexOf(start)
    assert.ok(from > 0, `${start} is in the page`)
    return page.slice(from, page.indexOf('\n}\n', from))
  }
  const renderTree = body('async function renderTree() {')
  assert.doesNotMatch(renderTree, /setNote\('no workspace root yet/, 'the tree no longer prints the no-roots note for every empty tree')
  assert.match(renderTree, /WorkspaceTree\.emptyList\(archiveMode, groupingMode, treeGroups\.length\)/, 'it asks emptyList with the filter it drew')
  const flat = body('async function renderFlatList() {')
  assert.doesNotMatch(flat, /no sessions to list/, 'nor the flat list its own words')
  assert.match(flat, /WorkspaceTree\.emptyList\(archiveMode, 'list', visible\.length\)/)
  const paint = body('function paintEmptyList(empty) {')
  assert.match(paint, /action\.onclick = async \(\) => \{\s*archiveMode = 'hide'\s*rememberArchived\(\)\s*await renderTree\(\)/, 'View other sessions sets Hide archived, keeps it and redraws, as DSH\'s leaveArchivedOnly')
})
