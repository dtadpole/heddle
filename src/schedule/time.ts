import { ScheduleInputError } from './errors.ts'

/**
 * Calendar and time-zone arithmetic for schedules, without Temporal.
 *
 * DSH computes every target with `@js-temporal/polyfill`; Node 24 ships no `Temporal`, and this project takes no
 * dependency for one module. What DSH actually uses of Temporal is small and is reproduced here exactly:
 *
 * - **plain dates** — proleptic Gregorian `{year, month, day}`, stepped by days, months and years. They are carried as
 *   an epoch-day number (Howard Hinnant's `days_from_civil`), so stepping is integer arithmetic and year 0 and the
 *   four-digit edges behave the same as everywhere else;
 * - **a zone's offset at an instant** — read from `Intl.DateTimeFormat#formatToParts`, the same IANA data Temporal
 *   reads, at one-second resolution (local-mean-time offsets have seconds);
 * - **a local wall time to an instant**, with DSH's disambiguation `earlier` **and** its round-trip check
 *   (SVC:245-248). For wall time W in zone Z, read W as if it were UTC (call it t); the candidate offsets are Z's
 *   offsets a day either side of t; each candidate o gives the instant t - o, which is kept only if Z shows W at that
 *   instant. None kept is a **gap** (the wall time does not exist); two kept is an **overlap**, and the earlier wins.
 *
 * Canonical UTC instants are `YYYY-MM-DDTHH:mm:ss.sssZ`, which is `Date#toISOString` for every four-digit year.
 */

/** Milliseconds in one day. */
export const DAY_MS = 86_400_000

/** The first instant a four-digit-year RFC 3339 UTC string can name. */
export const MIN_FOUR_DIGIT_YEAR_MS = Date.parse('0001-01-01T00:00:00.000Z')

/** The last instant a four-digit-year RFC 3339 UTC string can name. */
export const MAX_FOUR_DIGIT_YEAR_MS = Date.parse('9999-12-31T23:59:59.999Z')

/** The canonical stored instant: four-digit year (never 0000), milliseconds, `Z` (SVC:26). */
export const UTC_INSTANT = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/

/** An `Area/Location` zone name, as DSH accepts it before asking Intl (SVC:31). */
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/** A calendar date with no zone. */
export interface PlainDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** A wall-clock time of day with no zone. */
export interface PlainTime {
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly millisecond: number
}

/** Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's `days_from_civil`). */
export function epochDay(date: PlainDate): number {
  const year = date.month <= 2 ? date.year - 1 : date.year
  const era = Math.floor(year / 400)
  const yearOfEra = year - era * 400
  const shiftedMonth = (date.month + 9) % 12
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + date.day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146_097 + dayOfEra - 719_468
}

/** The proleptic Gregorian date of a day count since 1970-01-01 (Hinnant's `civil_from_days`). */
export function dateOfEpochDay(days: number): PlainDate {
  const shifted = days + 719_468
  const era = Math.floor(shifted / 146_097)
  const dayOfEra = shifted - era * 146_097
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365)
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
  return { year, month, day }
}

