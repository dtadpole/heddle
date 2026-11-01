import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The stats dock keeps the running turn's steps when the page opens the session that turn runs in.
 *
 * The dock's steps are the durable fold plus the running turn's rounds (`updateStatusBar`: `stats.steps + liveRounds`).
 * The fold counts a turn's rounds only once it ends (`turn/completed.rounds`, SESSION_STATS.md cycle 2), and the stream
 * counts the running turn's (`model/request`, one per round). `showSession` zeroed `liveRounds` and
 * `liveRoundStartedAt` on every open. So opening a session whose turn was running dropped the dock to `0 steps` until
 * the next round began, and lost the open round's rate. The case the review named is developer-ten's N1: a message sent
 * from the blank composer during the boot creates session N while the boot shows session X, and the turn's `session`
 * frame then opens N (`showSession(payload.session)` in `runTurn`), with N's first round already under way.
 *
 * The page now counts each running turn's rounds per session, for every session the stream names, and an open takes the
 * opened session's count while its turn runs. The test runs the page's own `model/request` branch (lifted out of the
 * stream listener) and its own `showSession`, with the reads answered by the test.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

function source(name: string): string {
  const start = page.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start + 1, page.indexOf('\n}\n', start) + 2)
}

/** A function this fix adds, when the page has it: the red run predates it, and its branch below counts inline. */
function optional(name: string): string {
  return page.search(new RegExp(`\\n(?:async )?function ${name}\\(`)) >= 0 ? source(name) : ''
}

/** The stream listener's `model/request` branch, as the page has it, to be run as a function of the frame. */
function modelRequestBranch(): string {
  const from = page.indexOf("  if (event.type === 'model/request') {")
  assert.ok(from >= 0, 'the stream listener has a model/request branch')
  return page.slice(from, page.indexOf('\n  }\n', from) + 4)
}

interface Dock {
  /** One `model/request` frame of `session`'s turn on the event stream. */
  round(session: string): void
  /** Open `session` the way the page does, answering its reads; resolves with `showSession`'s answer. */
  show(session: string): Promise<boolean>
  /** The page's own state: the steps the dock prints and the open round's start. */
  read(): { current: string | null; steps: number; liveRounds: number; roundStarted: boolean }
  setCurrent(id: string): void
  endTurn(id: string): void
}

function harness(options: { onRefresh?: (running: Set<string>, rounds: Map<string, unknown>) => void } = {}): Dock {
  return runInNewContext(
    `
    let current = null, composerKey = '__none__', unavailableSession = null, selectedPath = null, view = 'chat';
    const liveTurns = new Map();
    let sessionStats = null, liveRounds = 0, liveUsage, liveGenerationMs = 0, liveDecodeTokens = 0, liveRoundStartedAt = null;
    let showGeneration = 0;
    let sessionLoading = null;
    const runningSessions = new Set();
    const runningSince = new Map();
    const turnRounds = new Map();
    const turnsEnded = new Set();
    const schedState = { drawer: null };
    const unreadSessions = new Set();
    const sessionMetas = new Map();
    const slashReady = Promise.resolve(null);
    const log = { children: [], replaceChildren() { this.children = [] }, append(row) { this.children.push(row) } };
    function add(kind, text) { log.append({ kind, text }) }
    const document = { getElementById: () => null, createElement: () => ({ dataset: {}, className: '', textContent: '', setAttribute() {} }) };
    let clock = 1000;
    const performance = { now: () => (clock += 10) };
    // The session's history answer: N's first prompt is in the log, its running turn's rounds are not in the fold yet.
    const fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ id: decodeURIComponent(url.split('/').pop()), turns: [{ kind: 'user', text: 'hello' }], stats: { turns: 1, steps: 0 } }) });
    /** The sessions read: a test may have it end a turn whose turn/completed the page missed, as the real read does. */
    async function refreshSessions() { ON_REFRESH(runningSessions, turnRounds) }
    function markRunning(id) { runningSessions.add(id) }
    function noteCompletion() {}
    function paintRunningMarks() {}
    function renderComposerState() {}
    function refreshRunningStatus() {}
    function closeSchedulesPage() {}
    function closeScheduleDrawer() {}
    function resetScheduleList() {}
    function updateStatusBar() {}
    function placeholderDrawn() { return false }
    function scheduleTreeRefresh() {}
    function chooseWorkspace() {}
    function paintEmptyState() {}
    function rememberCurrent() {}
    function rememberSessionWorkspace() {}
    function paintComposerAccess() {}
    function jobsSessionChanged() {}
    function applySessionAccess() {}
    function adoptSession(id) { composerKey = id }
    function syncSelectionToSession() {}
    async function openCurrentGroup() {}
    async function showLedger() {}
    function paintSessionHeading() {}
    function historyFailureText() { return 'Failed to load history' }
    async function renderTree() {}
    function markSelection() {}
    function paintScheduleHeader() {}
    function applySessionModel() {}
    /** 4b2a0552 (#46): the seat's choice count, and the view's selection an open publishes. */
    let selectionSeq = 0
    function adoptViewSelection() {}
    async function refreshGoal() {}
    async function refreshTodo() {}
    function renderScheduleCards() {}
    function renderScheduleDrawer() {}
    async function refreshScheduleList() {}
    async function refreshScheduleCatalog() {}
    function rememberChatScroll() {}
    function restoreChatScroll() {}
    function drawKeptEvents() {}
    ${optional('noteRound')}
    ${optional('liveRoundsOf')}
    function onModelRequest(payload, event) {
    ${modelRequestBranch()}
    }
    ${source('showSession')}
    ;({
      round: (session) => onModelRequest({ session }, { type: 'model/request', at: '2026-10-31T19:00:00.000Z' }),
      show: (session) => showSession(session),
      read: () => ({ current, steps: (sessionStats?.steps ?? 0) + liveRounds, liveRounds, roundStarted: liveRoundStartedAt !== null }),
      setCurrent: (id) => { current = id; composerKey = id },
      // What the page does at a turn's end (turn/completed, turn/failed, a read that finds it no longer running).
      endTurn: (id) => { runningSessions.delete(id); turnRounds.delete(id) },
    })
    `,
    { ON_REFRESH: options.onRefresh ?? (() => {}), JSON, Promise, Map, Set, Array, Object, String, Number, Date, Math, Error },
  ) as Dock
}

