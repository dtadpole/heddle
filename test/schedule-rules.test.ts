import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ScheduleInputError, ScheduleLogError } from '../src/schedule/errors.ts'
import {
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createCronScheduleRecord,
  createDailyScheduleRecord,
  createEveryScheduleRecord,
  createWeeklyScheduleRecord,
  decodeScheduleRecord,
  parseAtInput,
  resolveCronOccurrence,
  resolveDailyOccurrence,
  resolveEveryOccurrence,
  resolveScheduleUpdate,
  resolveWeeklyOccurrence,
  scheduleView,
  type CronRecord,
  type DailyRecord,
  type EveryRecord,
  type ScheduleRecord,
  type WeeklyRecord,
} from '../src/schedule/rules.ts'

/**
 * Every rule a reminder is built from, with DSH's codes and messages verbatim: each selector's validation, each
 * selector's next target (including the DST gap that is skipped and the overlap that fires once, early), the
 * fixed-rate anchor and its re-anchor, the latest missed occurrence after downtime, the in-place update, and the
 * strict decoder for stored records.
 */

const LA = 'America/Los_Angeles'
const at = (iso: string) => Date.parse(iso)

const refuses = (run: () => unknown, code: string, message: string) =>
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ScheduleInputError, `expected a ScheduleInputError, got ${String(error)}`)
    assert.equal(error.code, code)
    assert.equal(error.message, message)
    return true
  })

const NOW = at('2026-10-29T12:00:00.000Z')

test('prompt and title: trimmed, non-empty, title at most 120 characters', () => {
  refuses(() => createAfterScheduleRecord('s', '   ', 60, NOW, 't'), 'invalid_prompt', 'prompt must be non-empty after trimming.')
  refuses(() => createAfterScheduleRecord('s', 'p', 60, NOW, '  '), 'invalid_prompt', 'title is required and must be non-empty after trimming.')
  refuses(() => createAfterScheduleRecord('s', 'p', 60, NOW, 'x'.repeat(121)), 'invalid_prompt', 'title must be at most 120 characters.')
  const record = createAfterScheduleRecord('s', '  check CI  ', 60, NOW, `  ${'x'.repeat(120)}  `)
  assert.equal(record.prompt, 'check CI')
  assert.equal(record.title.length, 120)
})

test('after_seconds: a positive safe integer; target = now + seconds', () => {
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '60']) {
    refuses(() => createAfterScheduleRecord('s', 'p', bad, NOW, 't'), 'invalid_rule', 'after_seconds must be a positive safe integer.')
  }
  assert.deepEqual(createAfterScheduleRecord('s', 'p', 90, NOW, 't'), {
    id: 's',
    kind: 'after',
    title: 't',
    prompt: 'p',
    afterSeconds: 90,
    scheduledAt: '2026-10-29T12:01:30.000Z',
  })
  refuses(
    () => createAfterScheduleRecord('s', 'p', 9_000_000_000_000, NOW, 't'),
    'time_out_of_range',
    'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.',
  )
})

test('every_seconds: a safe integer of at least 60; the first target is now + interval', () => {
  refuses(() => createEveryScheduleRecord('s', 'p', 60.5, NOW, 't'), 'invalid_rule', 'every_seconds must be a safe integer.')
  refuses(() => createEveryScheduleRecord('s', 'p', 59, NOW, 't'), 'frequency_too_high', 'every_seconds must be at least 60.')
  assert.equal(createEveryScheduleRecord('s', 'p', 3600, NOW, 't').scheduledAt, '2026-10-29T13:00:00.000Z')
})

