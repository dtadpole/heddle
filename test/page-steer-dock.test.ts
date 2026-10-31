import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The composer's steering rows (#31's page half), run as the page's own functions with a scripted server.
 *
 * developer-twelve's review of 535dbb66 asked for four cases, which a browser cannot time on purpose:
 * - a claim that reaches the stream before its steer's 200;
 * - a switch to another session while a steer, or a batch of them, is in flight;
 * - a claim missed while the stream was down, reconciled from the session view;
 * - a steer left by a Stop, claimed once by the next turn.
 */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
/** Functions a page from before this change lacks; a stub keeps the older behaviour measurable (the before reading). */
const OPTIONAL = new Map([
  ['reconcileSteers', 'function reconcileSteers() {}'],
  ['retireSteer', 'function retireSteer() { return false }'],
  ['claimedFor', 'function claimedFor() { return new Set() }'],
  ['goneFor', 'function goneFor() { return new Set() }'],
])
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0 && OPTIONAL.has(name)) return OPTIONAL.get(name) as string
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  assert.ok(end > start, name)
  return page.slice(start, end + 2)
}

interface Row { id: string; text: string; status: string; steerId?: string }
interface Dock {
  setKey(key: string): void
  queue(key: string): Row[]
  push(key: string, text: string): void
  deliverSteered(text: string): Promise<void>
  steerItem(id: string): Promise<void>
  steerQueue(): Promise<void>
  claim(session: string, steerId: string): void
  reconcile(session: string, body: unknown, askedAt?: number): void
  /** A view request issued now: its place on the page's clock. */
  ask(): number
  /** The running turn in a session ends (the pump may now send that session's pending rows). */
  endTurn(key: string): void
  pump(key: string): Promise<void>
  /** Turns the pump started, in order. */
  turns: { text: string; key: string }[]
  requests: { url: string; prompt: string }[]
  answer(reply: { status: number; steerId?: string }): void
}

/** The page's steering functions over a fake fetch whose answers the test releases one at a time. */
function harness(): Dock {
  const requests: { url: string; prompt: string }[] = []
  const turns: { text: string; key: string }[] = []
  const waiting: ((reply: { status: number; steerId?: string }) => void)[] = []
  const context = {
    requests,
    turns,
    fetch: (url: string, init: { body: string }) => {
      requests.push({ url, prompt: JSON.parse(init.body).prompt })
      return new Promise((resolve) => {
        waiting.push((reply) =>
          resolve({
            ok: reply.status === 200,
            status: reply.status,
            json: async () => (reply.steerId !== undefined ? { accepted: true, steerId: reply.steerId } : {}),
            text: async () => '',
          }),
        )
      })
    },
    answer: (reply: { status: number; steerId?: string }) => {
      const next = waiting.shift()
      assert.ok(next !== undefined, 'a steer request is in flight')
      next(reply)
    },
  }
  return runInNewContext(
    `
    const QUEUE_KEY_NONE = '';
    let composerKey = 'X';
    let queueSeq = 0;
    const queues = new Map();
    const earlyClaims = new Map();
    let steerClock = 0;
    const claimedSteers = new Map();
    const goneSteers = new Map();
    // The real pump, with a turn running in X: it sends nothing there until endTurn('X').
    const runningSessions = new Set(['X']);
    const directTurnsByQueue = new WeakMap();
    const pumping = new WeakSet(), stoppedQueues = new WeakSet(), queueTurnOut = new WeakSet();
    const field = { value: '' };
    function renderQueue() {}
    function renderComposerState() {}
    function add() {}
    async function runTurn(text, key, _attachments, onAccepted) { turns.push({ text, key }); onAccepted?.() }
    ${['queueOf', 'keyOfQueue', 'directTurnsFor', 'pumpQueue', 'enqueue', 'steerNow', 'deliverSteered', 'steerItem', 'steerQueue', 'claimedFor', 'goneFor', 'retireSteer', 'settleSteered', 'claimSteer', 'reconcileSteers'].map(source).join('\n')}
    ({
      setKey(key) { composerKey = key },
      queue(key) { return queueOf(key) },
      push(key, text) { queueOf(key).push({ id: text, text, status: 'pending', attachments: [] }) },
      deliverSteered: (text) => deliverSteered(text, []),
      steerItem, steerQueue,
      claim(session, steerId) { claimSteer(session, { role: 'user', source: { kind: 'steer', steerId } }) },
      reconcile: reconcileSteers,
      ask() { return ++steerClock },
      endTurn(key) { runningSessions.delete(key) },
      pump: (key) => pumpQueue(key),
      turns,
      requests, answer,
    })
  `,
    context,
  ) as Dock
}

