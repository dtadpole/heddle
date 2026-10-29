import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  DEFAULT_REFRESH_INTERVAL_MS,
  deriveBrowserTimeZone,
  foldTimeContext,
  formatDuration,
  formatTimestamp,
  recordTimeContext,
  renderBrowserTimeZone,
  timeContextReading,
} from '../src/schedule/time-context.ts'
import { SessionStore, type SessionEvent } from '../src/session/store.ts'

const root = mkdtempSync(join(tmpdir(), 'heddle-time-context-'))
after(() => rmSync(root, { recursive: true, force: true }))

/** 2026-10-29T11:30:16Z, the instant the examples below are written against. */
const T0 = Date.UTC(2026, 9, 29, 11, 30, 16)
const UNAVAILABLE = 'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.'

let seq = 0
function event(type: string, at: number, extra: Record<string, unknown> = {}): SessionEvent {
  seq += 1
  return { type, seq, at: new Date(at).toISOString(), ...extra } as unknown as SessionEvent
}
const user = (at: number, source: Record<string, unknown> = { kind: 'user' }) => event('message', at, { message: { role: 'user', content: [{ type: 'text', text: 'hi' }], source } })
const assistant = (at: number) => event('message', at, { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
const reading = (at: number) => event('context/note', at, { message: { role: 'user', content: [{ type: 'text', text: 'r' }], source: { kind: 'time-context', form: 'snapshot' } }, origin: 'time-context' })
const turnEnd = (at: number) => event('turn/completed', at, { rounds: 1 })

test('the duration is DSH compact form: zero days, hours and minutes left out, seconds always, floored', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(999), '0s')
  assert.equal(formatDuration(65_000), '1m 5s')
  assert.equal(formatDuration(3_600_000), '1h 0s')
  assert.equal(formatDuration(90_061_000), '1d 1h 1m 1s')
  assert.equal(formatDuration(-5_000), '0s', 'a negative elapsed time reads as zero')
})

test('the timestamp carries local fields, the long numeric offset and the zone in brackets', () => {
  assert.equal(formatTimestamp(T0, 'America/Los_Angeles'), '2026-10-29T04:30:16-07:00[America/Los_Angeles]')
  assert.equal(formatTimestamp(T0, 'Asia/Shanghai'), '2026-10-29T19:30:16+08:00[Asia/Shanghai]')
  assert.equal(formatTimestamp(T0, 'UTC'), '2026-10-29T11:30:16+00:00[UTC]', 'GMT reads as +00:00')
})

test('the browser zone line has DSH three forms', () => {
  assert.equal(renderBrowserTimeZone({ kind: 'resolved', timeZone: 'Asia/Shanghai' }), 'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.')
  assert.equal(
    renderBrowserTimeZone({ kind: 'mixed', timeZones: ['Asia/Shanghai', 'Europe/Paris'] }),
    'Browser time zone for this request: mixed ["Asia/Shanghai","Europe/Paris"]. Ask the user to clarify otherwise-unqualified dates and times.',
  )
  assert.equal(renderBrowserTimeZone({ kind: 'missing' }), UNAVAILABLE)
})

test('the browser zone comes from the open turn person-entered messages only', () => {
  const rpc = (zone: string) => ({ kind: 'user', rpcId: 'rpc-1', clientTimeZone: zone })
  assert.deepEqual(deriveBrowserTimeZone([user(T0)]), { kind: 'missing' }, 'a message without a zone says nothing')
  assert.deepEqual(deriveBrowserTimeZone([user(T0, rpc('Asia/Shanghai'))]), { kind: 'resolved', timeZone: 'Asia/Shanghai' })
  assert.deepEqual(deriveBrowserTimeZone([user(T0, rpc('Europe/Paris')), user(T0, rpc('Asia/Shanghai'))]), { kind: 'mixed', timeZones: ['Asia/Shanghai', 'Europe/Paris'] })
  assert.deepEqual(deriveBrowserTimeZone([user(T0, rpc('Europe/Paris')), turnEnd(T0), user(T0, rpc('Asia/Shanghai'))]), { kind: 'resolved', timeZone: 'Asia/Shanghai' }, 'an ended turn does not count')
  assert.deepEqual(deriveBrowserTimeZone([user(T0, rpc('asia/shanghai'))]), { kind: 'missing' }, 'a non-canonical zone is ignored')
})

