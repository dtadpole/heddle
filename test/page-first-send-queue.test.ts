import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * Messages queued behind the first message of a page with no session, run out of the page: its own `sendNow`,
 * `enqueue`, `queueOf`, `adoptSession`, `pumpQueue` and `runTurn`, with each turn's stream answered by the test.
 *
 * Since #142 a page load opens no session, so the first message goes out with no session (`new: true`) and the session
 * it creates is adopted from the turn's `session` frame. Rust 80a at f0442783 failed check-composer's two queue tests:
 * after the first turn only one queued message was answered and the rest were never sent. The parent's hypothesis:
 * messages queued while the first turn ran are keyed to "no session", and when the created session is adopted, by the
 * frame's own adoption or by N1's `showSession`, that queue does not move with it, so it never drains.
 *
 * The test sends the first message, queues three more (two by Enter, one at the front as a refused steer falls back),
 * some before the `session` frame lands and some after, ends the first turn, and checks that every queued message is
 * sent into the created session, in order, and that nothing is left in a queue for "no session".
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

function source(name: string): string {
  const start = page.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start + 1, page.indexOf('\n}\n', start) + 2)
}

function optional(name: string): string {
  return page.search(new RegExp(`\\n(?:async )?function ${name}\\(`)) >= 0 ? source(name) : ''
}

const block = (marker: string) => page.slice(page.indexOf(`/* ${marker}:begin */`), page.indexOf(`/* ${marker}:end */`))

interface Flow {
  sent: { prompt: string; session: string | null; fresh: boolean }[]
  current: string | null
  composerKey: string
  left: Record<string, string[]>
}

const N = 'session-33333333-3333-4333-8333-333333333333'

/**
 * Run the flow. `before` messages are queued while the first turn runs and before its `session` frame lands, `after`
 * ones once it has; `front` is queued at the front (a steer the server refused falls back to the queue's front).
 * `boot` is a saved session the boot's restore opens after the first message was sent and before its frame lands
 * (developer-ten's N1), or null.
 */
