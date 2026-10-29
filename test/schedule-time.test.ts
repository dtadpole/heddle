import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ScheduleInputError } from '../src/schedule/errors.ts'
import {
  addDays,
  addYears,
  canonicalizeTimeZone,
  dateOfEpochDay,
  epochDay,
  firstOfNextMonth,
  formatInstant,
  isoDayOfWeek,
  lastOfPreviousMonth,
  localDate,
  localInstant,
  localTime,
  MAX_FOUR_DIGIT_YEAR_MS,
  MIN_FOUR_DIGIT_YEAR_MS,
  offsetAt,
} from '../src/schedule/time.ts'

/**
 * The calendar and zone arithmetic that replaces Temporal.
 *
 * The two DST edges every schedule test leans on are pinned here first, in America/Los_Angeles: 2026-03-08 02:30 does
 * not exist (clocks jump 02:00 → 03:00), and 2026-11-01 01:30 happens twice (01:00-02:00 repeats). A gap must answer
 * "no instant", and an overlap must answer the **earlier** instant — DSH's disambiguation `earlier` plus its round trip.
 */

const LA = 'America/Los_Angeles'
const time = (hour: number, minute = 0, second = 0, millisecond = 0) => ({ hour, minute, second, millisecond })

const refusesZone = (value: string) =>
  assert.throws(
    () => canonicalizeTimeZone(value),
    (error: unknown) => error instanceof ScheduleInputError && error.code === 'invalid_time_zone' && error.message === 'time_zone must be UTC or a valid IANA Area/Location name.',
    value,
  )

