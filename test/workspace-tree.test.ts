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
  ARCHIVED_NOT_OPENABLE: string
  opensOnClick: (node: unknown) => boolean
  rowStatus: (facts?: { pending?: string; running?: boolean; completed?: boolean }) => { state: string; label: string; trailingLabel?: string }
  completionUnread: (unread: boolean, change: { wasRunning?: boolean; running?: boolean; viewing?: boolean }) => boolean
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
