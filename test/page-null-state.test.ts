import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * A page with nothing open draws no other session's turn: only its own first one (#142, developer-ten's finding on
 * 2349341f), run out of the page with its own session listener, runTurn and the held-events helpers.
 *
 * Every session's events reach every page (web.ts pushes them to every `/api/events` reader; the Rust hub does too). The
 * listener's gate was `shown = current ?? unavailableSession` and `if (shown && payload.session !== shown) return`, so
 * with neither it followed every session. On main a load starts a blank session and the gate filters; since #142 a
 * first visit opens nothing, so a fresh tab drew every other session's live turn into its blank panel (messages,
 * answers, tool rows, their usage), and its first send adopted its session without a redraw, under those rows.
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

const MINE = 'session-66666666-6666-4666-8666-666666666666'
const THEIRS = 'session-77777777-7777-4777-8777-777777777777'
const OPENED = 'session-88888888-8888-4888-8888-888888888888'

interface Page {
  /** One `/api/events` frame of `session`. */
  stream(session: string, event: Record<string, unknown>): void
  /** Start this page's own first turn (no session); `detached` answers 202, else the turn streams on its response. */
  send(detached: boolean): void
  /** The turn's response names its session (the streamed `session` frame, or the 202's body). */
  named(): void
  /** The turn ends (its streamed `done`, or its verdict on the stream). */
  ended(): void
  /** The boot's restore opens another session before the turn names its own (developer-ten's N1). */
  open(id: string): void
  drawn(): string[]
  settled(): number
  /** The listener's top half, which follows every session whatever the panel shows. */
  top(): string
  /** Whether the page still holds events for a turn of its own. */
  holding(): boolean
  /** The send is refused before any session exists. */
  refuse(): void
  rounds(): number
  current(): string | null
  turn(): Promise<void>
}

