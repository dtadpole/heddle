import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * One long-held connection per browser, whatever the number of tabs and running turns (#128), judged on the page's own
 * code run in `node:vm`.
 *
 * A browser allows six connections per host, shared by every tab. Measured before (issue #128, developer-six, both
 * builds): each tab held one `EventSource` and each running turn held its `POST /api/turn` answer, so five running
 * turns in one tab, or six tabs, stalled every other request and the sixth tab never loaded.
 *
 * - The tabs of one server share one stream: the tab holding the `heddle-events` lock opens the source and relays its
 *   frames over a `BroadcastChannel`; a waiting tab takes over when it closes, from the newest id it was given, and a
 *   tab brought to the front takes the stream over. A replayed frame is not delivered twice.
 * - A turn is sent `detach`ed and waits for its verdict on the stream, which may arrive before the `202`; a verdict the
 *   stream lost ends with a sessions read that finds the session idle.
 *
 * The browser checks (`_verifiers_/80-web-ui/check-connection-pool.mjs`) judge the same on both builds in Chrome.
 */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')

function marked(name: string): string {
  const begin = page.indexOf(`/* ${name}:begin */`)
  const end = page.indexOf(`/* ${name}:end */`)
  return begin >= 0 && end > begin ? page.slice(begin, end) : ''
}

/** A top-level `const name = (() => { … })()` block, as the page writes it. */
function block(name: string): string {
  const start = page.indexOf(`const ${name} = (() => {`)
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n})()\n', start)
  return page.slice(start, end + 6)
}

function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  return page.slice(start, end + 2)
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await flush()
}

