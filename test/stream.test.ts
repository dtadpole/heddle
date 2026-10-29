import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { test } from 'node:test'

import {
  DEFAULT_HEARTBEAT_MS,
  EventLog,
  RESET_EVENT,
  resetFrame,
  HEARTBEAT_EVENT,
  heartbeatFrame,
  heartbeatInterval,
  newClientId,
  READY_EVENT,
  readyData,
  readyFrame,
  StallWatch,
  STREAM_OPEN,
  type WatchedSocket,
} from '../src/server/stream.ts'
import { push } from '../src/server/web.ts'

/** Parse one SSE frame block into its event name and JSON data. */
function parseFrame(block: string): { event: string; data: unknown } {
  let event = 'message'
  const data: string[] = []
  for (const line of block.replace(/\n\n$/, '').split('\n')) {
    if (line.startsWith('event: ')) event = line.slice('event: '.length)
    else if (line.startsWith('data: ')) data.push(line.slice('data: '.length))
  }
  return { event, data: JSON.parse(data.join('\n')) }
}

test('the stream opens with its comment, which every SSE parser ignores', () => {
  assert.equal(STREAM_OPEN, ': heddle stream open\n\n')
  assert.ok(STREAM_OPEN.startsWith(':'), 'a comment line, so no client takes it for an event')
})

test("the ready frame is DSH's opening item: type ready, a client id, and the Host's home", () => {
  const frame = readyFrame('abc123', '/home/owner')
  assert.ok(frame.endsWith('\n\n'), 'one complete frame')
  const parsed = parseFrame(frame)
  assert.equal(parsed.event, READY_EVENT)
  assert.equal(parsed.event, 'ready')
  assert.deepEqual(parsed.data, { type: 'ready', clientId: 'abc123', host: { home: '/home/owner' } })
  // The key order is DSH's ({ type, clientId, host: { home } }) and the Rust server writes the same bytes.
  assert.equal(frame, 'event: ready\ndata: {"type":"ready","clientId":"abc123","host":{"home":"/home/owner"}}\n\n')
})

test("the Host's home defaults to this process's home folder", () => {
  assert.deepEqual(readyData('x'), { type: 'ready', clientId: 'x', host: { home: homedir() } })
})

test('every stream gets its own client id, 16 random bytes in hex', () => {
  const ids = new Set(Array.from({ length: 64 }, () => newClientId()))
  assert.equal(ids.size, 64, 'no two streams share an id')
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/)
})

test('the heartbeat is an event the page can watch, and the Rust server writes the same bytes', () => {
  const frame = heartbeatFrame()
  assert.equal(frame, 'event: heartbeat\ndata: {"type":"heartbeat"}\n\n')
  assert.equal(parseFrame(frame).event, HEARTBEAT_EVENT)
})

test("the heartbeat interval is DSH's two seconds unless HEDDLE_WEB_HEARTBEAT_MS names a usable one", () => {
  assert.equal(DEFAULT_HEARTBEAT_MS, 2000)
  assert.equal(heartbeatInterval({}), 2000)
  assert.equal(heartbeatInterval({ HEDDLE_WEB_HEARTBEAT_MS: '500' }), 500)
  for (const bad of ['', ' ', 'soon', '-5', '10', '1.5']) {
    assert.equal(heartbeatInterval({ HEDDLE_WEB_HEARTBEAT_MS: bad }), 2000, `'${bad}' falls back to the default`)
  }
})

/**
 * A socket double with Node's accounting: `written` bytes have left, `waiting` are still queued, and
 * `bytesWritten` counts both, as `net.Socket` does.
 */
function socket(waiting: number, written = 0): WatchedSocket & { waiting: number; written: number } {
  return {
    waiting,
    written,
    destroyed: false,
    get writableLength() {
      return this.waiting
    },
    get bytesWritten() {
      return this.written + this.waiting
    },
    destroy() {
      ;(this as { destroyed: boolean }).destroyed = true
    },
  }
}

test('a connection with unsent bytes that stop moving for two intervals is destroyed', () => {
  const watch = new StallWatch(1000)
  assert.equal(watch.deadlineMs, 2000)
  const dead = socket(4096, 100)
  watch.sweep([dead], 0)
  assert.deepEqual(watch.sweep([dead], 1000), [], 'one interval without progress is not yet dead')
  assert.equal(dead.destroyed, false)
  assert.deepEqual(watch.sweep([dead], 2000), [dead], 'two intervals without progress are')
  assert.equal(dead.destroyed, true)
  assert.deepEqual(watch.sweep([dead], 3000), [], 'and a destroyed socket is judged no more')
})

test('a slow but live link keeps moving bytes and is kept, as DSH keeps a congested link', () => {
  const watch = new StallWatch(1000)
  const slow = socket(65536, 0)
  for (let tick = 0; tick <= 10; tick += 1) {
    slow.written += 512 // a trickle, but progress
    assert.deepEqual(watch.sweep([slow], tick * 1000), [])
  }
  assert.equal(slow.destroyed, false)
})

test('an idle connection with nothing to send is never dead, however long it waits', () => {
  const watch = new StallWatch(1000)
  const idle = socket(0, 42)
  for (let tick = 0; tick <= 10; tick += 1) assert.deepEqual(watch.sweep([idle], tick * 10_000), [])
  assert.equal(idle.destroyed, false)
})

