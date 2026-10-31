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

function harness(): Page {
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
    async function refreshGoal() {}
    async function refreshTodo() {}
    function renderScheduleCards() {}
    function renderScheduleDrawer() {}
    async function refreshScheduleList() {}
    async function refreshScheduleCatalog() {}
    ${source('showSession')}
    ({
      show: showSession,
      rows: () => log.children.map((row) => (row.dataset?.kind === 'command' ? 'command:' + row.dataset.commandId : row.kind + ':' + row.text)),
      current: () => current,
    })
  `,
    { hold: (what: string) => new Promise((resolve) => pending.push({ what, resolve })) },
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
