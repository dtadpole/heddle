import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * An archived session is never the open, writable one — DSH's own rule, run out of the page.
 *
 * DSH (dsh-client-ui-workspace lib/client.js): `archiveSession` (:1532-1535) clears the main view when the session it
 * archived is the open one, and `clearArchivedCurrent` (:1638-1643), which `watchNavigation`'s reconcile runs on every
 * change of the workspace or session list (:1576-1578), clears it whenever the open session is archived, whoever archived
 * it. `clearMain` (:1644-1650) drops the main reference and empties the saved selection. #139's blocker B1 (developer-ten,
 * f0442783): heddle kept an archived open session open with its composer writable, so a message typed into it was
 * accepted, blocked by the server's gate, and lost. These tests run the page's own `clearMain`, `setSessionFlags`,
 * `noteSessions` and the stream's `turn/failed` branch.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

function source(name: string): string {
  const start = page.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start + 1, page.indexOf('\n}\n', start) + 2)
}

function optional(name: string): string {
  return page.search(new RegExp(`\\n(?:async )?function ${name}\\(`)) >= 0 ? source(name) : ''
}

const block = (marker: string) => page.slice(page.indexOf(`/* ${marker}:begin */`), page.indexOf(`/* ${marker}:end */`))

const S = 'session-11111111-1111-4111-8111-111111111111'
const T = 'session-22222222-2222-4222-8222-222222222222'

/** The stand-ins every harness below shares: the page state an open session sets, and calls recorded by name. */
const STATE = `
  const QUEUE_KEY_NONE = ''
  let current = OPEN, composerKey = OPEN, unavailableSession = null, activeFolder = '/work/other', selectedPath = 'session:' + OPEN
  let chosenWorkspace = null, showGeneration = 4, sessionLoading = { id: OPEN, generation: 4, events: [] }
  let sessionStats = { steps: 3 }, liveRounds = 2, liveUsage = {}, liveGenerationMs = 9, liveDecodeTokens = 9, liveRoundStartedAt = 7
  /** Turn counts per session (4b2a0552, #116): the open session's one turn so far. */
  const liveTurns = new Map([[OPEN, 1]])
  const calls = []
  const stored = {}
  const localStorage = { setItem: (key, value) => { stored[key] = value }, getItem: (key) => stored[key] ?? null }
  const WorkspaceTree = { SELECTION_KEY: 'heddle.sessions.current', selectionRecord: (id) => JSON.stringify(typeof id === 'string' ? { sessionId: id } : {}) }
  let sessionMetas = new Map([[OPEN, { id: OPEN, cwd: '/work/alpha/sub', title: 'kept notes' }]])
  const listedMetas = new Map()
  const log = { children: [1, 2, 3], replaceChildren() { this.children = [] } }
  const document = { getElementById: () => ({ textContent: 'x' }) }
  const slashReady = Promise.resolve(null)
  const record = (name) => (...args) => { calls.push(name) }
  const paintSessionHeading = record('paintSessionHeading'), resetScheduleList = record('resetScheduleList'), applySessionAccess = record('applySessionAccess')
  const paintComposerAccess = record('paintComposerAccess'), jobsSessionChanged = record('jobsSessionChanged'), paintScheduleHeader = record('paintScheduleHeader')
  const refreshGoal = async () => calls.push('refreshGoal'), refreshTodo = async () => calls.push('refreshTodo')
  const paintEmptyState = record('paintEmptyState'), updateStatusBar = record('updateStatusBar'), markSelection = record('markSelection')
  const renderQueue = record('renderQueue'), renderComposerState = record('renderComposerState'), scheduleTreeRefresh = record('scheduleTreeRefresh')
  const paintNewConversationPlace = record('paintNewConversationPlace')
  function chooseWorkspace(path) { chosenWorkspace = path === null ? null : { path, during: current } }
`

interface Cleared {
  current: string | null
  composerKey: string
  activeFolder: string | null
  selectedPath: string | null
  saved: string | null
  log: number
  generation: number
  loading: unknown
  live: number[]
  calls: string[]
}

test('clearMain lets the open session go as DSH\'s does: nothing open, the saved selection emptied, the composer on a new conversation in its folder', () => {
  const run = runInNewContext(
    `${STATE}
    ${source('rememberCurrent')}
    ${source('clearMain')}
    ;(() => {
      clearMain()
      const first = JSON.stringify({ current, composerKey, activeFolder, selectedPath, saved: stored['heddle.sessions.current'] ?? null, log: log.children.length, generation: showGeneration, loading: sessionLoading, live: [liveRounds, liveTurns.get(OPEN) ?? 0, liveGenerationMs, liveDecodeTokens, liveRoundStartedAt ?? 0], calls })
      calls.length = 0
      clearMain()
      return [first, JSON.stringify(calls)]
    })()`,
    { OPEN: S, JSON, Map, Set, Promise, Array, Object, String },
  ) as [string, string]
  const cleared = JSON.parse(run[0]) as Cleared
  assert.equal(cleared.current, null, 'nothing is open')
  assert.equal(cleared.saved, '{}', 'and a reload reopens nothing: DSH clearMain sets its selection to {}')
  assert.equal(cleared.composerKey, '', 'the composer is on no session, so the next message starts a new conversation')
  assert.equal(cleared.activeFolder, '/work/alpha/sub', 'aimed at the folder the session lived in, as a click on its row aims it')
  assert.equal(cleared.selectedPath, null, 'no row is selected')
  assert.equal(cleared.log, 0, 'its conversation is put away')
  assert.equal(cleared.generation, 5, 'an open of it still in flight draws nothing')
  assert.equal(cleared.loading, null)
  assert.deepEqual(cleared.live, [0, 0, 0, 0, 0], 'its dock counts nothing')
  for (const name of ['paintSessionHeading', 'paintComposerAccess', 'paintEmptyState', 'renderQueue', 'scheduleTreeRefresh']) {
    assert.ok(cleared.calls.includes(name), `and the page repaints: ${name}`)
  }
  assert.deepEqual(JSON.parse(run[1]), [], 'with nothing open, it does nothing')
})

