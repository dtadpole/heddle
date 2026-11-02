import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/** Tests only. No browser, server, build, source replacement, or invented page navigation flag. */
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
  assert.ok(start >= 0, `actual ${name} exists`)
  const end = page.indexOf('\n}', start)
  assert.ok(end >= start, `actual ${name} is a top-level function`)
  return page.slice(start, end + 2)
}
// Older full-page snapshots have additional real showSession helpers. Lift only those actually present.
const snapshotHelpers = ['liveRoundsOf', 'rememberSessionWorkspace']
  .filter((name) => new RegExp(`function ${name}\\(`).test(page)).map(source).join('\n')
const treeStart = page.indexOf('/* workspace-tree:begin */')
const treeEnd = page.indexOf('/* workspace-tree:end */', treeStart)
assert.ok(treeStart >= 0 && treeEnd > treeStart)

/** Read complete real registration expressions, including one-line handlers and nested callbacks. */
function callEnd(start: number): number {
  let depth = 0
  let quote = ''
  let lineComment = false
  let blockComment = false
  for (let i = page.indexOf('(', start); i < page.length; i++) {
    const ch = page[i]!, next = page[i + 1]
    if (lineComment) { if (ch === '\n') lineComment = false; continue }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++ }; continue }
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '(') depth++
    if (ch === ')' && --depth === 0) return i + 1
  }
  throw new Error('unterminated actual navigation registration')
}
const registrations = Array.from(page.matchAll(/\b(?:window\.)?addEventListener\(\s*(['"])(beforeunload|pagehide|pageshow)\1\s*,/g), (match) => ({
  type: match[2]!, text: page.slice(match.index!, callEnd(match.index!)),
}))
const lifecycleStart = page.indexOf('/* page-lifecycle:begin */')
const lifecycleEnd = page.indexOf('/* page-lifecycle:end */', lifecycleStart)
assert.equal(lifecycleStart >= 0, lifecycleEnd >= 0, 'actual lifecycle markers are paired')
// Lift the approved block whole, including its private state and registrations, exactly once.
// The unchanged Q2 snapshot has no lifecycle block or navigation registrations.
const lifecycleSource = lifecycleStart < 0 ? '' : page.slice(lifecycleStart, lifecycleEnd + '/* page-lifecycle:end */'.length)
// The older immutable edge reference registers leaving through a real loop, not literal calls.
// Lift that loop verbatim when present; never assign its global or substitute a lifecycle model.
const legacyLoopStart = page.indexOf("for (const name of ['beforeunload', 'pagehide']) {")
const legacyLoopSource = lifecycleStart >= 0 || legacyLoopStart < 0 ? ''
  : page.slice(legacyLoopStart, page.indexOf('\n}', legacyLoopStart) + 2)
const registrationSource = registrations
  .filter(({ text }) => !lifecycleSource.includes(text))
  .map(({ text }) => text).join('\n')

interface Row { className: string; textContent: string; dataset: Record<string, string>; setAttribute(name: string, value: string): void }
interface HistoryResponse { ok: boolean; status?: number; statusText?: string; json(): Promise<unknown> }
interface HistoryRequest { url: string; resolve(response: HistoryResponse): void; reject(error: Error): void }
interface Write { key: string; value: string; phase: string }
async function microtasks() { for (let i = 0; i < 30; i++) await Promise.resolve() }

function harness() {
  const window = new EventTarget()
  const rows: Row[] = [], writes: Write[] = [], requests: HistoryRequest[] = []
  const tasks = new Map<number, { callback(): void; due: number }>()
  let taskId = 0, now = 0, phase = 'opening', tornDown = false
  const storage = new Map<string, string>()
  const noop = () => {}
  const context = {
    t: englishT,
    window, Event, addEventListener: window.addEventListener.bind(window),
    setTimeout: (callback: () => void, delay = 0) => { const id = ++taskId; tasks.set(id, { callback, due: now + delay }); return id },
    clearTimeout: (id: number) => { tasks.delete(id) },
    fetch: (url: string) => new Promise<HistoryResponse>((resolve, reject) => requests.push({ url, resolve, reject })),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { writes.push({ key, value, phase }); storage.set(key, value) },
    },
    document: { getElementById: () => ({ textContent: '' }), createElement: (): Row => ({ className: '', textContent: '', dataset: {}, setAttribute: noop }) },
    log: { replaceChildren: () => { rows.length = 0 }, append: (row: Row) => rows.push(row) },
    add: (kind: string, text: string) => rows.push({ className: kind, textContent: text, dataset: {}, setAttribute: noop }),
    slashReady: Promise.resolve({ sessionShown: noop }),
    rememberChatScroll: noop, closeSchedulesPage: noop, closeScheduleDrawer: noop, resetScheduleList: noop,
    updateStatusBar: noop, placeholderDrawn: () => false, scheduleTreeRefresh: noop,
    renderComposerState: noop, chooseWorkspace: noop, paintEmptyState: noop, paintComposerAccess: noop,
    paintRunningMarks: noop, jobsSessionChanged: noop, applySessionAccess: noop, adoptSession: noop,
    refreshSessions: async () => {}, syncSelectionToSession: noop, showLedger: async () => {},
    paintSessionHeading: noop, renderTree: async () => {}, markSelection: noop, paintScheduleHeader: noop,
    renderModelSeat: noop, adoptViewSelection: noop, drawKeptEvents: noop, restoreChatScroll: noop,
    refreshGoal: async () => {}, refreshTodo: async () => {}, renderScheduleCards: noop,
    renderScheduleDrawer: noop, refreshScheduleList: async () => {}, refreshScheduleCatalog: async () => {},
  }
  const api = runInNewContext(`
    let current = null, unavailableSession = null, selectedPath = 'workspace', view = 'chat', showGeneration = 0;
    let sessionFolder = null, sessionLoading = null, sessionStats = null;
    let liveRounds = 0, liveUsage, liveGenerationMs = 0, liveDecodeTokens = 0, liveRoundStartedAt = null;
    let chosenEndpoint = null, chosenModel = null, chosenEffort = null;
    const defaultSelection = { model: 'default-model', effort: 'low' };
    const schedState = { drawer: null }, unreadSessions = new Set(), liveTurns = new Map(), sessionMetas = new Map();
    let selectionSeq = 0;
    const runningSessions = new Set(), turnRounds = new Map(), knownWorkspaces = [];
    ${page.slice(treeStart, treeEnd)}
    ${snapshotHelpers}
    ${lifecycleSource}
    ${source('historyFailureText')}
    ${source('rememberCurrent')}
    ${source('showSession')}
    ${legacyLoopSource}
    ${registrationSource};
    ({ show: showSession,
       saved: () => WorkspaceTree.savedSelection(localStorage.getItem(WorkspaceTree.SELECTION_KEY)),
       record: (id) => WorkspaceTree.selectionRecord(id), key: WorkspaceTree.SELECTION_KEY,
       state: () => ({ current, unavailable: unavailableSession }) })
  `, context, { timeout: 1000 }) as {
    show(id: string): Promise<boolean>; saved(): string | null; record(id: string | null): string;
    key: string; state(): { current: string | null; unavailable: string | null };
  }
  storage.set(api.key, api.record('S'))
  return {
    ...api, rows, writes, requests,
    registrations: registrations.map(({ type }) => type),
    async start() {
      const loading = api.show('S'); await microtasks()
      assert.equal(requests.length, 1, 'real showSession reached controlled history fetch')
      assert.equal(requests[0]!.url, '/api/sessions/S')
      assert.equal(api.saved(), 'S', 'real opening rememberCurrent saved the selected session')
      assert.deepEqual(writes.map(({ value }) => value), [api.record('S')])
      return { loading, request: requests[0]! }
    },
    navigate(type: string, persisted = false) {
      phase = 'navigation-before-teardown'
      const event = new Event(type, { cancelable: type === 'beforeunload' })
      if (type === 'pagehide' || type === 'pageshow') Object.defineProperty(event, 'persisted', { value: persisted })
      window.dispatchEvent(event) // Runs only handlers actually registered by this source; Q2 has none.
    },
    advanceClock(milliseconds: number) {
      phase = 'next-task'
      const target = now + milliseconds
      for (;;) {
        const next = [...tasks.entries()].filter(([, task]) => task.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0]
        if (!next) break
        const [id, task] = next
        tasks.delete(id); now = task.due; task.callback()
      }
      now = target
    },
    teardown() { tornDown = true; phase = 'teardown' },
    isTornDown: () => tornDown,
    async open(id: string) {
      const loading = api.show(id); await microtasks()
      const request = requests.at(-1)!
      assert.equal(request.url, '/api/sessions/' + id)
      return { loading, request }
    },
  }
}

test('D067 control: real successful showSession preserves saved S', async () => {
  const state = harness(); const { loading, request } = await state.start()
  request.resolve({ ok: true, json: async () => ({ turns: [{ kind: 'user', text: 'saved history' }], seq: 1 }) })
  assert.equal(await loading, true)
  assert.equal(state.saved(), 'S')
  assert.deepEqual(state.rows.map(({ textContent }) => textContent), ['saved history'])
  assert.deepEqual(state.writes.map(({ value }) => value), [state.record('S')])
})

test('D067 control: ordinary offline history failure really clears the saved selection', async () => {
  const state = harness(); const { loading, request } = await state.start()
  request.reject(new Error('offline'))
  assert.equal(await loading, false)
  state.advanceClock(0) // Ordinary failure still persists the empty selection in its next task.
  assert.equal(state.saved(), null)
  assert.deepEqual(state.writes.map(({ value }) => value), [state.record('S'), state.record(null)])
  assert.deepEqual(state.rows.map(({ textContent }) => textContent), ['Failed to load history: offline'])
})

for (const [type, persisted] of [['beforeunload', false], ['pagehide', false], ['pagehide', true]] as const) {
  test(`D067 navigation abort before teardown preserves saved S: ${type}, persisted=${persisted}`, async (t) => {
    const state = harness(); const { loading, request } = await state.start()
    t.diagnostic(`actual source navigation registrations: ${JSON.stringify(state.registrations)}`)
    state.navigate(type, persisted)
    request.reject(new Error('navigation'))
    // Promise rejection/catch runs now, before timers (another task) or browser teardown.
    await microtasks()
    assert.equal(state.isTornDown(), false)
    assert.equal(await loading, false)
    const navigationWrites = state.writes.filter(({ phase }) => phase === 'navigation-before-teardown')
    assert.equal(navigationWrites.filter(({ value }) => state.record(null) === value).length, 0,
      'navigation-aborted real history read must not write the empty selection before teardown')
    assert.equal(state.saved(), 'S', 'the next page must still restore the session selected before navigation')
    state.teardown()
  })
}

for (const recovery of ['pageshow', 'expiry'] as const) {
  test(`D067 edge: pending navigation failure is persisted on ${recovery}`, async () => {
    const state = harness(); const { loading, request } = await state.start()
    state.navigate('pagehide', true)
    request.reject(new Error('navigation pending'))
    assert.equal(await loading, false)
    state.advanceClock(0) // Run actual clearFailedSelection while leaving: retain the pending failure.
    assert.equal(state.saved(), 'S', 'pending failure cannot clear selection during leaving')
    assert.deepEqual(state.writes.map(({ value }) => value), [state.record('S')])
    if (recovery === 'pageshow') state.navigate('pageshow', true)
    else { state.advanceClock(9_999); assert.equal(state.saved(), 'S'); state.advanceClock(1) }
    assert.equal(state.saved(), null, 'a stayed/restored page eventually persists the still-shown failure')
    assert.deepEqual(state.writes.map(({ value }) => value), [state.record('S'), state.record(null)])
    state.advanceClock(10_000)
    assert.equal(state.writes.length, 2, 'resume cancels expiry and consumes pending exactly once')
  })
}

test('D067 edge: repeated leaving replaces expiry so the stale timer cannot resume newer navigation', async () => {
  const state = harness(); const { loading, request } = await state.start()
  state.navigate('beforeunload')
  request.reject(new Error('navigation pending'))
  assert.equal(await loading, false)
  state.advanceClock(0)
  assert.equal(state.saved(), 'S')
  state.advanceClock(5_000)
  state.navigate('pagehide', true)
  state.advanceClock(5_000) // First leaving's expiry; it must have been canceled.
  assert.equal(state.saved(), 'S', 'old timer cannot consume the newer leaving window')
  state.advanceClock(4_999); assert.equal(state.saved(), 'S')
  state.advanceClock(1); assert.equal(state.saved(), null)
  assert.deepEqual(state.writes.map(({ value }) => value), [state.record('S'), state.record(null)])
})

test('D067 edge: an older leaving expiry cannot expose a failure during a newer leaving', async () => {
  const state = harness(); const { loading, request } = await state.start()
  state.navigate('beforeunload'); state.advanceClock(5_000)
  state.navigate('pagehide', true); state.advanceClock(5_000)
  request.reject(new Error('newer navigation abort')); assert.equal(await loading, false)
  state.advanceClock(0)
  assert.equal(state.saved(), 'S', 'old expiry must not end the newer leaving before its history abort')
  state.advanceClock(5_000)
  assert.equal(state.saved(), null, 'newer expiry eventually consumes its own pending failure')
})

for (const recovery of ['pageshow', 'expiry'] as const) {
  test(`D067 edge: ${recovery} cannot clear a newer successful same-session generation`, async () => {
    const state = harness(); const { loading, request } = await state.start()
    state.navigate('beforeunload'); request.reject(new Error('navigation pending'))
    assert.equal(await loading, false)
    state.advanceClock(0); assert.equal(state.saved(), 'S')
    const retry = await state.open('S')
    retry.request.resolve({ ok: true, json: async () => ({ turns: [{ kind: 'user', text: 'new S history' }], seq: 2 }) })
    assert.equal(await retry.loading, true)
    const writes = [...state.writes]
    if (recovery === 'pageshow') state.navigate('pageshow', true)
    else state.advanceClock(10_000)
    assert.equal(state.saved(), 'S')
    assert.deepEqual({ ...state.state() }, { current: 'S', unavailable: null })
    assert.deepEqual(state.writes, writes, 'pending old generation cannot write over new success')
    assert.deepEqual(state.rows.map(({ textContent }) => textContent), ['new S history'])
  })
}

test('D067 edge: expired navigation allows a later ordinary retry failure to persist', async () => {
  const state = harness(); const { loading, request } = await state.start()
  state.navigate('beforeunload'); request.reject(new Error('navigation pending'))
  assert.equal(await loading, false); state.advanceClock(0)
  assert.equal(state.saved(), 'S')
  state.advanceClock(10_000); assert.equal(state.saved(), null)
  const retry = await state.open('S')
  retry.request.reject(new Error('offline retry')); assert.equal(await retry.loading, false)
  assert.equal(state.saved(), 'S', 'retry still defers ordinary clear to the next task')
  state.advanceClock(0); assert.equal(state.saved(), null)
  assert.deepEqual(state.writes.map(({ value }) => value), [state.record('S'), state.record(null), state.record('S'), state.record(null)])
  assert.deepEqual(state.rows.map(({ textContent }) => textContent), ['Failed to load history: offline retry'])
})

test('D067 edge: queued ordinary failure timer cannot clear a newer successful session', async () => {
  const state = harness(); const { loading, request } = await state.start()
  request.reject(new Error('ordinary offline')); assert.equal(await loading, false)
  assert.equal(state.saved(), 'S', 'ordinary clear is deferred, not synchronous')
  const newer = await state.open('T')
  newer.request.resolve({ ok: true, json: async () => ({ turns: [{ kind: 'user', text: 'T history' }], seq: 2 }) })
  assert.equal(await newer.loading, true)
  const writes = [...state.writes]
  state.advanceClock(0)
  assert.equal(state.saved(), 'T')
  assert.deepEqual(state.writes, writes, 'stale queued callback checks id and generation')
  assert.deepEqual({ ...state.state() }, { current: 'T', unavailable: null })
})

for (const recovery of ['pageshow', 'expiry'] as const) {
  test(`D067 edge: ${recovery} cannot clear a different newer unavailable session`, async () => {
    const state = harness(); const { loading, request } = await state.start()
    state.navigate('pagehide', true); request.reject(new Error('old navigation failure'))
    assert.equal(await loading, false); state.advanceClock(0)
    assert.equal(state.saved(), 'S')
    const newer = await state.open('T')
    newer.request.reject(new Error('T unavailable')); assert.equal(await newer.loading, false)
    // T's own deferred clear has not run. Resume of pending S must not clear T.
    if (recovery === 'pageshow') state.navigate('pageshow', true)
    else state.advanceClock(10_000) // T callback replaces pending S before the expiry runs.
    if (recovery === 'pageshow') assert.equal(state.saved(), 'T')
    state.advanceClock(0)
    assert.equal(state.saved(), null, 'only the still-shown T failure may persist its clear')
    assert.deepEqual({ ...state.state() }, { current: null, unavailable: 'T' })
    assert.deepEqual(state.writes.map(({ value }) => value), [state.record('S'), state.record('T'), state.record(null)])
  })
}

test('D067 task control: cancelled beforeunload does not suppress a later ordinary read failure', async () => {
  const state = harness(); const { loading, request } = await state.start()
  state.navigate('beforeunload')
  await microtasks()
  state.navigate('pageshow') // Browser stayed on the page; run any actual recovery handler.
  state.advanceClock(10_000) // Also permit the actual fallback recovery timer to expire in a later task.
  request.reject(new Error('offline after cancelled navigation'))
  assert.equal(await loading, false)
  state.advanceClock(0) // Ordinary failure still persists the empty selection in its next task.
  assert.equal(state.saved(), null)
  assert.deepEqual(state.rows.map(({ textContent }) => textContent), ['Failed to load history: offline after cancelled navigation'])
})
