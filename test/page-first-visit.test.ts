import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * A first visit, run out of the page: its own `restoreSelection`, `startSessionAt` and `newConversationTarget`, over its
 * own workspace-tree block, with the two list reads answered and every request recorded.
 *
 * #142 (developer-ten): since stack 2 a first visit (a fresh browser, a cleared entry, a saved session that is gone or
 * archived) made `restoreChoice` answer `start` in `recentWorkspace(...)`, and `startSessionAt` created a real blank
 * session at once. `recentWorkspace` ranks workspaces by the latest activity of any session on the server, so on a shared
 * deployment every load left a blank session in another person's workspace and aimed the composer at their folder. DSH
 * does create a session on load (`restoreSelection`, dsh-client-ui-workspace lib/client.js:1605-1628, `connectWorkspace`
 * :1397 -> `connectBlank` :1403-1406), but DSH is single-user, so its `recentWorkspace` (:1694-1710) is the person's own.
 *
 * Agreed with developer-ten: a first visit creates nothing; the composer is aimed at the workspace this browser last
 * worked in (`heddle.workspace.last`), else the only registered workspace, else nowhere (DSH's inert composer, #134's
 * `composerAimless`); the first message creates the session there (`new: true`, #134's path).
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const block = page.slice(page.indexOf('/* workspace-tree:begin */'), page.indexOf('/* workspace-tree:end */'))

/** A top-level function of the page, by name: from its line to the first line that closes it. */
function source(name: string): string {
  const start = page.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start + 1, page.indexOf('\n}\n', start) + 2)
}

/** The same function when the page has it, else nothing: a name this fix adds, which the red run predates. */
function optional(name: string): string {
  return page.search(new RegExp(`\\n(?:async )?function ${name}\\(`)) >= 0 ? source(name) : ''
}

interface Request {
  url: string
  method: string
}

interface Booted {
  requests: Request[]
  opened: string[]
  current: string | null
  target: { path: string; label: string } | null
  stored: Record<string, string>
}

const workspace = (id: string, path: string, sessionIds: string[] = [], title = path.split('/').pop()) => ({
  id,
  path,
  title,
  origin: 'added',
  parent: null,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
  sessionIds,
})
const session = (id: string, cwd: string, minute: number, extra: Record<string, unknown> = {}) => {
  const at = `2026-10-31T17:${String(minute).padStart(2, '0')}:00.000Z`
  return { id, cwd, created: at, updated: at, turns: 1, ...extra }
}

/**
 * Boot the page's first-visit path: `restoreSelection` with `storage` as localStorage, then the composer's target as the
 * page reads it once the tree is drawn (`treeTops` as `renderTree` keeps them).
 */
async function boot(workspaces: unknown[], sessions: unknown[], storage: Record<string, string>): Promise<Booted> {
  const run = runInNewContext(
    `
    ${block}
    let current = null
    let knownWorkspaces = []
    let chosenWorkspace = null
    let selectedPath = null
    let activeFolder = null
    let treeTops = []
    let lastWorkspace = null
    const expanded = new Set()
    const requests = []
    const opened = []
    const stored = { ...STORAGE }
    const localStorage = {
      getItem: (key) => (key in stored ? stored[key] : null),
      setItem: (key, value) => { stored[key] = String(value) },
    }
    let made = 0
    const fetch = async (url, init = {}) => {
      const method = String(init.method ?? 'GET').toUpperCase()
      requests.push({ url, method })
      if (method === 'GET' && url === '/api/workspaces') return { ok: true, status: 200, json: async () => ({ workspaces: WORKSPACES }) }
      if (method === 'GET' && url === '/api/sessions') return { ok: true, status: 200, json: async () => SESSIONS }
      if (method === 'POST' && url === '/api/sessions') return { ok: true, status: 200, json: async () => ({ session: 'session-made-' + ++made }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    const setNote = () => {}
    const rememberExpanded = () => {}
    const learnDefinition = () => {}
    const chooseSelected = (path) => { selectedPath = path }
    const renderTree = async () => {}
    const refreshSessions = async () => {}
    async function showSession(id) { opened.push(id); current = id; return true }
    ${source('rememberCurrent')}
    ${optional('rememberWorkspace')}
    ${source('startSessionAt')}
    ${source('restoreSelection')}
    ${source('newConversationTarget')}
    ;(async () => {
      await restoreSelection()
      // What renderTree keeps from its drawing, and what the hero, the note and the turn then read (#134).
      treeTops = WorkspaceTree.flatten(WorkspaceTree.deriveGroups(WORKSPACES, SESSIONS, { grouping: 'tree' }))
        .filter((group) => group.workspace !== null)
        .map((group) => ({ kind: 'workspace', path: group.path, label: group.label, group }))
      const target = current === null ? newConversationTarget() : null
      return JSON.stringify({ requests, opened, current, target, stored })
    })()
    `,
    { WORKSPACES: workspaces, SESSIONS: sessions, STORAGE: storage, JSON, Promise, Map, Set, Array, Object, String, Number, Date, Math, Error, RegExp, URL },
  ) as Promise<string>
  return JSON.parse(await run) as Booted
}