test('a stalled connection that drains in time is active again, and its clock restarts', () => {
  const watch = new StallWatch(1000)
  const link = socket(4096, 0)
  watch.sweep([link], 0)
  watch.sweep([link], 1500)
  link.waiting = 0 // the buffer emptied: activity
  watch.sweep([link], 1900)
  link.waiting = 8192 // queued again, no progress since
  assert.deepEqual(watch.sweep([link], 3000), [], 'the deadline counts from the last activity, not the first stall')
  assert.deepEqual(watch.sweep([link], 3900), [link])
})

test('bytes queued behind a stalled peer are not progress: a heartbeat a minute does not keep it alive', () => {
  const watch = new StallWatch(1000)
  const paused = socket(4096, 100)
  watch.sweep([paused], 0)
  paused.waiting += 40 // a heartbeat queued: Node's bytesWritten grows, nothing left the socket
  assert.deepEqual(watch.sweep([paused], 1000), [])
  paused.waiting += 40
  assert.deepEqual(watch.sweep([paused], 2000), [paused], 'still dead after two intervals')
})

test('ready carries the follow fields after DSH\'s keys, in the order the Rust server writes them', () => {
  const frame = readyFrame('abc123', '/home/owner', { cursor: 'e1-7', resumed: true, heartbeatMs: 2000 })
  assert.equal(
    frame,
    'event: ready\ndata: {"type":"ready","clientId":"abc123","host":{"home":"/home/owner"},"cursor":"e1-7","resumed":true,"heartbeatMs":2000}\n\n',
  )
})

test('the reset frame tells a client to re-read its baselines', () => {
  assert.equal(resetFrame(), 'event: reset\ndata: {"type":"reset"}\n\n')
  assert.equal(parseFrame(resetFrame()).event, RESET_EVENT)
})

test('every recorded frame gets the next id, written first so the browser takes it as its last event id', () => {
  const log = new EventLog({ epoch: 'e1' })
  assert.equal(log.cursor, 'e1-0', 'before the first frame')
  assert.equal(log.record('session', '{"a":1}'), 'id: e1-1\nevent: session\ndata: {"a":1}\n\n')
  assert.equal(log.record('approval', '{"b":2}'), 'id: e1-2\nevent: approval\ndata: {"b":2}\n\n')
  assert.equal(log.cursor, 'e1-2')
  assert.match(new EventLog().epoch, /^[0-9a-f]{16}$/, 'a fresh server picks a random epoch')
})

test('a cursor in the log is given exactly the frames after it, no duplicate and no gap', () => {
  const log = new EventLog({ epoch: 'e1' })
  for (let index = 1; index <= 5; index += 1) log.record('session', `{"n":${index}}`)
  assert.deepEqual(log.since('e1-5'), [], 'an up-to-date client is given nothing')
  assert.deepEqual(
    log.since('e1-3')?.map((text) => text.split('\n')[0]),
    ['id: e1-4', 'id: e1-5'],
  )
  assert.equal(log.since('e1-0')?.length, 5, 'a client that saw ready before any frame is given all of them')
})

test('a cursor the log cannot honour gets null, which the route answers with a reset', () => {
  const log = new EventLog({ epoch: 'e1', maxFrames: 3 })
  for (let index = 1; index <= 6; index += 1) log.record('session', `{"n":${index}}`)
  assert.equal(log.since('e0-3'), null, 'another epoch: the server restarted')
  assert.equal(log.since('e1-1'), null, 'older than the log reaches back (frames 4..6 kept)')
  assert.deepEqual(log.since('e1-3')?.length, 3, 'the oldest honoured cursor is the one just before the log')
  assert.equal(log.since('e1-9'), null, 'ahead of the log')
  for (const bad of ['', 'e1', 'e1-', '-3', 'e1-x', 'e1-3.5']) assert.equal(log.since(bad), null, `'${bad}' is malformed`)
})

test('the log is bounded by bytes as well as by count, and always keeps the newest frame', () => {
  const log = new EventLog({ epoch: 'e1', maxBytes: 100 })
  log.record('session', 'x'.repeat(60))
  log.record('session', 'y'.repeat(60))
  assert.equal(log.since('e1-0'), null, 'the first frame was evicted to keep under the byte bound')
  assert.equal(log.since('e1-1')?.length, 1)
  log.record('session', 'z'.repeat(500))
  assert.equal(log.since('e1-2')?.length, 1, 'a frame larger than the bound is still kept on its own')
})

test('a pushed change is numbered by the log, written to every subscriber, and kept for a reconnect', () => {
  const log = new EventLog({ epoch: 'e1' })
  const written: string[][] = [[], []]
  const subscribers = new Set(written.map((sink) => ({ write: (text: string) => sink.push(text) })))
  push({ log, subscribers: subscribers as never }, 'workspace', { type: 'workspace/renamed', workspace: { id: 'w-1', title: 'docs' } })
  const expected = 'id: e1-1\nevent: workspace\ndata: {"type":"workspace/renamed","workspace":{"id":"w-1","title":"docs"}}\n\n'
  assert.deepEqual(written, [[expected], [expected]], 'every page hears it, with the same id')
  assert.deepEqual(log.since('e1-0'), [expected], 'and a page that was away is given it on reconnect')
})

test('a subscriber that throws on write does not stop the push reaching the others', () => {
  const log = new EventLog({ epoch: 'e1' })
  const reached: string[] = []
  const subscribers = new Set([
    { write: () => { throw new Error('gone') } },
    { write: (text: string) => reached.push(text) },
  ])
  push({ log, subscribers: subscribers as never }, 'sessions', { type: 'session/renamed', session: 's', title: 't' })
  assert.equal(reached.length, 1)
})
