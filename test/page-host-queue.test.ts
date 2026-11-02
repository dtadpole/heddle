import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The page's host queue under failure (issue #162, developer-twelve's review), run as the page's own code.
 *
 * A send with `queue: true` is keyed by its `requestId` on the host, so a lost or unreadable answer is retried with the
 * same id; only a definitive refusal gives the words and the files back, together; an answer that never came back
 * leaves the row `Not confirmed` instead of inviting a second send; a removal keeps its row until the host answers.
 */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')

function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  return page.slice(start, end + 2)
}

type Answer = { status: number; body?: unknown; text?: string } | 'throw' | (() => Promise<{ status: number; body?: unknown; text?: string }>)

interface Row {
  id: string
  requestId?: string
  hostId?: string
  text: string
  status: string
  host?: boolean
  attachments?: unknown[]
}

interface Harness {
  enqueue(text: string, attachments?: unknown[]): Promise<void>
  sync(): Promise<void>
  remove(id: string): void
  queue: Row[]
  posts: { requestId: string }[]
  notes: string[]
  draft(): string
  setDraft(text: string): void
  files(): unknown[]
  setFiles(files: unknown[]): void
  advance(ms: number): void
}

/** The page's queue functions over a scripted fetch: `turn` answers each POST in order, `list` answers GET queue. */
function harness(turn: Answer[], list: () => unknown[] = () => [], remove: Answer[] = []): Harness {
  const context = {
    turn,
    list,
    removeAnswers: remove,
    clock: { now: 0 },
    posts: [] as { requestId: string }[],
    notes: [] as string[],
    Response: undefined,
  }
  return runInNewContext(
    `
    const QUEUE_KEY_NONE = ''
    let composerKey = 'session-1'
    let queueSeq = 0
    let editing = null
    let pendingAttachments = []
    const field = { value: '' }
    const queue = []
    const NOT_FORWARDED = new Set([502, 503, 504])
    const hostQueueReads = new Map()
    const admittedRequests = new Set()
    const UNCONFIRMED_RETRY_MS = 5000
    const Date = { now: () => clock.now }
    function queueOf() { return queue }
    function renderQueue() {}
    function renderPendingAttachments() {}
    function growComposer() {}
    function add(kind, text) { notes.push(text) }
    let requestCounter = 0
    function newRequestId() { return 'request-' + (++requestCounter) }
    // The backoff between attempts runs at once; the unconfirmed row's later read is left to the test (sync()).
    const setTimeout = (fn, ms) => { if (ms !== UNCONFIRMED_RETRY_MS) setImmediate(fn) }
    const reply = async (answer) => {
      const value = typeof answer === 'function' ? await answer() : answer
      if (value === 'throw' || value === undefined) throw new Error('the connection dropped')
      return {
        status: value.status,
        ok: value.status >= 200 && value.status < 300,
        json: async () => { if (value.body === undefined) throw new SyntaxError('not JSON'); return value.body },
        text: async () => value.text ?? JSON.stringify(value.body ?? ''),
      }
    }
    async function fetch(url, init = {}) {
      if (url === '/api/turn') {
        const body = JSON.parse(init.body)
        posts.push({ requestId: body.requestId })
        return reply(turn.shift())
      }
      if (url.endsWith('/queue/remove')) return reply(removeAnswers.shift())
      if (url.endsWith('/queue')) return reply({ status: 200, body: { items: list() } })
      throw new Error('unexpected ' + url)
    }
    ${source('restoreSend')}
    ${source('postQueued')}
    ${source('hostEnqueue')}
    ${source('settleSend')}
    ${source('syncHostQueue')}
    ${source('hostRemove')}
    ${source('removeItem')}
    ({
      enqueue: (text, attachments = []) => hostEnqueue(composerKey, text, attachments),
      sync: () => syncHostQueue(composerKey),
      remove: (id) => removeItem(id),
      queue,
      posts,
      notes,
      draft: () => field.value,
      setDraft: (text) => { field.value = text },
      files: () => pendingAttachments,
      setFiles: (files) => { pendingAttachments = files },
      advance: (ms) => { clock.now += ms },
    })
    `,
    { ...context, setImmediate, JSON, Error, SyntaxError, Promise, Map, Set, Array, String, Math },
  ) as Harness
}