const settle = () => new Promise((resolve) => setImmediate(resolve))
/** Every test has a short timeout: on a page with a duplicate send, an unanswered request would otherwise wait forever. */
/** Rows as plain strings in this realm: the page's arrays come from the vm context, whose Array is another one. */
const shape = (rows: Row[]) => Array.from(rows, (row) => `${row.text}:${row.status}`)

test('#31: an accepted steer stays as steering until its claim, which retires it', { timeout: 5000 }, async () => {
  const dock = harness()
  const sent = dock.deliverSteered('answer this too')
  dock.answer({ status: 200, steerId: 's1' })
  await sent
  assert.deepEqual(shape(dock.queue('X')), ['answer this too:steering'])
  dock.claim('X', 's1')
  assert.equal(dock.queue('X').length, 0)
})

test('#31: a claim that reaches the stream before the steer answered retires the row the answer would install', { timeout: 5000 }, async () => {
  const dock = harness()
  const sent = dock.deliverSteered('fast boundary')
  dock.claim('X', 's1')
  dock.answer({ status: 200, steerId: 's1' })
  await sent
  assert.equal(dock.queue('X').length, 0, 'no row left "Steering…" for good')
})

test('#31: switching to another session while a steer is in flight keeps its row, or its fallback, in the steered session', { timeout: 5000 }, async () => {
  const dock = harness()
  const accepted = dock.deliverSteered('for X')
  dock.setKey('Y')
  dock.answer({ status: 200, steerId: 's1' })
  await accepted
  assert.equal(dock.requests[0]?.url, '/api/sessions/X/steer')
  assert.deepEqual(shape(dock.queue('X')), ['for X:steering'])
  assert.equal(dock.queue('Y').length, 0, 'nothing lands in the session shown now')

  dock.setKey('X')
  const refused = dock.deliverSteered('for X again')
  dock.setKey('Y')
  dock.answer({ status: 409 })
  await refused
  assert.deepEqual(shape(dock.queue('X')), ['for X again:pending', 'for X:steering'], 'a refused steer falls back into its own queue')
  assert.equal(dock.queue('Y').length, 0)
})

test('#31: a batch steered from X keeps naming X after a switch, and a row steered alone stays in X', { timeout: 5000 }, async () => {
  const dock = harness()
  dock.push('X', 'one')
  dock.push('X', 'two')
  const batch = dock.steerQueue()
  dock.setKey('Y')
  dock.answer({ status: 200, steerId: 's1' })
  await settle()
  dock.answer({ status: 200, steerId: 's2' })
  await batch
  assert.deepEqual(Array.from(dock.requests, (request) => request.url), ['/api/sessions/X/steer', '/api/sessions/X/steer'])
  assert.deepEqual(shape(dock.queue('X')), ['one:steering', 'two:steering'])
  assert.equal(dock.queue('Y').length, 0)

  dock.setKey('X')
  dock.push('X', 'three')
  const single = dock.steerItem('three')
  dock.setKey('Y')
  dock.answer({ status: 200, steerId: 's3' })
  await single
  assert.equal(dock.requests[2]?.url, '/api/sessions/X/steer')
  assert.deepEqual(shape(dock.queue('X')), ['one:steering', 'two:steering', 'three:steering'])
})