test('at as a string: strict RFC 3339 with seconds, 1-3 fraction digits and an explicit offset', () => {
  const shape = 'at must use YYYY-MM-DDTHH:mm:ss with optional 1-3 digit fractional seconds and an explicit Z or numeric offset.'
  for (const bad of ['2026-10-30T12:00Z', '2026-10-30T12:00:00', '2026-10-30 12:00:00Z', '2026-10-30T12:00:00.1234Z', '2026-10-30T12:00:00+0800']) {
    refuses(() => parseAtInput(bad), 'invalid_rule', shape)
  }
  const calendar = 'The at value must be a real ISO calendar date and time.'
  for (const bad of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '0000-01-01T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z']) {
    refuses(() => parseAtInput(bad), 'invalid_rule', calendar)
  }
  for (const bad of ['2026-10-30T12:00:00-00:00', '2026-10-30T12:00:00+24:00', '2026-10-30T12:00:00+05:60']) {
    refuses(() => parseAtInput(bad), 'invalid_rule', 'The at numeric offset is invalid.')
  }
  assert.equal(parseAtInput('2026-10-30T20:00:00.5+08:00'), at('2026-10-30T12:00:00.500Z'))
  refuses(() => parseAtInput(42), 'invalid_rule', 'at must be an explicit-offset string or local calendar object.')
})

test('at as a local object: exact keys, strings, a real date, and a wall time that exists', () => {
  refuses(() => parseAtInput({ date: '2026-10-30', time: '09:00:00' }), 'invalid_rule', 'Local at must contain exactly date, time, and time_zone.')
  refuses(() => parseAtInput({ date: '2026-10-30', time: '09:00:00', time_zone: 'UTC', x: 1 }), 'invalid_rule', 'Local at must contain exactly date, time, and time_zone.')
  refuses(() => parseAtInput({ date: 20261030, time: '09:00:00', time_zone: 'UTC' }), 'invalid_rule', 'Local at date and time must be strings.')
  refuses(() => parseAtInput({ date: '2026-10-30', time: '09:00:00', time_zone: 8 }), 'invalid_time_zone', 'time_zone must be a string.')
  refuses(
    () => parseAtInput({ date: '2026-10-30', time: '9:00', time_zone: 'UTC' }),
    'invalid_rule',
    'Local at requires date YYYY-MM-DD and time HH:mm:ss with optional one-to-three digit milliseconds.',
  )
  refuses(() => parseAtInput({ date: '2026-10-30', time: '25:00:00', time_zone: 'UTC' }), 'invalid_rule', 'The local at value must be a real ISO calendar date and time.')
  refuses(() => parseAtInput({ date: '2026-02-29', time: '09:00:00', time_zone: 'UTC' }), 'invalid_rule', 'The at value must be a real ISO calendar date and time.')
  refuses(() => parseAtInput({ date: '2026-10-30', time: '09:00:00', time_zone: 'PST' }), 'invalid_time_zone', 'time_zone must be UTC or a valid IANA Area/Location name.')
  refuses(
    () => parseAtInput({ date: '2026-03-08', time: '02:30:00', time_zone: LA }),
    'invalid_rule',
    'The local at time does not exist in the selected time zone.',
  )
  assert.equal(parseAtInput({ date: '2026-11-01', time: '01:30:00', time_zone: LA }), at('2026-11-01T08:30:00.000Z'), 'an overlap takes the earlier instant')
})

test('at must be strictly future and keeps only the UTC instant', () => {
  refuses(() => createAtScheduleRecord('s', 'p', '2026-10-29T12:00:00Z', NOW, 't'), 'not_future', 'The scheduled time must be strictly in the future.')
  refuses(() => createAtScheduleRecord('s', 'p', '2026-10-29T11:00:00Z', NOW, 't'), 'not_future', 'The scheduled time must be strictly in the future.')
  refuses(
    () => createAtScheduleRecord('s', 'p', '0001-01-01T00:00:00+01:00', NOW, 't'),
    'time_out_of_range',
    'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.',
  )
  assert.deepEqual(createAtScheduleRecord('s', ' p ', { date: '2026-10-30', time: '09:00:00', time_zone: 'Asia/Shanghai' }, NOW, 't'), {
    id: 's',
    kind: 'at',
    title: 't',
    prompt: 'p',
    scheduledAt: '2026-10-30T01:00:00.000Z',
  })
})

