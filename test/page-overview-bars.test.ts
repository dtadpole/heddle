import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * S151 (R-developer-eleven-21): the overview draws DSH's per-record bars, merging a turn's records in one lane when they
 * are many or narrower than a pixel (developer-ten's condition 1), and a bar's words name the TTFT split. The page's
 * fenced helpers are sliced out and judged here.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
function fenced(name: string): string {
  const begin = page.indexOf(`/* ${name}:begin */`)
  const end = page.indexOf(`/* ${name}:end */`)
  assert.ok(begin !== -1 && end > begin, `page.html fences ${name}`)
  return page.slice(begin, end)
}
type Record_ = { turn: number; lane: string; kind: string; start: number; end: number; running: boolean; ttftMs?: number; decodingMs?: number }
type Bar = Record_ & { kinds: string[]; merged: number }
const helpers = new Function(`${fenced('timeline-tip')}; ${fenced('overview-bars')}; return { overviewBars, timelineRecordText }`)() as {
  overviewBars: (records: Record_[], trackPx: number) => Bar[]
  timelineRecordText: (bar: Bar, totalMs: number, startsAtMs: number) => { label: string; when: string }
}

const record = (turn: number, lane: string, kind: string, start: number, end: number, extra: Partial<Record_> = {}): Record_ => ({ turn, lane, kind, start, end, running: false, ...extra })

test('a few records wide enough to see are one bar each, keeping their TTFT split', () => {
  const bars = helpers.overviewBars([record(1, 'input', 'user', 0, 0.1), record(1, 'model', 'assistant', 0.2, 0.6, { ttftMs: 300, decodingMs: 900 })], 1000)
  assert.deepEqual(
    bars.map((bar) => [bar.lane, bar.kinds, bar.merged, bar.ttftMs, bar.decodingMs]),
    [['input', ['user'], 1, undefined, undefined], ['model', ['assistant'], 1, 300, 900]],
  )
})

test('a turn with many records in one lane, or one narrower than a pixel, is one merged bar', () => {
  const many = Array.from({ length: 13 }, (_, index) => record(2, 'tools', 'tool', 0.1 + index * 0.02, 0.11 + index * 0.02, { running: index === 12 }))
  const [merged] = helpers.overviewBars(many, 1000)
  assert.deepEqual([merged?.merged, merged?.start, merged?.end, merged?.running, merged?.kinds], [13, 0.1, 0.11 + 12 * 0.02, true, ['tool']])
  const thin = helpers.overviewBars([record(3, 'model', 'reasoning', 0.5, 0.5003), record(3, 'model', 'assistant', 0.5003, 0.7)], 1000)
  assert.deepEqual(thin.map((bar) => [bar.merged, bar.kinds]), [[2, ['reasoning', 'assistant']]], 'a 0.3-pixel bar merges its group')
})

test('a bar names its TTFT split after its clock, and a merged bar how many records it holds', () => {
  const startsAt = Date.parse('2026-10-31T09:00:00.000Z')
  const split = helpers.timelineRecordText({ ...record(1, 'model', 'assistant', 0.25, 0.5, { ttftMs: 300, decodingMs: 900 }), kinds: ['assistant'], merged: 1 }, 4000, startsAt)
  assert.match(split.when, / · TTFT 300 ms · decoding 900 ms$/)
  assert.equal(split.label, 'turn 1 · assistant')
  const merged = helpers.timelineRecordText({ ...record(2, 'tools', 'tool', 0.1, 0.4), kinds: ['tool'], merged: 13 }, 4000, startsAt)
  assert.equal(merged.label, 'turn 2 · tool · 13 records')
  assert.doesNotMatch(merged.when, /TTFT/)
})
