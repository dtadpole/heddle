import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// HEDDLE_TEST_PAGE permits a named git-show snapshot to judge the regression.
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
function extract(name: string) {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `The page defines ${name}`)
  const end = page.indexOf('\n}', start)
  assert.ok(end >= 0, `The page closes ${name}`)
  return page.slice(start, end + 2)
}
interface Row { className: string; textContent: string }
interface Response { ok: boolean; status?: number; statusText?: string; json(): Promise<unknown> }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness(previousTranscript = true) {
  const rows: Row[] = previousTranscript ? [{ className: 'turn assistant', textContent: 'previous session transcript' }] : []
  const requests: Array<ReturnType<typeof deferred<Response>> & { signal: AbortSignal }> = []
  const timers: Array<() => void> = []
  const calls: string[] = []
  const headers = new Map(['session-title', 'session-branch'].map((id) => [id, { textContent: '' }]))
  const noop = () => {}
  // These explicit dependencies do not reimplement loading, replay, filtering, or retry.
  const context = {
    AbortController, performance, console, Error,
    document: { getElementById: (id: string) => headers.get(id) ?? null, createElement: () => ({ className: '', textContent: '', dataset: {}, setAttribute: noop }) },
    log: { replaceChildren: () => { rows.length = 0; calls.push('clear') }, append: (row: Row) => rows.push(row) },
    add: (kind: string, text: string) => { rows.push({ className: `turn ${kind}`, textContent: text }) },
    fetch: (url: string, options: { signal: AbortSignal }) => {
      assert.equal(url, '/api/sessions/S', 'Only the transcript endpoint is fetched')
      calls.push('fetch')
      const request = { ...deferred<Response>(), signal: options.signal }
      request.signal.addEventListener('abort', () => request.reject(new Error('snapshot aborted')), { once: true })
      requests.push(request)
      return request.promise
    },
    setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 100); timers.push(callback); return timers.length },
    clearTimeout: noop,
    closeSchedulesPage: noop, closeScheduleDrawer: noop, resetScheduleList: noop,
    placeholderDrawn: () => false, chooseWorkspace: noop, jobsSessionChanged: noop,
    slashReady: Promise.resolve(null), markRunning: noop, drawTurnFailure: noop,
    rememberCurrent: noop, paintComposerAccess: noop, paintSessionHeading: noop,
    renderTree: async () => {}, markSelection: noop, noteCompletion: noop, markBranchable: noop,
    paintEmptyState: noop, applySessionAccess: noop, applySessionModel: noop,
    adoptSession: noop, refreshSessions: async () => {}, syncSelectionToSession: noop,
    showLedger: async () => {}, followChatTail: noop, updateStatusBar: noop,
    refreshGoal: async () => {}, refreshTodo: async () => {},
    renderScheduleCards: noop, renderScheduleDrawer: noop, paintScheduleHeader: noop,
    refreshScheduleList: async () => {}, refreshScheduleCatalog: async () => {},
    scheduleTreeRefresh: noop, scheduleGoalRefresh: noop, scheduleTodoRefresh: noop,
    paintRunningMarks: noop, renderComposerState: noop, refreshRunningStatus: noop,
    refreshSessionStats: async () => {}, pumpQueue: async () => {},
    settleChat: noop, renderSettledAnswers: async () => {}, settleReasoning: noop,
    addUsage: (previous: unknown, usage: unknown) => usage ?? previous,
    attachEditedFiles: async () => {}, renderAccess: noop,
    growLiveToolCall: noop, settleLiveToolCall: () => false, fillToolResult: () => false,
    messageContentText: () => 'user message', contentAttachments: () => [],
  }
  const api = runInNewContext(`
    const transcriptLoads = new Map(), transcriptWatermarks = new Map();
    let historyLoadGeneration = 0, current = 'old', composerKey = 'S', view = 'chat';
    const schedState = { drawer: null }, runningSessions = new Set(), runningSince = new Map(), queues = new Map();
    let sessionStats = null, liveRounds = 0, liveUsage, liveTurns = 0, liveGenerationMs = 0, liveDecodeTokens = 0;
    let liveRoundStartedAt = null, accessMode = null, followTail = true, ledgerRefetchTimer = null;
    let unavailableSession = null, selectedPath = null;
    const unreadSessions = new Set(), sessionMetas = new Map(), pendingInteractions = new Map();
    ${page.includes('function historyFailureText(') ? extract('historyFailureText') : ''}
    ${extract('showSession')}
    ${extract('handleSessionPayload')}
    ({ show: showSession, handle: handleSessionPayload,
       loading: () => transcriptLoads.has('S'), watermark: () => transcriptWatermarks.get('S'),
       buffered: () => transcriptLoads.get('S')?.events.length ?? 0,
       unavailable: () => unavailableSession })
  `, context, { timeout: 1000 }) as {
    show(id: string): Promise<boolean | undefined>
    unavailable(): string | null
    handle(payload: unknown): void
    loading(): boolean
    watermark(): number | undefined
    buffered(): number
  }
  return { ...api, rows, requests, timers, calls }
}
async function flush() { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
function delta(seq: number, text: string) {
  return { session: 'S', event: { seq, type: 'assistant/chunk', chunk: { type: 'text-delta', text } } }
}
function assistantTexts(state: ReturnType<typeof harness>) {
  return state.rows.filter((row) => row.className === 'turn assistant').map((row) => row.textContent)
}
async function snapshotStarted(state: ReturnType<typeof harness>, count: number) {
  await flush()
  assert.equal(state.requests.length, count, 'The snapshot starts without a real timer or network')
  assert.equal(state.loading(), true)
  return state.requests[count - 1]!
}

test('showSession clears the previous transcript before starting the snapshot fetch', { timeout: 5000 }, async () => {
  const state = harness()
  const loading = state.show('S')
  const request = await snapshotStarted(state, 1)
  const callsAtFetch = [...state.calls]
  const rowsAtFetch = [...state.rows]
  request.resolve({ ok: true, json: async () => ({ eventSeq: 1, turns: [] }) })
  await loading
  assert.deepEqual(callsAtFetch, ['clear', 'fetch'])
  assert.deepEqual(rowsAtFetch, [], 'No transcript from the previous session remains during the fetch')
})

test('showSession reports an HTTP snapshot failure as unavailable with the server reason and false result', { timeout: 5000 }, async () => {
  const state = harness()
  const loading = state.show('S')
  const request = await snapshotStarted(state, 1)
  request.resolve({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'no session S' }) })
  assert.equal(await loading, false, 'An HTTP failure must not claim that history loaded')
  assert.equal(state.unavailable(), 'S')
  assert.equal(state.loading(), false)
  assert.equal(state.watermark(), undefined)
  assert.deepEqual(assistantTexts(state), [])
  assert.ok(state.rows.some((row) => row.className === 'turn denied load-error' && row.textContent === 'Failed to load history: no session S (404)'), 'The actual page formatter exposes the server reason and HTTP status')
  assert.equal(state.timers.length, 0)
})