test('daily: shape, strict time and zone diagnostics', () => {
  const shape = 'daily must contain exactly time and time_zone, with time HH:mm:ss and optional 1-3 fractional digits.'
  refuses(() => createDailyScheduleRecord('s', 'p', { time: '09:00:00' }, NOW, 't'), 'invalid_rule', shape)
  refuses(() => createDailyScheduleRecord('s', 'p', { time: 9, time_zone: 'UTC' }, NOW, 't'), 'invalid_rule', shape)
  refuses(() => createDailyScheduleRecord('s', 'p', 'daily', NOW, 't'), 'invalid_rule', shape)
  refuses(() => createDailyScheduleRecord('s', 'p', { time: '09:00:00', time_zone: null }, NOW, 't'), 'invalid_time_zone', 'time_zone must be a string.')
  for (const bad of ['24:00:00', '23:59:60', '9:00:00', '09:00', '09:00:00.1234']) {
    refuses(
      () => createDailyScheduleRecord('s', 'p', { time: bad, time_zone: 'UTC' }, NOW, 't'),
      'invalid_rule',
      'daily.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00.',
    )
  }
  refuses(() => createDailyScheduleRecord('s', 'p', { time: '09:00:00', time_zone: 'Mars/Base' }, NOW, 't'), 'invalid_time_zone', 'time_zone must be UTC or a valid IANA Area/Location name.')
})

test('daily: stored HH:mm:ss.SSS and the canonical zone; next target is today if later, else tomorrow', () => {
  assert.deepEqual(createDailyScheduleRecord('s', 'Review', { time: '23:00:00', time_zone: 'Asia/Shanghai' }, NOW, 'Daily review'), {
    id: 's',
    kind: 'daily',
    title: 'Daily review',
    prompt: 'Review',
    time: '23:00:00.000',
    timeZone: 'Asia/Shanghai',
    scheduledAt: '2026-10-29T15:00:00.000Z',
  })
  assert.equal(createDailyScheduleRecord('s', 'p', { time: '19:00:00.5', time_zone: 'Asia/Shanghai' }, NOW, 't').scheduledAt, '2026-10-30T11:00:00.500Z')
  assert.equal(createDailyScheduleRecord('s', 'p', { time: '12:00:00', time_zone: 'Etc/UTC' }, NOW, 't').timeZone, 'UTC')
  assert.equal(createDailyScheduleRecord('s', 'p', { time: '12:00:00', time_zone: 'UTC' }, NOW, 't').scheduledAt, '2026-10-30T12:00:00.000Z', 'now itself is not the future')
})

test('daily across DST: a gap skips the date, an overlap fires once at the earlier instant', () => {
  const gap = createDailyScheduleRecord('s', 'p', { time: '02:30:00', time_zone: LA }, at('2026-03-08T08:00:00Z'), 't')
  assert.equal(gap.scheduledAt, '2026-03-09T09:30:00.000Z', '2026-03-08 02:30 does not exist; the next date is taken, not 03:30')
  const overlap = createDailyScheduleRecord('s', 'p', { time: '01:30:00', time_zone: LA }, at('2026-11-01T07:00:00Z'), 't')
  assert.equal(overlap.scheduledAt, '2026-11-01T08:30:00.000Z')
  const delivered = resolveDailyOccurrence(overlap, at('2026-11-01T08:30:00Z'))
  assert.deepEqual(delivered, { occurrenceAt: '2026-11-01T08:30:00.000Z', nextScheduledAt: '2026-11-02T09:30:00.000Z' }, 'the repeated 01:30 PST is not a second occurrence')
})

