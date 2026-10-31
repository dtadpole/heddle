import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// Normal runs extract the working page; the revision override proves the regression against
// an immutable old page without rewriting production files or creating another fixture file.
const root = join(import.meta.dirname, '..')
const page = process.env.HEDDLE_TEST_PAGE_REV
  ? execFileSync('git', ['show', `${process.env.HEDDLE_TEST_PAGE_REV}:src/server/page.html`], { cwd: root, encoding: 'utf8', timeout: 5000 })
  : readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(root, 'src/server/page.html'), 'utf8')
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  assert.ok(end > start, `the page defines the complete ${name}`)
  return page.slice(start, end + 2)
}

interface Read {
  url: string
  resolve(response: { ok: boolean; json(): Promise<unknown> }): void
  reject(error: Error): void
}
interface Snapshot {
  current: string
  stats: unknown
  rounds: number
  usage?: unknown
  turns: number
  generationMs: number
  decodeTokens: number
  roundStartedAt: number | null
  steps: string
  total: string
  usageHidden: boolean
  timeRows: string[][]
  usageRows: string[][]
}
interface Harness {
  done(): Promise<void>
  completed(): void
  refresh(): Promise<void>
  switchSession(): void
  snapshot(): Snapshot
  reads: Read[]
  paints: Snapshot[]
}

const liveUsage = { inputTokens: 80, outputTokens: 20, cacheReadTokens: 100 }
const folded = { turns: 1, steps: 3, usage: liveUsage, generationMs: 1000, decodeTokens: 20 }
const normalized = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function harness(): Harness {
  const reads: Read[] = []
  const paints: Snapshot[] = []
  const names = ['runTurn', 'handleSessionPayload', 'refreshSessionStats', 'updateStatusBar',
    'addUsage', 'formatTokenCount', 'formatRate', 'formatCacheHit', 'formatDurationMs',
    'formatExactCount', 'formatWindow', 'statPanelRows']
  const h = runInNewContext(`
    let current = 'S', composerKey = 'S';
    const view = 'chat';
    let sessionStats = null, liveRounds = 3, liveUsage = initialUsage;
    let liveTurns = 0, liveGenerationMs = 1000, liveDecodeTokens = 20, liveRoundStartedAt = 7;
    let stopRequested = true;
    const stopButton = { disabled: true }, QUEUE_KEY_NONE = 'none', activeFolder = null;
    const runningSessions = new Set(['S']), runningSince = new Map([['S', 0]]), queues = new Map();
    const transcriptLoads = new Map(), transcriptWatermarks = new Map();
    const endpointOptions = [], chosenEndpoint = null, endpointDefault = null;
    const windowFor = () => undefined;
    const cells = new Map();
    const statusBar = { hidden: false, querySelector(selector) {
      if (!cells.has(selector)) cells.set(selector, { textContent: '', hidden: false });
      return cells.get(selector);
    }};
    const selectionForTurn = () => ({});
    const noop = () => {};
    const settleReasoning = noop, settleChat = noop, refreshRunningStatus = noop,
      renderScheduleCards = noop, scheduleTreeRefresh = noop, scheduleGoalRefresh = noop,
      scheduleTodoRefresh = noop, paintRunningMarks = noop, renderComposerState = noop,
      add = noop, paintDock = noop;
    const renderSettledAnswers = async () => {}, renderTree = async () => {}, refreshSessions = async () => {};
    const sendTurn = async () => {
      let delivered = false;
      return { ok: true, body: { getReader: () => ({ read: async () => {
        if (delivered) return { done: true };
        delivered = true;
        return { done: false, value: new TextEncoder().encode('event: done\\ndata: {"session":"S"}\\n\\n') };
      }})}};
    };
    const fetch = (url) => new Promise((resolve, reject) => queueRead({ url, resolve, reject }));
    ${names.map(source).join('\n')}
    function snapshot() {
      return { current, stats: sessionStats, rounds: liveRounds, usage: liveUsage,
        turns: liveTurns, generationMs: liveGenerationMs, decodeTokens: liveDecodeTokens,
        roundStartedAt: liveRoundStartedAt,
        steps: statusBar.querySelector('[data-stat="steps"]').textContent,
        total: statusBar.querySelector('[data-stat="total"]').textContent,
        usageHidden: statusBar.querySelector('[data-stat-pill="usage"]').hidden,
        timeRows: statPanelRows('time'), usageRows: statPanelRows('usage') };
    }
    function renderStatPopover() { recordPaint(snapshot()); }
    updateStatusBar();
    ({ done: () => runTurn('hello', 'S'),
       completed: () => handleSessionPayload({ session: 'S', event: { type: 'turn/completed', seq: 11 } }),
       refresh: refreshSessionStats,
       switchSession: () => {
         current = 'T'; sessionStats = { turns: 9, steps: 10, usage: { inputTokens: 7, outputTokens: 2 } };
         liveRounds = 4; liveUsage = { inputTokens: 3, outputTokens: 1 }; liveTurns = 2;
         liveGenerationMs = 200; liveDecodeTokens = 5; liveRoundStartedAt = 123;
         updateStatusBar();
       }, snapshot })
  `, { initialUsage: { ...liveUsage }, TextEncoder, TextDecoder, performance: { now: () => 42 },
    queueRead: (read: Read) => reads.push(read), recordPaint: (value: Snapshot) => paints.push(normalized(value)),
  }, { timeout: 1000 }) as Omit<Harness, 'reads' | 'paints'>
  return { ...h, snapshot: () => normalized(h.snapshot()), reads, paints }
}

