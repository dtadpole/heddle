import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { test } from 'node:test'

import { newClientId, READY_EVENT, readyData, readyFrame, STREAM_OPEN } from '../src/server/stream.ts'

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