test('weekly: shape, weekday diagnostics, sorted weekdays and the next selected day', () => {
  const shape = 'weekly must contain exactly time, time_zone, and weekdays, with time HH:mm:ss and optional 1-3 fractional digits.'
  refuses(() => createWeeklyScheduleRecord('s', 'p', { time: '09:00:00', time_zone: 'UTC' }, NOW, 't'), 'invalid_rule', shape)
  refuses(() => createWeeklyScheduleRecord('s', 'p', { time: '09:00:00', time_zone: 1, weekdays: [1] }, NOW, 't'), 'invalid_time_zone', 'time_zone must be a string.')
  refuses(
    () => createWeeklyScheduleRecord('s', 'p', { time: '9:00', time_zone: 'UTC', weekdays: [1] }, NOW, 't'),
    'invalid_rule',
    'weekly.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00.',
  )
  refuses(() => createWeeklyScheduleRecord('s', 'p', { time: '09:00:00', time_zone: 'UTC', weekdays: [] }, NOW, 't'), 'invalid_rule', 'weekly.weekdays must be a non-empty array of ISO weekday numbers.')
  refuses(() => createWeeklyScheduleRecord('s', 'p', { time: '09:00:00', time_zone: 'UTC', weekdays: 'mon' }, NOW, 't'), 'invalid_rule', 'weekly.weekdays must be a non-empty array of ISO weekday numbers.')
  for (const bad of [[0], [8], [1.5], ['1']]) {
    refuses(
      () => createWeeklyScheduleRecord('s', 'p', { time: '09:00:00', time_zone: 'UTC', weekdays: bad }, NOW, 't'),
      'invalid_rule',
      'Each weekly.weekdays entry must be an integer from 1 (Monday) through 7 (Sunday).',
    )
  }
  refuses(() => createWeeklyScheduleRecord('s', 'p', { time: '09:00:00', time_zone: 'UTC', weekdays: [3, 1, 3] }, NOW, 't'), 'invalid_rule', 'weekly.weekdays must not repeat weekday 3.')
  const record = createWeeklyScheduleRecord('s', 'p', { time: '09:00:00', time_zone: 'Asia/Shanghai', weekdays: [5, 1] }, NOW, 't')
  assert.deepEqual(record.weekdays, [1, 5])
  assert.equal(record.scheduledAt, '2026-10-30T01:00:00.000Z', 'Friday 2026-10-30 09:00 in Shanghai')
  const gap = createWeeklyScheduleRecord('s', 'p', { time: '02:30:00', time_zone: LA, weekdays: [7] }, at('2026-03-07T12:00:00Z'), 't')
  assert.equal(gap.scheduledAt, '2026-03-15T09:30:00.000Z', 'Sunday 2026-03-08 02:30 is in the gap, so the next Sunday')
})

test('cron: shape and zone diagnostics, the next match, and no-future exhaustion', () => {
  const shape = 'cron must contain exactly expression and time_zone, with a five-field cron expression.'
  refuses(() => createCronScheduleRecord('s', 'p', { expression: '* * * * *' }, NOW, 't'), 'invalid_rule', shape)
  refuses(() => createCronScheduleRecord('s', 'p', { expression: 5, time_zone: 'UTC' }, NOW, 't'), 'invalid_rule', shape)
  refuses(() => createCronScheduleRecord('s', 'p', { expression: '* * * * *', time_zone: [] }, NOW, 't'), 'invalid_time_zone', 'time_zone must be a string.')
  refuses(() => createCronScheduleRecord('s', 'p', { expression: '61 * * * *', time_zone: 'UTC' }, NOW, 't'), 'invalid_rule', 'cron.expression minute field value 61 is outside 0-59.')
  refuses(
    () => createCronScheduleRecord('s', 'p', { expression: '0 0 31 2 *', time_zone: 'UTC' }, NOW, 't'),
    'time_out_of_range',
    'No future cron occurrence is representable as a four-digit-year UTC instant.',
  )
  const record = createCronScheduleRecord('s', 'p', { expression: '0,15,30,45 9-17 * * 1-5', time_zone: 'Asia/Shanghai' }, NOW, 't')
  assert.equal(record.expression, '0-45/15 9-17 * * 1-5')
  assert.equal(record.scheduledAt, '2026-10-30T01:00:00.000Z', 'Friday 09:00 in Shanghai; Thursday 20:00 is past the hours')
  const or = createCronScheduleRecord('s', 'p', { expression: '0 9 1 * 1', time_zone: 'UTC' }, at('2026-10-27T10:00:00Z'), 't')
  assert.equal(or.scheduledAt, '2026-11-01T09:00:00.000Z', 'day 1 (a Sunday) comes before the next Monday under the OR rule')
})

