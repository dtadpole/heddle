import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createDailyScheduleRecord, createEveryScheduleRecord, type ScheduleRecord } from '../src/schedule/rules.ts'
import { defaultScheduleFile, ScheduleStore, ScheduleStoreError, type ScheduleTask } from '../src/schedule/store.ts'

/**
 * The store file: DSH's whole-unit storage-domain document, read strictly and written atomically.
 *
 * The claims: an absent file is an empty store; a write lands as the exact unit shape and reads back equal; a corrupt
 * or invalid file refuses to open with a message naming it; a replaced row keeps its position; and no temp file is left
 * behind.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-schedule-store-'))
after(() => rmSync(root, { recursive: true, force: true }))
let counter = 0
const fresh = (): string => join(root, `case-${(counter += 1)}`, 'schedule.json')

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const daily = createDailyScheduleRecord('schedule-a', 'Review', { time: '23:00:00', time_zone: 'Asia/Shanghai' }, NOW, 'Daily review')
const every = createEveryScheduleRecord('schedule-b', 'Ping', 60, NOW, 'Ping')
const task = (record: ScheduleRecord = daily): ScheduleTask => ({ sessionId: 'session-1', record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } })

test('the default file is $HEDDLE_HOME/schedule.json', () => {
  assert.equal(defaultScheduleFile({ HEDDLE_HOME: '/tmp/h' }), '/tmp/h/schedule.json')
})

test('an absent file is an empty store, and a write creates it in the exact unit shape', () => {
  const file = fresh()
  const store = new ScheduleStore(file)
  assert.deepEqual(store.entries(), [])
  store.put(daily.id, task())
  const unit = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(unit), ['unit', 'global', 'tables'])
  assert.deepEqual(unit.unit, { name: 'schedule', version: 1 })
  assert.equal(unit.global, null)
  assert.deepEqual(Object.keys(unit.tables.tasks), ['schedule-a'])
  assert.deepEqual(Object.keys(unit.tables.tasks['schedule-a']), ['sessionId', 'record', 'status', 'deliveryHistory'])
  assert.deepEqual(Object.keys(unit.tables.tasks['schedule-a'].record), ['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'scheduledAt'])
  assert.deepEqual(readdirSync(join(file, '..')), ['schedule.json'], 'no temp file is left behind')
})

test('a store reopened from its file reads back the same rows in the same order', () => {
  const file = fresh()
  const store = new ScheduleStore(file)
  store.put(daily.id, task())
  store.put(every.id, task(every))
  const delivered: ScheduleTask = {
    ...task(),
    status: 'inactive',
    lastDelivery: { scheduledAt: daily.scheduledAt, deliveredAt: '2026-10-29T15:00:01.000Z', messageId: 'message-1' },
    deliveryHistory: {
      records: [{ scheduledAt: daily.scheduledAt, deliveredAt: '2026-10-29T15:00:01.000Z', messageId: 'message-1', prompt: 'Review' }],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
    },
  }
  store.put(daily.id, delivered)
  const reopened = new ScheduleStore(file)
  assert.deepEqual(reopened.entries(), [delivered, task(every)], 'a replaced row keeps its storage position')
  assert.equal(reopened.delete(every.id), true)
  assert.equal(reopened.delete(every.id), false)
  assert.deepEqual(new ScheduleStore(file).entries(), [delivered])
})

test('a row without a status reads as active, as the DSH schema defaults it', () => {
  const file = fresh()
  new ScheduleStore(file).put(daily.id, task())
  const unit = JSON.parse(readFileSync(file, 'utf8'))
  delete unit.tables.tasks['schedule-a'].status
  writeFileSync(file, JSON.stringify(unit))
  assert.equal(new ScheduleStore(file).get('schedule-a')?.status, 'active')
})

/** Write a document and expect the store to refuse it, naming the file and the reason. */
function refuses(document: string, reason: RegExp): void {
  const file = fresh()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, document)
  assert.throws(
    () => new ScheduleStore(file),
    (error: unknown) => error instanceof ScheduleStoreError && error.message.includes(file) && reason.test(error.message),
    reason.source,
  )
}

const unitWith = (rows: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: rows }, ...extra })

test('a corrupt or invalid file refuses to open', () => {
  refuses('', /not JSON/)
  refuses('{"unit":', /not JSON/)
  refuses('[]', /the unit must be an object/)
  refuses(JSON.stringify({ unit: { name: 'schedule', version: 2 }, global: null, tables: { tasks: {} } }), /unit must be/)
  refuses(unitWith({}, { extra: 1 }), /unknown key "extra"/)
  refuses(unitWith({ 'schedule-x': task() }), /stored task key "schedule-x" differs from record id "schedule-a"/)
  refuses(unitWith({ 'schedule-a': { ...task(), sessionId: '' } }), /non-empty sessionId/)
  refuses(unitWith({ 'schedule-a': { ...task(), status: 'paused' } }), /status must be active or inactive/)
  refuses(unitWith({ 'schedule-a': { ...task(), surprise: true } }), /unknown key "surprise"/)
  refuses(unitWith({ 'schedule-a': { ...task(), record: { ...daily, prompt: ' untrimmed' } } }), /daily prompt must be non-empty and already trimmed/)
  refuses(
    unitWith({ 'schedule-a': { ...task(), lastDelivery: { scheduledAt: daily.scheduledAt, deliveredAt: '2026-10-29T15:00:01.000Z', messageId: 'm' } } }),
    /Last delivery must match the latest saved delivery receipt/,
  )
  const receipt = { scheduledAt: daily.scheduledAt, deliveredAt: '2026-10-29T15:00:01.000Z', messageId: 'm' }
  refuses(
    unitWith({ 'schedule-a': { ...task(), lastDelivery: receipt, deliveryHistory: { records: [receipt, receipt], earlierRecordsUnavailable: false } } }),
    /message identities must be unique/,
  )
  refuses(
    unitWith({ 'schedule-a': { ...task(), lastDelivery: { ...receipt, deliveredAt: '2026-10-29T15:00:01Z' }, deliveryHistory: undefined } }),
    /canonical four-digit-year UTC calendar instant/,
  )
})

test('a failed write leaves the table as it was', () => {
  const file = fresh()
  const store = new ScheduleStore(file)
  store.put(daily.id, task())
  assert.throws(() => store.put('schedule-other', task()), /differs from record id/)
  assert.deepEqual(store.entries(), [task()])
})