test('the fold recovers DSH three baselines, and a turn end clears only the per-turn one', () => {
  assert.deepEqual(foldTimeContext([]), { lastMessageTime: null, lastInjectionTime: null, lastTurnInjectionTime: null })
  const events = [user(T0), assistant(T0 + 1000), reading(T0 + 2000)]
  assert.deepEqual(foldTimeContext(events), { lastMessageTime: T0 + 2000, lastInjectionTime: T0 + 2000, lastTurnInjectionTime: T0 + 2000 })
  assert.deepEqual(foldTimeContext([...events, turnEnd(T0 + 3000)]), { lastMessageTime: T0 + 2000, lastInjectionTime: T0 + 2000, lastTurnInjectionTime: null })
  const system = event('context/note', T0 + 4000, { message: { role: 'system', content: [] } })
  assert.equal(foldTimeContext([...events, system]).lastMessageTime, T0 + 2000, 'a note the model does not read as a message is not one')
})

test('the first step of a turn reads DSH full text, counting from the latest model-visible message', () => {
  const text = timeContextReading([user(T0)], { step: 1, now: T0 + 65_000, fallbackTimeZone: 'Asia/Shanghai' })
  assert.equal(text, `Time sampled while preparing turn 1, step 1: 2026-10-29T19:31:21+08:00[Asia/Shanghai]\n${UNAVAILABLE}\nElapsed since the preceding model-visible message: 1m 5s.`)
  assert.match(timeContextReading([], { step: 1, now: T0, fallbackTimeZone: 'UTC' }) ?? '', /Elapsed since the preceding model-visible message: unavailable\.$/, 'nothing precedes the first message')
})

test('a resolved browser zone chooses the timestamp zone over the fallback', () => {
  const text = timeContextReading([user(T0, { kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'Asia/Shanghai' })], { step: 1, now: T0, fallbackTimeZone: 'UTC' })
  assert.match(text ?? '', /: 2026-10-29T19:30:16\+08:00\[Asia\/Shanghai\]\nBrowser time zone for this request: Asia\/Shanghai\./)
})

test('a reading is skipped while the last one is younger than the interval, ten minutes by default', () => {
  assert.equal(DEFAULT_REFRESH_INTERVAL_MS, 600_000)
  const events = [user(T0), reading(T0)]
  assert.equal(timeContextReading(events, { step: 1, now: T0 + 599_999, fallbackTimeZone: 'UTC' }), undefined)
  assert.notEqual(timeContextReading(events, { step: 1, now: T0 + 600_000, fallbackTimeZone: 'UTC' }), undefined, 'at the interval a new reading is due')
  assert.notEqual(timeContextReading(events, { step: 1, now: T0 + 1000, refreshIntervalMs: 0, fallbackTimeZone: 'UTC' }), undefined, 'an interval of 0 reads on every step')
  assert.notEqual(timeContextReading(events, { step: 1, now: T0 - 1000, fallbackTimeZone: 'UTC' }), undefined, 'a reading from the future does not suppress one')
  assert.throws(() => timeContextReading(events, { step: 1, now: T0, refreshIntervalMs: -1 }), /refreshIntervalMs must be a non-negative safe integer/)
})

test('later steps count from the turn latest reading, and the turn number follows the ended turns', () => {
  const inTurn = [user(T0), reading(T0)]
  assert.match(timeContextReading(inTurn, { step: 2, now: T0 + 700_000, fallbackTimeZone: 'UTC' }) ?? '', /^Time sampled while preparing turn 1, step 2: .*\nElapsed since the preceding step context: 11m 40s\.$/s)
  const twoEnded = [user(T0), reading(T0), turnEnd(T0 + 1), user(T0 + 2), turnEnd(T0 + 3), user(T0 + 4)]
  assert.match(timeContextReading(twoEnded, { step: 2, now: T0 + 700_000, fallbackTimeZone: 'UTC' }) ?? '', /^Time sampled while preparing turn 3, step 2: .*step context: unavailable\.$/s, 'a new turn has no reading of its own yet')
})

test('recordTimeContext appends one model-visible note with DSH source, then waits out the interval', () => {
  const store = new SessionStore(join(root, 'store'))
  const handle = store.create({ cwd: root })
  // The store stamps events with the real clock, so the loop's `now` is the real clock too.
  assert.equal(recordTimeContext(store, handle, { step: 1, now: Date.now(), fallbackTimeZone: 'UTC' }), true)
  const notes = store.read(handle).filter((one) => one.type === 'context/note')
  assert.equal(notes.length, 1)
  const note = notes[0] as unknown as { message: { role: string; content: { text: string }[]; source: unknown }; origin: string }
  const text = note.message.content[0]?.text ?? ''
  assert.match(text, /^Time sampled while preparing turn 1, step 1: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00\[UTC\]\n/)
  assert.equal(note.message.role, 'user')
  assert.equal(note.origin, 'time-context')
  assert.deepEqual(note.message.source, { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] })
  assert.equal(recordTimeContext(store, handle, { step: 2, now: Date.now(), fallbackTimeZone: 'UTC' }), false, 'a second step inside the interval adds nothing')
})