function harness(): Page {
  return runInNewContext(
    `
    const QUEUE_KEY_NONE = ''
    const NO_WORKSPACE_REFUSAL = 'Choose a workspace first.'
    let current = null, composerKey = QUEUE_KEY_NONE, unavailableSession = null, activeFolder = null, workspaceRoutes = 'served'
    let sessionLoading = null, liveTurns = 0, liveRounds = 0, liveUsage, liveRoundStartedAt = null, sessionStats = null
    let directTurnPending = 0, directPendingKey = null, stopRequested = false, runningTick = 0
    const stopButton = { disabled: true }
    const runningSessions = new Set(), runningSince = new Map(), pendingInteractions = new Map(), turnRounds = new Map(), turnsEnded = new Set()
    const queues = new Map(), stoppedQueues = new Set()
    const field = { value: '' }
    const log = { append() {}, replaceChildren() {} }
    const document = { createElement: () => ({ className: '', textContent: '', setAttribute() {} }) }
    const firstTreeReady = Promise.resolve()
    const newConversationTarget = () => ({ path: '/work/alpha', label: 'alpha' })
    const drawn = []
    let settled = 0
    /** The drawing half, recorded: what reaches it is drawn and counted, so what does not reach it is neither. */
    function drawSessionEvent(payload) {
      const event = payload.event
      drawn.push((payload.session === MINE ? 'mine' : payload.session === THEIRS ? 'theirs' : payload.session) + ':' + event.type + (event.text ? ':' + event.text : ''))
    }
    let listen
    const events = { whenOpen: async () => {}, addEventListener(name, handler) { if (name === 'session') listen = handler } }
    const noop = () => {}
    let completions = 0, trees = 0
    const pumped = []
    const scheduleTreeRefresh = () => { trees += 1 }, scheduleGoalRefresh = noop, scheduleTodoRefresh = noop, paintRunningMarks = noop
    const noteCompletion = () => { completions += 1 }
    const renderComposerState = noop, refreshRunningStatus = noop, drawTurnFailure = noop, clearMain = noop, markBranchable = noop
    const renderScheduleCards = noop, updateStatusBar = noop, selectionForTurn = () => ({}), rememberCurrent = noop, rememberWorkspace = noop
    const chooseWorkspace = noop, adoptLooseQueue = noop, settleReasoning = noop, hideApproval = noop, markStopped = noop
    const growComposer = noop, updateSendDisabled = noop, paintEmptyState = noop, add = noop
    function settleChat() { settled += 1 }
    function markRunning(id) { runningSessions.add(id) }
    async function pumpQueue(key) { pumped.push(key) }
    async function refreshSessionStats() {}
    async function renderSettledAnswers() {}
    async function attachEditedFiles() {}
    async function attachTurnUsage() {}
    async function renderTree() {}
    async function refreshSessions() {}
    async function fetchSessionAccess() {}
    async function stopTurn() {}
    function adoptSession(id) { composerKey = id }
    async function showSession(id) { current = id; adoptSession(id); return true }
    function lastTurnRow() { return null }
    function queueOf() { return [] }
    let looseTurnEvents = null
    const LOOSE_EVENTS_LIMIT = 2000
    ${optional('holdLooseTurn')}
    ${optional('holdLooseEvent')}
    ${optional('adoptLooseEvents')}
    ${block('turn-failure')}
    ${source('turnNotice')}
    ${optional('noteRound')}
    ${optional('liveRoundsOf')}
    ${verdicts}
    ${listener()}
    /** The turn's response, released step by step by the test. */
    let release = []
    const gate = () => new Promise((resolve) => release.push(resolve))
    const encoder = new TextEncoder()
    const frame = (name, data) => encoder.encode('event: ' + name + '\\ndata: ' + JSON.stringify(data) + '\\n\\n')
    let detached = false, refused = null
    const sendTurn = async () => {
      if (refused !== null) { await refused; return { ok: false, status: 409, text: async () => 'refused' } }
      if (detached) {
        return { ok: true, status: 202, headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) }, json: async () => { await gate(); return { session: MINE, turn: 't1' } } }
      }
      const steps = [
        async () => { await gate(); return frame('session', { session: MINE, event: { type: 'message' } }) },
        async () => { await gate(); return frame('done', { session: MINE, text: 'answer', finishReason: 'stop', rounds: 1, denials: [] }) },
      ]
      return { ok: true, headers: { get: (name) => (name === 'content-type' ? 'text/event-stream' : null) }, body: { getReader() { return { read: async () => (steps.length === 0 ? { done: true } : { done: false, value: await steps.shift()() }) } } } }
    }
    ${source('runTurn')}
    let running = Promise.resolve()
    ;({
      stream: (session, event) => listen({ data: JSON.stringify({ session, event }) }),
      send: (asDetached) => { detached = asDetached; running = runTurn('mine', QUEUE_KEY_NONE, [], () => {}).catch((error) => error) },
      named: () => release.shift()?.(),
      ended: () => { if (detached) turnVerdicts.receive({ turn: 't1', outcome: 'done', session: MINE, finishReason: 'stop', rounds: 1, denials: [] }); else release.shift()?.() },
      open: (id) => { current = id; composerKey = id },
      drawn: () => [...drawn],
      top: () => JSON.stringify({ running: [...runningSessions], completions, trees, pumped }),
      holding: () => looseTurnEvents !== null,
      refuse: () => { refused = gate() },
      settled: () => settled,
      rounds: () => liveRounds,
      current: () => current,
      turn: () => running,
    })
    `,
    { MINE, THEIRS, JSON, Promise, TextEncoder, TextDecoder, performance, Error, Array, Object, String, Number, Set, Map, setTimeout },
  ) as Page
}

const settle = async () => {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve))
}

const foreignTurn = (page: Page) => {
  page.stream(THEIRS, { type: 'message', text: 'their prompt' })
  page.stream(THEIRS, { type: 'model/request' })
  page.stream(THEIRS, { type: 'assistant/chunk', text: 'their answer' })
  page.stream(THEIRS, { type: 'turn/completed' })
}

