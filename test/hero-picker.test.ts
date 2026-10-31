import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The Session Intent hero's workspace picker (C36), judged out of the page that runs it.
 *
 * DSH draws a workspace chip in the hero while a conversation is blank; its menu lists every workspace with the
 * current one checked, and a pick moves the new session to that workspace before its first prompt
 * (`dsh-client-ui-conversation` lib/client.js:17742-17845, :19777-19795; `dsh-client-ui-workspace` lib/client.js:2569-2715).
 * The rules live in `page.html` between two markers and are loaded here, so the page keeps one copy of them.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* hero-picker:begin */')
const end = page.indexOf('/* hero-picker:end */')
/** The tree's block too: its `workspaceDisplayTitle` is the one label rule the picker shares with the sidebar (#134). */
const treeBegin = page.indexOf('/* workspace-tree:begin */')
const treeEnd = page.indexOf('/* workspace-tree:end */')

interface Choice {
  id: string
  path: string
  label: string
  sessionIds: string[]
}

interface Picker {
  CHOOSE: string
  choices: (workspaces: unknown) => Choice[]
  ownerOf: (workspaces: unknown, sessionId: unknown) => Choice | null
  isBlank: (meta: unknown) => boolean
  reusable: (leftId: unknown, workspace: unknown, sessions: unknown) => string | null
  step: (key: string, index: number, count: number) => number | null
  shown: (state: Record<string, unknown>) => boolean
  label: (state: Record<string, unknown>) => string
}

function load(): Picker {
  assert.ok(begin !== -1 && end > begin, 'page.html carries the hero-picker block between its markers')
  assert.ok(treeBegin !== -1 && treeEnd > treeBegin, 'and the workspace-tree block between its own')
  return new Function(`${page.slice(treeBegin, treeEnd)}\n${page.slice(begin, end)}\nreturn HeroPicker`)() as Picker
}

/** A workspace as `/api/workspaces` answers it. */
function workspace(id: string, path: string, options: { origin?: string; sessionIds?: string[]; title?: string } = {}) {
  return {
    id,
    path,
    title: options.title ?? path.split('/').pop(),
    origin: options.origin ?? 'added',
    parent: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    sessionIds: options.sessionIds ?? [],
  }
}

/** A session as `/api/sessions` answers it. */
function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, cwd: '/w', created: '2026-10-30T00:00:00.000Z', turns: 0, ...extra }
}

test('the menu offers the registered workspaces in the record order, and not an adopted root', () => {
  const picker = load()
  const offered = picker.choices([
    workspace('w-b', '/repo/beta'),
    workspace('w-auto', '/loose', { origin: 'auto' }),
    workspace('w-a', '/repo/alpha', { title: 'Alpha' }),
    workspace('w-blank', '/repo/untitled', { title: '  ' }),
  ])
  assert.deepEqual(
    offered.map((choice) => [choice.id, choice.label]),
    [
      ['w-b', 'beta'],
      ['w-a', 'Alpha'],
      ['w-blank', 'untitled'],
    ],
    'record order, the stored title, the folder name when the title is blank, Ungrouped left out',
  )
  assert.deepEqual(picker.choices(undefined), [], 'no answer is no choices')
})

test('the chip names the workspace that holds the open session, as DSH\'s sessionWorkspace does', () => {
  const picker = load()
  const list = [workspace('w-a', '/a', { sessionIds: ['s1'] }), workspace('w-auto', '/x', { origin: 'auto', sessionIds: ['s2'] })]
  assert.equal(picker.ownerOf(list, 's1')?.id, 'w-a')
  assert.equal(picker.ownerOf(list, 's2'), null, 'an Ungrouped session has no workspace to name')
  assert.equal(picker.ownerOf(list, null), null)
  assert.equal(picker.label({ current: 's1', pending: null, owner: 'alpha' }), 'alpha')
  assert.equal(picker.label({ current: 's1', pending: 'beta', owner: 'alpha' }), 'beta', 'a pick in flight shows its target at once')
  assert.equal(picker.label({ current: null, pending: null, owner: 'alpha' }), picker.CHOOSE, 'no session and nowhere to start one: DSH\'s call to action')
  assert.equal(picker.CHOOSE, 'Choose workspace')
})

