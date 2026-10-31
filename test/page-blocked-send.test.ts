import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The end of the page's own turn (`runTurn`'s `done` frame), run out of the page with its stream answered by the test.
 *
 * #139's blocker B1 (developer-ten's review of f0442783): a message sent into an archived open session is accepted by
 * both servers and blocked by the archived-session gate before any step, so the turn ends `done` with
 * `finishReason: 'blocked'`, no round and `ended: [ARCHIVED_BLOCKED]`. The prompt is never written as a message, the
 * stream's `turn/failed` for a blocked end draws nothing, and f0442783 stopped drawing the ended notice too: the field had
 * been cleared by the send, so the words were lost and nothing on screen said why. Now the notice is drawn as its own row
 * (never under the previous turn's answer, which a reload does not show either), the words go back to the composer, and
 * the archived session is let go, as DSH's `clearArchivedCurrent` lets it go (dsh-client-ui-workspace lib/client.js:1638-1643).
 *
 * developer-ten's N1 on a5b90f28: the `done` frame zeroed `liveRounds` whatever session the panel showed, so the end of
 * this page's turn in N dropped the dock of M, open and running, to its fold mid-turn.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

function source(name: string): string {
  const start = page.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start + 1, page.indexOf('\n}\n', start) + 2)
}

const block = (marker: string) => page.slice(page.indexOf(`/* ${marker}:begin */`), page.indexOf(`/* ${marker}:end */`))

interface Ended {
  /** The rows the log holds, newest last: `kind:text`, a notice nested under a row as `kind:text>notice`. */
  rows(): string[]
  field(): string
  current(): string | null
  composerKey(): string
  cleared(): string[]
  liveRounds(): number
}

/**
 * The page with session `open` on screen and in the composer, the previous turn's answer as its last row, and a turn of
 * session `turn` whose stream answers `done` with `payload`. `running` lists the sessions with a running turn, each with
 * the rounds the page counted for it.
 */
function finish(options: { open: string | null; turn: string; payload: Record<string, unknown>; running?: Record<string, number>; draft?: string }): Promise<Ended> {
  return runInNewContext(
    `
    const QUEUE_KEY_NONE = ''
    const NO_WORKSPACE_REFUSAL = 'Choose a workspace first.'
    let current = OPTIONS.open
    let composerKey = OPTIONS.open ?? QUEUE_KEY_NONE
    let unavailableSession = null
    let activeFolder = null
    let workspaceRoutes = 'served'
    let liveTurns = 0, liveRounds = 7, liveUsage, liveRoundStartedAt = null
    let directTurnPending = 0, directPendingKey = null, stopRequested = false
    const stopButton = { disabled: true }
    const runningSessions = new Set(Object.keys(OPTIONS.running ?? {}))
    const turnRounds = new Map(Object.entries(OPTIONS.running ?? {}).map(([id, rounds]) => [id, { rounds, startedAt: 5 }]))
    const runningSince = new Map(), pendingInteractions = new Map(), stoppedQueues = new Set()
    const cleared = []
    /** The log: rows the page drew, each a { kind, text, notices } with the DOM calls the done branch makes. */
    function row(kind, text) {
      const node = { kind, text, notices: [], dataset: { kind }, append(child) { node.notices.push(child.textContent) }, before() {} }
      return node
    }
    const log = { children: OPTIONS.open === null ? [] : [row('assistant', 'the previous answer')], append(child) { this.children.push(child.kind === undefined ? row('notice', child.textContent) : child) }, replaceChildren() { this.children = [] } }
    const field = { value: OPTIONS.draft ?? '' }
    const document = { createElement: () => ({ className: '', textContent: '', setAttribute() {} }) }
    const firstTreeReady = Promise.resolve()
    const newConversationTarget = () => ({ path: '/work/alpha', label: 'alpha' })
    function lastTurnRow() { return log.children.at(-1) ?? null }
    function add(kind, text) { log.children.push(row(kind, text)) }
    function updateStatusBar() {}
    async function refreshSessionStats() {}
    function selectionForTurn() { return {} }
    function rememberCurrent() {}
    function rememberWorkspace() {}
    function chooseWorkspace() {}
    function adoptSession(id) { composerKey = id }
    function adoptLooseQueue() {}
    async function fetchSessionAccess() {}
    async function stopTurn() {}
    async function showSession(id) { current = id; return true }
    function settleReasoning() {}
    function settleChat() {}
    function refreshRunningStatus() {}
    async function renderSettledAnswers() {}
    function renderScheduleCards() {}
    async function attachTurnUsage() {}
    async function attachEditedFiles() {}
    async function renderTree() {}
    async function refreshSessions() {}
    function hideApproval() {}
    function markStopped() {}
    function noteCompletion() {}
    function paintRunningMarks() {}
    function renderComposerState() {}
    function drawTurnFailure() {}
    function growComposer() {}
    function paintEmptyState() {}
    function updateSendDisabled() {}
    function queueOf() { return [] }
    /** The page's clearMain, as far as this needs it: nothing open, the composer on no session, the log emptied. */
    function clearMain() { if (current === null) return; cleared.push(current); current = null; composerKey = QUEUE_KEY_NONE; log.replaceChildren() }
    ${block('turn-failure')}
    ${source('turnNotice')}
    ${page.search(/\nfunction liveRoundsOf\(/) >= 0 ? source('liveRoundsOf') : ''}
    const frames = 'event: done\\ndata: ' + JSON.stringify({ session: OPTIONS.turn, ...OPTIONS.payload }) + '\\n\\n'
    const sendTurn = async () => ({
      ok: true,
      body: { getReader() { let sent = false; return { read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: new TextEncoder().encode(frames) })) } } },
    })
    ${source('runTurn')}
    runTurn('where does this go', OPTIONS.turn, [], () => {}).then(() => ({
      rows: () => log.children.map((node) => node.kind + ':' + node.text + node.notices.map((notice) => '>' + notice).join('')),
      field: () => field.value,
      current: () => current,
      composerKey: () => composerKey,
      cleared: () => [...cleared],
      liveRounds: () => liveRounds,
    }))
    `,
    { OPTIONS: options, JSON, Promise, TextEncoder, TextDecoder, performance, Error, Array, Object, String, Number, Set, Map },
  ) as Promise<Ended>
}

