import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { ScheduleInputError } from '../src/schedule/errors.ts'
import { appendDelivery, ScheduleService, type ScheduleServiceOptions } from '../src/schedule/service.ts'
import { ScheduleStore, type ScheduleTask } from '../src/schedule/store.ts'

/**
 * The schedule service over a real store file in a temp directory, with an injected clock.
 *
 * Its contract is DSH's: one FIFO for every write, create's clock sampled before the queue and update's inside it,
 * a compare-and-set update with `schedule_conflict`, `schedule_ended` and `schedule_not_found`, the session binding on
 * every operation, the subagent refusals, the catalog and history reads, retention pruning, and a change notification
 * after every committed write.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-schedule-service-'))
after(() => rmSync(root, { recursive: true, force: true }))
let counter = 0

const T0 = Date.parse('2026-10-29T12:00:00.000Z')

function setup(options: Partial<ScheduleServiceOptions> = {}) {
  counter += 1
  const clock = { now: T0 }
  const file = join(root, `case-${counter}`, 'schedule.json')
  let ids = 0
  const service = new ScheduleService({ file, now: () => clock.now, newId: () => `schedule-${(ids += 1)}`, ...options })
  const changes: number[] = []
  service.onChange(() => changes.push(clock.now))
  const drives: number[] = []
  service.attachDriver({ requestDrive: () => drives.push(clock.now), start: () => undefined })
  return { service, clock, file, changes, drives }
}

/** Hold the FIFO until the returned function is called. */
function blockQueue(service: ScheduleService): () => void {
  let released = false
  let resolveBlock: (() => void) | undefined
  void service.serialize(
    () =>
      new Promise<void>((resolve) => {
        if (released) resolve()
        else resolveBlock = resolve
      }),
  )
  return () => {
    released = true
    resolveBlock?.()
  }
}

const rejectsWith = async (promise: Promise<unknown>, code: string, message: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof ScheduleInputError && error.code === code && error.message === message)

test('create persists an active row with empty history, announces it and asks for a drive', async () => {
  const { service, file, changes, drives } = setup()
  const record = await service.create('session-1', { prompt: ' Review ', title: ' Daily review ', daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } })
  assert.deepEqual(record, {
    id: 'schedule-1',
    kind: 'daily',
    title: 'Daily review',
    prompt: 'Review',
    time: '23:00:00.000',
    timeZone: 'Asia/Shanghai',
    scheduledAt: '2026-10-29T15:00:00.000Z',
  })
  assert.deepEqual(new ScheduleStore(file).entries(), [
    { sessionId: 'session-1', record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } },
  ])
  assert.equal(changes.length, 1)
  assert.equal(drives.length, 1)
})

test('create needs exactly one selector and validates before it queues', async () => {
  const { service, changes } = setup()
  await rejectsWith(service.create('s', { prompt: 'p', title: 't' }), 'invalid_selector', 'Exactly one reminder selector is required.')
  await rejectsWith(service.create('s', { prompt: 'p', title: 't', after_seconds: 60, every_seconds: 60 }), 'invalid_selector', 'Exactly one reminder selector is required.')
  await rejectsWith(service.create('s', { prompt: 'p', title: ' ', after_seconds: 60 }), 'invalid_prompt', 'title is required and must be non-empty after trimming.')
  await rejectsWith(service.create('s', { prompt: 'p', title: 't', at: '2026-10-29T11:00:00Z' }), 'not_future', 'The scheduled time must be strictly in the future.')
  assert.equal(changes.length, 0, 'nothing was committed')
})

test('create samples its clock before queueing; update samples inside the queue', async () => {
  const { service, clock } = setup()
  const first = await service.create('s', { prompt: 'p', title: 't', every_seconds: 60 })
  const release = blockQueue(service)
  const created = service.create('s', { prompt: 'p', title: 't', after_seconds: 60 })
  const updated = service.update({ sessionId: 's', id: first.id, expected: first, change: { kind: 'every', every_seconds: 120 } })
  clock.now = T0 + 30_000
  release()
  assert.equal((await created).scheduledAt, '2026-10-29T12:01:00.000Z', 'anchored at the request, T0 + 60s')
  const result = await updated
  assert.ok('record' in result)
  assert.equal(result.record.scheduledAt, '2026-10-29T12:02:30.000Z', 'anchored at the save, T0 + 30s + 120s')
})