/** The browser's lock manager for one origin: exclusive locks, a queue, and `steal`. */
class Locks {
  holder: { tab: string; reject: (error: unknown) => void } | null = null
  queue: { tab: string; callback: () => unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = []
  forTab(tab: string) {
    return {
      request: (name: string, options: unknown, maybe?: () => unknown) => {
        const callback = (typeof options === 'function' ? options : maybe) as () => unknown
        const steal = typeof options === 'object' && options !== null && (options as { steal?: boolean }).steal === true
        return new Promise((resolve, reject) => {
          const entry = { tab, callback, resolve, reject }
          if (steal) {
            if (this.holder !== null) this.holder.reject({ name: 'AbortError' })
            this.holder = null
            this.grant(entry)
          } else {
            this.queue.push(entry)
            this.next()
          }
          void name
        })
      },
    }
  }
  grant(entry: { tab: string; callback: () => unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void }) {
    this.holder = { tab: entry.tab, reject: entry.reject }
    queueMicrotask(() => {
      Promise.resolve(entry.callback()).then(entry.resolve, entry.reject)
    })
  }
  next() {
    if (this.holder !== null) return
    const entry = this.queue.shift()
    if (entry !== undefined) this.grant(entry)
  }
  /** A closed tab's lock and waiting requests go with its document. */
  drop(tab: string) {
    this.queue = this.queue.filter((entry) => entry.tab !== tab)
    if (this.holder?.tab === tab) {
      this.holder = null
      this.next()
    }
  }
}

/** BroadcastChannel across one origin's tabs: delivered later, to every other channel of the name. */
class Bus {
  channels = new Set<{ tab: string; name: string; onmessage: ((event: { data: unknown }) => void) | null; closed: boolean }>()
  classFor(tab: string) {
    const bus = this
    return class {
      tab = tab
      name: string
      onmessage: ((event: { data: unknown }) => void) | null = null
      closed = false
      constructor(name: string) {
        this.name = name
        bus.channels.add(this)
      }
      postMessage(data: unknown) {
        const copy = JSON.parse(JSON.stringify(data))
        for (const other of bus.channels) {
          if (other === this || other.closed || other.name !== this.name) continue
          setImmediate(() => {
            if (!other.closed) other.onmessage?.({ data: copy })
          })
        }
      }
      close() {
        this.closed = true
        bus.channels.delete(this)
      }
    }
  }
  drop(tab: string) {
    for (const channel of [...this.channels]) if (channel.tab === tab) {
      channel.closed = true
      this.channels.delete(channel)
    }
  }
}

interface Source {
  url: string
  closed: boolean
  onerror: (() => void) | null
  emit(name: string, data: unknown, id?: string): void
}

interface Tab {
  name: string
  sources: Source[]
  open(): Source[]
  delivered: string[]
  body: { dataset: Record<string, string> }
  show(): void
  /** Move this tab's clock on, firing the timers that come due. */
  advance(ms: number): void
}

function tab(name: string, world: { locks?: Locks | null; bus: Bus; visible: boolean; refuse?: boolean }): Tab {
  const sources: Source[] = []
  const delivered: string[] = []
  /** The tab's own clock, so a test decides when its timers fire. */
  let now = 0
  let nextTimer = 1
  const timers = new Map<number, { due: number; fn: () => void }>()
  const body = { dataset: {} as Record<string, string> }
  const visibility: (() => void)[] = []
  const documentDouble = {
    body,
    visibilityState: world.visible ? 'visible' : 'hidden',
    getElementById: () => ({ hidden: true }),
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'visibilitychange') visibility.push(listener)
    },
  }
  class FakeEventSource implements Source {
    url: string
    closed = false
    listeners = new Map<string, ((message: { data: string; lastEventId: string }) => void)[]>()
    onerror: (() => void) | null = null
    constructor(url: string) {
      this.url = url
      sources.push(this)
    }
    addEventListener(type: string, listener: (message: { data: string; lastEventId: string }) => void) {
      const list = this.listeners.get(type) ?? []
      list.push(listener)
      this.listeners.set(type, list)
    }
    close() {
      this.closed = true
    }
    emit(type: string, data: unknown, id = '') {
      for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data), lastEventId: id })
    }
  }
  const locks =
    world.locks === null || world.locks === undefined
      ? undefined
      : world.refuse === true
        ? { request: () => Promise.reject({ name: 'SecurityError' }) }
        : world.locks.forTab(name)
  const context = {
    document: documentDouble,
    navigator: locks === undefined ? {} : { locks },
    BroadcastChannel: world.bus.classFor(name),
    EventSource: FakeEventSource,
    setTimeout: (fn: () => void, ms = 0) => {
      const id = nextTimer++
      timers.set(id, { due: now + ms, fn })
      return id
    },
    clearTimeout: (id: number) => {
      timers.delete(id)
    },
    console,
    delivered,
  }
  runInNewContext(
    `${marked('feed-order')}
    ${block('events')};
    events.addEventListener('session', (message) => delivered.push(JSON.parse(message.data).n))
    `,
    context,
  )
  return {
    name,
    sources,
    open: () => sources.filter((source) => !source.closed),
    delivered,
    body,
    show() {
      documentDouble.visibilityState = 'visible'
      for (const listener of visibility) listener()
    },
    advance(ms: number) {
      now += ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.due <= now).sort((a, b) => a[1].due - b[1].due)[0]
        if (due === undefined) return
        timers.delete(due[0])
        due[1].fn()
      }
    },
  }
}

function close(world: { locks: Locks; bus: Bus }, closing: Tab): void {
  for (const source of closing.sources) source.closed = true
  world.bus.drop(closing.name)
  world.locks.drop(closing.name)
}

const ready = (cursor: string) => ({ type: 'ready', cursor, resumed: false, heartbeatMs: 2000 })

test('two tabs of one server hold one stream: the second delivers what the first relays', { timeout: 5000 }, async () => {
  const world = { locks: new Locks(), bus: new Bus() }
  const first = tab('first', { ...world, visible: true })
  await settle()
  const second = tab('second', { ...world, visible: false })
  await settle()
  assert.equal(first.open().length, 1, 'the first tab opened the stream')
  assert.equal(second.open().length, 0, 'the second tab opened none of its own')
  assert.equal(first.body.dataset.feed, 'leader')
  assert.equal(second.body.dataset.feed, 'follower')
  const stream = first.open()[0]!
  stream.emit('ready', ready('e-0'))
  stream.emit('session', { n: 1 }, 'e-1')
  stream.emit('session', { n: 2 }, 'e-2')
  await settle()
  assert.deepEqual(Array.from(first.delivered), [1, 2])
  assert.deepEqual(Array.from(second.delivered), [1, 2], 'the frames reached the tab without a stream')
  assert.equal(second.body.dataset.connection, 'open', 'and so did the connection state')
})