test('cron across DST: a gap time is skipped, an overlap time fires once', () => {
  const gap = createCronScheduleRecord('s', 'p', { expression: '30 2 * * *', time_zone: LA }, at('2026-03-08T08:00:00Z'), 't')
  assert.equal(gap.scheduledAt, '2026-03-09T09:30:00.000Z')
  const overlap = createCronScheduleRecord('s', 'p', { expression: '30 1 * * *', time_zone: LA }, at('2026-11-01T07:00:00Z'), 't')
  assert.equal(overlap.scheduledAt, '2026-11-01T08:30:00.000Z')
  assert.equal(resolveCronOccurrence(overlap, at('2026-11-01T08:30:00Z')).nextScheduledAt, '2026-11-02T09:30:00.000Z')
})

test('no future daily or weekly occurrence near the year 9999 ceiling', () => {
  const late = at('9999-12-31T23:00:00Z')
  refuses(
    () => createDailyScheduleRecord('s', 'p', { time: '22:00:00', time_zone: 'UTC' }, late, 't'),
    'time_out_of_range',
    'No future daily occurrence is representable as a four-digit-year UTC instant.',
  )
  refuses(
    () => createWeeklyScheduleRecord('s', 'p', { time: '22:00:00', time_zone: 'UTC', weekdays: [5] }, late, 't'),
    'time_out_of_range',
    'No future weekly occurrence is representable as a four-digit-year UTC instant.',
  )
  refuses(() => createDailyScheduleRecord('s', 'p', { time: '22:00:00', time_zone: 'UTC' }, Number.NaN, 't'), 'time_out_of_range', 'Daily creation time must be a representable four-digit-year UTC instant.')
})

const every = (scheduledAt: string, everySeconds: number): EveryRecord => ({ id: 'e', kind: 'every', title: 't', prompt: 'p', everySeconds, scheduledAt })

test('every: fixed rate from the anchor; downtime delivers one occurrence and keeps the phase', () => {
  assert.deepEqual(resolveEveryOccurrence(every('2026-10-29T12:00:00.000Z', 60), at('2026-10-29T12:00:00Z')), {
    occurrenceAt: '2026-10-29T12:00:00.000Z',
    nextScheduledAt: '2026-10-29T12:01:00.000Z',
  })
  assert.deepEqual(resolveEveryOccurrence(every('2026-10-29T12:00:00.000Z', 60), at('2026-10-29T12:02:30Z')), {
    occurrenceAt: '2026-10-29T12:02:00.000Z',
    nextScheduledAt: '2026-10-29T12:03:00.000Z',
  }, 'the 12:00 and 12:01 occurrences are dropped; the next keeps the :00 phase')
  assert.throws(() => resolveEveryOccurrence(every('2026-10-29T12:00:00.000Z', 60), at('2026-10-29T11:59:00Z')), ScheduleLogError)
})