test('operations run in FIFO order', async () => {
  const { service } = setup()
  const seen: number[] = []
  const release = blockQueue(service)
  const a = service.serialize(() => seen.push(service.tasks().length))
  const b = service.create('s', { prompt: 'p', title: 't', after_seconds: 60 })
  const c = service.serialize(() => seen.push(service.tasks().length))
  release()
  await Promise.all([a, b, c])
  assert.deepEqual(seen, [0, 1], 'the work queued before the create sees no row; the work queued after it sees the row')
})

test('list is the session’s active rows in storage order; catalog is every row sorted by target then id', async () => {
  const { service } = setup()
  const later = await service.create('s1', { prompt: 'p', title: 'later', after_seconds: 600 })
  const sooner = await service.create('s1', { prompt: 'p', title: 'sooner', after_seconds: 60 })
  const other = await service.create('s2', { prompt: 'p', title: 'other', after_seconds: 60 })
  assert.deepEqual((await service.list({ sessionId: 's1' })).map((record) => record.id), [later.id, sooner.id])
  const catalog = await service.catalog()
  assert.deepEqual(catalog.map((entry) => entry.id), [sooner.id, other.id, later.id], 'equal targets order by id')
  assert.deepEqual(Object.keys(catalog[0] ?? {}), ['id', 'kind', 'title', 'prompt', 'afterSeconds', 'scheduledAt', 'sessionId', 'status'])
  service.commitDelivery({
    sessionId: 's1',
    record: sooner,
    status: 'inactive',
    lastDelivery: { scheduledAt: sooner.scheduledAt, deliveredAt: '2026-10-29T12:01:00.000Z', messageId: 'message-1' },
    deliveryHistory: { records: [{ scheduledAt: sooner.scheduledAt, deliveredAt: '2026-10-29T12:01:00.000Z', messageId: 'message-1', prompt: 'p' }], earlierRecordsUnavailable: false },
  })
  assert.deepEqual((await service.list({ sessionId: 's1' })).map((record) => record.id), [later.id], 'an inactive row leaves the list')
  const inactive = (await service.catalog()).find((entry) => entry.id === sooner.id)
  assert.equal(inactive?.status, 'inactive', 'and stays in the catalog')
  assert.equal(inactive?.lastDelivery?.messageId, 'message-1')
})

test('update: a stale expected is schedule_conflict; a wrong binding or missing id is schedule_not_found; an inactive row is schedule_ended', async () => {
  const { service, changes } = setup()
  const record = await service.create('s1', { prompt: 'p', title: 't', every_seconds: 60 })
  const before = changes.length
  assert.deepEqual(await service.update({ sessionId: 's1', id: record.id, expected: { ...record, prompt: 'stale' }, title: 'new' }), {
    id: record.id,
    updated: false,
    code: 'schedule_conflict',
  })
  assert.deepEqual(await service.update({ sessionId: 's2', id: record.id, expected: record, title: 'new' }), { id: record.id, updated: false, code: 'schedule_not_found' })
  assert.deepEqual(await service.update({ sessionId: 's1', id: 'schedule-x', expected: record, title: 'new' }), { id: 'schedule-x', updated: false, code: 'schedule_not_found' })
  assert.equal(changes.length, before, 'no miss writes anything')
  const task = service.tasks()[0] as ScheduleTask
  service.commitDelivery({ ...task, status: 'inactive' })
  assert.deepEqual(await service.update({ sessionId: 's1', id: record.id, expected: record, title: 'new' }), { id: record.id, updated: false, code: 'schedule_ended' })
})