for (const failure of ['fetch rejection', 'JSON rejection'] as const) {
  test(`showSession clears old history before fetch and retains buffered live deltas after ${failure} without a stale watermark`, { timeout: 5000 }, async () => {
    const state = harness()
    const initial = state.show('S')
    const first = await snapshotStarted(state, 1)
    first.resolve({ ok: true, json: async () => ({ eventSeq: 100, turns: [{ kind: 'assistant', text: 'old snapshot' }] }) })
    await initial
    assert.equal(state.watermark(), 100, 'A successful snapshot establishes the old watermark')
    assert.deepEqual(assistantTexts(state), ['old snapshot'])
    const loading = state.show('S')
    const request = await snapshotStarted(state, 2)
    const callsAtFetch = [...state.calls]
    const rowsAtFetch = [...state.rows]
    const watermarkAtFetch = state.watermark()
    state.handle(delta(90, 'buffered first'))
    state.handle(delta(91, 'buffered second'))
    assert.equal(state.buffered(), 2)
    assert.deepEqual(state.rows, rowsAtFetch, 'Live deltas wait for the in-flight snapshot')
    if (failure === 'fetch rejection') request.reject(new Error('network unavailable'))
    else request.resolve({ ok: true, json: async () => { throw new Error('invalid snapshot JSON') } })
    assert.equal(await loading, false, 'A rejected snapshot must not claim that history loaded')
    assert.equal(state.unavailable(), 'S', 'Transport and JSON failures mark the session unavailable')
    assert.equal(state.loading(), false, 'Failure releases the pending load')
    assert.equal(state.watermark(), undefined, 'A failed snapshot establishes no watermark')
    assert.deepEqual(assistantTexts(state), ['buffered first', 'buffered second'], 'Buffered deltas below the old watermark replay once in arrival order')
    assert.ok(state.rows.some((row) => row.className === 'turn denied load-error' && row.textContent === `Failed to load history: ${failure === 'fetch rejection' ? 'network unavailable' : 'invalid snapshot JSON'} (0)`), 'The visible failure is the injected snapshot error')
    assert.deepEqual(state.rows.map((row) => row.textContent), ['buffered first', 'buffered second', `Failed to load history: ${failure === 'fetch rejection' ? 'network unavailable' : 'invalid snapshot JSON'} (0)`], 'Buffered live deltas replay before the view is marked unavailable and its alert is appended')
    assert.ok(!state.rows.some((row) => /ReferenceError|is not defined/.test(row.textContent)), 'A missing mock dependency must not masquerade as a snapshot failure')
    state.handle(delta(92, 'later live delta'))
    assert.deepEqual(assistantTexts(state), ['buffered first', 'buffered second', 'later live delta'])
    assert.equal(state.timers.length, 0, 'Snapshot failures do not schedule an unsolicited retry')
    assert.deepEqual(callsAtFetch, ['clear', 'fetch', 'clear', 'fetch'], 'Every snapshot fetch starts after clearing the old transcript')
    assert.deepEqual(rowsAtFetch, [], 'The prior transcript is absent while the new snapshot is pending')
    assert.equal(watermarkAtFetch, undefined, 'Reopening invalidates the previous watermark before replay')
  })
}