function flow(options: { before: string[]; after: string[]; front?: string; boot?: string | null }): Promise<Flow> {
  return runInNewContext(
    `
    const QUEUE_KEY_NONE = ''
    const NO_WORKSPACE_REFUSAL = 'Choose a workspace first.'
    let current = null
    let composerKey = QUEUE_KEY_NONE
    let unavailableSession = null
    let activeFolder = null
    let workspaceRoutes = 'served'
    let liveTurns = 0, liveRounds = 0, liveUsage, liveRoundStartedAt = null
    let directTurnPending = 0, directPendingKey = null, directPendingSince = null, pendingWatchdog = null, stopRequested = false
    let queueSeq = 0
    const queues = new Map()
    const pumping = new WeakSet()
    const directTurnsByQueue = new WeakMap()
    const queueTurnOut = new WeakSet()
    const stoppedQueues = new WeakSet()
    const runningSessions = new Set(), runningSince = new Map(), pendingInteractions = new Map(), turnRounds = new Map()
    const stopButton = { disabled: true }
    const field = { value: '' }
    const log = { children: [], append(child) { this.children.push(child) }, replaceChildren() { this.children = [] } }
    const document = { createElement: () => ({ className: '', textContent: '', setAttribute() {} }) }
    const firstTreeReady = Promise.resolve()
    const newConversationTarget = () => ({ path: '/work/default-workspace', label: 'Default workspace' })
    const setTimeout = () => 0, clearTimeout = () => {}
    function lastTurnRow() { return null }
    function add() {}
    function updateStatusBar() {}
    async function refreshSessionStats() {}
    function selectionForTurn() { return {} }
    function rememberCurrent() {}
    function rememberWorkspace() {}
    function chooseWorkspace() {}
    async function fetchSessionAccess() {}
    async function stopTurn() {}
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
    function renderQueue() {}
    function drawTurnFailure() {}
    function growComposer() {}
    function updateSendDisabled() {}
    function paintEmptyState() {}
    function clearMain() {}
    /** The page's open as far as the queue goes: the session becomes current and the composer follows it. */
    async function showSession(id) { current = id; adoptSession(id); return true }
    ${block('turn-failure')}
    ${source('turnNotice')}
    ${optional('liveRoundsOf')}
    ${source('queueOf')}
    ${source('adoptSession')}
    ${optional('looseTurnOut')}
    ${optional('adoptLooseQueue')}
    ${source('directTurnsFor')}
    ${source('keyOfQueue')}
    ${source('enqueue')}
    ${source('pumpQueue')}
    ${source('sendNow')}
    /** Each turn's stream: the first, with no session, names the session it created and waits to be ended. */
    const sent = []
    let releaseFirst
    const firstEnds = new Promise((resolve) => { releaseFirst = resolve })
    let frameLanded
    const frameSeen = new Promise((resolve) => { frameLanded = resolve })
    const frame = (name, data) => new TextEncoder().encode('event: ' + name + '\\ndata: ' + JSON.stringify(data) + '\\n\\n')
    const sendTurn = async (body) => {
      sent.push({ prompt: body.prompt, session: body.session, fresh: body.new === true })
      const session = body.session ?? CREATED
      const steps = body.session === null
        ? [async () => frame('session', { session }), async () => { frameLanded(); await firstEnds; return frame('done', { session, text: 'answer', finishReason: 'stop', rounds: 1, denials: [] }) }]
        : [async () => frame('done', { session, text: 'answer', finishReason: 'stop', rounds: 1, denials: [] })]
      return { ok: true, body: { getReader() { return { read: async () => (steps.length === 0 ? { done: true } : { done: false, value: await steps.shift()() }) } } } }
    }
    ${source('runTurn')}
    const settle = () => new Promise((resolve) => setImmediate(resolve))
    ;(async () => {
      const first = sendNow('first')
      for (const text of OPTIONS.before) enqueue(text, 'queue')
      /** N1's case: the boot's restoreSelection opens the saved session while the first message's turn starts. */
      if (OPTIONS.boot) await showSession(OPTIONS.boot)
      await frameSeen
      await settle()
      for (const text of OPTIONS.after) enqueue(text, 'queue')
      if (OPTIONS.front) enqueue(OPTIONS.front, 'steer')
      releaseFirst()
      await first
      for (let round = 0; round < 20; round += 1) await settle()
      return JSON.stringify({
        sent,
        current,
        composerKey,
        left: Object.fromEntries([...queues].map(([key, queue]) => [key, queue.map((item) => item.text + ':' + item.status)])),
      })
    })()
    `,
    { OPTIONS: options, CREATED: N, JSON, Promise, TextEncoder, TextDecoder, performance, Error, Array, Object, String, Number, Set, Map, WeakSet, WeakMap, Date, setImmediate },
  ).then((text: string) => JSON.parse(text)) as Promise<Flow>
}

const expectSent = (prompts: string[]) => [
  { prompt: 'first', session: null, fresh: true },
  ...prompts.map((prompt) => ({ prompt, session: N, fresh: false })),
]

test('messages queued behind the first message of a page with no session all go into the session it created, in order (check-composer, #142)', async () => {
  const run = await flow({ before: ['second'], after: ['third'], front: 'urgent' })
  assert.deepEqual(run.sent, expectSent(['urgent', 'second', 'third']), `every queued message is sent, into the created session, the front one first\nsaw: ${JSON.stringify(run)}`)
  assert.equal(run.current, N)
  assert.equal(run.composerKey, N)
  assert.deepEqual(Object.values(run.left).flat(), [], `and nothing waits anywhere, least of all under "no session"\nsaw: ${JSON.stringify(run.left)}`)
})

test('the same when every message was queued before the created session was adopted, or after it', async () => {
  const early = await flow({ before: ['queued one', 'queued two', 'queued three'], after: [] })
  assert.deepEqual(early.sent, expectSent(['queued one', 'queued two', 'queued three']), `queued before the frame\nsaw: ${JSON.stringify(early)}`)
  const late = await flow({ before: [], after: ['queued one', 'queued two', 'queued three'] })
  assert.deepEqual(late.sent, expectSent(['queued one', 'queued two', 'queued three']), `queued after the frame\nsaw: ${JSON.stringify(late)}`)
})

test('the same when the page showed another session as the frame landed and N1 opened the created one', async () => {
  const run = await flow({ before: ['second'], after: ['third'], boot: 'session-44444444-4444-4444-8444-444444444444' })
  assert.deepEqual(run.sent.map((entry) => [entry.prompt, entry.session]), [['first', null], ['second', N], ['third', N]], `saw: ${JSON.stringify(run)}`)
  assert.deepEqual(Object.values(run.left).flat(), [])
})
