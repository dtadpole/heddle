import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Unit tests for the page's per-session scroll memory (C74 in the parity inventory): DSH restores a transcript's place
 * on return, and keeps a reader who was following the tail at the tail. The object is read out of page.html between
 * its markers, so the page and this test judge one source.
 */
const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* chat-scroll:begin */')
const end = page.indexOf('/* chat-scroll:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences ChatScrollMemory with its markers')

interface Place { showing: boolean; rows: number; following: boolean; top: number }
interface Memory {
  remember: (session: string | null, place: Place) => boolean
  plan: (session: string) => { follow: true } | { follow: false; top: number }
}
const ChatScrollMemory = new Function(`${page.slice(begin, end)}\nreturn ChatScrollMemory`)() as { create: () => Memory }

test('a session opened for the first time follows its tail', () => {
  assert.deepEqual(ChatScrollMemory.create().plan('session-a'), { follow: true })
})

test('a reader who scrolled back is returned to the same place, per session', () => {
  const memory = ChatScrollMemory.create()
  assert.equal(memory.remember('session-a', { showing: true, rows: 12, following: false, top: 300 }), true)
  memory.remember('session-b', { showing: true, rows: 4, following: false, top: 40 })
  assert.deepEqual(memory.plan('session-a'), { follow: false, top: 300 })
  assert.deepEqual(memory.plan('session-b'), { follow: false, top: 40 })
})

test('a reader who was following the tail keeps following it', () => {
  const memory = ChatScrollMemory.create()
  memory.remember('session-a', { showing: true, rows: 12, following: false, top: 300 })
  memory.remember('session-a', { showing: true, rows: 13, following: true, top: 1600 })
  assert.deepEqual(memory.plan('session-a'), { follow: true }, 'the latest visit decides')
})

test('a hidden or empty transcript, or no session, records nothing', () => {
  const memory = ChatScrollMemory.create()
  memory.remember('session-a', { showing: true, rows: 12, following: false, top: 300 })
  assert.equal(memory.remember('session-a', { showing: false, rows: 12, following: false, top: 0 }), false, 'a hidden transcript reads as the top')
  assert.equal(memory.remember('session-a', { showing: true, rows: 0, following: false, top: 0 }), false, 'an empty one has no place')
  assert.equal(memory.remember(null, { showing: true, rows: 3, following: false, top: 10 }), false)
  assert.deepEqual(memory.plan('session-a'), { follow: false, top: 300 }, 'the earlier place stands')
})

test('a nonsense position is kept as the top, never as a negative or NaN scroll', () => {
  const memory = ChatScrollMemory.create()
  memory.remember('session-a', { showing: true, rows: 2, following: false, top: Number.NaN })
  assert.deepEqual(memory.plan('session-a'), { follow: false, top: 0 })
  memory.remember('session-a', { showing: true, rows: 2, following: false, top: -5 })
  assert.deepEqual(memory.plan('session-a'), { follow: false, top: 0 })
})
