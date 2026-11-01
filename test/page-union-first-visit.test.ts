import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The union of first-visit-2 and developer-twelve's corrected composition 4b2a0552, judged as developer-ten's ruling on
 * it asks: one case through the page's own stream listener, runTurn, held-events helpers, statistics dock and **real**
 * drawSessionEvent (only leaf drawing and network calls are stubbed).
 *
 * - Nothing shown (first-visit-2): a blank page holds only its own no-session turn's events, draws nothing and keeps its
 *   dock hidden; on adoption it draws that session's events in order, and no other session's.
 * - Counting (4b2a0552, #116): a turn counts once, from its persisted user `message`, under its own session id, never
 *   under the shown one; the held own prompt counts when it is drawn at adoption.
 * - Unavailable history (N1a wins): a no-session turn that names its session while another session's "Failed to load
 *   history" shows opens that session through `showSession`.
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

function listener(): string {
  const start = page.indexOf("events.addEventListener('session', (message) => {")
  assert.ok(start >= 0, 'the page registers its session listener')
  return page.slice(start, page.indexOf('\n})\n', start) + 3)
}

const verdicts = (() => {
  const start = page.indexOf('const turnVerdicts = (() => {')
  return start < 0 ? 'const turnVerdicts = { receive() {}, wait: () => new Promise(() => {}), lateTail() {}, endIdle() {} }' : page.slice(start, page.indexOf('\n})()\n', start) + 6)
})()

const MINE = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const THEIRS = 'session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const B = 'session-ffffffff-ffff-4fff-8fff-ffffffffffff'
const SECOND = 'session-99999999-9999-4999-8999-999999999999'

interface Union {
  stream(session: string, event: Record<string, unknown>): void
  send(): void
  named(session: string): void
  ended(): void
  unavailable(id: string): void
  state(): string
  turn(): Promise<unknown>
}

function harness(): Union {
  return runInNewContext(
    `
    const QUEUE_KEY_NONE = ''
    const NO_WORKSPACE_REFUSAL = 'Choose a workspace first.'
    let current = null, composerKey = QUEUE_KEY_NONE, unavailableSession = null, activeFolder = null, workspaceRoutes = 'served'
    let sessionLoading = null, sessionStats = null, liveRounds = 0, liveUsage, liveRoundStartedAt = null, liveGenerationMs = 0, liveDecodeTokens = 0
    ${page.match(/(?:let|const) liveTurns = [^\n]+/)?.[0]}
    let directTurnPending = 0, directPendingKey = null, stopRequested = false, runningTick = 0
    const stopButton = { disabled: true }
    const runningSessions = new Set(), runningSince = new Map(), pendingInteractions = new Map(), turnRounds = new Map(), turnsEnded = new Set()
    const queues = new Map(), stoppedQueues = new Set(), directTurnsByQueue = new WeakMap(), queueTurnOut = new WeakSet()
    let chosenEndpoint = null, chosenModel = null, chosenEffort = null
    const heldSeats = new Map(), recordedSelections = new Set(), pendingSaves = new Set(), serverSeats = new Map()
    const endpointOptions = [], endpointDefault = null, view = 'chat'
    const field = { value: '' }
    const firstTreeReady = Promise.resolve()
    const newConversationTarget = () => ({ path: '/work/alpha', label: 'alpha' })
    /** What the panel shows: the rows the page's own add() and failure lines would draw. */
    const rows = []
    const log = { append(node) { rows.push('notice:' + (node.textContent ?? '')) }, replaceChildren() { rows.length = 0 } }
    function add(kind, text) { rows.push(kind + ':' + text) }
    const document = { createElement: () => ({ className: '', textContent: '', dataset: {}, setAttribute() {} }), getElementById: () => null }
    const cells = new Map()
    const statusBar = { hidden: true, querySelector(selector) {
      if (!cells.has(selector)) cells.set(selector, { textContent: '', hidden: false, setAttribute() {} })
      return cells.get(selector)
    } }
    const windowFor = () => undefined
    const noop = () => {}
    const scheduleTreeRefresh = noop, scheduleGoalRefresh = noop, scheduleTodoRefresh = noop, noteCompletion = noop, paintRunningMarks = noop
    const renderComposerState = noop, refreshRunningStatus = noop, drawTurnFailure = noop, settleChat = noop, settleReasoning = noop
    const renderScheduleCards = noop, rememberCurrent = noop, rememberWorkspace = noop, chooseWorkspace = noop, hideApproval = noop
    const markStopped = noop, growComposer = noop, updateSendDisabled = noop, paintEmptyState = noop, paintDock = noop, renderStatPopover = noop
    const markBranchable = noop, growLiveToolCall = noop, applySessionModel = noop, renderAccess = noop, renderQueue = noop, clearMain = noop
    const settleLiveToolCall = () => false, fillToolResult = () => false, lastTurnRow = () => null
    const messageContentText = (content) => (content ?? []).map((part) => part.text ?? '').join('')
    const contentAttachments = () => []
    const selectionForSeat = () => ({}), selectionForTurn = () => ({})
    const slashReady = Promise.resolve(null)
    async function pumpQueue() {}
    function markRunning(id) { runningSessions.add(id) }
    async function refreshSessionStats() {}
    async function renderSettledAnswers() {}
    async function attachEditedFiles() {}
    async function attachTurnUsage() {}
    async function renderTree() {}
    async function refreshSessions() {}
    async function fetchSessionAccess() {}
    async function stopTurn() {}
    async function showLedger() {}
    /** The open the N1a branch asks for: recorded, and it ends the failure state as the real showSession does. */
    const opened = []
    async function showSession(id) { opened.push(id); unavailableSession = null; current = id; composerKey = id; updateStatusBar(); return true }
    let listen
    const events = { whenOpen: async () => {}, addEventListener(name, handler) { if (name === 'session') listen = handler } }
    let looseTurnEvents = null
    const LOOSE_EVENTS_LIMIT = 2000
    ${['addUsage', 'formatTokenCount', 'formatRate', 'formatCacheHit', 'formatDurationMs', 'formatExactCount', 'formatWindow', 'statPanelRows'].map(optional).join('\n')}
    ${source('updateStatusBar')}
    ${optional('countOwnSessionTurn')}
    ${optional('holdLooseTurn')}
    ${optional('holdLooseEvent')}
    ${optional('adoptLooseEvents')}
    ${optional('noteRound')}
    ${optional('liveRoundsOf')}
    ${source('adoptSession')}
    ${optional('looseTurnOut')}
    ${optional('adoptLooseQueue')}
    ${block('turn-failure')}
    ${source('turnNotice')}
    ${verdicts}
    ${source('drawSessionEvent')}
    ${listener()}
    /** The no-session turn's 202, released by the test with the session it created; its verdict later on the stream. */
    let release = null, turnId = 0, accepted = null
    const sendTurn = async () => {
      const turn = 't' + ++turnId
      const session = await new Promise((resolve) => { release = resolve })
      accepted = { turn, session }
      return { ok: true, status: 202, headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) }, json: async () => ({ session, turn }) }
    }
    ${source('runTurn')}
    let running = Promise.resolve()
    ;({
      stream: (session, event) => listen({ data: JSON.stringify({ session, event }) }),
      send: () => { running = runTurn('mine', QUEUE_KEY_NONE, [], () => {}).catch((error) => error) },
      named: (session) => release(session),
      ended: () => turnVerdicts.receive({ turn: accepted.turn, outcome: 'done', session: accepted.session, finishReason: 'stop', rounds: 1, denials: [] }),
      unavailable: (id) => { current = null; composerKey = QUEUE_KEY_NONE; unavailableSession = id; rows.length = 0; rows.push('notice:Failed to load history: offline'); updateStatusBar() },
      state: () => JSON.stringify({ current, unavailable: unavailableSession, rows, dockHidden: statusBar.hidden, turnsText: cells.get('[data-stat="turns"]')?.textContent ?? null, counts: [...liveTurns], opened, holding: looseTurnEvents !== null }),
      turn: () => running,
    })
    `,
    { JSON, Promise, TextEncoder, TextDecoder, performance, Error, Array, Object, String, Number, Set, Map, WeakSet, WeakMap, Math, Date, setTimeout, clearTimeout },
  ) as Union
}

const settle = async () => {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve))
}