test('#31: the session view reconciles a missed claim and draws a waiting steer this page never saw', { timeout: 5000 }, async () => {
  const dock = harness()
  const sent = dock.deliverSteered('claimed while the stream was down')
  dock.answer({ status: 200, steerId: 's1' })
  await sent
  dock.reconcile('X', { turns: [{ kind: 'user', steerId: 's1' }], pendingSteers: [{ steerId: 's2', text: 'from another tab' }] })
  assert.deepEqual(shape(dock.queue('X')), ['from another tab:steering'], 'the claimed row retires and the waiting steer is drawn')
  assert.equal(dock.queue('X')[0]?.steerId, 's2')
  dock.reconcile('X', { turns: [], pendingSteers: [{ steerId: 's2', text: 'from another tab' }] })
  assert.equal(dock.queue('X').length, 1, 'reconciling twice draws it once')
})

test('#31: a steer a Stop left waiting stays steering, and the next turn claims it exactly once', { timeout: 5000 }, async () => {
  const dock = harness()
  const sent = dock.deliverSteered('left by the stop')
  dock.answer({ status: 200, steerId: 's1' })
  await sent
  // A Stop: the server keeps the steer in the inbox (DSH's keepInbox), and the view still lists it.
  dock.reconcile('X', { turns: [], pendingSteers: [{ steerId: 's1', text: 'left by the stop' }] })
  assert.deepEqual(shape(dock.queue('X')), ['left by the stop:steering'], 'not resent, not turned back into a pending row')
  // The next turn claims it before its own prompt; a replayed claim afterwards changes nothing.
  dock.claim('X', 's1')
  assert.equal(dock.queue('X').length, 0)
  dock.claim('X', 's1')
  dock.reconcile('X', { turns: [{ kind: 'user', steerId: 's1' }], pendingSteers: [] })
  assert.equal(dock.queue('X').length, 0, 'claimed once, never drawn again')
})

test('#31: a view asked for before a steer was accepted cannot remove its row; a later view that lacks it can', { timeout: 5000 }, async () => {
  const dock = harness()
  const early = dock.ask()
  const sent = dock.deliverSteered('accepted after the view was asked')
  dock.answer({ status: 200, steerId: 's1' })
  await sent
  dock.reconcile('X', { turns: [], pendingSteers: [] }, early)
  assert.deepEqual(shape(dock.queue('X')), ['accepted after the view was asked:steering'], 'an older view says nothing about it')
  const later = dock.ask()
  dock.reconcile('X', { turns: [], pendingSteers: [] }, later)
  assert.equal(dock.queue('X').length, 0, 'a view asked for after the steer was queued, without it, retires it')
})

test('#31: a view asked for before the claim but answered after it does not draw the claimed steer again', { timeout: 5000 }, async () => {
  const dock = harness()
  const sent = dock.deliverSteered('claimed on the stream')
  dock.answer({ status: 200, steerId: 's1' })
  await sent
  const asked = dock.ask()
  dock.claim('X', 's1')
  dock.reconcile('X', { turns: [], pendingSteers: [{ steerId: 's1', text: 'claimed on the stream' }] }, asked)
  assert.equal(dock.queue('X').length, 0, 'no permanent row from a stale pending list')
})

test('#31: request, claim on the stream, a reconcile, then the 200: the claim is kept and no row is left', { timeout: 5000 }, async () => {
  const dock = harness()
  // The session already has a queue (a message waits), as on a live page, so the reconcile walks it.
  dock.push('X', 'waiting behind')
  const sent = dock.deliverSteered('fast boundary')
  dock.claim('X', 's1')
  dock.reconcile('X', { turns: [{ kind: 'user', steerId: 's1' }], pendingSteers: [] }, dock.ask())
  dock.answer({ status: 200, steerId: 's1' })
  await sent
  assert.deepEqual(shape(dock.queue('X')), ['waiting behind:pending'], 'the reconcile did not forget the claim')
})