test('when the leading tab closes, a waiting tab reconnects from the newest id it was given and draws nothing twice', { timeout: 5000 }, async () => {
  const world = { locks: new Locks(), bus: new Bus() }
  const first = tab('first', { ...world, visible: true })
  await settle()
  const second = tab('second', { ...world, visible: false })
  await settle()
  const stream = first.open()[0]!
  stream.emit('ready', ready('e-0'))
  stream.emit('session', { n: 1 }, 'e-1')
  await settle()
  close(world, first)
  await settle()
  assert.equal(second.body.dataset.feed, 'leader')
  assert.equal(second.open().length, 1, 'the waiting tab opened the stream')
  const resumed = second.open()[0]!
  assert.equal(resumed.url, '/api/events?cursor=e-1', 'from the newest id it was given')
  resumed.emit('ready', { ...ready('e-2'), resumed: true })
  resumed.emit('session', { n: 1 }, 'e-1')
  resumed.emit('session', { n: 2 }, 'e-2')
  await settle()
  assert.deepEqual(Array.from(second.delivered), [1, 2], 'the replayed frame is not drawn again')
})

test('a tab brought to the front takes the stream over, and the tab it took it from follows', { timeout: 5000 }, async () => {
  const world = { locks: new Locks(), bus: new Bus() }
  const first = tab('first', { ...world, visible: true })
  await settle()
  const second = tab('second', { ...world, visible: false })
  await settle()
  const old = first.open()[0]!
  old.emit('ready', ready('e-0'))
  old.emit('session', { n: 1 }, 'e-1')
  await settle()
  second.show()
  await settle()
  assert.equal(second.body.dataset.feed, 'leader')
  assert.equal(first.body.dataset.feed, 'follower')
  assert.equal(first.open().length, 0, 'the old leader closed its stream')
  const taken = second.open()[0]!
  assert.equal(taken.url, '/api/events?cursor=e-1')
  taken.emit('ready', { ...ready('e-1'), resumed: true })
  taken.emit('session', { n: 2 }, 'e-2')
  await settle()
  assert.deepEqual(Array.from(first.delivered), [1, 2], 'the old leader delivers what the new one relays')
  close(world, second)
  await settle()
  assert.equal(first.body.dataset.feed, 'leader', 'and leads again when that tab closes')
  assert.equal(first.open()[0]?.url, '/api/events?cursor=e-2')
})

test('without locks, or where the browser refuses them, a tab keeps a stream of its own', { timeout: 5000 }, async () => {
  const bus = new Bus()
  const bare = tab('bare', { locks: null, bus, visible: true })
  await settle()
  assert.equal(bare.open().length, 1)
  assert.equal(bare.body.dataset.feed, 'solo')
  const refused = tab('refused', { locks: new Locks(), bus, visible: true, refuse: true })
  await settle()
  assert.equal(refused.open().length, 1)
  assert.equal(refused.body.dataset.feed, 'solo')
})

test('a follower takes the stream over when the leading tab goes quiet while it is open', { timeout: 5000 }, async () => {
  const world = { locks: new Locks(), bus: new Bus() }
  const first = tab('first', { ...world, visible: true })
  await settle()
  const second = tab('second', { ...world, visible: false })
  await settle()
  const stream = first.open()[0]!
  stream.emit('ready', ready('e-0'))
  stream.emit('session', { n: 1 }, 'e-1')
  await settle()
  second.advance(5000)
  stream.emit('heartbeat', { type: 'heartbeat' })
  await settle()
  second.advance(5000)
  await settle()
  assert.equal(second.body.dataset.feed, 'follower', 'relayed heartbeats keep it following')
  second.advance(2100)
  await settle()
  assert.equal(second.body.dataset.feed, 'leader', 'three quiet heartbeats later it took the stream over')
  assert.equal(second.open()[0]?.url, '/api/events?cursor=e-1', 'from the newest id it was given')
  assert.equal(first.open().length, 0, 'and the tab it was taken from closed its own when it ran again')
})