/** Whether a proleptic Gregorian year is a leap year. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Days in one month of one year. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/** Whether `{year, month, day}` names a real date (month 1-12, day within the month). */
export function isRealDate(year: number, month: number, day: number): boolean {
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

/** A date stepped by whole days (negative steps back). */
export function addDays(date: PlainDate, days: number): PlainDate {
  return dateOfEpochDay(epochDay(date) + days)
}

/** A date stepped by whole years, clamping the day to the target month like Temporal's `constrain`. */
export function addYears(date: PlainDate, years: number): PlainDate {
  const year = date.year + years
  return { year, month: date.month, day: Math.min(date.day, daysInMonth(year, date.month)) }
}

/** The first day of the month after `date` — Temporal's `date.add({months: 1}).with({day: 1})`. */
export function firstOfNextMonth(date: PlainDate): PlainDate {
  return date.month === 12 ? { year: date.year + 1, month: 1, day: 1 } : { year: date.year, month: date.month + 1, day: 1 }
}

/** The last day of the month before `date` — Temporal's `date.with({day: 1}).subtract({days: 1})`. */
export function lastOfPreviousMonth(date: PlainDate): PlainDate {
  return addDays({ year: date.year, month: date.month, day: 1 }, -1)
}

/** Negative, zero or positive as `left` is before, on or after `right`. */
export function compareDates(left: PlainDate, right: PlainDate): number {
  return epochDay(left) - epochDay(right)
}

/** Negative, zero or positive as `left` is before, at or after `right`. */
export function compareTimes(left: PlainTime, right: PlainTime): number {
  return timeOfDayMs(left) - timeOfDayMs(right)
}

/** ISO weekday of a date: Monday 1 through Sunday 7. 1970-01-01 was a Thursday. */
export function isoDayOfWeek(date: PlainDate): number {
  return ((((epochDay(date) + 3) % 7) + 7) % 7) + 1
}

/** Milliseconds since local midnight of a wall-clock time. */
export function timeOfDayMs(time: PlainTime): number {
  return ((time.hour * 60 + time.minute) * 60 + time.second) * 1000 + time.millisecond
}

/** A wall-clock date and time read as if it were UTC, in epoch milliseconds. */
export function wallMs(date: PlainDate, time: PlainTime): number {
  return epochDay(date) * DAY_MS + timeOfDayMs(time)
}

/** The canonical UTC spelling of an instant: `YYYY-MM-DDTHH:mm:ss.sssZ` for every four-digit year. */
export function formatInstant(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

/**
 * Validate and canonicalize one raw time-zone selector — DSH's `canonicalizeTimeZone` (SVC:212-223).
 *
 * `UTC` or an `Area/Location` shape first, so a bare abbreviation such as `PST` or a lowercase `utc` is refused before
 * Intl can accept it; then Intl's own resolution, which is the runtime's canonical name.
 */
export function canonicalizeTimeZone(value: string): string {
  if (value.length === 0 || value.trim() !== value || (value !== 'UTC' && !IANA_ZONE.test(value))) {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be UTC or a valid IANA Area/Location name.')
  }
  let canonical: string
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch (error) {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must be UTC or a valid IANA Area/Location name.', { cause: error })
  }
  if (canonical !== 'UTC' && !IANA_ZONE.test(canonical)) {
    throw new ScheduleInputError('invalid_time_zone', 'time_zone must resolve to UTC or an IANA Area/Location name.')
  }
  return canonical
}

/** One formatter per zone: constructing `Intl.DateTimeFormat` costs far more than formatting with one. */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * A zone's UTC offset at one instant, in milliseconds (wall time minus UTC).
 *
 * The era is read because Intl spells years before 1 CE as `1 BC`, `2 BC`, …; ISO year 0 is 1 BC. An `hour` of 24 is
 * the old `hour12: false` midnight spelling, mapped to 0 on the same date in case a runtime still produces it.
 */
export function offsetAt(epochMs: number, timeZone: string): number {
  let year = 0
  let month = 1
  let day = 1
  let hour = 0
  let minute = 0
  let second = 0
  let beforeCommonEra = false
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    switch (part.type) {
      case 'year':
        year = Number(part.value)
        break
      case 'month':
        month = Number(part.value)
        break
      case 'day':
        day = Number(part.value)
        break
      case 'hour':
        hour = Number(part.value) % 24
        break
      case 'minute':
        minute = Number(part.value)
        break
      case 'second':
        second = Number(part.value)
        break
      case 'era':
        beforeCommonEra = part.value.startsWith('B')
        break
      default:
        break
    }
  }
  if (beforeCommonEra) year = 1 - year
  const wholeSecond = Math.floor(epochMs / 1000) * 1000
  return wallMs({ year, month, day }, { hour, minute, second, millisecond: 0 }) - wholeSecond
}

/** The wall-clock reading of an instant in a zone, as an as-if-UTC epoch. */
export function zonedWallMs(epochMs: number, timeZone: string): number {
  return epochMs + offsetAt(epochMs, timeZone)
}

/** The local calendar date of an instant in a zone — Temporal's `toZonedDateTimeISO(zone).toPlainDate()`. */
export function localDate(epochMs: number, timeZone: string): PlainDate {
  return dateOfEpochDay(Math.floor(zonedWallMs(epochMs, timeZone) / DAY_MS))
}

/** The local wall-clock time of an instant in a zone — Temporal's `toZonedDateTimeISO(zone).toPlainTime()`. */
export function localTime(epochMs: number, timeZone: string): PlainTime {
  const wall = zonedWallMs(epochMs, timeZone)
  let rest = wall - Math.floor(wall / DAY_MS) * DAY_MS
  const hour = Math.floor(rest / 3_600_000)
  rest -= hour * 3_600_000
  const minute = Math.floor(rest / 60_000)
  rest -= minute * 60_000
  const second = Math.floor(rest / 1000)
  return { hour, minute, second, millisecond: rest - second * 1000 }
}

/**
 * The instant a local date and time names in a zone, or `undefined` when that wall time does not exist there.
 *
 * DSH's `localInstant` (SVC:245-248): disambiguation `earlier`, then a round trip that must reproduce the wall time.
 * A gap therefore answers `undefined` (Temporal's `earlier` lands before the gap and fails the round trip), and an
 * overlap answers its earlier instant.
 */
export function localInstant(date: PlainDate, time: PlainTime, timeZone: string): number | undefined {
  const wall = wallMs(date, time)
  const candidates = new Set([offsetAt(wall - DAY_MS, timeZone), offsetAt(wall + DAY_MS, timeZone)])
  let earliest: number | undefined
  for (const offset of candidates) {
    const instant = wall - offset
    if (zonedWallMs(instant, timeZone) !== wall) continue
    if (earliest === undefined || instant < earliest) earliest = instant
  }
  return earliest
}