test('update: a committed change is persisted and announced; a no-op writes nothing', async () => {
  const { service, file, changes, drives } = setup()
  const record = await service.create('s1', { prompt: 'p', title: 't', every_seconds: 60 })
  const before = { changes: changes.length, drives: drives.length }
  const noop = await service.update({ sessionId: 's1', id: record.id, expected: record, change: { kind: 'every', every_seconds: 60 } })
  assert.deepEqual(noop, { id: record.id, updated: false, record })
  assert.equal(changes.length, before.changes)
  const titled = await service.update({ sessionId: 's1', id: record.id, expected: record, title: 'Renamed' })
  assert.ok('record' in titled && titled.updated)
  assert.equal(titled.record.scheduledAt, record.scheduledAt, 'a title alone keeps the target')
  assert.equal(new ScheduleStore(file).get(record.id)?.record.title, 'Renamed')
  assert.equal(changes.length, before.changes + 1)
  assert.equal(drives.length, before.drives + 1)
  assert.deepEqual(await service.update({ sessionId: 's1', id: record.id, expected: titled.record, change: { kind: 'every' } }), {
    code: 'invalid_rule',
    message: 'Timing change must contain exactly kind and its matching timing selector.',
  })
})

test('a delegated child’s session: create throws and update returns subagent_session; list and delete still work', async () => {
  const delegated = new Set<string>()
  const { service } = setup({ isDelegated: (id) => delegated.has(id) })
  const record = await service.create('child', { prompt: 'p', title: 't', after_seconds: 60 })
  delegated.add('child')
  await rejectsWith(
    service.create('child', { prompt: 'p', title: 't', after_seconds: 60 }),
    'subagent_session',
    'This Session belongs to subagent routing, which never receives reminder delivery.',
  )
  assert.deepEqual(await service.update({ sessionId: 'child', id: record.id, expected: record, title: 'x' }), {
    code: 'subagent_session',
    message: 'This Session belongs to subagent routing, which never receives reminder delivery.',
  })
  assert.equal((await service.list({ sessionId: 'child' })).length, 1)
  assert.deepEqual(await service.delete({ sessionId: 'child', id: record.id }), { id: record.id, deleted: true })
})

test('an aborted signal is checked in the queue, before anything is written', async () => {
  const { service, changes } = setup()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(service.create('s', { prompt: 'p', title: 't', after_seconds: 60 }, controller.signal), { name: 'AbortError' })
  assert.equal(service.tasks().length, 0)
  assert.equal(changes.length, 0)
})

test('delete removes the row and its history from any state; a wrong binding is schedule_not_found', async () => {
  const { service } = setup()
  const record = await service.create('s1', { prompt: 'p', title: 't', after_seconds: 60 })
  assert.deepEqual(await service.delete({ sessionId: 's2', id: record.id }), { id: record.id, deleted: false, code: 'schedule_not_found' })
  service.commitDelivery({ ...(service.tasks()[0] as ScheduleTask), status: 'inactive' })
  assert.deepEqual(await service.delete({ sessionId: 's1', id: record.id }), { id: record.id, deleted: true })
  assert.deepEqual(await service.history({ sessionId: 's1', id: record.id, limit: 10 }), { id: record.id, code: 'schedule_not_found' })
  assert.equal(JSON.stringify(await service.delete({ sessionId: 's1', id: record.id })), `{"id":"${record.id}","deleted":false,"code":"schedule_not_found"}`)
})

test('the archive stop removes only that session’s active rows', async () => {
  const { service } = setup()
  await service.create('s1', { prompt: 'p', title: 'a', after_seconds: 60 })
  const kept = await service.create('s2', { prompt: 'p', title: 'b', after_seconds: 60 })
  await service.stopSessionTasks('s1')
  assert.deepEqual(service.tasks().map((task) => task.record.id), [kept.id])
})

/** A task whose history holds `count` deliveries, one minute apart, ending at `end`. */
function withHistory(service: ScheduleService, id: string, count: number, end: number): void {
  const task = service.tasks().find((one) => one.record.id === id) as ScheduleTask
  let current = task
  for (let index = 0; index < count; index += 1) {
    const deliveredAt = new Date(end - (count - 1 - index) * 60_000).toISOString()
    current = { ...current, ...appendDelivery(current, { scheduledAt: task.record.scheduledAt, deliveredAt, messageId: `message-${index}` }, service.retention) }
  }
  service.commitDelivery(current)
}

