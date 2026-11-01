import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/** Tests only. No browser, server, build, source replacement, or invented page navigation flag. */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `actual ${name} exists`)
  const end = page.indexOf('\n}', start)
  assert.ok(end >= start, `actual ${name} is a top-level function`)
  return page.slice(start, end + 2)
}
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
const registrationSource = registrations.map(({ text }) => text).join('\n')
// Only real declarations referenced by the lifted handlers/showSession are included. On Q2 this is empty.
const navigationState = Array.from(page.matchAll(/^(?:let|const)[ \t]+(\w+)[ \t]*=[ \t]*(?:false|true|null|0)[ \t]*;?[ \t]*$/gm))
  .filter((match) => new RegExp(`\\b${match[1]}\\b`).test(registrationSource))
  .map((match) => match[0]).join('\n')

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
    ${page.slice(treeStart, treeEnd)}
    ${navigationState}
    ${source('historyFailureText')}
    ${source('rememberCurrent')}
    ${source('showSession')}
    ${registrationSource}
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
      if (type === 'pagehide') Object.defineProperty(event, 'persisted', { value: persisted })
      window.dispatchEvent(event) // Runs only handlers actually registered by this source; Q2 has none.
    },
    advanceClock(milliseconds: number) {
      phase = 'next-task'
      now += milliseconds
      const ready = [...tasks.entries()].filter(([, task]) => task.due <= now)
      for (const [id, task] of ready) { tasks.delete(id); task.callback() }
    },
    teardown() { tornDown = true; phase = 'teardown' },
    isTornDown: () => tornDown,
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

test('D067 task control: cancelled beforeunload does not suppress a later ordinary read failure', async () => {
  const state = harness(); const { loading, request } = await state.start()
  state.navigate('beforeunload')
  await microtasks()
  state.navigate('pageshow') // Browser stayed on the page; run any actual recovery handler.
  state.advanceClock(10_000) // Also permit the actual fallback recovery timer to expire in a later task.
  request.reject(new Error('offline after cancelled navigation'))
  assert.equal(await loading, false)
  assert.equal(state.saved(), null)
  assert.deepEqual(state.rows.map(({ textContent }) => textContent), ['Failed to load history: offline after cancelled navigation'])
})