const settle = () => new Promise((resolvePromise) => setImmediate(resolvePromise))
/** The page runs in its own realm: compare plain copies of what it holds. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const hostRow = (id: string, requestId: string, text: string) => ({ id, requestId, text, editable: true, content: [{ type: 'text', text }] })

test('an unreadable 202 is retried with the same request id, and the row becomes the host’s', async () => {
  const page = harness([{ status: 202 }, { status: 202, body: { queued: true, id: 'inbox-1', requestId: 'request-1' } }])
  await page.enqueue('hello')
  assert.deepEqual(
    plain(page.posts.map((post) => post.requestId)),
    ['request-1', 'request-1'],
    'the retry carries the same id',
  )
  assert.deepEqual(plain(page.queue.map((row) => [row.status, row.hostId])), [['host', 'inbox-1']], 'the row is the host’s')
  await page.sync()
  assert.equal(page.queue.length, 0, 'and the host’s list (empty here, as once claimed) is what the dock then draws')
  assert.equal(page.draft(), '', 'nothing is given back')
})

test('a lost answer is retried with the same id; after three it is Not confirmed and nothing is given back', async () => {
  const files = [{ path: '/tmp/a.png', name: 'a.png', bytes: 3 }]
  const page = harness(['throw', 'throw', 'throw'], () => [])
  await page.enqueue('lost', files)
  assert.deepEqual(
    plain(page.posts.map((post) => post.requestId)),
    ['request-1', 'request-1', 'request-1'],
  )
  assert.deepEqual(
    plain(page.queue.map((row) => [row.text, row.status, row.requestId])),
    [['lost', 'unknown', 'request-1']],
    'the row stays, unconfirmed, with its id',
  )
  assert.equal(page.draft(), '', 'the words are not given back, which would invite a second send')
  assert.deepEqual(plain(page.files()), [], 'nor the files')
})

test('an unconfirmed row is adopted when the host’s queue lists its request id', async () => {
  let listed: unknown[] = []
  const page = harness(['throw', 'throw', 'throw'], () => listed)
  await page.enqueue('lost then found')
  listed = [hostRow('inbox-7', 'request-1', 'lost then found')]
  await page.sync()
  assert.deepEqual(
    plain(page.queue.map((row) => [row.text, row.status, row.hostId])),
    [['lost then found', 'host', 'inbox-7']],
    'one row, the host’s',
  )
})

test('a definitive refusal gives the words and the files back together, or keeps both on the row', async () => {
  const files = [{ path: '/tmp/a.png', name: 'a.png', bytes: 3 }]
  const untouched = harness([{ status: 400, text: 'one message may carry at most 10 attachments' }])
  await untouched.enqueue('refused', files)
  assert.equal(untouched.draft(), 'refused')
  assert.deepEqual(plain(untouched.files()), files, 'the files come back with the words')
  assert.equal(untouched.queue.length, 0)

  const typing = harness([{ status: 400, text: 'refused' }])
  typing.setDraft('something new')
  await typing.enqueue('refused', files)
  assert.equal(typing.draft(), 'something new', 'a draft that moved on is not overwritten')
  assert.deepEqual(
    plain(typing.queue.map((row) => [row.text, row.status, row.attachments])),
    [['refused', 'failed', files]],
    'and the row keeps the words and the files, Not sent',
  )
})

test('a host event that lands before the POST answers does not duplicate the row', async () => {
  let release: (value: { status: number; body: unknown }) => void = () => {}
  const answer = () => new Promise<{ status: number; body: unknown }>((resolvePromise) => (release = resolvePromise))
  let listed: unknown[] = []
  const page = harness([answer], () => listed)
  const sent = page.enqueue('early event')
  await settle()
  listed = [hostRow('inbox-3', 'request-1', 'early event')]
  await page.sync()
  assert.deepEqual(
    plain(page.queue.map((row) => [row.status, row.hostId])),
    [['host', 'inbox-3']],
  )
  release({ status: 202, body: { queued: true, id: 'inbox-3', requestId: 'request-1' } })
  await sent
  assert.equal(page.queue.length, 1, 'still one row after the answer')
})

test('a removal keeps its row until the host answers, and a failed one puts it back', async () => {
  const listed = [hostRow('inbox-1', 'request-1', 'keep me')]
  const page = harness([{ status: 202, body: { queued: true, id: 'inbox-1', requestId: 'request-1' } }], () => listed, ['throw'])
  await page.enqueue('keep me')
  await page.sync()
  const row = page.queue[0]!
  page.remove(row.id)
  assert.equal(page.queue[0]?.status, 'removing', 'shown as Removing… while the host is asked')
  await settle()
  await settle()
  await page.sync()
  assert.deepEqual(
    plain(page.queue.map((entry) => [entry.text, entry.status])),
    [['keep me', 'host']],
    'the host still holds it, and so does the dock',
  )
  assert.ok(page.notes.some((note) => /not confirmed/.test(note)))
})

test('a 202 whose id is empty is no receipt: it is retried with the same id', async () => {
  const page = harness([{ status: 202, body: { queued: true, id: '' } }, { status: 202, body: { queued: true, id: 'inbox-2', pending: true } }])
  await page.enqueue('empty id')
  assert.deepEqual(plain(page.posts.map((post) => post.requestId)), ['request-1', 'request-1'])
  assert.deepEqual(plain(page.queue.map((row) => [row.status, row.hostId])), [['host', 'inbox-2']])
})

test('an unconfirmed row the host already claimed is settled by posting the same request again', async () => {
  const page = harness(['throw', 'throw', 'throw', { status: 202, body: { queued: true, id: 'inbox-9', duplicate: true, pending: false } }], () => [])
  await page.enqueue('claimed while unconfirmed')
  assert.equal(page.queue[0]?.status, 'unknown')
  await page.sync()
  assert.equal(page.posts.length, 3, 'not asked again before the retry time')
  page.advance(5000)
  await page.sync()
  await settle()
  await settle()
  assert.deepEqual(plain(page.posts.map((post) => post.requestId)), ['request-1', 'request-1', 'request-1', 'request-1'], 'the same request, once more')
  assert.equal(page.queue.length, 0, 'the host says its turn took it: the row is settled, not left Not confirmed')
})

test('an unconfirmed row the host still holds is adopted when the same request is posted again', async () => {
  let listed: unknown[] = []
  const page = harness(['throw', 'throw', 'throw', async () => {
    listed = [hostRow('inbox-4', 'request-1', 'pending while unconfirmed')]
    return { status: 202, body: { queued: true, id: 'inbox-4', duplicate: true, pending: true } }
  }], () => listed)
  await page.enqueue('pending while unconfirmed')
  page.advance(5000)
  await page.sync()
  await settle()
  await settle()
  await settle()
  assert.deepEqual(plain(page.queue.map((row) => [row.status, row.hostId])), [['host', 'inbox-4']])
})

test('a refusal after the host was seen holding the request does not give the message back', async () => {
  let listed: unknown[] = []
  let page: Harness
  page = harness([
    async () => {
      // Accepted, its answer lost, and the host's event read before the retry.
      listed = [hostRow('inbox-5', 'request-1', 'admitted then refused')]
      await page.sync()
      throw new Error('the connection dropped')
    },
    { status: 409, text: 'session is archived' },
  ], () => listed)
  await page.enqueue('admitted then refused')
  assert.equal(page.draft(), '', 'the words are not given back: the host has the message')
  assert.deepEqual(plain(page.queue.map((row) => [row.text, row.status])), [['admitted then refused', 'host']])
})

test('a removal settles by the host’s list even when a read replaced its row meanwhile', async () => {
  const listed = [hostRow('inbox-1', 'request-1', 'still here')]
  let fail: () => void = () => {}
  const removal = () =>
    new Promise<{ status: number }>((_, reject) => {
      fail = () => reject(new Error('the connection dropped'))
    })
  const page = harness([{ status: 202, body: { queued: true, id: 'inbox-1', pending: true } }], () => listed, [removal])
  await page.enqueue('still here')
  await page.sync()
  page.remove(page.queue[0]!.id)
  await settle()
  await page.sync()
  assert.equal(page.queue[0]?.status, 'removing', 'a read during the removal keeps the mark on the new row')
  fail()
  for (let i = 0; i < 6; i += 1) await settle()
  assert.deepEqual(plain(page.queue.map((row) => [row.text, row.status])), [['still here', 'host']], 'the host still lists it, so it is queued again, not stuck Removing…')
  assert.ok(page.notes.some((note) => /not confirmed/.test(note)))
})