const X = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const N = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const M = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'

test('opening the session whose turn is running, as N1 does mid-turn, keeps the rounds already counted: the dock does not drop to 0 steps', async () => {
  const dock = harness()
  dock.setCurrent(X)
  /** N's first round starts while the boot shows X: the page sees the frame, and X's dock does not count it. */
  dock.round(N)
  assert.equal(dock.read().liveRounds, 0, "another session's round is not counted in the open session's dock")
  /** The turn's session frame opens N (runTurn's showSession(payload.session)). */
  assert.equal(await dock.show(N), true)
  const opened = dock.read()
  assert.equal(opened.current, N)
  assert.equal(opened.steps, 1, `the dock prints 1 steps for the round under way, not 0\nsaw: ${JSON.stringify(opened)}`)
  assert.equal(opened.roundStarted, true, 'and the open round keeps its start, so its rate is measured when it ends')
  dock.round(N)
  assert.equal(dock.read().steps, 2, 'the next round counts on from there')
})

test('opening the open session again while its turn runs (a reset, a click on its row) keeps its count too', async () => {
  const dock = harness()
  dock.setCurrent(N)
  dock.round(N)
  dock.round(N)
  assert.equal(dock.read().steps, 2)
  await dock.show(N)
  assert.equal(dock.read().steps, 2, 'the same two rounds')
})

test('a session whose turn is not running opens with no live rounds, and a turn that ended leaves none behind', async () => {
  const dock = harness()
  dock.setCurrent(X)
  dock.round(N)
  dock.round(M)
  dock.endTurn(M)
  await dock.show(M)
  assert.deepEqual({ ...dock.read() }, { current: M, steps: 0, liveRounds: 0, roundStarted: false }, "an ended turn's rounds are the fold's, not counted twice")
  await dock.show(X)
  assert.equal(dock.read().steps, 0, 'a session that never ran here has none')
  await dock.show(N)
  assert.equal(dock.read().steps, 1, 'while N, still running, has its own')
})

test('every place the page ends a running turn forgets its rounds', () => {
  const lines = page.split('\n')
  const ends = lines.flatMap((line, index) => (/runningSessions\.delete\(/.test(line) ? [index] : []))
  assert.ok(ends.length > 0)
  for (const index of ends) {
    assert.ok(lines.slice(index, index + 4).some((line) => /turnRounds\.delete\(/.test(line)), `a turnRounds.delete beside the runningSessions.delete on line ${index + 1}`)
  }
})

test('an open whose sessions read ends the turn the page thought was running counts no live rounds for it (N2)', async () => {
  /**
   * developer-ten's N2 on a5b90f28: showSession took the opened session's rounds before its sessions read, and that read
   * ends a turn whose turn/completed the page missed (refreshSessions drops the running mark and forgets the rounds).
   * The dock then added rounds the fold already counts.
   */
  const dock = harness({
    onRefresh: (running, rounds) => {
      running.delete(N)
      rounds.delete(N)
    },
  })
  dock.setCurrent(X)
  dock.round(N)
  await dock.show(N)
  assert.deepEqual({ ...dock.read() }, { current: N, steps: 0, liveRounds: 0, roundStarted: false }, 'the read said the turn was over: none live')
})

test('a re-read of the open session\'s statistics keeps its running turn\'s rounds (N1)', async () => {
  /**
   * developer-ten's N1 on a5b90f28: refreshSessionStats zeroed liveRounds for the open session. It runs at the end of
   * this page's turn in another session, while the open one may still be running; its fold has no running rounds.
   */
  const reread = (running: boolean) =>
    runInNewContext(
      `
      const liveTurns = new Map()
      let current = M, sessionStats = null, liveRounds = 3, liveUsage, liveGenerationMs = 0, liveDecodeTokens = 0, liveRoundStartedAt = 5
      const runningSessions = new Set(RUNNING ? [M] : [])
      const turnRounds = new Map(RUNNING ? [[M, { rounds: 3, startedAt: 5 }]] : [])
      function updateStatusBar() {}
      const fetch = async () => ({ ok: true, json: async () => ({ stats: { turns: 2, steps: 4 } }) })
      ${optional('liveRoundsOf')}
      ${source('refreshSessionStats')}
      refreshSessionStats().then(() => JSON.stringify({ steps: sessionStats.steps + liveRounds, roundStarted: liveRoundStartedAt !== null }))
      `,
      { M: 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd', RUNNING: running, JSON, Promise, Map, Set, Array, Object, String },
    ) as Promise<string>
  assert.deepEqual(JSON.parse(await reread(true)), { steps: 7, roundStarted: true }, 'the fold\'s four steps and the three of the turn still running')
  assert.deepEqual(JSON.parse(await reread(false)), { steps: 4, roundStarted: false }, 'with no turn running, the fold alone')
})