test('zones: UTC and Area/Location names canonicalize through Intl; anything else is invalid_time_zone', () => {
  assert.equal(canonicalizeTimeZone('UTC'), 'UTC')
  assert.equal(canonicalizeTimeZone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(canonicalizeTimeZone('Etc/UTC'), 'UTC', 'an alias resolves to the runtime canonical name')
  assert.equal(canonicalizeTimeZone('America/Argentina/Buenos_Aires').includes('Buenos_Aires'), true, 'a three-part name is an Area/Location name')
  for (const bad of ['', 'utc', 'PST', ' UTC', 'UTC ', 'Mars/Phobos', 'Asia/', '/Asia', 'asia shanghai']) refusesZone(bad)
})

test('epoch days round-trip across leap years, year 0 and the four-digit edges', () => {
  for (const date of [
    { year: 1970, month: 1, day: 1 },
    { year: 2000, month: 2, day: 29 },
    { year: 1900, month: 3, day: 1 },
    { year: 0, month: 12, day: 31 },
    { year: 1, month: 1, day: 1 },
    { year: 9999, month: 12, day: 31 },
    { year: 2026, month: 10, day: 29 },
  ]) {
    assert.deepEqual(dateOfEpochDay(epochDay(date)), date)
  }
  assert.equal(epochDay({ year: 1970, month: 1, day: 1 }), 0)
  assert.deepEqual(addDays({ year: 2028, month: 2, day: 28 }, 1), { year: 2028, month: 2, day: 29 })
  assert.deepEqual(addDays({ year: 2026, month: 1, day: 1 }, -1), { year: 2025, month: 12, day: 31 })
})

test('weekday, month and year steps follow Temporal: ISO weekdays, first-of-next, last-of-previous, constrained years', () => {
  assert.equal(isoDayOfWeek({ year: 2026, month: 10, day: 26 }), 1, 'a Monday')
  assert.equal(isoDayOfWeek({ year: 2026, month: 11, day: 1 }), 7, 'a Sunday')
  assert.equal(isoDayOfWeek({ year: 1970, month: 1, day: 1 }), 4, 'a Thursday')
  assert.deepEqual(firstOfNextMonth({ year: 2026, month: 1, day: 31 }), { year: 2026, month: 2, day: 1 })
  assert.deepEqual(firstOfNextMonth({ year: 2026, month: 12, day: 5 }), { year: 2027, month: 1, day: 1 })
  assert.deepEqual(lastOfPreviousMonth({ year: 2028, month: 3, day: 17 }), { year: 2028, month: 2, day: 29 })
  assert.deepEqual(addYears({ year: 2028, month: 2, day: 29 }, 1), { year: 2029, month: 2, day: 28 })
  assert.deepEqual(addYears({ year: 2028, month: 2, day: 29 }, 400), { year: 2428, month: 2, day: 29 })
})

test('offsets come from the IANA data, including the hour change and local mean time', () => {
  assert.equal(offsetAt(Date.parse('2026-01-15T12:00:00Z'), LA), -8 * 3_600_000)
  assert.equal(offsetAt(Date.parse('2026-07-15T12:00:00Z'), LA), -7 * 3_600_000)
  assert.equal(offsetAt(Date.parse('2026-07-15T12:00:00Z'), 'Asia/Kolkata'), 5.5 * 3_600_000)
  assert.equal(offsetAt(Date.parse('2026-07-15T12:00:00Z'), 'UTC'), 0)
  assert.equal(offsetAt(MIN_FOUR_DIGIT_YEAR_MS, LA), -(7 * 3600 + 52 * 60 + 58) * 1000, "Los Angeles' local mean time, read through a BC era")
})

test('local date and time of an instant in a zone', () => {
  const instant = Date.parse('2026-11-01T08:30:00.250Z')
  assert.deepEqual(localDate(instant, LA), { year: 2026, month: 11, day: 1 })
  assert.deepEqual(localTime(instant, LA), time(1, 30, 0, 250))
  assert.deepEqual(localDate(MIN_FOUR_DIGIT_YEAR_MS, LA), { year: 0, month: 12, day: 31 })
  assert.deepEqual(localDate(MAX_FOUR_DIGIT_YEAR_MS, 'UTC'), { year: 9999, month: 12, day: 31 })
})

test('a wall time in a DST gap has no instant', () => {
  assert.equal(localInstant({ year: 2026, month: 3, day: 8 }, time(2, 30), LA), undefined)
  assert.equal(localInstant({ year: 2026, month: 3, day: 8 }, time(2, 0), LA), undefined)
  assert.equal(formatInstant(localInstant({ year: 2026, month: 3, day: 8 }, time(3, 0), LA) as number), '2026-03-08T10:00:00.000Z')
  assert.equal(formatInstant(localInstant({ year: 2026, month: 3, day: 8 }, time(1, 59, 59, 999), LA) as number), '2026-03-08T09:59:59.999Z')
})

test('a wall time in a DST overlap resolves to the earlier instant', () => {
  assert.equal(formatInstant(localInstant({ year: 2026, month: 11, day: 1 }, time(1, 30), LA) as number), '2026-11-01T08:30:00.000Z')
  assert.equal(formatInstant(localInstant({ year: 2026, month: 11, day: 1 }, time(1, 0), LA) as number), '2026-11-01T08:00:00.000Z')
  assert.equal(formatInstant(localInstant({ year: 2026, month: 11, day: 1 }, time(2, 0), LA) as number), '2026-11-01T10:00:00.000Z')
})

test('half-hour and date-line zones resolve exactly', () => {
  assert.equal(formatInstant(localInstant({ year: 2026, month: 10, day: 29 }, time(23), 'Asia/Shanghai') as number), '2026-10-29T15:00:00.000Z')
  assert.equal(formatInstant(localInstant({ year: 2026, month: 1, day: 1 }, time(0), 'Asia/Kathmandu') as number), '2025-12-31T18:15:00.000Z')
  assert.equal(localInstant({ year: 2011, month: 12, day: 30 }, time(12), 'Pacific/Apia'), undefined, 'Samoa skipped 2011-12-30 entirely')
})

test('instants are spelled canonically: four-digit year, milliseconds, Z', () => {
  assert.equal(formatInstant(Date.parse('2026-10-29T15:00:00Z')), '2026-10-29T15:00:00.000Z')
  assert.equal(formatInstant(MIN_FOUR_DIGIT_YEAR_MS), '0001-01-01T00:00:00.000Z')
  assert.equal(formatInstant(MAX_FOUR_DIGIT_YEAR_MS), '9999-12-31T23:59:59.999Z')
})
