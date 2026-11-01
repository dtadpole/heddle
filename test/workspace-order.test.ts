import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * DSH's two session orders (parity row C17, R-developer-eight-20), judged out of the page block that applies them.
 *
 * dsh-client-ui-workspace's README (*Reordering and view options*): **Last updated** sorts each partition (pinned, then
 * the rest) strictly by the latest user prompt or steer time, newest first, pin time not counting; **Manual** uses one
 * saved sequence per account, including hidden archives. Entering Manual freezes the chronological order on screen,
 * returning to Last updated discards the layout, and dragging a row edits the sequence and selects Manual. Display
 * orders are browser-local (the persisted view store `dsh.workspace.view.v5`, lib/client.js:1265-1315), so a reload
 * reads them back from storage. The functions cited below are DSH's, in dsh-client-ui-workspace/lib/client.js.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* workspace-tree:begin */')
const end = page.indexOf('/* workspace-tree:end */')

interface Meta {
  id: string
  [key: string]: unknown
}
interface Group {
  key: string
  order: string[]
  sessions: Meta[]
}
interface OrderState {
  orderBy: 'updated' | 'manual'
  orders: Record<string, string[]>
}
interface Tree {
  FLAT: string
  deriveGroups: (workspaces: unknown[], sessions: unknown[], options?: Record<string, unknown>) => Group[]
  flatRows: (sessions: unknown[], options?: Record<string, unknown>) => { order: string[]; rows: Meta[] }
  accountOrders: (workspaces: unknown[], sessions: unknown[], order: OrderState) => Record<string, string[]>
  draggable: (meta: Meta) => boolean
  dragOrder: (order: string[], rows: Meta[], drag: { id: string; pinned: boolean }, over: { id: string; half: 'before' | 'after' }) => string[] | undefined
  readOrder: (text: string | null) => OrderState
  chooseOrderBy: (state: OrderState, mode: 'updated' | 'manual', shown: Record<string, string[]>) => OrderState
  withSessionOrder: (state: OrderState, key: string, order: string[], shown: Record<string, string[]>) => OrderState
  withPinFronted: (state: OrderState, id: string, shown: Record<string, string[]>) => OrderState
}

const tree = new Function(`${page.slice(begin, end)}\nreturn WorkspaceTree`)() as Tree

