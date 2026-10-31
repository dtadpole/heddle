import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * When two opens of a conversation overlap, it is drawn once. The test runs the page's own `showSession` twice before
 * either read has landed, and holds the sessions list and each history read until it releases them.
 *
 * Measured on stack-2 in the goal command's browser check (`_verifiers_/80-web-ui/check-goal-command.mjs`, "after a
 * reload"), on TS and Rust builds alike, in about one run in several. After a reload the transcript held its four
 * Command input bubbles and four result cards, then four more `.hc-command` rows with no state, title or text.
 *
 * A reload runs two opens of the saved session about a millisecond apart: the boot's `restoreSelection` reopens it
 * (#17), and the check also opens it by name. Each open emptied `#log`, awaited its history, and appended every turn
 * once its read landed. So when the second open emptied the log before the first had drawn, both drew. A command turn
 * is drawn as an empty placeholder that the menu module fills, and the menu fills the first placeholder that carries a
 * run's id, so the second set stayed empty.
 *
 * The same overlap happens on a double click on a row, or when the stream's `reset` reopens the session while a
 * click's open is in flight. With two different sessions it is worse: the first session's turns, landing late, were
 * appended under the second session's header.
 *
 * Now only the latest open draws. An older open that a later one has replaced stops at its next step and resolves false.
 */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  return page.slice(start, end + 2)
}

interface Opened {
  show(id: string): Promise<boolean | undefined>
  rows(): string[]
  current(): string | null
}

interface Page extends Opened {
  /** Answer the oldest request still waiting on `what` (`list`, or a history URL), or the newest with `last`. */
  release(what: string, answer?: unknown, last?: boolean): void
  waiting(what: string): number
}

function harness(options: { holdGoal?: boolean } = {}): Page {
  const pending: { what: string; resolve: (answer: unknown) => void }[] = []
  const opened = runInNewContext(
    `
    let current = null, unavailableSession = null, selectedPath = null, view = 'chat';
    let sessionStats = null, liveRounds = 0, liveUsage, liveTurns = 0, liveGenerationMs = 0, liveDecodeTokens = 0, liveRoundStartedAt = null;
    let showGeneration = 0;
    const schedState = { drawer: null };
    const unreadSessions = new Set();
    const sessionMetas = new Map();
    const slashReady = Promise.resolve(null);
    // #log: an open empties it, and the turns are appended to it the way the page's own add() appends one.
    const log = {
      children: [],
      replaceChildren() { this.children = [] },
      append(row) { this.children.push(row) },
    };
    function add(kind, text) { log.append({ kind, text }) }
    const document = {
      getElementById: () => null,
      createElement: () => ({ dataset: {}, className: '', textContent: '', setAttribute() {} }),
    };
    // The page's two reads, held until the test answers them.
    async function refreshSessions() { await hold('list') }
    const fetch = (url) => hold(url);
    function closeSchedulesPage() {}
    function closeScheduleDrawer() {}
    function resetScheduleList() {}
    function updateStatusBar() {}
    function placeholderDrawn() { return false }
    function scheduleTreeRefresh() {}
    function renderComposerState() {}
    function chooseWorkspace() {}
    function paintEmptyState() {}
    function rememberCurrent() {}
    function paintComposerAccess() {}
    function paintRunningMarks() {}
    function jobsSessionChanged() {}
    function applySessionAccess() {}
    function adoptSession() {}
    function syncSelectionToSession() {}
    async function showLedger() {}
    function paintSessionHeading() {}
    function historyFailureText() { return 'Failed to load history' }
    async function renderTree() {}
    function markSelection() {}
    function paintScheduleHeader() {}
    function applySessionModel() {}
    function followChatTail() {}
    async function refreshGoal() { if (HOLD_GOAL) await hold('goal') }
    async function refreshTodo() {}
    function renderScheduleCards() {}
    function renderScheduleDrawer() {}
    async function refreshScheduleList() {}
    async function refreshScheduleCatalog() {}
    // The conversation chain's pieces of an open (#76, C74): live events kept aside during the history read, tagged with
    // the same showGeneration, and the reader's scroll place. The kept events are the page's own; drawing one is a stub.
    let sessionLoading = null;
    function rememberChatScroll() {}
    function restoreChatScroll() {}
    function drawSessionEvent() {}
    ${source('keptToDraw')}
    ${source('drawKeptEvents')}
    ${source('showSession')}
    ({
      show: showSession,
      rows: () => log.children.map((row) => (row.dataset?.kind === 'command' ? 'command:' + row.dataset.commandId : row.kind + ':' + row.text)),
      current: () => current,
    })
  `,
    { hold: (what: string) => new Promise((resolve) => pending.push({ what, resolve })), HOLD_GOAL: options.holdGoal === true },
  ) as Opened
  return {
    show: (id) => opened.show(id),
    rows: () => Array.from(opened.rows()),
    current: () => opened.current(),
    release(what, answer, last = false) {
      const matching = pending.filter((entry) => entry.what === what)
      const entry = last ? matching.at(-1) : matching[0]
      assert.ok(entry !== undefined, `a ${what} read is in flight`)
      pending.splice(pending.indexOf(entry), 1)
      entry.resolve(answer)
    },
    waiting: (what) => pending.filter((entry) => entry.what === what).length,
  }
}

