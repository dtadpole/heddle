import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/** Bounded regressions adapted from 54d205ac, running stack12's actual functions and stream listener, not a model. */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')

/** The page's English table (#80), so a lifted function that draws its words through t() shows them as the page does. */
const ENGLISH: Record<string, string> = (() => {
  const start = page.indexOf('  en: Object.freeze({')
  const table: Record<string, string> = {}
  if (start < 0) return table
  const end = page.indexOf('\n  }),', start)
  for (const match of page.slice(start, end).matchAll(/^\s+'([^']+)': '((?:[^'\\]|\\.)*)',$/gm)) table[match[1]!] = match[2]!.replace(/\\'/g, "'")
  return table
})()

function englishT(key: string, vars: Record<string, unknown> = {}): string {
  return (ENGLISH[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, name)
  return page.slice(start, page.indexOf('\n}', start) + 2)
}
const listenerStart = page.indexOf("events.addEventListener('session', (message) => {")
assert.ok(listenerStart >= 0)
const listener = page.slice(listenerStart, page.indexOf('\n})', listenerStart) + 3)
const lifecycleStart = page.indexOf('/* page-lifecycle:begin */')
const lifecycleEnd = page.indexOf('/* page-lifecycle:end */', lifecycleStart)
assert.equal(lifecycleStart >= 0, lifecycleEnd >= 0)
const lifecycleSource = lifecycleStart < 0 ? '' : page.slice(lifecycleStart, lifecycleEnd + '/* page-lifecycle:end */'.length)
async function flush() { for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve)) }
interface Row { className: string; textContent: string; dataset: Record<string, string>; setAttribute(name: string, value: string): void }
interface Request { resolve(value: unknown): void; reject(error: Error): void }
interface TurnResponse {
  ok: boolean; status?: number; headers: { get(name: string): string }
  json?(): Promise<unknown>
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } }
}
function harness(deferredCommands = false) {
  const rows: Row[] = []
  const calls: string[] = []
  const requests: Request[] = []
  const noop = () => {}
  const timers = new Map<number, () => void>()
  let timerId = 0
  const advanceClock = (_milliseconds: 0) => {
    for (const [id, callback] of [...timers]) { timers.delete(id); callback() }
  }
  let handle!: (message: { data: string }) => void
  let releaseCommands!: (value: unknown) => void
  const commands = { sessionShown: noop, draw: () => calls.push('command'), drawTurn: () => calls.push('command-turn') }
  const slashReady = deferredCommands ? new Promise((resolve) => { releaseCommands = resolve }) : Promise.resolve(commands)
  const branch = { textContent: 'old branch' }
  const context = {
    t: englishT,
    rows, calls, slashReady, performance, TextDecoder, window: new EventTarget(),
    setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 0); timers.set(++timerId, callback); return timerId },
    clearTimeout: (id: number) => { timers.delete(id) },
    fetch: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    events: { addEventListener: (_name: string, fn: typeof handle) => { handle = fn }, whenOpen: async () => {} },
    document: { getElementById: () => branch, createElement: (): Row => ({ className: '', textContent: '', dataset: {}, setAttribute: noop }) },
    log: { replaceChildren: () => { rows.length = 0; calls.push('clear') }, append: (row: Row) => rows.push(row) },
    add: (kind: string, text: string) => { rows.push({ className: kind, textContent: text, dataset: {}, setAttribute: noop }) },
    closeSchedulesPage: noop, closeScheduleDrawer: noop, resetScheduleList: noop,
    updateStatusBar: noop, placeholderDrawn: () => false, scheduleTreeRefresh: noop,
    renderComposerState: noop, chooseWorkspace: noop, paintEmptyState: noop,
    rememberCurrent: () => calls.push('remember'), paintComposerAccess: () => calls.push('access'),
    paintRunningMarks: noop, jobsSessionChanged: noop, applySessionAccess: noop,
    adoptSession: () => calls.push('adopt'), refreshSessions: async () => {}, syncSelectionToSession: noop,
    showLedger: async () => {}, paintSessionHeading: () => calls.push('heading'), renderTree: async () => {},
    markSelection: noop, paintScheduleHeader: noop, renderModelSeat: noop,
    rememberChatScroll: noop, restoreChatScroll: () => calls.push('scroll'), refreshGoal: async () => {}, refreshTodo: async () => {},
    renderScheduleCards: () => calls.push('cards'), renderScheduleDrawer: noop,
    refreshScheduleList: async () => {}, refreshScheduleCatalog: async () => {},
    scheduleGoalRefresh: noop, scheduleTodoRefresh: noop, refreshRunningStatus: noop,
    markRunning: noop, noteCompletion: (id: string, was: boolean, running: boolean) => calls.push(`completion:${id}:${was}:${running}`),
    drawTurnFailure: () => calls.push('failure-panel'), settleChat: () => calls.push('settle'),
    pumpQueue: async (id: string) => { calls.push(`pump:${id}`) }, refreshSessionStats: async () => {},
    markBranchable: (seq: number) => calls.push(`branch:${seq}`), renderSettledAnswers: async () => { calls.push('answers') },
    attachEditedFiles: async () => { calls.push('files') }, settleReasoning: noop,
    addUsage: (_old: unknown, usage: unknown) => usage, messageContentText: () => 'user', contentAttachments: () => [],
    sendTurn: async (_body: Record<string, unknown>): Promise<TurnResponse> => ({ ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }),
    turnVerdicts: { wait: async (_turn: string, _session: string | null) => ({ outcome: 'lost' }), lateTail: noop },
    stopButton: { disabled: false },
    newConversationTarget: () => ({ path: 'workspace' }),
    fetchSessionAccess: async () => { calls.push('fetch-access') }, stopTurn: async () => {},
  }
  const api = runInNewContext(`
    let current = null, unavailableSession = null, selectedPath = 'old', view = 'chat', showGeneration = 0;
    let sessionStats = null, liveRounds = 0, liveUsage, liveGenerationMs = 0, liveDecodeTokens = 0, liveRoundStartedAt = null;
    const liveTurns = new Map();
    let sessionLoading = null, composerKey = 'S', accessMode;
    let selectionSeq = 0, chosenEndpoint = null, chosenModel = null, chosenEffort = null;
    let defaultSelection = { model: 'default-model', effort: 'low' };
    const latestSelection = new Map(), serverSeats = new Map(), heldSeats = new Map();
    const recordedSelections = new Set(), pendingSaves = new Set();
    function selectionForTurn() {
      return { ...(chosenEndpoint !== null ? { endpoint: chosenEndpoint } : {}),
        ...(chosenModel !== null ? { model: chosenModel } : {}),
        ...(chosenEffort !== null ? { reasoningEffort: chosenEffort } : {}) };
    }
    function applySessionModel(endpoint, model, effort) {
      chosenEndpoint = endpoint; chosenModel = model; chosenEffort = effort;
    }
    const schedState = { drawer: null }, unreadSessions = new Set(), sessionMetas = new Map();
    const runningSessions = new Set(), runningSince = new Map(), pendingInteractions = new Map(), queues = new Map();
    let followTail = false, ledgerRefetchTimer = null;
    const QUEUE_KEY_NONE = ''; let activeFolder = 'workspace', workspaceRoutes = 'present'; const firstTreeReady = Promise.resolve();
    let directTurnPending = 0, directPendingKey = null, stopRequested = false;
    ${['historyFailureText', 'adoptViewSelection', 'selectionForSeat', 'showSession', 'keptToDraw', 'drawKeptEvents', 'drawSessionEvent', 'runTurn'].map(source).join('\n')}
    ${lifecycleSource}
    ${listener};
    ({ show: showSession, run: runTurn,
       state: () => ({ current, unavailable: unavailableSession, loading: sessionLoading !== null, selectedPath }),
       selection: () => ({ endpoint: chosenEndpoint, model: chosenModel, effort: chosenEffort }),
       seat: (id) => ({ recorded: recordedSelections.has(id), server: serverSeats.get(id), held: heldSeats.get(id) }),
       kept: () => sessionLoading?.events.length ?? 0,
       buffer: () => sessionLoading?.events,
       prepare: (id) => { runningSessions.add(id); runningSince.set(id, 1); pendingInteractions.set(id, {}); queues.set(id, []); },
       lifecycle: (id) => [runningSessions.has(id), runningSince.has(id), pendingInteractions.has(id)],
    })
  `, context, { timeout: 1000 }) as {
    show(id: string): Promise<boolean>; run(text: string, key: string): Promise<void>;
    state(): { current: string | null; unavailable: string | null; loading: boolean; selectedPath: string | null };
    selection(): { endpoint: string | null; model: string | null; effort: string | null };
    seat(id: string): { recorded: boolean; server?: { endpoint: string; model: string | null; effort: string | null }; held?: { endpoint: string; model: string | null; effort: string | null } };
    kept(): number; buffer(): unknown[]; prepare(id: string): void; lifecycle(id: string): boolean[];
  }
  return { ...api, rows, calls, requests, branch, advanceClock, handle: (payload: unknown) => handle({ data: JSON.stringify(payload) }),
    releaseCommands: () => releaseCommands(commands), context }
}
const delta = (seq: number, text = 'partial') => ({ session: 'S', event: { seq, type: 'assistant/chunk', chunk: { type: 'text-delta', text } } })
async function started(state: ReturnType<typeof harness>, count = 1) {
  await flush()
  assert.equal(state.requests.length, count, 'actual showSession reached snapshot fetch')
  return state.requests[count - 1]!
}
for (const failure of ['HTTP refusal', 'fetch rejection', 'JSON rejection'] as const) {
  test(`failed history discards kept events and blocks drawing after ${failure}`, { timeout: 5000 }, async () => {
    const state = harness(); const loading = state.show('S'); const request = await started(state)
    state.handle(delta(90)); state.handle(delta(91)); state.prepare('S')
    state.handle({ session: 'S', event: { seq: 92, type: 'turn/completed' } })
    assert.equal(state.kept(), 3); const kept = state.buffer()
    assert.equal(state.rows.length, 0, 'including completion, drawing waits for history')
    assert.deepEqual(Array.from(state.lifecycle('S')), [false, false, false])
    if (failure === 'HTTP refusal') request.resolve({ ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ error: 'history unavailable' }) })
    else if (failure === 'fetch rejection') request.reject(new Error('network unavailable'))
    else request.resolve({ ok: true, json: async () => { throw new Error('invalid snapshot JSON') } })
    assert.equal(await loading, false)
    state.advanceClock(0)
    assert.deepEqual({ ...state.state() }, { current: null, unavailable: 'S', loading: false, selectedPath: null })
    assert.equal(kept.length, 0, 'failed snapshot deliberately drops its kept events')
    const reason = failure === 'HTTP refusal' ? 'history unavailable (503)' : failure === 'fetch rejection' ? 'network unavailable' : 'invalid snapshot JSON'
    assert.deepEqual(state.rows.map((row) => row.textContent), [`Failed to load history: ${reason}`])
    assert.equal(state.rows[0]?.className, 'turn denied load-error'); assert.equal(state.branch.textContent, '')
    for (const session of ['S', 'other-session']) {
      state.prepare(session)
      state.handle({ ...delta(93), session })
      state.handle({ session, event: { type: 'message', message: { role: 'user', content: [] } } })
      state.handle({ session, event: { type: 'command/run' } })
      state.handle({ session, event: { seq: 94, type: 'turn/failed', message: 'must not draw' } })
      state.prepare(session)
      state.handle({ session, event: { seq: 95, type: 'turn/completed' } })
      assert.deepEqual(Array.from(state.lifecycle(session)), [false, false, false])
    }
    await flush()
    assert.equal(state.rows.length, 1)
    assert.equal(state.calls.filter((call) => call === 'completion:S:true:false').length, 2, 'no replay of buffered completion lifecycle')
    assert.equal(state.calls.filter((call) => call === 'pump:S').length, 2)
    assert.ok(!state.calls.some((call) => /^(settle|answers|cards|files|command|failure-panel|branch:)/.test(call)))
    const retry = state.show('T'); const next = await started(state, 2)
    next.resolve({ ok: true, json: async () => ({ turns: [{ kind: 'user', text: 'recovered' }], seq: 100 }) })
    assert.equal(await retry, true); assert.equal(state.state().unavailable, null)
    assert.deepEqual(state.rows.map((row) => row.textContent), ['recovered'])
  })
}
test('a command already awaiting its module cannot draw after unavailable history', { timeout: 5000 }, async () => {
  const state = harness(true)
  state.handle({ session: 'S', event: { type: 'command/run' } })
  const loading = state.show('S'); (await started(state)).reject(new Error('offline')); assert.equal(await loading, false)
  state.releaseCommands(); await flush()
  assert.ok(!state.calls.includes('command'))
})
test('deferred history commands cannot recreate rows in a later unavailable view', { timeout: 5000 }, async () => {
  const state = harness(true); const first = state.show('S'); const response = await started(state)
  response.resolve({ ok: true, json: async () => ({ seq: 1, turns: [{ kind: 'command', commandId: 'old-command' }] }) })
  assert.equal(await first, true)
  const latest = state.show('T'); (await started(state, 2)).reject(new Error('offline')); assert.equal(await latest, false)
  state.releaseCommands(); await flush()
  assert.ok(!state.calls.includes('command-turn'))
  assert.deepEqual(state.rows.map((row) => row.textContent), ['Failed to load history: offline'])
})
test('older rejected history cannot replace newer successful history', { timeout: 5000 }, async () => {
  const state = harness(); const old = state.show('S'); const first = await started(state)
  const latest = state.show('T'); const second = await started(state, 2)
  second.resolve({ ok: true, json: async () => ({ turns: [{ kind: 'user', text: 'T' }], seq: 1 }) })
  assert.equal(await latest, true); first.reject(new Error('old offline')); assert.equal(await old, false)
  assert.equal(state.state().current, 'T'); assert.equal(state.state().unavailable, null)
  assert.deepEqual(state.rows.map((row) => row.textContent), ['T'])
})
test('late A model JSON retains only A seats after B history becomes unavailable', { timeout: 5000 }, async () => {
  const state = harness()
  let releaseJSON!: (value: unknown) => void
  const old = state.show('A'); const first = await started(state)
  first.resolve({ ok: true, json: () => new Promise((resolve) => { releaseJSON = resolve }) })
  await flush()
  const latest = state.show('B'); const second = await started(state, 2)
  second.resolve({ ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ error: 'B unavailable' }) })
  assert.equal(await latest, false)
  state.advanceClock(0)
  const before = { ...state.selection() }
  const rows = state.rows.map((row) => row.textContent)
  const calls = [...state.calls]
  releaseJSON({ endpoint: 'fixture-A', model: 'model-A', reasoningEffort: 'high', turns: [{ kind: 'user', text: 'must not draw A' }] })
  assert.equal(await old, false)
  assert.deepEqual({ ...state.state() }, { current: null, unavailable: 'B', loading: false, selectedPath: null })
  assert.deepEqual({ ...state.selection() }, before, 'late A cannot publish into the unavailable B seat')
  assert.deepEqual(state.rows.map((row) => row.textContent), rows)
  assert.deepEqual(state.calls, calls, 'late A cannot resume history drawing or lifecycle work')
  assert.equal(state.seat('A').recorded, true)
  assert.deepEqual({ ...state.seat('A').server }, { endpoint: 'fixture-A', model: 'model-A', effort: 'high' })
  assert.deepEqual({ ...state.seat('A').held }, { endpoint: 'fixture-A', model: 'model-A', effort: 'high' })
  assert.equal(state.seat('B').recorded, false)
  assert.equal(state.seat('B').server, undefined)
  assert.equal(state.seat('B').held, undefined)
})
for (const unavailable of [false, true]) {
  test(`pending new-session response ${unavailable ? 'skips unavailable adoption' : 'still adopts normally'}`, { timeout: 5000 }, async () => {
    const state = harness()
    let release!: (value: { value: Uint8Array; done: boolean }) => void
    let reads = 0
    state.context.sendTurn = async () => ({ ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => {
      if (reads++ > 0) return { done: true }
      return await new Promise((resolve) => { release = resolve })
    } }) } }) as Awaited<ReturnType<typeof state.context.sendTurn>>
    const turn = state.run('new', ''); await flush()
    if (unavailable) {
      const loading = state.show('S'); (await started(state)).reject(new Error('offline')); assert.equal(await loading, false)
    }
    const before = state.calls.filter((call) => call === 'adopt').length
    release({ value: new TextEncoder().encode('event: session\ndata: {"session":"created"}\n\n'), done: false })
    await turn
    assert.equal(state.state().current, unavailable ? null : 'created')
    assert.equal(state.state().unavailable, unavailable ? 'S' : null)
    assert.equal(state.calls.filter((call) => call === 'adopt').length, before + (unavailable ? 0 : 1))
    assert.equal(state.calls.includes('fetch-access'), !unavailable)
  })
}
test('detached 202 JSON acceptance cannot adopt or publish a seat over unavailable history', { timeout: 5000 }, async () => {
  const state = harness()
  const initial = state.show('A'); const history = await started(state)
  history.resolve({ ok: true, json: async () => ({ endpoint: 'fixture-A', model: 'model-A', reasoningEffort: 'high', turns: [] }) })
  assert.equal(await initial, true)
  let release!: (response: TurnResponse) => void
  const sends: Record<string, unknown>[] = []
  state.context.sendTurn = (body) => {
    sends.push(body)
    return new Promise((resolve) => { release = resolve })
  }
  const turn = state.run('new detached turn', ''); await flush()
  assert.equal(sends.length, 1, 'actual runTurn reached the acceptance request')
  assert.deepEqual({ ...sends[0] }, { prompt: 'new detached turn', session: null, folder: 'workspace', new: true,
    endpoint: 'fixture-A', model: 'model-A', reasoningEffort: 'high', detach: true })
  const loading = state.show('B'); (await started(state, 2)).reject(new Error('B offline'))
  assert.equal(await loading, false)
  state.advanceClock(0)
  const before = { ...state.selection() }
  assert.deepEqual(before, { endpoint: 'fixture-A', model: 'model-A', effort: 'high' }, 'the seat assertion is non-vacuous')
  const errorRow = state.rows[0]
  const calls = [...state.calls]
  const waits: [string, string | null][] = []
  const assertUnavailable = () => {
    assert.deepEqual({ ...state.state() }, { current: null, unavailable: 'B', loading: false, selectedPath: null })
    assert.deepEqual({ ...state.selection() }, before, 'the accepted A send cannot publish into unavailable B')
    assert.equal(state.rows.length, 1)
    assert.equal(state.rows[0], errorRow, 'the exact unavailable-history error row survives acceptance')
    assert.equal(errorRow?.className, 'turn denied load-error')
    assert.equal(errorRow?.textContent, 'Failed to load history: B offline')
    assert.deepEqual(state.calls, calls, 'acceptance cannot adopt, fetch access, remember or redraw another session')
    assert.equal(state.requests.length, 2, 'acceptance cannot reopen the created session over unavailable history')
    for (const id of ['B', 'created']) {
      assert.equal(state.seat(id).recorded, false)
      assert.equal(state.seat(id).server, undefined)
      assert.equal(state.seat(id).held, undefined)
    }
  }
  state.context.turnVerdicts.wait = async (id, session) => {
    waits.push([id, session])
    assertUnavailable() // Actual JSON session verdict has run; no terminal recovery can hide an adoption.
    return { outcome: 'lost' }
  }
  release({ ok: true, status: 202, headers: { get: () => 'application/json' },
    json: async () => ({ session: 'created', turn: 'accepted-turn' }) })
  await turn
  assert.deepEqual(waits, [['accepted-turn', 'created']], 'actual detached path waits for the accepted turn/session')
  assertUnavailable()
})
test('successful history still replays only post-snapshot drawing without repeating completion lifecycle', { timeout: 5000 }, async () => {
  const state = harness(); const loading = state.show('S'); const request = await started(state)
  state.handle(delta(9, 'already in history')); state.handle(delta(11, 'new tail')); state.prepare('S')
  state.handle({ session: 'S', event: { seq: 12, type: 'turn/completed' } })
  request.resolve({ ok: true, json: async () => ({ seq: 10, turns: [{ kind: 'assistant', text: 'snapshot' }] }) })
  assert.equal(await loading, true)
  assert.deepEqual(state.rows.map((row) => row.textContent), ['snapshot', 'new tail'])
  assert.equal(state.calls.filter((call) => call === 'completion:S:true:false').length, 1)
  assert.equal(state.calls.filter((call) => call === 'pump:S').length, 1)
  assert.equal(state.calls.filter((call) => call === 'branch:12').length, 1)
  assert.ok(state.calls.includes('answers')); assert.ok(state.calls.includes('scroll'))
})