test('daily and weekly downtime: only the latest missed occurrence, the next on a later local date', () => {
  const daily: DailyRecord = { id: 'd', kind: 'daily', title: 't', prompt: 'p', time: '09:00:00.000', timeZone: 'UTC', scheduledAt: '2026-03-01T09:00:00.000Z' }
  assert.deepEqual(resolveDailyOccurrence(daily, at('2026-03-05T10:00:00Z')), { occurrenceAt: '2026-03-05T09:00:00.000Z', nextScheduledAt: '2026-03-06T09:00:00.000Z' })
  assert.deepEqual(resolveDailyOccurrence(daily, at('2026-03-05T08:00:00Z')), { occurrenceAt: '2026-03-04T09:00:00.000Z', nextScheduledAt: '2026-03-05T09:00:00.000Z' })
  const drifted: DailyRecord = { ...daily, scheduledAt: '2026-03-05T09:30:00.000Z' }
  assert.equal(resolveDailyOccurrence(drifted, at('2026-03-05T09:45:00Z')).occurrenceAt, '2026-03-05T09:30:00.000Z', 'never earlier than the committed target')

  const weekly: WeeklyRecord = { id: 'w', kind: 'weekly', title: 't', prompt: 'p', time: '09:00:00.000', timeZone: 'UTC', weekdays: [1, 4], scheduledAt: '2026-10-01T09:00:00.000Z' }
  assert.deepEqual(resolveWeeklyOccurrence(weekly, at('2026-10-28T12:00:00Z')), {
    occurrenceAt: '2026-10-26T09:00:00.000Z',
    nextScheduledAt: '2026-10-29T09:00:00.000Z',
  }, 'Monday 26th is the latest selected day; Thursday 29th is next')
})

test('cron downtime: the latest matching time at or before the decision, then the first after it', () => {
  const hourly: CronRecord = { id: 'c', kind: 'cron', title: 't', prompt: 'p', expression: '0 * * * *', timeZone: 'UTC', scheduledAt: '2026-10-29T06:00:00.000Z' }
  assert.deepEqual(resolveCronOccurrence(hourly, at('2026-10-29T11:30:00Z')), { occurrenceAt: '2026-10-29T11:00:00.000Z', nextScheduledAt: '2026-10-29T12:00:00.000Z' })
  assert.deepEqual(resolveCronOccurrence(hourly, at('2026-10-29T12:00:00Z')), { occurrenceAt: '2026-10-29T12:00:00.000Z', nextScheduledAt: '2026-10-29T13:00:00.000Z' })
})

test('a view adds state and deliveryMode after the record, in DSH key order', () => {
  const record = createDailyScheduleRecord('schedule-1', "Review today's tasks", { time: '23:00:00', time_zone: 'Asia/Shanghai' }, NOW, 'Daily review')
  assert.equal(
    JSON.stringify(scheduleView(record, NOW)),
    '{"id":"schedule-1","kind":"daily","title":"Daily review","prompt":"Review today\'s tasks","time":"23:00:00.000","timeZone":"Asia/Shanghai","scheduledAt":"2026-10-29T15:00:00.000Z","state":"scheduled","deliveryMode":"host"}',
  )
  assert.equal(scheduleView(record, at('2026-10-29T15:00:00Z')).state, 'overdue', 'now >= scheduledAt is overdue')
})

const DAILY: DailyRecord = { id: 'd', kind: 'daily', title: 'Review', prompt: 'p', time: '09:00:00.000', timeZone: 'UTC', scheduledAt: '2026-10-30T09:00:00.000Z' }

test('update: an incomplete expected is invalid_rule, a different one is schedule_conflict', () => {
  assert.deepEqual(resolveScheduleUpdate(DAILY, { ...DAILY, extra: 1 }, undefined, NOW, { title: 'x' }), { code: 'invalid_rule', message: 'expected must be a complete valid Schedule record.' })
  assert.deepEqual(resolveScheduleUpdate(DAILY, null, undefined, NOW, { title: 'x' }), { code: 'invalid_rule', message: 'expected must be a complete valid Schedule record.' })
  assert.deepEqual(resolveScheduleUpdate(DAILY, { ...DAILY, prompt: 'other' }, undefined, NOW, { title: 'x' }), { id: 'd', updated: false, code: 'schedule_conflict' })
})