const A = '/work/alpha'
const B = '/work/beta'
const MINE = 'session-11111111-1111-4111-8111-111111111111'
const THEIRS = 'session-22222222-2222-4222-8222-222222222222'
const GONE = 'session-33333333-3333-4333-8333-333333333333'
/** Two workspaces: mine (A) with an older session, and another client's (B) with the newest activity on the server. */
const shared = [workspace('w-alpha', A, [MINE]), workspace('w-beta', B, [THEIRS])]
const activity = [session(THEIRS, B, 20, { title: 'their running work', running: true }), session(MINE, A, 5, { title: 'my notes' })]
const lastKey = 'heddle.workspace.last'
const writes = (booted: Booted) => booted.requests.filter((request) => request.method !== 'GET')

test('a first visit with two workspaces and another client\'s recent activity creates no session and aims nowhere (#142)', async () => {
  const booted = await boot(shared, activity, {})
  assert.deepEqual(writes(booted), [], `nothing is created on load: no POST\nsaw: ${JSON.stringify(booted.requests)}`)
  assert.deepEqual(booted.opened, [], 'no session is opened')
  assert.equal(booted.current, null)
  assert.equal(booted.target, null, 'the composer is aimed nowhere, so it is DSH\'s inert one: not at B, where the server was active last')
})

test('a first visit aims at the workspace this browser last worked in, and still creates nothing (#142)', async () => {
  const booted = await boot(shared, activity, { [lastKey]: JSON.stringify({ path: A }) })
  assert.deepEqual(writes(booted), [], `no POST\nsaw: ${JSON.stringify(booted.requests)}`)
  assert.deepEqual(booted.opened, [])
  assert.deepEqual(booted.target, { path: A, label: 'alpha' }, 'the composer is aimed at A, though B is the server\'s most recently active workspace')
  const toB = await boot(shared, activity, { [lastKey]: JSON.stringify({ path: B }) })
  assert.deepEqual(toB.target, { path: B, label: 'beta' }, 'the memory decides, whichever workspace it names')
  const stale = await boot(shared, activity, { [lastKey]: JSON.stringify({ path: '/work/removed' }) })
  assert.equal(stale.target, null, 'a remembered workspace that is no longer registered is no place')
})

test('with exactly one workspace and no memory, a first visit aims at it and creates nothing: the single-user Default workspace (#142)', async () => {
  const home = '/home/u/.heddle/default-workspace'
  const booted = await boot([workspace('w-default', home, [], 'default-workspace')], [], {})
  assert.deepEqual(writes(booted), [], `no POST\nsaw: ${JSON.stringify(booted.requests)}`)
  assert.deepEqual(booted.target, { path: home, label: 'Default workspace' })
})

test('a saved session that is gone is forgotten and the load is a first visit: no POST, aimed by the memory (#142)', async () => {
  const booted = await boot(shared, activity, { 'heddle.sessions.current': JSON.stringify({ sessionId: GONE }), [lastKey]: JSON.stringify({ path: A }) })
  assert.deepEqual(writes(booted), [], `no POST\nsaw: ${JSON.stringify(booted.requests)}`)
  assert.equal(booted.stored['heddle.sessions.current'], '{}', 'the stale entry is emptied')
  assert.deepEqual(booted.target, { path: A, label: 'alpha' })
  const archived = await boot(shared, [{ ...activity[0] }, { ...activity[1], archived: true }], { 'heddle.sessions.current': JSON.stringify({ sessionId: MINE }) })
  assert.deepEqual(writes(archived), [], 'an archived saved session is not reopened, and nothing is started in its place')
  assert.deepEqual(archived.opened, [])
  assert.equal(archived.target, null)
})