/** Let every step the page can take without a read run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** A history answer as `GET /api/sessions/:id` gives it: a message, then two command runs, as the goal check has. */
function history(id: string): unknown {
  const turns = [
    { kind: 'user', text: `hello from ${id}` },
    { kind: 'command', commandId: `${id}-run-1`, name: 'goal', args: 'ship the release', state: 'done', text: 'Goal created' },
    { kind: 'command', commandId: `${id}-run-2`, name: 'goal', args: 'pause', state: 'done', text: 'Goal paused' },
  ]
  return { ok: true, status: 200, json: async () => ({ id, turns }) }
}

function drawn(id: string): string[] {
  return [`user:hello from ${id}`, `command:${id}-run-1`, `command:${id}-run-2`]
}

const S = 'session-11111111-1111-4111-8111-111111111111'
const T = 'session-22222222-2222-4222-8222-222222222222'
const read = (id: string) => '/api/sessions/' + encodeURIComponent(id)

test('two opens of one session that overlap draw its turns once (the reload in check-goal-command)', { timeout: 5000 }, async () => {
  const at = harness()
  // The first open (the boot's restoreSelection) empties the log and is waiting on the history read.
  const first = at.show(S)
  await settle()
  at.release('list')
  await settle()
  assert.equal(at.waiting(read(S)), 1, "the first open's history read is in flight")
  // The second (the check's own showSession) starts before that read lands.
  const second = at.show(S)
  await settle()
  if (at.waiting('list') > 0) at.release('list')
  await settle()
  at.release(read(S), history(S))
  await settle()
  if (at.waiting(read(S)) > 0) at.release(read(S), history(S))
  const answers = await Promise.all([first, second])
  assert.deepEqual(at.rows(), drawn(S), 'each turn is in the transcript once: one placeholder per command run, not two')
  assert.equal(answers[1], true, 'the latest open resolves true: it drew the history')
  assert.equal(at.current(), S)
})

test("an older open's history that lands after a newer open's is not appended under the other session", { timeout: 5000 }, async () => {
  const at = harness()
  const first = at.show(S)
  await settle()
  at.release('list')
  await settle()
  // A click on another session while the first read is in flight.
  const second = at.show(T)
  await settle()
  if (at.waiting('list') > 0) at.release('list')
  await settle()
  at.release(read(T), history(T))
  await settle()
  at.release(read(S), history(S))
  const answers = await Promise.all([first, second])
  assert.deepEqual(at.rows(), drawn(T), "only the open session's turns are shown")
  assert.deepEqual(answers, [false, true], 'the replaced open resolves false, the one that drew resolves true')
  assert.equal(at.current(), T)
})

test('a replaced open whose list read lands last does not empty what the newer open drew', { timeout: 5000 }, async () => {
  const at = harness()
  const first = at.show(S)
  await settle()
  const second = at.show(S)
  await settle()
  assert.equal(at.waiting('list'), 2, 'both opens are reading the sessions list')
  // The newer open's list read lands first, and it draws the whole history.
  at.release('list', undefined, true)
  await settle()
  at.release(read(S), history(S))
  await settle()
  assert.deepEqual(at.rows(), drawn(S))
  // Then the older open's list read lands. It must stop before it touches the log, not empty it and leave it empty.
  at.release('list')
  await settle()
  if (at.waiting(read(S)) > 0) at.release(read(S), history(S))
  await Promise.all([first, second])
  assert.deepEqual(at.rows(), drawn(S), 'the transcript is still drawn, once')
})

/**
 * The boot's half: `restoreSelection` with its two list reads held. A session opened while they were read stays shown,
 * as it did when the boot was `refreshSessions` (it opened the newest only `if (current === null)`) before #17. After #17,
 * the boot reopened the saved session over it, and that was the second open of every reload in check-goal-command.
 */
interface Restoring {
  restore(): Promise<void>
  /** What an open does first, synchronously: the page's `current` is that session. */
  open(id: string): void
  opened: string[]
  started: string[]
}