test('update: title or prompt alone keeps the target; an unchanged request is a no-op', () => {
  const titled = resolveScheduleUpdate(DAILY, DAILY, undefined, NOW, { title: '  Evening review ', prompt: ' new ' })
  assert.deepEqual(titled, { id: 'd', updated: true, record: { ...DAILY, title: 'Evening review', prompt: 'new' } })
  const same = resolveScheduleUpdate(DAILY, DAILY, undefined, NOW, { title: 'Review' })
  assert.ok('record' in same && same.updated === false && same.record === DAILY)
  assert.deepEqual(resolveScheduleUpdate(DAILY, DAILY, undefined, NOW, { prompt: '  ' }), { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' })
  assert.deepEqual(resolveScheduleUpdate(DAILY, DAILY, undefined, NOW, { title: 'x'.repeat(121) }), { code: 'invalid_prompt', message: 'title must be at most 120 characters.' })
})

test('update: every re-anchors to the save time on a different interval; the same interval is a no-op', () => {
  const record = every('2026-10-29T12:00:30.000Z', 60)
  const changed = resolveScheduleUpdate(record, record, { kind: 'every', every_seconds: 120 }, NOW, {})
  assert.ok('record' in changed)
  assert.equal(changed.record.scheduledAt, '2026-10-29T12:02:00.000Z', 'save time + new interval, not the old anchor')
  const same = resolveScheduleUpdate(record, record, { kind: 'every', every_seconds: 60 }, NOW, {})
  assert.ok('record' in same && same.updated === false && same.record.scheduledAt === record.scheduledAt)
  assert.deepEqual(resolveScheduleUpdate(record, record, { kind: 'every', every_seconds: 30 }, NOW, {}), { code: 'frequency_too_high', message: 'every_seconds must be at least 60.' })
})

test('update: equivalent normalized rules keep the target; a different rule or kind recomputes from the save time', () => {
  const sameDaily = resolveScheduleUpdate(DAILY, DAILY, { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Etc/UTC' } }, NOW, {})
  assert.ok('record' in sameDaily && sameDaily.updated === false)
  const weekly: WeeklyRecord = { id: 'w', kind: 'weekly', title: 't', prompt: 'p', time: '09:00:00.000', timeZone: 'UTC', weekdays: [1, 5], scheduledAt: '2026-10-30T09:00:00.000Z' }
  const sameWeekly = resolveScheduleUpdate(weekly, weekly, { kind: 'weekly', weekly: { time: '09:00:00.000', time_zone: 'UTC', weekdays: [5, 1] } }, NOW, {})
  assert.ok('record' in sameWeekly && sameWeekly.updated === false)
  const cron: CronRecord = { id: 'c', kind: 'cron', title: 't', prompt: 'p', expression: '0-45/15 * * * *', timeZone: 'UTC', scheduledAt: '2026-10-29T12:15:00.000Z' }
  const sameCron = resolveScheduleUpdate(cron, cron, { kind: 'cron', cron: { expression: '0,15,30,45 * * * *', time_zone: 'UTC' } }, NOW, {})
  assert.ok('record' in sameCron && sameCron.updated === false)

  const toCron = resolveScheduleUpdate(DAILY, DAILY, { kind: 'cron', cron: { expression: '30 12 * * *', time_zone: 'UTC' } }, NOW, {})
  assert.deepEqual(toCron, {
    id: 'd',
    updated: true,
    record: { id: 'd', kind: 'cron', title: 'Review', prompt: 'p', expression: '30 12 * * *', timeZone: 'UTC', scheduledAt: '2026-10-29T12:30:00.000Z' },
  })
})

test('update: at keeps an after record when the instant is the same, and refuses a past instant', () => {
  const after = createAfterScheduleRecord('a', 'p', 3600, NOW, 't')
  const same = resolveScheduleUpdate(after, after, { kind: 'at', at: '2026-10-29T13:00:00Z' }, NOW, {})
  assert.ok('record' in same && same.updated === false && same.record.kind === 'after')
  const moved = resolveScheduleUpdate(after, after, { kind: 'at', at: '2026-10-29T14:00:00+00:00' }, NOW, {})
  assert.ok('record' in moved && moved.record.kind === 'at' && moved.record.scheduledAt === '2026-10-29T14:00:00.000Z')
  assert.deepEqual(resolveScheduleUpdate(after, after, { kind: 'at', at: '2026-10-29T11:00:00Z' }, NOW, {}), { code: 'not_future', message: 'The scheduled time must be strictly in the future.' })
})

test('update: a malformed timing change is invalid_rule with DSH wording', () => {
  assert.deepEqual(resolveScheduleUpdate(DAILY, DAILY, null, NOW, {}), { code: 'invalid_rule', message: 'Timing change must be an object with exactly one supported timing selector.' })
  const exact = { code: 'invalid_rule', message: 'Timing change must contain exactly kind and its matching timing selector.' }
  assert.deepEqual(resolveScheduleUpdate(DAILY, DAILY, { kind: 'hourly', at: 'x' }, NOW, {}), exact)
  assert.deepEqual(resolveScheduleUpdate(DAILY, DAILY, { kind: 'at' }, NOW, {}), exact)
  assert.deepEqual(resolveScheduleUpdate(DAILY, DAILY, { kind: 'at', at: 'x', cron: {} }, NOW, {}), exact)
})

test('decode: every kind round-trips; malformed stored records are ScheduleLogErrors', () => {
  const records: ScheduleRecord[] = [
    createAfterScheduleRecord('a', 'p', 60, NOW, 't'),
    createAtScheduleRecord('b', 'p', '2026-11-01T00:00:00Z', NOW, 't'),
    createEveryScheduleRecord('c', 'p', 60, NOW, 't'),
    DAILY,
    createWeeklyScheduleRecord('w', 'p', { time: '09:00:00', time_zone: 'UTC', weekdays: [3, 1] }, NOW, 't'),
    createCronScheduleRecord('x', 'p', { expression: '0 9 * * 7', time_zone: 'UTC' }, NOW, 't'),
  ]
  for (const record of records) assert.deepEqual(decodeScheduleRecord(JSON.parse(JSON.stringify(record))), record)

  const corrupt = (value: unknown, message: string) =>
    assert.throws(() => decodeScheduleRecord(value), (error: unknown) => error instanceof ScheduleLogError && error.message === message)
  const { title: _title, ...untitled } = records[2] as EveryRecord
  corrupt(untitled, 'title is required and must be non-empty after trimming.')
  corrupt({ ...DAILY, prompt: ' p' }, 'daily prompt must be non-empty and already trimmed')
  corrupt({ ...DAILY, time: '09:00:00' }, 'daily time must be normalized to HH:mm:ss.SSS')
  corrupt({ ...DAILY, extra: 1 }, 'daily schedule must contain exactly id, kind, title, prompt, time, timeZone, and scheduledAt')
  corrupt({ ...DAILY, scheduledAt: '2026-10-30T09:00:00Z' }, 'scheduledAt must be a canonical four-digit-year RFC 3339 UTC instant')
  corrupt({ ...(records[4] as WeeklyRecord), weekdays: [3, 1] }, 'weekly weekdays must be normalized to unique ascending ISO weekday numbers')
  corrupt({ ...(records[5] as CronRecord), expression: '0 9 * * 7' }, 'cron expression must be canonical')
  corrupt({ ...DAILY, kind: 'hourly' }, 'v1 schedule kind must be "after", "at", or "every"')
  corrupt('x', 'schedule record must be an object')
})
