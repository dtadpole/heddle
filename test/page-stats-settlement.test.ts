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
  ? execFileSync('git', ['show', `${process.env.HEDDLE_TEST_PAGE_REV}:src/server/page.html`], { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(root, 'src/server/page.html'), 'utf8')
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  assert.ok(end > start, `the page defines the complete ${name}`)
  return page.slice(start, end + 2)
}

// Stack12 owns lifecycle in the registered EventSource callback, not handleSessionPayload.
// Execute that callback and the page's drawing function unchanged; no substitute history buffer.
function sessionListenerSource(): string {
  const start = page.indexOf("events.addEventListener('session', (message) => {")
  assert.ok(start >= 0, 'the page registers its session listener')
  const end = page.indexOf('\n})', start)
  assert.ok(end > start, 'the complete session listener is present')
  return page.slice(start, end + 3)
}

interface Read {
  url: string
  resolve(response: { ok: boolean; json(): Promise<unknown> }): void
  reject(error: Error): void
}
interface Snapshot {
  current: string | null
  counts: [string, number][]
  dockHidden: boolean
  stats: unknown
  rounds: number
  usage?: unknown
  turns: number
  turnsText: string
  generationMs: number
  decodeTokens: number
  roundStartedAt: number | null
  steps: string
  total: string
  usageHidden: boolean
  timeRows: string[][]
  usageRows: string[][]
}
type Admission = 'streamed' | 'detached' | 'offline' | 'refused' | 'stream-unavailable' | 'lost-ack'
interface Harness {
  done(): Promise<void>
  emitUser(session?: string, seq?: number): void
  replay(upTo: number): void
  admission(): { posts: number; accepted: number }
  baseline(): void
  completed(): void
  refresh(): Promise<void>
  switchSession(id?: string): void
  blank(): void
  unavailable(): void
  created(order: 'before' | 'after'): Promise<void>
  snapshot(): Snapshot
  reads: Read[]
  paints: Snapshot[]
}