for (const budget of ['event count', 'serialized bytes'] as const) {
  test(`handleSessionPayload retains live updates when the ${budget} budget overflows and retries history at most once`, { timeout: 5000 }, async () => {
    const state = harness(false)
    const firstLoad = state.show('S')
    const first = await snapshotStarted(state, 1)
    function overflow(prefix: string) {
      const priorTexts = assistantTexts(state)
      const count = budget === 'event count' ? 4096 : 1
      for (let i = 0; i < count; i += 1) state.handle(delta(i + 1, `${prefix}:${i}`))
      assert.equal(state.buffered(), count)
      assert.deepEqual(assistantTexts(state), priorTexts, 'No buffered row is drawn before overflow')
      // Unknown event data consumes the actual JSON budget without drawing 8 MiB.
      const trigger = { ...delta(count + 1, `${prefix}:trigger`), ...(budget === 'serialized bytes' ? { padding: 'x'.repeat(8 * 1024 * 1024) } : {}) }
      state.handle(trigger)
      assert.equal(state.loading(), false, 'Overflow releases the buffer immediately')
      assert.equal(state.watermark(), undefined)
      assert.deepEqual(assistantTexts(state), [...priorTexts, ...Array.from({ length: count }, (_, i) => `${prefix}:${i}`), `${prefix}:trigger`], 'Buffered rows and the triggering delta survive in order exactly once')
      assert.ok(state.rows.some((row) => row.className === 'turn denied' && row.textContent.includes('event budget')))
    }
    overflow('first')
    assert.equal(first.signal.aborted, true, 'The obsolete snapshot is aborted')
    await firstLoad
    state.handle(delta(5000, 'between loads'))
    assert.equal(assistantTexts(state).at(-1), 'between loads', 'Live traffic continues after the aborted snapshot')
    assert.equal(state.timers.length, 1, 'The first overflow schedules one retry')
    state.timers.shift()!()
    const retry = await snapshotStarted(state, 2)
    overflow('retry')
    assert.equal(retry.signal.aborted, true)
    await flush()
    assert.equal(state.timers.length, 0, 'Overflow in the retry must not schedule another retry')
    assert.equal(state.requests.length, 2, 'Only the initial request and one retry are issued')
    state.handle(delta(6000, 'after retry overflow'))
    assert.equal(assistantTexts(state).at(-1), 'after retry overflow')
  })
}
