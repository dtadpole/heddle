import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * A message sent from the blank composer while the page boots, run out of the page: `runTurn` with its stream and the
 * boot's tree read stubbed.
 *
 * developer-ten's N1 on follow-up 1 (c973210c): the composer's handlers are live before the boot's top-level awaits, so
 * a message can be sent before the tree is drawn. Its turn waits on `firstTreeReady`, which resolves only after
 * `restoreSelection` has opened the saved session X. The turn then creates session N, and its `session` frame set
 * `current = N` without a new generation or a redraw: X's history stayed on screen and N's live events were appended
 * under it. The frame now opens N as any open is (`showSession`) when the panel shows another session.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start, page.indexOf('\n}\n', start) + 2)
}

interface Run {
  /** Start the turn; it waits on the boot's tree read. */
  send(): Promise<void>
  /** The boot's restoreSelection opening `id` (null for none), then the tree read resolving. */
  boot(id: string | null): void
  /** The boot's restore of `id` failing (#56): nothing is current, and `id` is the unavailable session on screen. */
  bootUnavailable(id: string): void
  current(): string | null
  unavailable(): string | null
  opened(): string
  adopted(): string
  /** The workspace the page remembered as this browser's last (#142), or null. */
  remembered(): string | null
}

function harness(created: string): Run {
  return runInNewContext(
    `
    const QUEUE_KEY_NONE = '__none__'
    const NO_WORKSPACE_REFUSAL = 'Choose a workspace first.'
    let current = null
    let unavailableSession = null
    let activeFolder = null
    let workspaceRoutes = 'served'
    let liveTurns = 0
    let directTurnPending = 0
    let directPendingKey = null
    let stopRequested = false
    const opened = []
    const adopted = []
    let remembered = null
    /** The page's memory of this browser's last workspace (#142): here, what it was asked to keep. */
    const rememberWorkspace = (path) => { remembered = path }
    let ready
    const firstTreeReady = new Promise((resolve) => { ready = resolve })
    const newConversationTarget = () => ({ path: '/work/default-workspace', label: 'Default workspace' })
    const updateStatusBar = () => {}
    const selectionForTurn = () => ({})
    const rememberCurrent = () => {}
    const chooseWorkspace = () => {}
    const adoptSession = (id) => { adopted.push(id) }
    /** What was queued behind the message moves with the session it created (here, nothing was queued). */
    const adoptLooseQueue = () => {}
    /** #142: what the stream held for this turn while nothing was open; nothing here draws it. */
    const holdLooseTurn = () => {}, adoptLooseEvents = () => {}
    const fetchSessionAccess = async () => {}
    const stopTurn = async () => {}
    /** The page's own open: it ends an unavailable session's state, makes the session current and redraws it (here, records that it was asked). */
    const showSession = async (id) => { opened.push(id); unavailableSession = null; current = id; return true }
    const frames = 'event: session\\ndata: ' + JSON.stringify({ session: CREATED }) + '\\n\\n'
    /** #128: a turn is sent once the page follows the event stream; here it always does. */
    const events = { whenOpen: async () => {} }
    /**
     * The turn is answered as a stream, the shape a server without #128's detach still sends; runTurn reads its frames
     * through the same verdict() as a detached turn's, so the N1 adoption below is judged either way.
     */
    const sendTurn = async () => ({
      ok: true,
      headers: { get: (name) => (name === 'content-type' ? 'text/event-stream' : null) },
      body: {
        getReader() {
          let sent = false
          return { read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: new TextEncoder().encode(frames) })) }
        },
      },
    })
    ${source('runTurn')}
    let running
    ;({
      send() { running = runTurn('hello', QUEUE_KEY_NONE); return running },
      boot(id) { if (id !== null) { current = id; opened.push(id) } ready() },
      bootUnavailable(id) { opened.push(id); unavailableSession = id; current = null; ready() },
      current: () => current,
      unavailable: () => unavailableSession,
      opened: () => opened.join(','),
      adopted: () => adopted.join(','),
      remembered: () => remembered,
    })
    `,
    { CREATED: created, JSON, Promise, TextEncoder, TextDecoder, performance, Error, Array, Object, String, Number, Set, Map },
  ) as Run
}

const X = 'session-00000000-0000-0000-0000-00000000000a'
const N = 'session-00000000-0000-0000-0000-00000000000b'

test('a turn sent during the boot opens the session it created when the boot opened another one meanwhile (N1)', async () => {
  const run = harness(N)
  const sent = run.send()
  run.boot(X)
  await sent
  assert.equal(run.opened(), `${X},${N}`, 'the created session is opened as any open is, after the saved one')
  assert.equal(run.current(), N, 'and is the one shown')
})

test('a turn sent with nothing open simply adopts the session it created, as before', async () => {
  const run = harness(N)
  const sent = run.send()
  run.boot(null)
  await sent
  assert.equal(run.opened(), '', 'no open is needed: nothing else is on screen')
  assert.equal(run.current(), N, 'the created session is current')
  assert.equal(run.adopted(), N, 'and the composer adopts it')
  assert.equal(run.remembered(), '/work/default-workspace', 'and the workspace it started in is remembered as this browser\'s last (#142)')
})

test('a turn that created its session in a workspace remembers that workspace even when the boot opened another one meanwhile (#142)', async () => {
  const run = harness(N)
  const sent = run.send()
  run.boot(X)
  await sent
  assert.equal(run.remembered(), '/work/default-workspace', 'the workspace the first message started its session in')
})

test('a turn sent during the boot opens the session it created when the boot\'s restore failed and shows Session unavailable (N1a)', async () => {
  /**
   * developer-ten's N1a on follow-up 2: the session frame asked only `current !== null`. After a failed restore (#56)
   * nothing is current and session A is the unavailable one on screen, with the composer disabled; the frame then set
   * `current = N` and left `unavailableSession = A`, so the composer stayed "Session unavailable" over N's live turn.
   * It now opens N through `showSession`, which ends A's state, whenever the panel shows another session or A's failure.
   */
  const run = harness(N)
  const sent = run.send()
  run.bootUnavailable(X)
  await sent
  assert.equal(run.opened(), `${X},${N}`, 'the created session is opened as any open is')
  assert.equal(run.current(), N)
  assert.equal(run.unavailable(), null, 'and the unavailable state is over, so the composer takes N\'s turn')
})