function booting(saved: string | null): Restoring & Pick<Page, 'release' | 'waiting'> {
  const pending: { what: string; resolve: (answer: unknown) => void }[] = []
  const restoring = runInNewContext(
    `
    let current = null;
    const opened = [], started = [];
    const WorkspaceTree = {
      SELECTION_KEY: 'heddle.sessions.current',
      savedSelection: (raw) => raw,
      restoreChoice: (saved, workspaces, sessions) =>
        saved !== null && sessions.some((meta) => meta.id === saved) ? { kind: 'saved', id: saved } : { kind: 'start', path: '/work' },
    };
    const localStorage = { getItem: () => saved };
    async function showSession(id) { current = id; opened.push(id); return true }
    async function startSessionAt(node) { started.push(node.path); current = 'session-fresh' }
    async function refreshSessions() {}
    function rememberCurrent() {}
    const fetch = (path) => hold(path);
    ${source('restoreSelection')}
    ({ restore: restoreSelection, open: (id) => { current = id }, opened, started })
  `,
    { hold: (what: string) => new Promise((resolve) => pending.push({ what, resolve })), saved },
  ) as Restoring
  return {
    restore: () => restoring.restore(),
    open: (id) => restoring.open(id),
    get opened() {
      return Array.from(restoring.opened)
    },
    get started() {
      return Array.from(restoring.started)
    },
    release(what, answer) {
      const index = pending.findIndex((entry) => entry.what === what)
      assert.ok(index >= 0, `a ${what} read is in flight`)
      const [entry] = pending.splice(index, 1)
      assert.ok(entry !== undefined)
      entry.resolve(answer)
    },
    waiting: (what) => pending.filter((entry) => entry.what === what).length,
  }
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

async function answerLists(at: Pick<Page, 'release'>, sessions: unknown[]): Promise<void> {
  at.release('/api/workspaces', ok({ workspaces: [{ id: 'w-1', path: '/work' }] }))
  at.release('/api/sessions', ok(sessions))
  await settle()
}

test('a reload reopens the saved session when nothing else opened one meanwhile', { timeout: 5000 }, async () => {
  const at = booting(S)
  const boot = at.restore()
  await settle()
  await answerLists(at, [{ id: S }])
  await boot
  assert.deepEqual(at.opened, [S], 'the saved session is reopened, once')
  assert.deepEqual(at.started, [])
})

test('a session opened while the boot reads its lists is not opened a second time by the boot (the reload in check-goal-command)', { timeout: 5000 }, async () => {
  const at = booting(S)
  const boot = at.restore()
  await settle()
  // The check opens the session by name while the boot is reading.
  at.open(S)
  await answerLists(at, [{ id: S }])
  await boot
  assert.deepEqual(at.opened, [], 'the boot does not run a second open of the session that is already opening')
})

test('a first visit does not start a fresh session over one that was opened while the lists were read', { timeout: 5000 }, async () => {
  const at = booting(null)
  const boot = at.restore()
  await settle()
  at.open(T)
  await answerLists(at, [{ id: T }])
  await boot
  assert.deepEqual([at.opened, at.started], [[], []], 'the open session stays the open one: nothing is opened or started over it')
})

test('an open that another session replaced while its goal was read resolves false; one replaced by the same session, true (N3)', { timeout: 5000 }, async () => {
  /**
   * developer-ten's N3 on follow-up 1: an open superseded during refreshGoal/refreshTodo still resolved true, so the flat
   * row that awaited it marked itself selected while another session was shown. It now answers whether the session it
   * asked for is the one shown.
   */
  const other = harness({ holdGoal: true })
  const first = other.show(S)
  await settle()
  other.release('list')
  await settle()
  other.release(read(S), history(S))
  await settle()
  assert.equal(other.waiting('goal'), 1, "the first open is reading S's goal")
  const second = other.show(T)
  await settle()
  other.release('list')
  await settle()
  other.release(read(T), history(T))
  await settle()
  other.release('goal')
  await settle()
  other.release('goal')
  assert.deepEqual(await Promise.all([first, second]), [false, true], 'the open of S, which T replaced, resolves false; T resolves true')
  assert.equal(other.current(), T)

  const same = harness({ holdGoal: true })
  const again = same.show(S)
  await settle()
  same.release('list')
  await settle()
  same.release(read(S), history(S))
  await settle()
  const repeat = same.show(S)
  await settle()
  same.release('list')
  await settle()
  same.release(read(S), history(S))
  await settle()
  same.release('goal')
  await settle()
  same.release('goal')
  assert.deepEqual(await Promise.all([again, repeat]), [true, true], 'replaced by an open of the same session, both resolve true: S is shown')
})