test('#31: a view that drew the steer before its 200 leaves one row, and the claim retires every copy', { timeout: 5000 }, async () => {
  const dock = harness()
  const sent = dock.deliverSteered('drawn by the view first')
  dock.reconcile('X', { turns: [], pendingSteers: [{ steerId: 's1', text: 'drawn by the view first' }] }, dock.ask())
  dock.answer({ status: 200, steerId: 's1' })
  await sent
  assert.deepEqual(shape(dock.queue('X')), ['drawn by the view first:steering'], 'upserted by id, not duplicated')

  dock.push('X', 'row')
  const single = dock.steerItem('row')
  dock.reconcile('X', { turns: [], pendingSteers: [{ steerId: 's1', text: 'drawn by the view first' }, { steerId: 's2', text: 'row' }] }, dock.ask())
  dock.answer({ status: 200, steerId: 's2' })
  await single
  assert.deepEqual(shape(dock.queue('X')).sort(), ['drawn by the view first:steering', 'row:steering'], 'the row a view drew replaces the one being sent')
  dock.claim('X', 's1')
  dock.claim('X', 's2')
  assert.equal(dock.queue('X').length, 0, 'every copy retires on its claim')
})

test('#31: two views asked before the 200, served out of order around the queueing, cannot retire the waiting row', { timeout: 5000 }, async () => {
  // developer-twelve's combined race: view A is asked first but served after the steer was queued (it lists it);
  // view B is asked second but served before (empty) and answers last.
  for (const how of ['composer', 'row', 'batch'] as const) {
    const dock = harness()
    if (how !== 'composer') dock.push('X', 'row')
    const sent = how === 'composer' ? dock.deliverSteered('row') : how === 'row' ? dock.steerItem('row') : dock.steerQueue()
    const askedA = dock.ask()
    const askedB = dock.ask()
    dock.reconcile('X', { turns: [], pendingSteers: [{ steerId: 's1', text: 'row' }] }, askedA)
    dock.answer({ status: 200, steerId: 's1' })
    await sent
    dock.reconcile('X', { turns: [], pendingSteers: [] }, askedB)
    assert.deepEqual(shape(dock.queue('X')), ['row:steering'], `${how}: the still-waiting steer keeps its one row`)
    dock.claim('X', 's1')
    assert.equal(dock.queue('X').length, 0, `${how}: and its claim retires it`)
  }
})

test('#31: a row on its way is not sent twice: a second click and the chord both skip it', { timeout: 5000 }, async () => {
  const dock = harness()
  dock.push('X', 'a')
  dock.push('X', 'b')
  const first = dock.steerItem('a')
  const again = dock.steerItem('a')
  const chord = dock.steerQueue()
  dock.answer({ status: 200, steerId: 's-a' })
  await first
  await again
  await settle()
  dock.answer({ status: 200, steerId: 's-b' })
  await chord
  assert.deepEqual(Array.from(dock.requests, (request) => request.prompt), ['a', 'b'], 'each row reached the server once')
  assert.deepEqual(shape(dock.queue('X')), ['a:steering', 'b:steering'])
})

test('#31: a turn that ends before the steer answers does not let the pump send the reserved row as a new turn', { timeout: 5000 }, async () => {
  const dock = harness()
  dock.push('X', 'late steer')
  const steering = dock.steerItem('late steer')
  dock.endTurn('X')
  await dock.pump('X')
  assert.equal(dock.turns.length, 0, 'the pump skips a row whose steer is in flight')
  dock.answer({ status: 409 })
  await steering
  await settle()
  assert.deepEqual(Array.from(dock.turns, (turn) => turn.text), ['late steer'], 'refused, it goes back to the queue and is sent once')
  assert.equal(dock.requests.length, 1, 'and was steered once')
  assert.equal(dock.queue('X').length, 0)
})

test('#31: once a newer view showed a steer gone, an older view that still lists it cannot draw it again', { timeout: 5000 }, async () => {
  const dock = harness()
  const sent = dock.deliverSteered('claimed while the stream was down')
  dock.answer({ status: 200, steerId: 's1' })
  await sent
  const older = dock.ask()
  const newer = dock.ask()
  dock.reconcile('X', { turns: [], pendingSteers: [] }, newer)
  assert.equal(dock.queue('X').length, 0, 'the newer, authoritative view retires it')
  dock.reconcile('X', { turns: [], pendingSteers: [{ steerId: 's1', text: 'claimed while the stream was down' }] }, older)
  assert.equal(dock.queue('X').length, 0, 'the older view answering last does not resurrect it')
})