/** `setSessionFlags` with the server answering `ok`, recording when clearMain ran against the redraw. */
async function flag(patch: Record<string, unknown>, id: string): Promise<string[]> {
  const run = runInNewContext(
    `${STATE}
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
    function definitionFolder() { return undefined }
    function setNote() {}
    function captureRowBoxes() { return null }
    function glideRows() {}
    async function renderTree() { calls.push('renderTree') }
    async function refreshSessions() { calls.push('refreshSessions') }
    function clearMain() { calls.push('clearMain') }
    ${source('setSessionFlags')}
    setSessionFlags({ session: { id: ID } }, PATCH).then(() => JSON.stringify(calls))`,
    { OPEN: S, ID: id, PATCH: patch, JSON, Map, Set, Promise, Array, Object, String },
  ) as Promise<string>
  return JSON.parse(await run) as string[]
}

test('archiving the open session from this page lets it go before the tree is drawn again, as DSH\'s archiveSession does (B1)', async () => {
  assert.deepEqual(await flag({ archived: true }, S), ['clearMain', 'renderTree', 'refreshSessions'], 'the open session, archived here, is let go')
  assert.deepEqual(await flag({ archived: true }, T), ['renderTree', 'refreshSessions'], 'another session archived leaves the open one open')
  assert.deepEqual(await flag({ pinned: true }, S), ['renderTree', 'refreshSessions'], 'a pin is no archive')
  assert.deepEqual(await flag({ archived: false }, S), ['renderTree', 'refreshSessions'], 'nor an unarchive')
})

test('a list read that says the open session is archived lets it go, whoever archived it: DSH\'s clearArchivedCurrent (B1)', () => {
  const read = (list: unknown[]) =>
    JSON.parse(
      runInNewContext(
        `${STATE}
        function clearMain() { calls.push('clearMain'); current = null }
        ${optional('clearArchivedCurrent')}
        ${source('noteSessions')}
        noteSessions(LIST)
        JSON.stringify({ calls, current })`,
        { OPEN: S, LIST: list, JSON, Map, Set, Promise, Array, Object, String },
      ) as string,
    ) as { calls: string[]; current: string | null }
  const archived = read([{ id: S, archived: true }, { id: T }])
  assert.ok(archived.calls.includes('clearMain'), `another client's archive, seen in the list, lets it go\nsaw: ${JSON.stringify(archived)}`)
  assert.equal(archived.current, null)
  const live = read([{ id: S }, { id: T, archived: true }])
  assert.ok(!live.calls.includes('clearMain'), 'an unarchived open session stays, whatever else is archived')
  assert.equal(live.current, S)
})

test('the stream\'s blocked turn end for the open session lets it go: the gate only blocks an archived session (B1)', () => {
  const from = page.indexOf("  else if (event.type === 'turn/failed') {")
  assert.ok(from > 0, 'the stream listener has a turn/failed branch')
  const branch = page.slice(from, page.indexOf('\n  }\n', from) + 4)
  const run = (session: string, event: Record<string, unknown>) =>
    JSON.parse(
      runInNewContext(
        `${STATE}
        const runningSessions = new Set([OPEN]), runningSince = new Map(), turnRounds = new Map(), turnsEnded = new Set()
        function paintRunningMarks() {}
        function drawTurnFailure() { calls.push('drawTurnFailure') }
        function settleChat() {}
        async function pumpQueue() {}
        function clearMain() { calls.push('clearMain'); current = null }
        ${block('turn-failure')}
        function onTurnFailed(payload, event) {
          const shown = current ?? unavailableSession
          if (false) {}
          ${branch}
        }
        onTurnFailed({ session: SESSION, event: EVENT }, EVENT)
        JSON.stringify({ calls, current })`,
        { OPEN: S, SESSION: session, EVENT: event, JSON, Map, Set, Promise, Array, Object, String, performance },
      ) as string,
    ) as { calls: string[]; current: string | null }
  const blocked = run(S, { type: 'turn/failed', reason: { kind: 'blocked' } })
  assert.ok(blocked.calls.includes('clearMain'), `the open session's blocked end lets it go\nsaw: ${JSON.stringify(blocked)}`)
  assert.ok(!blocked.calls.includes('drawTurnFailure'), 'and draws no failure (#139)')
  assert.ok(!run(T, { type: 'turn/failed', reason: { kind: 'blocked' } }).calls.includes('clearMain'), 'another session\'s blocked end leaves the open one open')
  const failed = run(S, { type: 'turn/failed', message: 'upstream answered 502' })
  assert.ok(!failed.calls.includes('clearMain'), 'a real failure leaves the session open')
  /** Since the union with 4b2a0552 the failure line is the drawing half's, for the shown session (drawSessionEvent). */
  const drawAt = page.indexOf('\nfunction drawSessionEvent(payload) {')
  const draw = page.slice(drawAt, page.indexOf('\n}\n', drawAt))
  assert.match(draw, /event\.type === 'turn\/failed'\) \{[^]*?if \(shown !== null && payload\.session === shown\) \{\s*if \(TurnFailure\.shows\(event\)\) drawTurnFailure\(payload\.session, event\.message\)/, 'and a real failure is drawn there, for the shown session')
})