const S = 'session-11111111-1111-4111-8111-111111111111'
const M = 'session-22222222-2222-4222-8222-222222222222'
const BLOCKED = 'blocked: an archived session runs no model step until it is unarchived'
const blockedAtOnce = { text: '', finishReason: 'blocked', rounds: 0, denials: [], ended: [BLOCKED] }

test('a message the archived gate blocked before any step is said in its own row, its words come back, and the archived session is let go (B1)', async () => {
  const ended = await finish({ open: S, turn: S, payload: blockedAtOnce })
  assert.deepEqual(Array.from(ended.rows()), ['notice:Blocked: an archived session runs no model step until it is unarchived'], 'the notice is its own row, and the previous answer carries none')
  assert.equal(ended.field(), 'where does this go', 'the words are back in the composer, so nothing typed is lost')
  assert.deepEqual(Array.from(ended.cleared()), [S], 'the archived session is no longer the open one (DSH clearArchivedCurrent)')
  assert.equal(ended.current(), null)
  assert.equal(ended.composerKey(), '', 'and the next message starts a new conversation rather than going to it again')
})

test('when the stream had already let the archived session go, the notice and the words still land (B1, the race)', async () => {
  /** The stream's turn/failed for the blocked end arrived first and let the session go: nothing is open now. */
  const ended = await finish({ open: null, turn: S, payload: blockedAtOnce })
  assert.deepEqual(Array.from(ended.rows()), ['notice:Blocked: an archived session runs no model step until it is unarchived'], 'the notice is drawn in the emptied panel')
  assert.equal(ended.field(), 'where does this go', 'and the words come back')
  assert.deepEqual(Array.from(ended.cleared()), [], 'nothing is let go twice')
  const kept = await finish({ open: S, turn: S, payload: blockedAtOnce, draft: 'typed meanwhile' })
  assert.equal(kept.field(), 'typed meanwhile', 'words typed since are never overwritten')
  const elsewhere = await finish({ open: M, turn: S, payload: blockedAtOnce })
  assert.equal(elsewhere.field(), '', 'nor are the words put into another session\'s composer')
  assert.deepEqual(Array.from(elsewhere.rows()), ['assistant:the previous answer'], 'and nothing is drawn in a session that is not the blocked one')
  assert.equal(elsewhere.current(), M, 'which stays open')
})

test('a turn that stopped early for any other reason keeps its notice under its answer, and the session stays open', async () => {
  const ended = await finish({ open: S, turn: S, payload: { text: 'partial', finishReason: 'length', rounds: 8, denials: [], ended: ['stopped after the round limit of 8'] } })
  assert.deepEqual(Array.from(ended.rows()), ['assistant:the previous answer>Stopped after the round limit of 8'])
  assert.equal(ended.current(), S)
  assert.equal(ended.field(), '', 'and nothing is put back: the message was delivered')
})

test('the end of this page\'s turn in another session leaves the open running session\'s live rounds as they are (N1)', async () => {
  const ended = await finish({ open: M, turn: S, payload: { text: 'done', finishReason: 'stop', rounds: 1, denials: [] }, running: { [M]: 3, [S]: 1 } })
  assert.equal(ended.liveRounds(), 3, "M's dock keeps the three rounds of its running turn, not 0")
  const own = await finish({ open: S, turn: S, payload: { text: 'done', finishReason: 'stop', rounds: 1, denials: [] }, running: { [S]: 1 } })
  assert.equal(own.liveRounds(), 0, 'the session whose turn ended counts none live: its rounds are the fold\'s now')
})
