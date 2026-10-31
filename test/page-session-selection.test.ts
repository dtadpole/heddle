import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
const start = page.indexOf('async function showSession(id)')
const source = page.slice(start, page.indexOf('\n}', start) + 2)
const selectStart = page.indexOf('async function selectSession(node)')
const selectSource = page.slice(selectStart, page.indexOf('\n}', selectStart) + 2)
const adoptStart = page.indexOf('function adoptViewSelection(id, body, selectionAt)')
const adoptSource = page.slice(adoptStart, page.indexOf('\n}', adoptStart) + 2)
assert.ok(start >= 0 && selectStart >= 0 && adoptStart >= 0, 'the page defines both session entry points and the model publication guard')
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness() {
  const a = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
  const nextA = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
  let aRequests = 0
  const started = deferred<void>()
  const title = { textContent: '' }
  const branch = { textContent: '' }
  const rows: string[] = []
  const context = {
    schedState: { drawer: null },
    closeSchedulesPage() {}, closeScheduleDrawer() {}, resetScheduleList() {},
    updateStatusBar() {}, paintEmptyState() {}, applySessionAccess() {},
    placeholderDrawn: () => false, scheduleTreeRefresh() {}, chooseWorkspace() {}, jobsSessionChanged() {},
    slashReady: Promise.resolve(null),
    syncSelectionToSession() {}, paintScheduleHeader() {}, followChatTail() {},
    renderScheduleCards() {}, renderScheduleDrawer() {}, refreshScheduleList() {}, refreshScheduleCatalog() {},
    refreshSessions: async () => {}, refreshGoal: async () => {}, refreshTodo: async () => {}, showLedger: async () => {},
    log: { replaceChildren: () => rows.splice(0), append: (note: { textContent: string }) => rows.push(note.textContent) },
    add: (_kind: string, text: string) => rows.push(text),
    document: { getElementById: (id: string) => id === 'session-title' ? title : branch, createElement: () => ({ className: '', textContent: '' }) },
    fetch: async (url: string) => {
      if (url.endsWith('/A')) { started.resolve(); return ++aRequests === 1 ? a.promise : nextA.promise }
      return { ok: true, json: async () => ({ title: 'B title', cwd: '/B', endpoint: 'B model', turns: [{ kind: 'user', text: 'B message' }] }) }
    },
  }
  const api = runInNewContext(`
    let current = null, composerKey = '', view = 'chat', sessionViewGeneration = 0;
    let sessionStats, liveRounds, liveUsage, liveTurns, liveGenerationMs, liveDecodeTokens, liveRoundStartedAt;
    let seat = '', activeFolder = null, selected = null;
    let selectionSeq = 0, chosenEndpoint = null, chosenModel = null, chosenEffort = null;
    const latestSelection = new Map(), serverSeats = new Map(), heldSeats = new Map(), recordedSelections = new Set();
    function setNote() {}
    function renderRing() {}
    function chooseSelected(path) { selected = path }
    async function showView(next) { view = next }
    function adoptSession(id) { composerKey = id }
    // Only rendering is stubbed: the page's actual model publication guard runs below.
    function applySessionModel(endpoint, model, effort) {
      seat = chosenEndpoint = endpoint; chosenModel = model; chosenEffort = effort;
    }
    ${adoptSource}
    ${source}
    ${selectSource}
    ({ showSession, selectSession,
      chooseModel(endpoint) { latestSelection.set(current, ++selectionSeq); applySessionModel(endpoint, null, null) },
      state: () => ({ current, composerKey, seat, selected }) })
  `, context) as { chooseModel(endpoint: string): void; showSession(id: string): Promise<void>; selectSession(node: {path:string;cwd:string;session:{id:string}}):Promise<void>; state(): { current: string; composerKey: string; seat: string; selected:string } }
  return { ...api, a, nextA, started, title, rows }
}

for (const outcome of ['success', 'refused', 'failed'] as const) {
  test(`stale session A ${outcome} cannot replace selected B`, { timeout: 5000 }, async () => {
    const h = harness()
    const old = h.showSession('A')
    await h.started.promise
    await h.showSession('B')
    if (outcome === 'failed') h.a.reject(new Error('A unavailable'))
    else h.a.resolve({ ok: outcome === 'success', json: async () => ({ title: 'A title', endpoint: 'A model', turns: [{ kind: 'user', text: 'A message' }] }) })
    await old
    assert.equal(h.state().current, 'B')
    assert.equal(h.state().composerKey, 'B')
    assert.equal(h.state().seat, 'B model')
    assert.equal(h.title.textContent, 'B title')
    assert.deepEqual(h.rows, ['B message'])
  })
}


test('a delayed tree-row open does not move the selected row away from B', { timeout: 5000 }, async () => {
  const h = harness()
  const old = h.selectSession({ path: 'row-A', cwd: '/A', session: { id: 'A' } })
  await h.started.promise
  await h.selectSession({ path: 'row-B', cwd: '/B', session: { id: 'B' } })
  h.a.resolve({ ok: true, json: async () => ({ title: 'A', turns: [] }) })
  await old
  assert.equal(h.state().current, 'B')
  assert.equal(h.state().selected, 'row-B')
})

test('a newer model choice survives its current session view while the transcript publishes', { timeout: 5000 }, async () => {
  const h = harness()
  const opening = h.showSession('A')
  await h.started.promise
  h.chooseModel('new choice')
  h.a.resolve({ ok: true, json: async () => ({ title: 'A title', endpoint: 'old choice', turns: [{ kind: 'user', text: 'A message' }] }) })
  await opening
  assert.equal(h.state().seat, 'new choice')
  assert.equal(h.title.textContent, 'A title')
  assert.deepEqual(h.rows, ['A message'])
})

test('an earlier view of the same session cannot replace its newer generation', { timeout: 5000 }, async () => {
  const h = harness()
  const old = h.showSession('A')
  await h.started.promise
  await h.showSession('B')
  const newer = h.showSession('A')
  h.nextA.resolve({ ok: true, json: async () => ({ title: 'A current', endpoint: 'A current model', turns: [{ kind: 'user', text: 'A current message' }] }) })
  await newer
  h.a.resolve({ ok: true, json: async () => ({ title: 'A stale', endpoint: 'A stale model', turns: [{ kind: 'user', text: 'A stale message' }] }) })
  await old
  assert.equal(h.state().current, 'A')
  assert.equal(h.state().seat, 'A current model')
  assert.equal(h.title.textContent, 'A current')
  assert.deepEqual(h.rows, ['A current message'])
})
