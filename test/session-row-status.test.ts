import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * A session row's statuses with DSH's running-subagent count (issue #187), and the page's composition of a session's
 * pending interaction from approvals and questions (issue #147).
 *
 * DSH's `sessionStatuses` (dsh-client-ui-workspace `lib/client.js:2068-2117`) puts a pending interaction or a running
 * turn first and the count after it; the count alone is the status of an idle parent whose background subagent works
 * ("1 subagent running", "{n} subagents running", `:4971-4972`). Its runtime picks one interaction per session by
 * precedence, plan review over question over approval (dsh-client-ui-session `lib/client.js:933-947`).
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* workspace-tree:begin */')
const end = page.indexOf('/* workspace-tree:end */')

interface Status {
  state: string
  label: string
  trailingLabel?: string
}
interface Tree {
  rowStatus: (facts?: object) => Status
  rowStatuses: (facts?: object) => Status[]
  runningChildCount: (sessions: object[], parentId: string, running?: Set<string>) => number
}
const tree = new Function(`${page.slice(begin, end)}\nreturn WorkspaceTree`)() as Tree

test('#187: an idle parent whose background subagent works says "1 subagent running"', () => {
  assert.equal(typeof tree.rowStatuses, 'function', 'the block lists a row’s statuses')
  assert.deepEqual(tree.rowStatuses({ runningSubagents: 1 }), [{ state: 'ongoing', label: '1 subagent running' }])
  assert.deepEqual(tree.rowStatuses({ runningSubagents: 3 }), [{ state: 'ongoing', label: '3 subagents running' }])
  assert.deepEqual(tree.rowStatus({ runningSubagents: 1, completed: true }), { state: 'ongoing', label: '1 subagent running' }, 'live work outranks an unread completion')
})

test('#187: a running or waiting parent keeps its own status first, and the count follows it', () => {
  assert.deepEqual(tree.rowStatuses({ running: true, runningSubagents: 2 }), [
    { state: 'ongoing', label: 'Running' },
    { state: 'ongoing', label: '2 subagents running' },
  ])
  assert.deepEqual(tree.rowStatuses({ pending: 'question', running: true, runningSubagents: 1 }), [
    { state: 'warning', label: 'Waiting for answer', trailingLabel: 'Answer' },
    { state: 'ongoing', label: '1 subagent running' },
  ])
  assert.deepEqual(tree.rowStatuses({ runningSubagents: 0 }), [{ state: 'idle', label: 'Idle' }], 'no running child adds nothing')
  assert.deepEqual(tree.rowStatuses({ runningSubagents: 1.5 }), [{ state: 'idle', label: 'Idle' }], 'a count is a whole number')
})

test('#187: the count comes from the listing’s subagent children that the page knows to be running', () => {
  const sessions = [
    { id: 'p', origin: 'web' },
    { id: 'c1', origin: 'subagent', parentSession: 'p' },
    { id: 'c2', origin: 'subagent', parentSession: 'p' },
    { id: 'f', origin: 'fork', parentSession: 'p' },
  ]
  assert.equal(tree.runningChildCount(sessions, 'p', new Set(['c1', 'f'])), 1, 'a fork is not a child')
  assert.equal(tree.runningChildCount(sessions, 'p', new Set(['c1', 'c2'])), 2)
})

/** The page's composition helpers, run in a small scope with the hover card's `pendingKind`. */
function composition() {
  const start = page.indexOf('const pendingInteractions = new Map()')
  const stop = page.indexOf('const questionReadsInFlight = new Set()')
  assert.ok(start > 0 && stop > start, 'the page keeps its pending sources beside pendingInteractions')
  return new Function(`${page.slice(start, stop)}\nreturn { pendingInteractions, approvalSessions, questionKinds, questionReads, composePending, clearPending }`)() as {
    pendingInteractions: Map<string, string>
    approvalSessions: Set<string>
    questionKinds: Map<string, string>
    questionReads: Map<string, number>
    composePending: (id: string) => boolean
    clearPending: (id: string) => void
  }
}

test('#147: a waiting question marks the row "Waiting for answer", a plan review outranks it, and either outranks an approval', () => {
  const c = composition()
  c.questionKinds.set('s', 'question')
  assert.equal(c.composePending('s'), true)
  assert.equal(c.pendingInteractions.get('s'), 'question')
  c.approvalSessions.add('s')
  assert.equal(c.composePending('s'), false, 'an approval beside a question changes nothing')
  assert.equal(c.pendingInteractions.get('s'), 'question')
  c.questionKinds.set('s', 'plan-review')
  c.composePending('s')
  assert.equal(c.pendingInteractions.get('s'), 'plan-review')
  c.questionKinds.delete('s')
  c.composePending('s')
  assert.equal(c.pendingInteractions.get('s'), 'approval', 'once the question is answered the approval shows again')
  c.clearPending('s')
  assert.equal(c.pendingInteractions.has('s'), false, 'a turn that ended waits on nobody')
  assert.equal(c.approvalSessions.has('s') || c.questionKinds.has('s'), false)
  const before = c.questionReads.get('s') ?? 0
  c.clearPending('s')
  assert.ok((c.questionReads.get('s') ?? 0) > before, 'and a question read still in flight is void')
})