test('the chip and the menu call the first-use workspace Default workspace, as the tree does (#134)', () => {
  const picker = load()
  const list = [
    workspace('w-default', '/home/u/.heddle/default-workspace', { title: 'default-workspace', sessionIds: ['s1'] }),
    workspace('w-renamed', '/home/u/.heddle/other', { title: 'Default Workspace' }),
  ]
  assert.deepEqual(
    picker.choices(list).map((choice) => choice.label),
    ['Default workspace', 'Default Workspace'],
    'the stored first-use title reads Default workspace; a title someone typed reads as typed',
  )
  assert.equal(picker.ownerOf(list, 's1')?.label, 'Default workspace', 'and so does the chip over its blank session')
})

test('with no session open, the chip names the workspace the first message will start in (#134)', () => {
  const picker = load()
  assert.equal(
    picker.label({ current: null, pending: null, owner: null, target: 'Default workspace' }),
    'Default workspace',
    'a reload before the first message still names the Default workspace, not Choose workspace',
  )
  assert.equal(picker.label({ current: null, pending: 'beta', owner: null, target: 'Default workspace' }), 'beta', 'a pick in flight still shows its target first')
  assert.equal(picker.label({ current: null, pending: null, owner: null, target: null }), picker.CHOOSE, 'nowhere to start one: the call to action')
  assert.equal(picker.label({ current: 's1', pending: null, owner: null, target: 'Default workspace' }), picker.CHOOSE, 'an open session outside every workspace is not named after another place')
  assert.equal(picker.label({ current: 's1', pending: null, owner: 'alpha', target: 'Default workspace' }), 'alpha', 'an open session names its own workspace')
})

test('blank means no turn has started: no turns, not running, not archived, not a subagent\'s', () => {
  const picker = load()
  assert.equal(picker.isBlank(session('s')), true)
  assert.equal(picker.isBlank(session('s', { turns: 1 })), false)
  assert.equal(picker.isBlank(session('s', { running: true })), false)
  assert.equal(picker.isBlank(session('s', { archived: true })), false)
  assert.equal(picker.isBlank(session('s', { parentSession: 'p', origin: 'subagent' })), false)
  assert.equal(picker.isBlank(null), false)
})

test('a pick reopens only the blank this page left in that workspace, while it is still blank there', () => {
  const picker = load()
  const beta = workspace('w-b', '/b', { sessionIds: ['left', 'other'] })
  const sessions = [session('left'), session('other')]
  assert.equal(picker.reusable('left', beta, sessions), 'left')
  assert.equal(picker.reusable(undefined, beta, sessions), null, 'nothing left there: a new session, never another client\'s blank')
  assert.equal(picker.reusable('left', beta, [session('left', { turns: 2 })]), null, 'started since: a new session')
  assert.equal(picker.reusable('left', workspace('w-b', '/b', { sessionIds: ['other'] }), sessions), null, 'no longer that workspace\'s')
  assert.equal(picker.reusable('left', beta, []), null, 'gone from the store')
})

test('the menu keys are DSH\'s: arrows wrap, Home and End jump, and from the chip ArrowDown is the first item', () => {
  const picker = load()
  assert.equal(picker.step('ArrowDown', -1, 3), 0)
  assert.equal(picker.step('ArrowUp', -1, 3), 2)
  assert.equal(picker.step('ArrowDown', 0, 3), 1)
  assert.equal(picker.step('ArrowDown', 2, 3), 0, 'wraps forward')
  assert.equal(picker.step('ArrowUp', 0, 3), 2, 'wraps back')
  assert.equal(picker.step('Home', 2, 3), 0)
  assert.equal(picker.step('End', 0, 3), 2)
  assert.equal(picker.step('Enter', 0, 3), null, 'Enter is the item\'s own click')
  assert.equal(picker.step('ArrowDown', -1, 0), null)
})

test('the row shows on the empty page and over a blank session, and goes once anything is drawn', () => {
  const picker = load()
  const base = { view: 'chat', current: 's', hasContent: false, emptyShown: false, blank: true, pending: false }
  assert.equal(picker.shown(base), true, 'a blank session open in chat')
  assert.equal(picker.shown({ ...base, blank: null }), false, 'not yet known to be blank: nothing rather than a guess')
  assert.equal(picker.shown({ ...base, blank: false }), false, 'a session with turns')
  assert.equal(picker.shown({ ...base, hasContent: true }), false, 'the first prompt is drawn')
  assert.equal(picker.shown({ ...base, view: 'trajectory' }), false, 'another view')
  assert.equal(picker.shown({ ...base, current: null, blank: null, emptyShown: true }), true, 'the empty page')
  assert.equal(picker.shown({ ...base, current: null, blank: null, emptyShown: false }), false)
  assert.equal(picker.shown({ ...base, blank: null, pending: true }), true, 'a pick moving to another workspace keeps the row')
})
