import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The sidebar's subagent and startup rules, judged out of the page that runs them.
 *
 * DSH hides a subagent's child from every sidebar listing (`sessionVisible`, dsh-client-ui-workspace `lib/client.js:964`),
 * reopens the saved selection when the page starts (`restoreSelection`, `:1605`), and gives a one-shot child a read-only
 * record instead of a composer (`selectReadOnlySubagent`, dsh-client-ui-subagent `lib/client.js:944`). Phase A measured
 * heddle hiding the child from the tree only: the flat list and the search listed it, a reload opened it as the newest
 * session, and its composer was writable (R-developer-eight-1, -26, -28, -2). The pure block that now decides those lives
 * in `page.html` between two markers and is loaded here.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* session-rules:begin */')
const end = page.indexOf('/* session-rules:end */')

interface Meta {
  id: string
  [key: string]: unknown
}

interface Rules {
  CURRENT_KEY: string
  subagentMode: (meta: unknown) => 'one-shot' | 'continuable' | null
  sidebarSessions: (sessions: unknown) => Meta[]
  startupSession: (sessions: unknown, saved: string | null) => string | null
  composerReadOnly: (meta: unknown) => boolean
}

/** A page without the block yields no rules, so every test below fails by name rather than the file failing to load. */
const rules = (begin > 0 && end > begin ? new Function(`${page.slice(begin, end)}\nreturn SessionRules`)() : {}) as Rules

/** `/api/sessions` as the phase-A store answered it: newest first, the delegated child newest of all. */
const parent = { id: 'session-parent', cwd: '/w/beta', title: 'parent prompt', turns: 1 }
const child = { id: 'session-child', cwd: '/w/beta', title: 'child task', turns: 1, parentSession: 'session-parent', origin: 'subagent', delegationDepth: 1 }
const teammate = { id: 'session-mate', cwd: '/w/beta', title: 'teammate reviewer', turns: 1, parentSession: 'session-lead', origin: 'subagent', delegationDepth: 1, teamId: 'session-lead' }
const beta = { id: 'session-beta', cwd: '/w/beta', title: 'Beta notes', turns: 2 }
const old = { id: 'session-old', cwd: '/w/alpha', title: 'archived one', turns: 1, archived: true }
const listed = [child, teammate, parent, beta, old]

test('the block is in the page, between its markers', () => {
  assert.ok(begin > 0 && end > begin, 'both markers are present, in order')
  assert.equal(typeof rules.startupSession, 'function')
  assert.equal(rules.CURRENT_KEY, 'heddle.session.current.v1')
})

test('a subagent\'s child is never a sidebar row: the flat list and the search read only the others', () => {
  assert.deepEqual(
    rules.sidebarSessions(listed).map((meta) => meta.id),
    ['session-parent', 'session-beta', 'session-old'],
    'the delegated child and the teammate are dropped, the order and the archived row are left to the filters after it',
  )
  assert.deepEqual(rules.sidebarSessions(null), [], 'an answer that is not a list lists nothing')
  assert.deepEqual(rules.sidebarSessions([null, 'x', { title: 'no id' }, parent]).map((meta) => meta.id), ['session-parent'])
})

test('a reload reopens the saved session, and without one it never lands on a hidden child or an archived session', () => {
  assert.equal(rules.startupSession(listed, 'session-beta'), 'session-beta', 'the session that was open comes back')
  assert.equal(rules.startupSession(listed, null), 'session-parent', 'nothing saved: the newest session the sidebar shows, not the newer child')
  assert.equal(rules.startupSession(listed, 'session-gone'), 'session-parent', 'a saved session the store no longer lists falls back the same way')
  assert.equal(rules.startupSession(listed, 'session-old'), 'session-parent', 'an archived saved session is not reopened (DSH clears an archived current)')
  assert.equal(rules.startupSession(listed, 'session-child'), 'session-child', 'a child the person had open is restored, as DSH restores a saved child address')
  assert.equal(rules.startupSession([child, old], null), null, 'only hidden or archived sessions: nothing is opened')
  assert.equal(rules.startupSession([], ''), null)
})

test('a one-shot child\'s composer is read-only; a teammate is continuable and keeps it; anything else is writable', () => {
  assert.equal(rules.subagentMode(child), 'one-shot')
  assert.equal(rules.subagentMode(teammate), 'continuable')
  assert.equal(rules.subagentMode(parent), null)
  assert.equal(rules.subagentMode(undefined), null)
  assert.equal(rules.composerReadOnly(child), true, 'the delegated child is a record')
  assert.equal(rules.composerReadOnly(teammate), false, 'a continuable child keeps Send and Stop')
  assert.equal(rules.composerReadOnly(beta), false)
  assert.equal(rules.composerReadOnly(undefined), false, 'a session the list has not named yet is not locked')
})