const user = (text: string, seq: number) => ({ type: 'message', seq, message: { role: 'user', content: [{ type: 'text', text }] } })
const chunk = (text: string, seq: number) => ({ type: 'assistant/chunk', seq, chunk: { type: 'text-delta', text } })

interface State {
  current: string | null
  unavailable: string | null
  rows: string[]
  dockHidden: boolean
  turnsText: string | null
  counts: [string, number][]
  opened: string[]
  holding: boolean
}

test('the union: a blank page draws only its own first turn, counts each turn once under its own id, and an acceptance over unavailable history opens the session (developer-ten\'s ruling)', async () => {
  const page = harness()
  const read = () => JSON.parse(page.state()) as State
  page.send()
  await settle()
  assert.equal(read().holding, true, 'the no-session turn holds the stream from just before it is sent')

  /** Before adoption: its own prompt and another session's turn, interleaved. */
  page.stream(MINE, user('mine', 1))
  page.stream(THEIRS, user('their prompt', 1))
  page.stream(THEIRS, { type: 'model/request', seq: 2 })
  page.stream(MINE, { type: 'model/request', seq: 2 })
  page.stream(THEIRS, chunk('their answer', 3))
  const before = read()
  assert.deepEqual(before.rows, [], 'nothing is drawn before the turn names its session')
  assert.equal(before.dockHidden, true, 'and the dock stays hidden')
  assert.deepEqual(before.counts, [], 'nothing is counted yet: the held prompts are not drawn')

  /** The 202 names MINE: its held events are drawn in order through the real drawSessionEvent, and no one else's. */
  page.named(MINE)
  await settle()
  const adopted = read()
  assert.equal(adopted.current, MINE, 'the page adopts the session its turn created')
  assert.deepEqual(adopted.rows, ['user:mine'], `only its own rows\nsaw: ${JSON.stringify(adopted)}`)
  assert.equal(adopted.turnsText, '1 turns', 'and the dock, drawn for it, says one turn: its own')
  const counts = new Map(adopted.counts)
  assert.equal(counts.get(MINE), 1, 'its prompt counts once, under its own id, when it is drawn')
  assert.equal(counts.get(THEIRS), 1, 'the other session\'s prompt counts only under its own id, never under the shown one')

  /** After adoption: its answer is drawn live, another session's turn is not. */
  page.stream(MINE, chunk('the answer', 3))
  page.stream(THEIRS, user('their second prompt', 4))
  page.stream(THEIRS, chunk('their second answer', 5))
  page.stream(MINE, { type: 'turn/completed', seq: 4 })
  page.ended()
  await page.turn()
  const done = read()
  assert.deepEqual(done.rows, ['user:mine', 'assistant:the answer'], `each of its events once, none of theirs\nsaw: ${JSON.stringify(done)}`)
  assert.equal(new Map(done.counts).get(MINE), 1, 'still one turn for its own session')
  assert.equal(new Map(done.counts).get(THEIRS), 2, 'theirs counted under their own id only')

  /** Then another session's history fails, and a no-session turn names its session: N1a opens it through showSession. */
  page.unavailable(B)
  assert.equal(read().dockHidden, true, 'under "Failed to load history" the dock is hidden')
  page.send()
  await settle()
  page.stream(B, user('must not draw under the failure', 1))
  page.named(SECOND)
  await settle()
  const reopened = read()
  assert.deepEqual(reopened.opened, [SECOND], 'the acceptance opens the created session through showSession')
  assert.equal(reopened.unavailable, null, 'which ends the failure state')
  assert.equal(reopened.current, SECOND)
  assert.ok(!reopened.rows.some((row) => row.includes('must not draw')), 'nothing was drawn under the failure')
  page.ended()
  await page.turn()
})