test('while the leading tab is connecting, a follower waits 30 s before taking over', { timeout: 5000 }, async () => {
  const world = { locks: new Locks(), bus: new Bus() }
  const first = tab('first', { ...world, visible: true })
  await settle()
  const second = tab('second', { ...world, visible: false })
  await settle()
  const stream = first.open()[0]!
  stream.emit('ready', ready('e-0'))
  await settle()
  stream.onerror?.()
  await settle()
  assert.equal(second.body.dataset.connection, 'connecting', "the follower shows the leader's state")
  second.advance(20_000)
  await settle()
  assert.equal(second.body.dataset.feed, 'follower', 'a server that is down is not a frozen tab')
  second.advance(10_100)
  await settle()
  assert.equal(second.body.dataset.feed, 'leader', 'but 30 s of silence is')
})

test('a follower starts with no connection state of its own, until the leading tab says one', { timeout: 5000 }, async () => {
  const world = { locks: new Locks(), bus: new Bus() }
  const first = tab('first', { ...world, visible: true })
  await settle()
  const second = tab('second', { ...world, visible: false })
  assert.equal(second.body.dataset.connection, undefined, 'unknown, not connected')
  first.open()[0]!.emit('ready', ready('e-0'))
  await settle()
  assert.equal(second.body.dataset.connection, 'open')
})

test('a numbered frame is new only after the newest delivered one of its epoch; unnumbered frames always are', () => {
  const order = runInNewContext(`${marked('feed-order')}; FeedOrder`) as {
    isNew(last: { epoch: string; seq: number } | null, name: string, id: string): boolean
  }
  assert.ok(order !== undefined, 'the page carries FeedOrder between its markers')
  const last = { epoch: 'ab12', seq: 7 }
  assert.equal(order.isNew(last, 'session', 'ab12-8'), true)
  assert.equal(order.isNew(last, 'session', 'ab12-7'), false)
  assert.equal(order.isNew(last, 'session', 'ab12-3'), false)
  assert.equal(order.isNew(last, 'session', 'cd34-1'), true, 'another epoch is another stream')
  assert.equal(order.isNew(last, 'reset', 'ab12-7'), true, 'reset repeats the previous id and is still news')
  assert.equal(order.isNew(last, 'session', ''), true)
  assert.equal(order.isNew(null, 'session', 'ab12-1'), true)
})

interface Verdicts {
  receive(data: unknown): void
  wait(turn: string, session: string | null): Promise<{ outcome: string; turn: string }>
  endIdle(live: Map<string, unknown>, readTick: number): void
  tick(): number
}

function verdicts(): Verdicts {
  return runInNewContext(`
    let runningTick = 0;
    ${block('turnVerdicts')};
    ({ receive: (data) => turnVerdicts.receive(data), wait: (turn, session) => turnVerdicts.wait(turn, session), endIdle: (live, tick) => turnVerdicts.endIdle(live, tick), tick: () => runningTick })
  `) as Verdicts
}

test('a verdict that arrives before its 202 is kept for the turn, and one that arrives after ends the wait', { timeout: 5000 }, async () => {
  const kept = verdicts()
  kept.receive({ turn: 't1', outcome: 'done', session: 's' })
  assert.equal((await kept.wait('t1', 's')).outcome, 'done', 'the early verdict was kept')
  let ended = ''
  void kept.wait('t2', 's').then((verdict) => (ended = verdict.outcome))
  await flush()
  assert.equal(ended, '', 'no verdict yet: the turn is still waiting')
  kept.receive({ turn: 'other', outcome: 'done', session: 'x' })
  await flush()
  assert.equal(ended, '', "another turn's verdict does not end it")
  kept.receive({ turn: 't2', outcome: 'error', session: 's', message: 'boom' })
  await flush()
  assert.equal(ended, 'error')
})

test('a verdict the stream lost ends with a sessions read issued after the turn was accepted that finds it idle', { timeout: 5000 }, async () => {
  const lost = verdicts()
  const before = lost.tick()
  let ended = ''
  void lost.wait('t1', 's').then((verdict) => (ended = verdict.outcome))
  lost.endIdle(new Map(), before)
  await flush()
  assert.equal(ended, '', 'a read issued before the acceptance cannot end the turn')
  lost.endIdle(new Map([['s', {}]]), lost.tick())
  await flush()
  assert.equal(ended, '', 'a read that finds the session running does not end it')
  lost.endIdle(new Map(), lost.tick())
  await flush()
  assert.equal(ended, 'lost')
})