test('history: newest first, an exclusive cursor, nextBefore, and lookup misses', async () => {
  const { service } = setup()
  const record = await service.create('s1', { prompt: 'p', title: 't', every_seconds: 60 })
  await rejectsWith(service.history({ sessionId: 's1', id: record.id, limit: 0 }), 'invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
  await rejectsWith(service.history({ sessionId: 's1', id: record.id, limit: 101 }), 'invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
  withHistory(service, record.id, 5, T0)
  const page = await service.history({ sessionId: 's1', id: record.id, limit: 2 })
  assert.ok('records' in page)
  assert.deepEqual(page.records.map((one) => one.messageId), ['message-4', 'message-3'])
  assert.equal(page.nextBefore, 'message-3')
  assert.deepEqual(page.retention, { days: 30, records: 200 })
  assert.equal(page.earlierRecordsUnavailable, false)
  assert.equal(page.earlierRecordsPruned, false)
  const second = await service.history({ sessionId: 's1', id: record.id, limit: 2, before: page.nextBefore })
  assert.ok('records' in second)
  assert.deepEqual(second.records.map((one) => one.messageId), ['message-2', 'message-1'])
  const last = await service.history({ sessionId: 's1', id: record.id, limit: 2, before: 'message-1' })
  assert.ok('records' in last)
  assert.deepEqual(last.records.map((one) => one.messageId), ['message-0'])
  assert.equal(last.nextBefore, undefined, 'the first page has no older cursor')
  assert.deepEqual(Object.keys(last.records[0] ?? {}), ['scheduledAt', 'deliveredAt', 'messageId', 'prompt'])
  assert.deepEqual(await service.history({ sessionId: 's1', id: record.id, limit: 2, before: 'message-x' }), { id: record.id, code: 'delivery_cursor_not_found' })
  assert.deepEqual(await service.history({ sessionId: 's2', id: record.id, limit: 2 }), { id: record.id, code: 'schedule_not_found' })
})

test('retention prunes by the day window and by the record cap, and says so', async () => {
  const { service } = setup({ retention: { days: 1, records: 3 } })
  const record = await service.create('s1', { prompt: 'p', title: 't', every_seconds: 60 })
  withHistory(service, record.id, 3, T0)
  let page = await service.history({ sessionId: 's1', id: record.id, limit: 100 })
  assert.ok('records' in page)
  assert.equal(page.records.length, 3)
  assert.equal(page.earlierRecordsPruned, false)
  withHistory(service, record.id, 1, T0 + 60_000)
  page = await service.history({ sessionId: 's1', id: record.id, limit: 100 })
  assert.ok('records' in page)
  assert.deepEqual(page.records.map((one) => one.messageId).length, 3, 'the cap keeps the last three')
  assert.equal(page.earlierRecordsUnavailable, true)
  assert.equal(page.earlierRecordsPruned, true)

  const task = service.tasks()[0] as ScheduleTask
  const pruned = appendDelivery(task, { scheduledAt: task.record.scheduledAt, deliveredAt: new Date(T0 + 2 * 86_400_000).toISOString(), messageId: 'late' }, { days: 1, records: 10 })
  assert.deepEqual(pruned.deliveryHistory.records.map((one) => one.messageId), ['late'], 'records older than the day window go')
  const legacy: ScheduleTask = { sessionId: 's', record: task.record, status: 'active', lastDelivery: { scheduledAt: task.record.scheduledAt, deliveredAt: new Date(T0).toISOString(), messageId: 'old' } }
  const fromLegacy = appendDelivery(legacy, { scheduledAt: task.record.scheduledAt, deliveredAt: new Date(T0 + 1000).toISOString(), messageId: 'new' }, { days: 30, records: 200 })
  assert.equal(fromLegacy.deliveryHistory.earlierRecordsUnavailable, true, 'a row without history exposes only its last delivery')
  assert.deepEqual(fromLegacy.deliveryHistory.records.map((one) => one.messageId), ['old', 'new'])
})

test('retention bounds are checked; a throwing change listener is contained; a stopped service refuses work', async () => {
  assert.throws(() => setup({ retention: { days: 0 } }), RangeError)
  assert.throws(() => setup({ retention: { records: 10_001 } }), RangeError)
  const warnings: string[] = []
  const { service } = setup({ warn: (message) => warnings.push(message) })
  service.onChange(() => {
    throw new Error('listener broke')
  })
  await service.create('s', { prompt: 'p', title: 't', after_seconds: 60 })
  assert.deepEqual(warnings, ['schedule: schedule/changed listener failed: Error: listener broke'])
  await service.dispose()
  await assert.rejects(service.serialize(() => 1), /Schedule service is stopping/)
})