test('a saved, live, unarchived session is reopened as before, and nothing is created (#17)', async () => {
  const booted = await boot(shared, activity, { 'heddle.sessions.current': JSON.stringify({ sessionId: MINE }), [lastKey]: JSON.stringify({ path: B }) })
  assert.deepEqual(booted.opened, [MINE], 'the saved session, whatever the memory names')
  assert.deepEqual(writes(booted), [])
})

/**
 * The memory's writes: a session opened, or started in a workspace, is the act that says where this browser works. The
 * page keeps it beside the open session's entry, read from the whole index the way New session finds a session's
 * workspace (#119), so an Ungrouped session changes nothing.
 */
test('opening a session remembers the registered workspace it lives in; an Ungrouped one changes nothing (#142)', () => {
  const run = runInNewContext(
    `
    ${block}
    let lastWorkspace = null
    let knownWorkspaces = WORKSPACES
    let sessionMetas = new Map(SESSIONS.map((meta) => [meta.id, meta]))
    const stored = {}
    const localStorage = { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = String(value) } }
    ${source('rememberWorkspace')}
    ${source('rememberSessionWorkspace')}
    ;({ open: (id) => { rememberSessionWorkspace(id); return JSON.stringify({ last: lastWorkspace, stored }) } })
    `,
    {
      WORKSPACES: [...shared, { ...workspace('w-loose', '/tmp/loose', ['session-loose']), origin: 'auto' }],
      SESSIONS: [...activity, session('session-new', B, 30), session('session-loose', '/tmp/loose', 31)],
      JSON,
      Map,
      Set,
      Array,
      Object,
      String,
    },
  ) as { open(id: string): string }
  assert.deepEqual(JSON.parse(run.open(MINE)), { last: A, stored: { [lastKey]: JSON.stringify({ path: A }) } }, 'a session in A: A is remembered')
  assert.equal(JSON.parse(run.open('session-new')).last, B, 'a session no workspace lists yet, by its cwd: B')
  assert.equal(JSON.parse(run.open('session-loose')).last, B, 'an Ungrouped session leaves the memory where it was')
  const show = source('showSession')
  const read = show.indexOf('const body = await response.json()')
  assert.ok(read > 0 && show.indexOf('rememberSessionWorkspace(id)', read) > read, 'the page remembers it once the opened session\'s history was read, so a session that cannot be loaded is not kept')
  assert.match(source('startSessionAt'), /await showSession\(body\.session\)/, 'a session started in a workspace is opened, and so remembered')
})

test('the memory of a workspace that is no longer registered is forgotten when the registry is read (N5)', () => {
  /**
   * developer-ten's N5 on f3adbf49: nothing cleared heddle.workspace.last when its workspace was deleted. The aim already
   * re-checks the registry, so the stale entry was harmless, but adding that folder again re-aimed at it. The tree's read
   * of the registry (here, or after another client's delete) now forgets it.
   */
  const reconcile = (workspaces: unknown[], remembered: string) =>
    JSON.parse(
      runInNewContext(
        `
        ${block}
        let lastWorkspace = REMEMBERED
        const stored = { 'heddle.workspace.last': JSON.stringify({ path: REMEMBERED }) }
        const localStorage = { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = String(value) } }
        ${source('forgetRemovedWorkspace')}
        forgetRemovedWorkspace(WORKSPACES)
        JSON.stringify({ last: lastWorkspace, stored: stored['heddle.workspace.last'] })
        `,
        { WORKSPACES: workspaces, REMEMBERED: remembered, JSON, Map, Set, Array, Object, String },
      ) as string,
    ) as { last: string | null; stored: string }
  assert.deepEqual(reconcile(shared, A), { last: A, stored: JSON.stringify({ path: A }) }, 'a registered workspace is kept')
  assert.deepEqual(reconcile([shared[1]], A), { last: null, stored: '{}' }, 'a deleted one is forgotten, in memory and in storage')
  assert.deepEqual(reconcile([{ ...shared[0], origin: 'auto' }], A), { last: null, stored: '{}' }, 'an adopted root at that path is no registered workspace')
  const tree = source('drawTree')
  assert.match(tree, /if \(Array\.isArray\(workspaces\)\) \{\s*knownWorkspaces = workspaces\s*forgetRemovedWorkspace\(workspaces\)/, 'the tree forgets it where it keeps the registry')
})
