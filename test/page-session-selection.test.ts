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
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness() {
  const a = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
  const started = deferred<void>()
  const title = { textContent: '' }
  const branch = { textContent: '' }
  const rows: string[] = []
  const context = {
    schedState: { drawer: null },
    closeSchedulesPage() {}, closeScheduleDrawer() {}, resetScheduleList() {},
    updateStatusBar() {}, paintEmptyState() {}, applySessionAccess() {},
    syncSelectionToSession() {}, paintScheduleHeader() {}, followChatTail() {},
    renderScheduleCards() {}, renderScheduleDrawer() {}, refreshScheduleList() {}, refreshScheduleCatalog() {},
    refreshSessions: async () => {}, refreshGoal: async () => {}, refreshTodo: async () => {}, showLedger: async () => {},
    log: { replaceChildren: () => rows.splice(0), append: (note: { textContent: string }) => rows.push(note.textContent) },
    add: (_kind: string, text: string) => rows.push(text),
    document: { getElementById: (id: string) => id === 'session-title' ? title : branch, createElement: () => ({ className: '', textContent: '' }) },
    fetch: async (url: string) => {
      if (url.endsWith('/A')) { started.resolve(); return a.promise }
      return { ok: true, json: async () => ({ title: 'B title', cwd: '/B', endpoint: 'B model', turns: [{ kind: 'user', text: 'B message' }] }) }
    },
  }
  const api = runInNewContext(`
    let current = null, composerKey = '', view = 'chat', sessionViewGeneration = 0;
    let sessionStats, liveRounds, liveUsage, liveTurns, liveGenerationMs, liveDecodeTokens, liveRoundStartedAt;
    let seat = '', activeFolder = null, selected = null;
    function setNote() {}
    function renderRing() {}
    function chooseSelected(path) { selected = path }
    async function showView(next) { view = next }
    function adoptSession(id) { composerKey = id }
    function applySessionModel(endpoint) { seat = endpoint }
    ${source}
    ${selectSource}
    ({ showSession, selectSession, state: () => ({ current, composerKey, seat, selected }) })
  `, context) as { showSession(id: string): Promise<void>; selectSession(node: {path:string;cwd:string;session:{id:string}}):Promise<void>; state(): { current: string; composerKey: string; seat: string; selected:string } }
  return { ...api, a, started, title, rows }
}

for (const outcome of ['success', 'refused', 'failed'] as const) {
  test(`stale session A ${outcome} cannot replace selected B`, async () => {
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


test('a delayed tree-row open does not move the selected row away from B', async () => {
  const h = harness()
  const old = h.selectSession({ path: 'row-A', cwd: '/A', session: { id: 'A' } })
  await h.started.promise
  await h.selectSession({ path: 'row-B', cwd: '/B', session: { id: 'B' } })
  h.a.resolve({ ok: true, json: async () => ({ title: 'A', turns: [] }) })
  await old
  assert.equal(h.state().current, 'B')
  assert.equal(h.state().selected, 'row-B')
})