test('with nothing open and no turn of its own, the page draws, settles and counts no other session\'s turn (#142)', async () => {
  const page = harness()
  page.stream(THEIRS, { type: 'message', text: 'their prompt' })
  page.stream(THEIRS, { type: 'model/request' })
  assert.deepEqual(JSON.parse(page.top()).running, [THEIRS], 'the top half still follows them: their session is marked running, for the tree')
  page.stream(THEIRS, { type: 'assistant/chunk', text: 'their answer' })
  page.stream(THEIRS, { type: 'turn/completed' })
  assert.deepEqual(Array.from(page.drawn()), [], 'none of their rows reaches the panel, so none of their usage reaches the dock')
  assert.equal(page.settled(), 0, 'and nothing is settled for their turn')
  assert.equal(page.rounds(), 0, 'nor a round counted')
  const top = JSON.parse(page.top()) as { running: string[]; completions: number; trees: number; pumped: string[] }
  assert.deepEqual(top.running, [], 'and their turn\'s end marks it idle again (developer-ten\'s edge 1: only the drawing half is held)')
  assert.equal(top.completions, 2, 'noteCompletion sees its start and its end')
  assert.ok(top.trees >= 2, 'and the tree is asked to redraw on their message and their end')
  assert.equal(page.holding(), false, 'nothing is kept for them')
})

test('a send refused before any session exists drops what was held and leaves the panel blank (developer-ten\'s edge 3)', async () => {
  const page = harness()
  page.refuse()
  page.send(false)
  await settle()
  page.stream(MINE, { type: 'message', text: 'mine' })
  page.stream(THEIRS, { type: 'message', text: 'their prompt' })
  assert.equal(page.holding(), true, 'held while the send is on its way')
  page.named()
  await page.turn()
  assert.equal(page.holding(), false, 'the refusal lets the held events go')
  assert.deepEqual(Array.from(page.drawn()), [], 'and none is drawn')
  assert.equal(page.current(), null, 'with nothing open')
  page.stream(THEIRS, { type: 'assistant/chunk', text: 'their answer' })
  assert.deepEqual(Array.from(page.drawn()), [], 'and later events of others are dropped, not kept')
})

for (const detached of [false, true]) {
  const kind = detached ? 'detached (#128)' : 'streamed'
  test(`its own first turn, ${kind}: its events before and after it names its session are drawn once, in order, and no one else's (#142)`, async () => {
    const page = harness()
    page.send(detached)
    await settle()
    /** Before the turn names its session: its own prompt and first round, interleaved with another session's turn. */
    page.stream(MINE, { type: 'message', text: 'mine' })
    page.stream(THEIRS, { type: 'message', text: 'their prompt' })
    page.stream(MINE, { type: 'model/request' })
    page.stream(THEIRS, { type: 'assistant/chunk', text: 'their answer' })
    assert.deepEqual(Array.from(page.drawn()), [], 'nothing is drawn before the turn names its session')
    page.named()
    await settle()
    assert.equal(page.current(), MINE, 'the page adopts the session the turn created')
    assert.deepEqual(Array.from(page.drawn()), ['mine:message:mine', 'mine:model/request'], 'and draws what came of it before, in order')
    /** After: the turn's answer, and another session's still running. */
    page.stream(MINE, { type: 'assistant/chunk', text: 'answer' })
    foreignTurn(page)
    page.stream(MINE, { type: 'turn/completed' })
    page.ended()
    await page.turn()
    assert.deepEqual(Array.from(page.drawn()), ['mine:message:mine', 'mine:model/request', 'mine:assistant/chunk:answer', 'mine:turn/completed'], 'each of its events once, and none of theirs')
  })
}

test('when the boot opened another session before the turn named its own, the held events are dropped: its open redraws from the log (N1)', async () => {
  const page = harness()
  page.send(false)
  await settle()
  page.stream(MINE, { type: 'message', text: 'mine' })
  page.open(OPENED)
  page.named()
  await settle()
  assert.equal(page.current(), MINE, 'the created session is opened')
  assert.deepEqual(Array.from(page.drawn()), [], 'and nothing held is drawn over the redraw from its own log')
})
