import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The dock after the page's own first turn, when the turn's `done` (its own response) is handled before the event
 * stream's last chunk — the order TS's two connections can deliver, run out of the page.
 *
 * check-composer at fbbe52d0 on TS (2 of 2, test 17 at :1240): right after the dock's rate appeared, the time pill's
 * surface said "No statistics yet", and test 9 (:654) read `0 steps` where one round had run (1 of 2). Both wait for the
 * rate as the sign that the turn ended and its statistics were read. Since #142 the first message of a page creates its
 * session, so the dock starts with no statistics at all, and the rate could come from the live counters instead: the
 * open session's round was timed from its `model/request`, `done` zeroed the live rounds but left the round's start, and
 * the stream's chunk that closed the round, arriving after `done`, timed it. The dock then showed a rate with no
 * statistics behind it and `0 steps`. A turn's `done` ends its rounds, so its open round is no longer timed live either;
 * the rate appears with the statistics read, which `done` asks for.
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

/** The page's handling of a chunk's usage and of the chunk that closes a round (`drawSessionEvent`). */
function chunkHandling(): string {
  const usage = page.indexOf("  if (event.type === 'assistant/chunk' && event.chunk.usage !== undefined")
  assert.ok(usage > 0, 'drawSessionEvent merges a chunk\'s usage')
  const guard = page.lastIndexOf('\n  /** A chunk of a turn whose `done`', usage)
  const from = guard > 0 && usage - guard < 300 ? guard + 1 : usage
  const to = page.indexOf("  if (event.type === 'permission/mode') {", from)
  return `function onChunk(event, payload) {\n${page.slice(from, to)}}\n`
}

interface Seen {
  steps: number
  rate: boolean
  statistics: boolean
  /** Output tokens the dock counts: the fold's and the live usage's. */
  output: number
}

const N = 'session-55555555-5555-4555-8555-555555555555'
const FOLD = { turns: 1, steps: 1, llmMs: 900, generationMs: 800, decodeTokens: 20, usage: { inputTokens: 200, cacheReadTokens: 400, outputTokens: 20 } }

/**
 * Run the first turn of a page with no session through `order`, a list of what lands, in turn:
 * - `session`: the turn's response names the session it created (runTurn adopts it);
 * - `request`: the stream's `model/request` for it;
 * - `done`: the turn's response ends (runTurn's `done`, which asks for the statistics);
 * - `chunk`: the stream's chunk that closes the round, with its usage;
 * - `stats`: the statistics read answers.
 * Answers what the dock showed when its rate first appeared, and at the end.
 */