function runTurnHarness(answer: string) {
  const sent: Record<string, unknown>[] = []
  const calls: string[] = []
  const harness = runInNewContext(
    `
    let runningTick = 0, liveTurns = 0, liveRounds = 0, liveUsage, stopRequested = false, directTurnPending = 0, directPendingKey = null;
    let current = 'S', activeFolder = null;
    const QUEUE_KEY_NONE = '';
    const stopButton = { disabled: true };
    const runningSessions = new Set(['S']), runningSince = new Map();
    const log = { append() {} };
    function updateStatusBar() {}
    function selectionForTurn() { return {} }
    async function refreshSessionStats() {}
    function add(kind, text) { calls.push(kind + ':' + text) }
    function lastTurnRow() { return null }
    function turnNotice() { return {} }
    function settleReasoning() {}
    function settleChat() { calls.push('settled') }
    function refreshRunningStatus() {}
    async function renderSettledAnswers() {}
    function renderScheduleCards() {}
    async function renderTree() {}
    async function refreshSessions() { calls.push('sessions read') }
    function hideApproval() {}
    function drawTurnFailure() {}
    function paintRunningMarks() {}
    function renderComposerState() {}
    function adoptSession() {}
    async function fetchSessionAccess() {}
    async function sendTurn(body) {
      sent.push(body);
      return ${answer};
    }
    ${block('turnVerdicts')};
    ${source('runTurn')}
    ({ run: () => runTurn('hello', 'S', [], () => calls.push('accepted')), verdict: (data) => turnVerdicts.receive(data) })
    `,
    { sent, calls, performance: { now: () => 0 }, TextDecoder, chunks: CHUNKS },
  ) as { run(): Promise<void>; verdict(data: unknown): void }
  return { sent, calls, harness }
}

/** A streamed turn whose second chunk finishes a `data:` line the first one split. */
const CHUNKS = [
  'event: session\ndata: {"session":"S","event":{"type":"x"}}\n\nevent: done\ndata: {"session":"S","den',
  'ials":[{"tool":"bash","message":"no"}]}\n\n',
].map((text) => new TextEncoder().encode(text))

test('the page sends a turn detached and its runTurn ends with the verdict on the stream, not with the 202', { timeout: 5000 }, async () => {
  const { sent, calls, harness } = runTurnHarness(
    "{ ok: true, status: 202, headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) }, json: async () => ({ session: 'S', turn: 't9' }) }",
  )
  let finished = false
  let failure: unknown = null
  const running = harness.run().then(
    () => (finished = true),
    (error: unknown) => {
      failure = error
      finished = true
    },
  )
  await settle()
  assert.equal(sent[0]?.detach, true, 'the turn is sent detached')
  assert.deepEqual(Array.from(calls), ['accepted'], 'accepted at the 202')
  assert.equal(finished, false, 'and still running: the verdict has not come')
  harness.verdict({ turn: 't9', outcome: 'done', session: 'S', denials: [{ tool: 'bash', message: 'no' }] })
  await running
  assert.equal(failure, null)
  assert.ok(calls.includes('denied:bash: no'), JSON.stringify(calls))
  assert.ok(calls.includes('settled') && calls.includes('sessions read'), 'the done verdict settles the turn as the old done frame did')
})

test('a streamed turn from a server without detach is read frame by frame, each once, even when a chunk splits a line', { timeout: 5000 }, async () => {
  const { calls, harness } = runTurnHarness(
    "{ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { getReader: () => { let at = 0; return { read: async () => (at < chunks.length ? { value: chunks[at++], done: false } : { value: undefined, done: true }) } } } }",
  )
  let failure: unknown = null
  await harness.run().catch((error: unknown) => (failure = error))
  assert.equal(failure, null, 'a split data line is not a failed turn')
  assert.deepEqual(
    Array.from(calls).filter((call) => call.startsWith('denied:')),
    ['denied:bash: no'],
    'the done frame was read once, whole',
  )
})