for (const failure of ['HTTP refusal', 'fetch rejection', 'JSON rejection'] as const) {
  test(`a vanished session's draft starts from the default selection, while a read lost in transit keeps the seat: ${failure} (A104)`, { timeout: 5000 }, async () => {
    const state = harness()
    const initial = state.show('A'); const history = await started(state)
    history.resolve({ ok: true, json: async () => ({ endpoint: 'fixture-A', model: 'model-A', reasoningEffort: 'high', turns: [] }) })
    assert.equal(await initial, true)
    assert.deepEqual({ ...state.selection() }, { endpoint: 'fixture-A', model: 'model-A', effort: 'high' }, 'A\'s seat is shown first')
    const loading = state.show('B'); const request = await started(state, 2)
    if (failure === 'HTTP refusal') request.resolve({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'no such session' }) })
    else if (failure === 'fetch rejection') request.reject(new Error('network unavailable'))
    else request.resolve({ ok: true, json: async () => { throw new Error('invalid snapshot JSON') } })
    assert.equal(await loading, false)
    state.advanceClock(0)
    assert.deepEqual({ ...state.state() }, { current: null, unavailable: 'B', loading: false, selectedPath: null })
    const expected = failure === 'HTTP refusal'
      ? { endpoint: null, model: 'default-model', effort: 'low' }
      : { endpoint: 'fixture-A', model: 'model-A', effort: 'high' }
    assert.deepEqual({ ...state.selection() }, expected, failure === 'HTTP refusal' ? 'the server said B is gone: the draft starts from the default selection' : 'B could not be read: the seat stays')
    assert.equal(state.seat('A').held?.model, 'model-A', 'A keeps its own held seat either way')
  })
}