function pendingRead(h: Harness): Read {
  assert.equal(h.reads.length, 1, 'one deferred durable statistics GET is in flight')
  const read = h.reads[0]
  assert.ok(read, 'the deferred statistics read exists')
  assert.equal(read.url, '/api/sessions/S')
  return read
}
function assertLive(h: Harness): void {
  const at = h.snapshot()
  assert.equal(at.rounds, 3, 'live rounds survive until the durable fold is read')
  assert.deepEqual(at.usage, liveUsage, 'reported live usage survives until the durable fold is read')
  assert.equal(at.steps, '3 steps', 'the dock must not regress to zero steps')
  assert.equal(at.total, '200 tok', 'the dock must not lose the reported tokens')
  assert.equal(at.usageHidden, false, 'the token pill stays visible')
}
function assertFolded(h: Harness): void {
  const at = h.snapshot()
  assert.deepEqual(at.stats, folded, 'the returned durable fold replaces the baseline')
  assert.deepEqual([at.rounds, at.usage, at.turns, at.generationMs, at.decodeTokens, at.roundStartedAt],
    [0, undefined, 0, 0, 0, null], 'all live counters reset together, only after a successful current-session read')
  assert.equal(at.steps, '3 steps', 'folded steps are counted exactly once')
  assert.equal(at.total, '200 tok', 'folded tokens are counted exactly once')
}

for (const entry of ['done', 'completed'] as const) {
  test(`statistics settlement: actual ${entry} preserves live figures during deferred GET and replaces them atomically`, { timeout: 5000 }, async () => {
    const h = harness()
    await h[entry]()
    const read = pendingRead(h)
    // Even response headers alone are insufficient: JSON may still be in flight.
    let answerBody!: (body: unknown) => void
    read.resolve({ ok: true, json: () => new Promise((resolve) => { answerBody = resolve }) })
    await flush()
    assertLive(h)
    const paintCount = h.paints.length
    answerBody({ stats: folded })
    await flush()
    assertFolded(h)
    assert.equal(h.paints.length, paintCount + 1, 'one paint commits the durable baseline and all live resets')
    assert.deepEqual(h.paints.at(-1), h.snapshot(), 'no partial counter replacement is painted')
  })

  for (const failure of ['network', 'http', 'json'] as const) {
    test(`statistics settlement: actual ${entry} preserves live figures on ${failure} read failure`, { timeout: 5000 }, async () => {
      const h = harness()
      await h[entry]()
      const read = pendingRead(h)
      if (failure === 'network') read.reject(new Error('offline'))
      else read.resolve({ ok: failure !== 'http', json: async () => { throw new Error('malformed JSON') } })
      await flush()
      assertLive(h)
      assert.equal(h.snapshot().stats, null, 'failure does not replace the last baseline')
      assert.equal(h.snapshot().generationMs, 1000)
      assert.equal(h.snapshot().decodeTokens, 20)
      assert.equal(h.snapshot().roundStartedAt, 7)
    })
  }

  test(`statistics settlement: actual ${entry} ignores a successful stale-session GET without clearing the new session`, { timeout: 5000 }, async () => {
    const h = harness()
    await h[entry]()
    const read = pendingRead(h)
    h.switchSession()
    const before = h.snapshot()
    const paintCount = h.paints.length
    read.resolve({ ok: true, json: async () => ({ stats: folded }) })
    await flush()
    assert.deepEqual(h.snapshot(), before, 'neither baseline nor live counters of T are overwritten by S')
    assert.equal(h.paints.length, paintCount, 'a stale read does not paint')
  })
}

test('statistics settlement: usage and TPS popover rows retain live-first facts while GET is deferred, then fold exactly once', { timeout: 5000 }, async () => {
  const h = harness()
  await h.done()
  const read = pendingRead(h)
  const usageRows = [['total', '200 tok'], ['Cache hit', '56%'], ['Uncached input', '80 tok'], ['Cached input', '100 tok'], ['Output', '20 tok']]
  const timeRows = [['Tokens per second (TPS)', '20 tok/s']]
  const before = h.snapshot()
  assert.deepEqual(before.usageRows, usageRows, 'live-first usage cannot produce a no-data popover')
  assert.deepEqual(before.timeRows, timeRows, 'measured live generation/output yield the same TPS as the dock')
  read.resolve({ ok: true, json: async () => ({ stats: folded }) })
  await flush()
  assertFolded(h)
  assert.deepEqual(h.snapshot().usageRows, usageRows, 'fold replacement does not double-count popover usage')
  assert.deepEqual(h.snapshot().timeRows, timeRows, 'fold replacement does not double-count popover TPS')
})