function workspace(id: string, sessionIds: string[]) {
  return { id, path: `/${id}`, title: id, origin: 'added', parent: null, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', sessionIds }
}

/** A session as `/api/sessions` answers it: `minute` is its latest prompt (`updated`); `created` is older still. */
function session(id: string, minute: number, extra: Record<string, unknown> = {}) {
  return { id, cwd: '/w', created: '2026-10-28T09:00:00.000Z', updated: `2026-10-28T10:${String(minute).padStart(2, '0')}:00.000Z`, turns: 1, ...extra }
}

const ids = (metas: Meta[] | undefined) => (metas ?? []).map((meta) => meta.id)
const LAST_UPDATED: OrderState = { orderBy: 'updated', orders: {} }

test('Last updated: pinned rows lead, and each part is by latest prompt alone, pin time not counting', () => {
  const sessions = [
    session('s-recent', 50),
    session('s-pin-old-pin', 30, { pinned: true, pinnedAt: '2026-10-28T09:00:00.000Z' }),
    session('s-pin-new-pin', 20, { pinned: true, pinnedAt: '2026-10-28T11:00:00.000Z' }),
    session('s-older', 10),
  ]
  const [group] = tree.deriveGroups([workspace('w', sessions.map((meta) => meta.id))], sessions, { order: LAST_UPDATED })
  assert.deepEqual(ids(group?.sessions), ['s-pin-old-pin', 's-pin-new-pin', 's-recent', 's-older'], 'the pin made later does not lead a pin prompted later')
  assert.deepEqual(group?.order, ['s-recent', 's-pin-old-pin', 's-pin-new-pin', 's-older'], 'the account order is recency alone')
})

test('In one list follows the same Last updated order, by prompt time rather than by creation', () => {
  const sessions = [session('s-made-first-prompted-last', 40, { created: '2026-10-28T08:00:00.000Z' }), session('s-made-last', 5, { created: '2026-10-28T09:59:00.000Z' })]
  assert.deepEqual(ids(tree.flatRows(sessions, { order: LAST_UPDATED }).rows), ['s-made-first-prompted-last', 's-made-last'])
})

test('a drag puts a session above another, selects Manual, and the order survives a reload from storage', () => {
  const sessions = [session('s-a', 40), session('s-b', 30), session('s-c', 20), session('s-hidden', 50, { archived: true })]
  const workspaces = [workspace('w', ['s-a', 's-b', 's-c', 's-hidden'])]
  const [before] = tree.deriveGroups(workspaces, sessions, { order: LAST_UPDATED })
  assert.deepEqual(ids(before?.sessions), ['s-a', 's-b', 's-c'])
  const shown = tree.accountOrders(workspaces, sessions, LAST_UPDATED)
  assert.deepEqual(shown.w, ['s-hidden', 's-a', 's-b', 's-c'], 'the account order keeps the hidden archive')

  /** Drag s-c onto the top half of s-a. */
  const next = tree.dragOrder(shown.w ?? [], before?.sessions ?? [], { id: 's-c', pinned: false }, { id: 's-a', half: 'before' })
  assert.deepEqual(next, ['s-hidden', 's-c', 's-a', 's-b'], 'the dragged row lands before its target; the hidden archive keeps its slot')
  const state = tree.withSessionOrder(LAST_UPDATED, 'w', next ?? [], shown)
  assert.equal(state.orderBy, 'manual', 'a drag selects Manual')
  assert.deepEqual(state.orders[tree.FLAT], shown[tree.FLAT], "and freezes the other accounts' orders as shown")

  const reloaded = tree.readOrder(JSON.stringify(state))
  assert.deepEqual(reloaded, state, 'what the browser stored reads back unchanged')
  const [after] = tree.deriveGroups(workspaces, sessions, { order: reloaded })
  assert.deepEqual(ids(after?.sessions), ['s-c', 's-a', 's-b'], 'after the reload the list is in the dragged order')

  /** A newer prompt does not move a row in Manual. */
  const prompted = sessions.map((meta) => (meta.id === 's-b' ? { ...meta, updated: '2026-10-28T10:59:00.000Z' } : meta))
  assert.deepEqual(ids(tree.deriveGroups(workspaces, prompted, { order: reloaded })[0]?.sessions), ['s-c', 's-a', 's-b'])
  assert.deepEqual(ids(tree.deriveGroups(workspaces, prompted, { order: LAST_UPDATED })[0]?.sessions), ['s-b', 's-a', 's-c'], 'while Last updated moves it')
})

test('a drop that changes nothing, crosses the pinned boundary, or moves a blank or archived row is refused', () => {
  const rows = [session('s-pin', 50, { pinned: true }), session('s-a', 40), session('s-b', 30), session('s-blank', 20, { turns: 0 })]
  const order = ['s-a', 's-pin', 's-b', 's-blank']
  assert.equal(tree.dragOrder(order, rows, { id: 's-b', pinned: false }, { id: 's-a', half: 'after' }), undefined, 'already there')
  assert.equal(tree.dragOrder(order, rows, { id: 's-b', pinned: false }, { id: 's-pin', half: 'before' }), undefined, 'not into the pinned part')
  assert.equal(tree.dragOrder(order, rows, { id: 's-blank', pinned: false }, { id: 's-a', half: 'before' }), undefined, 'a blank row stays')
  assert.equal(tree.draggable(session('s-x', 1, { archived: true })), false, 'an archived row is not draggable')
  assert.deepEqual(tree.dragOrder(order, rows, { id: 's-a', pinned: false }, { id: 's-b', half: 'after' }), ['s-pin', 's-b', 's-a', 's-blank'])
})

test('Manual reconciles its saved sequence with the members: new pins first, new rows by recency, new archives last', () => {
  const state: OrderState = { orderBy: 'manual', orders: { w: ['s-gone', 's-b', 's-a'] } }
  const sessions = [
    session('s-a', 10),
    session('s-b', 20),
    session('s-new', 30),
    session('s-new-archived', 59, { archived: true }),
    session('s-pin-1', 5, { pinned: true, pinnedAt: '2026-10-28T09:00:00.000Z' }),
    session('s-pin-2', 4, { pinned: true, pinnedAt: '2026-10-28T09:30:00.000Z' }),
  ]
  const [group] = tree.deriveGroups([workspace('w', sessions.map((meta) => meta.id))], sessions, { order: state, archived: 'show' })
  assert.deepEqual(group?.order, ['s-pin-2', 's-pin-1', 's-b', 's-a', 's-new', 's-new-archived'], 'missing pins newest pin first, saved positions, then by recency, archives last')
  assert.deepEqual(ids(group?.sessions), ['s-pin-2', 's-pin-1', 's-b', 's-a', 's-new', 's-new-archived'])
})

test('choosing a mode: Manual freezes the order shown, Last updated discards it, and a pin under Manual goes to the front', () => {
  const shown = { w: ['s-a', 's-b', 's-c'] }
  const manual = tree.chooseOrderBy(LAST_UPDATED, 'manual', shown)
  assert.deepEqual(manual, { orderBy: 'manual', orders: { w: ['s-a', 's-b', 's-c'] } })
  assert.equal(tree.chooseOrderBy(manual, 'manual', { w: [] }), manual, 'choosing the current mode changes nothing')
  assert.deepEqual(tree.chooseOrderBy(manual, 'updated', shown), LAST_UPDATED)
  assert.deepEqual(tree.withPinFronted(manual, 's-c', shown).orders.w, ['s-c', 's-a', 's-b'])
  assert.deepEqual(tree.readOrder('not json'), LAST_UPDATED, 'unreadable storage is the default, Last updated')
  assert.deepEqual(tree.readOrder(null), LAST_UPDATED)
})