function firstTurn(order: string[]): Promise<{ first: Seen | null; last: Seen }> {
  return runInNewContext(
    `
    const QUEUE_KEY_NONE = ''
    const NO_WORKSPACE_REFUSAL = 'Choose a workspace first.'
    let current = null, composerKey = QUEUE_KEY_NONE, unavailableSession = null, activeFolder = null, workspaceRoutes = 'served'
    let sessionStats = null, liveTurns = 0, liveRounds = 0, liveUsage, liveRoundStartedAt = null, liveGenerationMs = 0, liveDecodeTokens = 0
    let directTurnPending = 0, directPendingKey = null, stopRequested = false
    const stopButton = { disabled: true }
    const runningSessions = new Set(), runningSince = new Map(), pendingInteractions = new Map(), turnRounds = new Map(), stoppedQueues = new Set(), turnsEnded = new Set()
    const log = { children: [], append() {}, replaceChildren() {} }
    const field = { value: '' }
    const document = { createElement: () => ({ className: '', textContent: '', setAttribute() {} }) }
    const firstTreeReady = Promise.resolve()
    const newConversationTarget = () => ({ path: '/work/default-workspace', label: 'Default workspace' })
    /** The dock's figures as updateStatusBar computes them, kept from the first moment the rate shows. */
    let first = null
    const seen = () => ({
      steps: (sessionStats?.steps ?? 0) + liveRounds,
      rate: (sessionStats?.generationMs ?? 0) + liveGenerationMs > 0 && (sessionStats?.decodeTokens ?? 0) + liveDecodeTokens > 0,
      statistics: typeof sessionStats?.llmMs === 'number',
      output: (sessionStats?.usage?.outputTokens ?? 0) + (liveUsage?.outputTokens ?? 0),
    })
    function updateStatusBar() {
      if (current === null) return
      const now = seen()
      if (first === null && now.rate) first = now
    }
    function addUsage(left, right) { return { ...(left ?? {}), ...(right ?? {}) } }
    function lastTurnRow() { return null }
    function add() {}
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
    function updateSendDisabled() {}
    function paintEmptyState() {}
    function clearMain() {}
    function queueOf() { return [] }
    ${block('turn-failure')}
    ${source('turnNotice')}
    ${optional('noteRound')}
    ${optional('liveRoundsOf')}
    ${source('refreshSessionStats')}
    ${chunkHandling()}
    /** The old inline model/request handling, for a page without noteRound. */
    function onRequest(session) {
      const wasRunning = runningSessions.has(session)
      runningSessions.add(session)
      if (typeof noteRound === 'function') noteRound(session, wasRunning)
      else if (session === (current ?? composerKey)) { liveRoundStartedAt = performance.now(); liveRounds += 1; updateStatusBar() }
    }
    /** Gates: each named step lets one thing land. */
    const gates = {}
    const gate = (name) => new Promise((resolve) => { gates[name] = resolve })
    const sessionLands = gate('session'), doneLands = gate('done'), statsLand = gate('stats')
    const fetch = async () => { await statsLand; return { ok: true, json: async () => ({ stats: FOLD }) } }
    const encoder = new TextEncoder()
    const frame = (name, data) => encoder.encode('event: ' + name + '\\ndata: ' + JSON.stringify(data) + '\\n\\n')
    const steps = [
      async () => { await sessionLands; return frame('session', { session: N, event: { type: 'message' } }) },
      async () => { await doneLands; return frame('done', { session: N, text: 'answer', finishReason: 'stop', rounds: 1, denials: [] }) },
    ]
    /** #128: the page follows the stream before it sends, and a server without detach streams the turn. */
    const events = { whenOpen: async () => {} }
    const sendTurn = async () => ({ ok: true, headers: { get: (name) => (name === 'content-type' ? 'text/event-stream' : null) }, body: { getReader() { return { read: async () => (steps.length === 0 ? { done: true } : { done: false, value: await steps.shift()() }) } } } })
    ${source('runTurn')}
    const settle = async () => { for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve)) }
    ;(async () => {
      const turn = runTurn('report the cost', QUEUE_KEY_NONE, [], () => {})
      await settle()
      for (const step of ORDER) {
        if (step === 'request') onRequest(N)
        else if (step === 'chunk') onChunk({ type: 'assistant/chunk', chunk: { type: 'done', usage: { outputTokens: 20 } } }, { session: N })
        else gates[step]()
        await new Promise((resolve) => setTimeout(resolve, 2))
        await settle()
      }
      await turn
      await settle()
      return JSON.stringify({ first, last: seen() })
    })()
    `,
    { ORDER: order, N, FOLD, JSON, Promise, TextEncoder, TextDecoder, performance, Error, Array, Object, String, Number, Set, Map, setImmediate, setTimeout },
  ).then((text: string) => JSON.parse(text)) as Promise<{ first: Seen | null; last: Seen }>
}

test('when the turn\'s done lands before the stream\'s last chunk, the rate appears with the statistics, never before them (check-composer on TS)', async () => {
  const run = await firstTurn(['session', 'request', 'done', 'chunk', 'stats'])
  assert.deepEqual(run.first, { steps: 1, rate: true, statistics: true, output: 20 }, `the rate first shows with the statistics read: one step, and LLM time to show\nsaw: ${JSON.stringify(run)}`)
  assert.deepEqual(run.last, { steps: 1, rate: true, statistics: true, output: 20 })
})

test('in the stream\'s own order the rate may show live, and the figures it shows count the round', async () => {
  const run = await firstTurn(['session', 'request', 'chunk', 'done', 'stats'])
  assert.equal(run.first?.steps, 1, `a live rate counts the round it timed\nsaw: ${JSON.stringify(run)}`)
  assert.deepEqual(run.last, { steps: 1, rate: true, statistics: true, output: 20 })
})

test('a model/request the stream delivers after the turn\'s done counts no round twice', async () => {
  const run = await firstTurn(['session', 'done', 'request', 'chunk', 'stats'])
  assert.deepEqual(run.first, { steps: 1, rate: true, statistics: true, output: 20 }, `the round is the statistics' own\nsaw: ${JSON.stringify(run)}`)
  assert.deepEqual(run.last, { steps: 1, rate: true, statistics: true, output: 20 }, 'and stays counted once')
})

test('a closing chunk or a model/request the stream delivers after the fold landed adds nothing to it (main\'s settle-on-fold lacks this)', async () => {
  /**
   * Main's 64efdee2 keeps the live figures until the fold is read and then replaces them at once. An event of the same
   * turn handled after that read (the stream lagging the turn's response) was added on top of the fold until the
   * stream's turn/completed asked for it again: the output counted twice, or the round. `turnsEnded` keeps them out.
   */
  const chunk = await firstTurn(['session', 'request', 'done', 'stats', 'chunk'])
  assert.deepEqual(chunk.last, { steps: 1, rate: true, statistics: true, output: 20 }, `the late chunk's usage is not counted again\nsaw: ${JSON.stringify(chunk)}`)
  const request = await firstTurn(['session', 'done', 'stats', 'request', 'chunk'])
  assert.deepEqual(request.last, { steps: 1, rate: true, statistics: true, output: 20 }, `nor the late request's round\nsaw: ${JSON.stringify(request)}`)
})
