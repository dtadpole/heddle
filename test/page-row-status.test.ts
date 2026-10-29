import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { repoRoot } from '../_tools_/verify-runner/lib.mjs'

/**
 * A session row says when the session waits for a person and when it finished while another session was open.
 *
 * DSH's rows (`dsh-client-ui-workspace`, Pending interactions) show the shared warning dot and **Approval** in place of
 * the age while an approval waits, the done dot for a finished turn nobody has opened (`completionUnread`, kept by the
 * page in `dsh-client-ui-session`), the running spinner otherwise, and no dot when idle, in that order. The page showed
 * the spinner alone, so a wait or a finished turn in another session was invisible (DSH parity R-developer-seven-3,
 * rows S28 and S29). The status rule is cut from `page.html` and run here; the wiring is judged by removal detectors,
 * and the behaviour in a browser by `_verifiers_/80-web-ui/check-row-status.mjs`.
 */

const page = readFileSync(join(repoRoot, 'src', 'server', 'page.html'), 'utf8')

type Status = { state: string; label: string; trailing: string | null }
type Sets = { pending: Set<string>; running: Set<string>; unread: Set<string> }

function loadStatus(): (id: string, sets: Sets) => Status {
  const source = /function sessionRowStatus\([^)]*\) \{[\s\S]*?\n\}/.exec(page)
  assert.ok(source, 'the page has a sessionRowStatus function')
  return runInNewContext(`${source[0]}\nsessionRowStatus`) as (id: string, sets: Sets) => Status
}

const load = loadStatus()
/** The function runs in another realm, so its objects are compared by value, not by prototype. */
const status = (id: string, given: Sets): Status => JSON.parse(JSON.stringify(load(id, given))) as Status
const sets = (pending: string[], running: string[], unread: string[]): Sets => ({
  pending: new Set(pending),
  running: new Set(running),
  unread: new Set(unread),
})

test('a waiting approval wins over running and unread, says Approval in place of the age, and names the wait', () => {
  assert.deepEqual(status('x', sets(['x'], ['x'], ['x'])), { state: 'warning', label: 'Waiting for approval', trailing: 'Approval' })
})

test('running comes next, then a finished turn nobody opened, then idle with no trailing label', () => {
  assert.deepEqual(status('x', sets([], ['x'], ['x'])), { state: 'ongoing', label: 'Running', trailing: null })
  assert.deepEqual(status('x', sets([], [], ['x'])), { state: 'done', label: 'Completed', trailing: null })
  assert.deepEqual(status('x', sets([], [], [])), { state: 'idle', label: 'Idle', trailing: null })
})

test('the status of one session does not leak into another', () => {
  assert.equal(status('y', sets(['x'], ['x'], ['x'])).state, 'idle')
})

test('the page keeps the two sets the way DSH does', () => {
  assert.match(page, /if \(runningSessions\.has\(payload\.session\)\) noteSessionStopped\(payload\.session\)/, 'a turn that ends while another session is open becomes unread')
  assert.match(page, /if \(typeof id === 'string' && id\.length > 0 && id !== current\) completionUnread\.add\(id\)/, 'but not the open one')
  assert.match(page, /if \(completionUnread\.delete\(id\)\) paintRunningMarks\(\)/, 'opening a session reads it')
  assert.match(page, /runningSessions\.add\(payload\.session\)\n\s+completionUnread\.delete\(payload\.session\)/, 'running again clears it')
  assert.match(page, /const waiting = new Set\(requests\.map\(\(entry\) => entry\.session\)/, 'every waiting session is read from the pending list')
  assert.match(page, /pendingApprovalSessions\.add\(request\.session\)/, 'and from the approval event')
  assert.match(page, /'#tree \.age\[data-stamp\]:not\(\[data-pending\]\)'/, 'the age clock leaves Approval in place')
})

test('the pending list is read even when no session is open', () => {
  const poll = /setInterval\(\(\) => \{\n\s+if \(document\.hidden\) return\n\s+void refreshApprovals\(\)\n\}, 2000\)/.exec(page)
  assert.ok(poll, 'the poll no longer stops while nothing is open')
})