const liveUsage = { inputTokens: 80, outputTokens: 20, cacheReadTokens: 100 }
const folded = { turns: 1, steps: 3, usage: liveUsage, generationMs: 1000, decodeTokens: 20 }
const normalized = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function harness(admission: Admission = 'streamed', outcome = 'done'): Harness {
  const reads: Read[] = []
  const paints: Snapshot[] = []
  const names = ['runTurn', 'sendTurn', 'adoptSession', 'selectionForSeat', 'selectionForTurn', 'drawSessionEvent', 'drawKeptEvents', 'keptToDraw', 'refreshSessionStats', 'updateStatusBar',
    'addUsage', 'formatTokenCount', 'formatRate', 'formatCacheHit', 'formatDurationMs',
    'formatExactCount', 'formatWindow', 'statPanelRows', 'isReplacementCopy', 'endLiveRetries']
  const h = runInNewContext(`
    let current = 'S', composerKey = 'S';
    const view = 'chat';
    let sessionStats = null, liveRounds = 3, liveUsage = initialUsage;
    ${page.match(/(?:let|const) liveTurns = [^\n]+/)?.[0]}
    let liveGenerationMs = 1000, liveDecodeTokens = 20, liveRoundStartedAt = 7;
    let stopRequested = true;
    const stopButton = { disabled: true }, QUEUE_KEY_NONE = 'none', activeFolder = null;
    const runningSessions = new Set(['S']), runningSince = new Map([['S', 0]]), queues = new Map();
    let sessionLoading = null;
    const pendingInteractions = new Map();
    let posts = 0, accepted = 0;
    const NOT_FORWARDED = new Set([502, 503, 504]), RETRY_DELAY_MS = 0;
    const hideApproval = () => {}, drawTurnFailure = () => {};
    const turnVerdicts = { wait: async () => {
      if (adoptionOrder === 'after') persistedUser('N', 20);
      return { session: adoptionOrder ? 'N' : 'S', outcome, message: 'provider failed' };
    } };
    let sessionListener;
    const events = { addEventListener(name, listener) {
      if (name === 'session') sessionListener = listener;
    },
    // #128: runTurn sends only once the page follows the stream.
    whenOpen: async () => { if (admission === 'stream-unavailable') throw new Error('stream unavailable'); } };
    const endpointOptions = [], endpointDefault = null;
    let chosenEndpoint = null, chosenModel = null, chosenEffort = null;
    const heldSeats = new Map(), recordedSelections = new Set(), pendingSaves = new Set();
    let unavailableSession = null;
    const firstTreeReady = Promise.resolve(), workspaceRoutes = 'absent';
    const newConversationTarget = () => null;
    let directTurnPending = 0, directPendingKey = null;
    const rememberCurrent = () => {}, chooseWorkspace = () => {}, renderQueue = () => {}, pumpQueue = async () => {};
    const fetchSessionAccess = async () => {}, stopTurn = async () => {};
    let adoptionOrder = null;
    const windowFor = () => undefined;
    const cells = new Map();
    const statusBar = { hidden: false, querySelector(selector) {
      if (!cells.has(selector)) cells.set(selector, { textContent: '', hidden: false });
      return cells.get(selector);
    }};
    const noop = () => {};
    const settleReasoning = noop, settleChat = noop, refreshRunningStatus = noop,
      renderScheduleCards = noop, scheduleTreeRefresh = noop, scheduleGoalRefresh = noop,
      scheduleTodoRefresh = noop, paintRunningMarks = noop, renderComposerState = noop,
      add = noop, paintDock = noop, noteCompletion = noop, markBranchable = noop,
      attachEditedFiles = noop, attachTurnUsage = noop;
    const lastTurnRow = () => null;
    const messageContentText = () => 'hello', contentAttachments = () => [];
    function persistedUser(session = 'S', seq = 10) {
      sessionListener({ data: JSON.stringify({ session, event: {
        type: 'message', seq, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
      } }) });
    }
    const renderSettledAnswers = async () => {}, renderTree = async () => {}, refreshSessions = async () => {};
    const fetch = async (url) => {
      if (url !== '/api/turn') return new Promise((resolve, reject) => queueRead({ url, resolve, reject }));
      posts += 1;
      if (admission === 'offline') throw new Error('offline fetch');
      if (admission === 'refused') return { ok: false, status: 400, text: async () => 'refused before admission' };
      if (adoptionOrder) {
        if (adoptionOrder === 'before') persistedUser('N', 20);
        return { ok: true, status: 202, headers: { get: () => 'application/json' },
          json: async () => ({ session: 'N', turn: 'new-turn' }) };
      }
      persistedUser('S', 9 + posts);
      if (admission === 'lost-ack') throw new Error('acknowledgment lost');
      if (admission === 'detached') return {
        ok: true, status: 202, headers: { get: () => 'application/json' },
        json: async () => ({ session: 'S', turn: 'turn-fixture' })
      };
      let delivered = false;
      // A server without detach streams the verdict; its prompt still arrives on the session feed.
      return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => {
        if (delivered) return { done: true };
        delivered = true;
        return { done: false, value: new TextEncoder().encode('event: ' + outcome + '\\ndata: {"session":"S","message":"provider failed"}\\n\\n') };
      }})}};
    };
    ${names.map(source).join('\n')}
    ${sessionListenerSource()}
    function snapshot() {
      return { current, stats: sessionStats, rounds: liveRounds, usage: liveUsage,
        counts: liveTurns instanceof Map ? [...liveTurns] : [['global', liveTurns]], dockHidden: statusBar.hidden,
        turns: liveTurns instanceof Map ? (liveTurns.get(current) ?? 0) : liveTurns, turnsText: statusBar.querySelector('[data-stat="turns"]').textContent,
        generationMs: liveGenerationMs, decodeTokens: liveDecodeTokens,
        roundStartedAt: liveRoundStartedAt,
        steps: statusBar.querySelector('[data-stat="steps"]').textContent,
        total: statusBar.querySelector('[data-stat="total"]').textContent,
        usageHidden: statusBar.querySelector('[data-stat-pill="usage"]').hidden,
        timeRows: statPanelRows('time'), usageRows: statPanelRows('usage') };
    }
    function renderStatPopover() { recordPaint(snapshot()); }
    updateStatusBar();
    ({ done: () => runTurn('hello', 'S', [], () => { accepted += 1; }),
       emitUser: persistedUser,
       replay: (upTo) => {
         sessionLoading = { generation: 1, id: 'S', events: [] };
         persistedUser();
         drawKeptEvents(1, upTo);
       },
       admission: () => ({ posts, accepted }),
       baseline: () => { sessionStats = { turns: 5 }; updateStatusBar(); },
       completed: () => {
         persistedUser();
         sessionListener({ data: JSON.stringify({ session: 'S', event: { type: 'turn/completed', seq: 11 } }) });
       },
       refresh: refreshSessionStats,
       blank: () => { current = null; composerKey = QUEUE_KEY_NONE; sessionStats = null; stopRequested = false; updateStatusBar(); },
       unavailable: () => { current = null; unavailableSession = 'missing'; updateStatusBar(); },
       created: (order) => { adoptionOrder = order; return runTurn('own prompt', QUEUE_KEY_NONE); },
       switchSession: (id = 'T') => {
         current = id; sessionStats = { turns: 9, steps: 10, usage: { inputTokens: 7, outputTokens: 2 } };
         liveRounds = 4; liveUsage = { inputTokens: 3, outputTokens: 1 }; if (liveTurns instanceof Map) liveTurns.set(id, liveTurns.get(id) ?? 2); else liveTurns = 2;
         liveGenerationMs = 200; liveDecodeTokens = 5; liveRoundStartedAt = 123;
         updateStatusBar();
       }, snapshot })
  `, { admission, outcome, setTimeout, initialUsage: { ...liveUsage }, TextEncoder, TextDecoder, performance: { now: () => 42 },
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
  assert.equal(at.turns, 1, 'the persisted user event stays counted until the durable fold is read')
  assert.equal(at.turnsText, '1 turns', 'the dock keeps the legitimate turn during settlement')
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
  assert.equal(at.turnsText, '1 turns', 'folded turns are counted exactly once')
  assert.equal(at.steps, '3 steps', 'folded steps are counted exactly once')
  assert.equal(at.total, '200 tok', 'folded tokens are counted exactly once')
}

for (const admission of ['offline', 'refused', 'stream-unavailable'] as const) {
  test(`turn admission: actual runTurn leaves five turns unchanged after ${admission}`, async () => {
    const h = harness(admission)
    h.baseline()
    const before = h.snapshot()
    for (let attempt = 0; attempt < 2; attempt += 1) await assert.rejects(h.done())
    assert.deepEqual(h.snapshot(), before, 'a failed local send contributes no persisted user turn')
    assert.equal(h.snapshot().turnsText, '5 turns')
    assert.equal(h.admission().accepted, 0, 'a refused send never retires the queued echo')
    assert.equal(h.admission().posts, admission === 'stream-unavailable' ? 0 : admission === 'offline' ? 4 : 2)
    const refreshing = h.refresh()
    pendingRead(h).reject(new Error('still offline'))
    await refreshing
    assert.deepEqual(h.snapshot(), before, 'a failed statistics read cannot hide a phantom increment')
  })
}

for (const admission of ['streamed', 'detached'] as const) {
  test(`turn admission: persisted ${admission} provider failure counts one legitimate turn`, async () => {
    const h = harness(admission, 'error')
    h.baseline()
    await h.done()
    assert.equal(h.admission().accepted, 1)
    assert.equal(h.snapshot().turns, 1)
    assert.equal(h.snapshot().turnsText, '6 turns', 'provider failure does not undo the persisted prompt')
    const refreshing = h.refresh()
    pendingRead(h).reject(new Error('statistics offline'))
    await refreshing
    assert.equal(h.snapshot().turnsText, '6 turns', 'failed statistics GET preserves the real turn')
    const foldedRead = h.refresh()
    h.reads[1]!.resolve({ ok: true, json: async () => ({ stats: { turns: 6 } }) })
    await foldedRead
    assert.equal(h.snapshot().turns, 0)
    assert.equal(h.snapshot().turnsText, '6 turns', 'durable replacement counts the failed turn once')
  })
}

test('turn admission: an observed persisted prompt counts even when its acknowledgment is lost', async () => {
  const h = harness('lost-ack')
  await assert.rejects(h.done(), /acknowledgment lost/)
  assert.equal(h.admission().accepted, 0)
  // sendTurn retains its existing retry policy: both attempts really persisted one prompt in this fixture.
  assert.equal(h.admission().posts, 2)
  assert.equal(h.snapshot().turns, 2, 'count persisted messages rather than successful acknowledgments')
})

for (const order of ['before', 'after'] as const) {
  test(`turn admission N1: no-current external user then created-session own user ${order} 202 adoption shows one turn`, async () => {
    const h = harness('detached', 'error')
    h.blank()
    h.emitUser('external', 1)
    assert.equal(h.snapshot().dockHidden, true, 'no session still has no dock')
    await h.created(order)
    const at = h.snapshot()
    assert.equal(at.current, 'N', 'actual runTurn adopts the 202-created session')
    assert.equal(at.turns, 1, 'its known persisted user survives either adoption order')
    assert.equal(at.turnsText, '1 turns', 'the external user must not make the created session say two')
    assert.deepEqual(at.counts, [['external', 1], ['N', 1]], 'both sessions retain only their own live facts')
    const refreshing = h.refresh()
    assert.equal(h.reads[0]!.url, '/api/sessions/N')
    h.reads[0]!.resolve({ ok: true, json: async () => ({ stats: { turns: 1 } }) })
    await refreshing
    assert.equal(h.snapshot().turnsText, '1 turns', 'the created-session fold counts its prompt once')
    assert.deepEqual(h.snapshot().counts, [['external', 1]], 'reading N clears N only, not the external session')
  })
}

test('turn admission: a shown-session fold preserves another session count and unavailable history guards counting', async () => {
  const h = harness()
  h.emitUser('T', 1)
  h.emitUser('S', 2)
  assert.equal(h.snapshot().turnsText, '1 turns', 'T never changes S dock')
  const refreshing = h.refresh()
  pendingRead(h).resolve({ ok: true, json: async () => ({ stats: { turns: 1 } }) })
  await refreshing
  assert.deepEqual(h.snapshot().counts, [['T', 1]], 'only the read session clears')
  h.unavailable()
  const before = h.snapshot()
  h.emitUser('T', 3)
  h.emitUser('missing', 4)
  assert.deepEqual(h.snapshot(), before, 'unavailable history cannot become a partial live count or dock')
})

test('turn admission: existing session filter and history cutoff count only new shown-session user facts', () => {
  const h = harness()
  h.baseline()
  h.emitUser('T')
  assert.equal(h.snapshot().turnsText, '5 turns', 'another session cannot change the shown dock')
  h.replay(10)
  assert.equal(h.snapshot().turnsText, '5 turns', 'the history baseline already includes the buffered event')
  h.replay(9)
  assert.equal(h.snapshot().turnsText, '6 turns', 'one buffered event beyond the baseline counts once')
  h.emitUser('S', 11)
  assert.equal(h.snapshot().turnsText, '7 turns', 'a new turn from another client follows the same persisted path')
})

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
