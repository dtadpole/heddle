import { isDeepStrictEqual } from 'node:util'

import { canonicalizeCronExpression, cronDateMatch, cronTimes, parseCronExpression, type ParsedCron } from './cron.ts'
import { ScheduleInputError, ScheduleLogError } from './errors.ts'
import {
  addDays,
  addYears,
  canonicalizeTimeZone,
  compareDates,
  compareTimes,
  firstOfNextMonth,
  formatInstant,
  isoDayOfWeek,
  isRealDate,
  lastOfPreviousMonth,
  localDate,
  localInstant,
  localTime,
  MAX_FOUR_DIGIT_YEAR_MS,
  MIN_FOUR_DIGIT_YEAR_MS,
  UTC_INSTANT,
  wallMs,
  type PlainDate,
  type PlainTime,
} from './time.ts'

/**
 * Schedule records and the rules that make them: selector validation, record construction, the next target, the
 * latest missed occurrence, the in-place update, and the strict decoder for stored records.
 *
 * Every function here is a port of DSH's `dsh-schedule` domain (SVC:18-1385, 1692-1837) and keeps its messages
 * character for character, because they are what a model reads back. All are pure: the caller supplies `now`, so the
 * same input always gives the same record, and a test can pin a DST edge without waiting for one.
 *
 * The record is the durable unit: `{id, kind, title, prompt, <kind fields>, scheduledAt}` in that key order, which is
 * also the order a view's JSON carries. `scheduledAt` is the **committed** target — the earliest occurrence not yet
 * delivered — and it is never recomputed on decode or restart; only a delivery or a timing update moves it.
 */

/** Fixed lower bound of a fixed-rate reminder, in seconds. */
export const MIN_EVERY_INTERVAL_SECONDS = 60

/** Fixed upper bound of a stored title, in UTF-16 units (JS `length`, as DSH measures it). */
export const MAX_TITLE_LENGTH = 120

/** The diagnostic for a title that is missing or blank after trimming. */
export const REQUIRED_TITLE_MESSAGE = 'title is required and must be non-empty after trimming.'

const OFFSET_INSTANT =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?(?<zone>Z|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/
const LOCAL_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/
const LOCAL_TIME = /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?$/
const LOCAL_CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/

/** A one-shot reminder delivered a fixed delay after its creation. */
export interface AfterRecord {
  readonly id: string
  readonly kind: 'after'
  readonly title: string
  readonly prompt: string
  readonly afterSeconds: number
  readonly scheduledAt: string
}

/** A one-shot reminder at an absolute instant; only the UTC instant is kept, never the zone it was given in. */
export interface AtRecord {
  readonly id: string
  readonly kind: 'at'
  readonly title: string
  readonly prompt: string
  readonly scheduledAt: string
}

/** A fixed-rate reminder, anchored to its creation (or its last interval change). */
export interface EveryRecord {
  readonly id: string
  readonly kind: 'every'
  readonly title: string
  readonly prompt: string
  readonly everySeconds: number
  readonly scheduledAt: string
}

/** A reminder every day at one local time in one zone. */
export interface DailyRecord {
  readonly id: string
  readonly kind: 'daily'
  readonly title: string
  readonly prompt: string
  readonly time: string
  readonly timeZone: string
  readonly scheduledAt: string
}

/** A reminder on chosen ISO weekdays at one local time in one zone. */
export interface WeeklyRecord {
  readonly id: string
  readonly kind: 'weekly'
  readonly title: string
  readonly prompt: string
  readonly time: string
  readonly timeZone: string
  readonly weekdays: readonly number[]
  readonly scheduledAt: string
}

/** A reminder on a five-field cron expression in one zone. */
export interface CronRecord {
  readonly id: string
  readonly kind: 'cron'
  readonly title: string
  readonly prompt: string
  readonly expression: string
  readonly timeZone: string
  readonly scheduledAt: string
}

export type ScheduleRecord = AfterRecord | AtRecord | EveryRecord | DailyRecord | WeeklyRecord | CronRecord
export type RecurringRecord = EveryRecord | DailyRecord | WeeklyRecord | CronRecord
export type ScheduleKind = ScheduleRecord['kind']

/** A record as a reader sees it: whether it is already due, and who delivers it (always the host). */
export type ScheduleView = ScheduleRecord & { readonly state: 'scheduled' | 'overdue'; readonly deliveryMode: 'host' }

/** One recurring decision: the occurrence delivered now, and the next target when one is representable. */
export interface Occurrence {
  readonly occurrenceAt: string
  readonly nextScheduledAt?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected)
  return expected.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
}

function hasKeysWithOptional(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
}

// ---------------------------------------------------------------------------------------------------------------
// Title, prompt and instants
// ---------------------------------------------------------------------------------------------------------------

/** Validate a supplied title: required, trimmed, at most 120 characters. Returns the trimmed title. */
export function scheduleTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim().length === 0) throw new ScheduleInputError('invalid_prompt', REQUIRED_TITLE_MESSAGE)
  const normalized = title.trim()
  if (normalized.length > MAX_TITLE_LENGTH) throw new ScheduleInputError('invalid_prompt', `title must be at most ${MAX_TITLE_LENGTH} characters.`)
  return normalized
}

/** Validate a replacement prompt: a string, non-empty after trimming. Returns the trimmed prompt. */
export function schedulePrompt(prompt: unknown): string {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  return prompt.trim()
}

/** Validate one stored title: present, trimmed, non-empty, at most 120 characters. */
function decodeStoredTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ScheduleLogError(REQUIRED_TITLE_MESSAGE)
  if (value.length > MAX_TITLE_LENGTH) throw new ScheduleLogError(`title must be at most ${MAX_TITLE_LENGTH} characters`)
  if (value.trim() !== value) throw new ScheduleLogError('title must be a trimmed string')
  return value
}

function decodeId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ScheduleLogError('schedule id must be a non-empty string without surrounding whitespace')
  }
  return value
}

/** Validate one canonical four-digit-year UTC instant. */
export function decodeInstant(value: unknown): string {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) throw new ScheduleLogError('scheduledAt must be a canonical four-digit-year RFC 3339 UTC instant')
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || formatInstant(epoch) !== value) throw new ScheduleLogError('scheduledAt is not a real UTC calendar instant')
  return value
}

/** Require a safe, representable, strictly future target, and spell it canonically (SVC:178-185). */
export function futureInstant(epoch: number, now: number): string {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(epoch) || epoch < MIN_FOUR_DIGIT_YEAR_MS || epoch > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleInputError('time_out_of_range', 'The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.')
  }
  if (epoch <= now) throw new ScheduleInputError('not_future', 'The scheduled time must be strictly in the future.')
  return formatInstant(epoch)
}

interface CalendarParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly millisecond: number
}

/** Exact calendar fields as an as-if-UTC epoch, refusing any value a calendar would have to normalize. */
function calendarEpoch(parts: CalendarParts): number {
  if (!isRealDate(parts.year, parts.month, parts.day)) {
    throw new ScheduleInputError('invalid_rule', 'The at value must be a real ISO calendar date and time.')
  }
  return wallMs(parts, parts)
}

function milliseconds(value: string | undefined): number {
  return value === undefined ? 0 : Number(value.padEnd(3, '0'))
}

function group(groups: Record<string, string | undefined>, name: string): number {
  const value = groups[name]
  if (value === undefined) throw new ScheduleInputError('invalid_rule', 'The at value has an invalid shape.')
  return Number(value)
}

/** Parse a strict RFC 3339 instant whose `Z` or numeric offset is part of the input (SVC:187-206). */
function parseOffsetInstant(value: string): number {
  const groups = OFFSET_INSTANT.exec(value)?.groups
  if (groups === undefined) {
    throw new ScheduleInputError(
      'invalid_rule',
      'at must use YYYY-MM-DDTHH:mm:ss with optional 1-3 digit fractional seconds and an explicit Z or numeric offset.',
    )
  }
  const parts: CalendarParts = {
    year: group(groups, 'year'),
    month: group(groups, 'month'),
    day: group(groups, 'day'),
    hour: group(groups, 'hour'),
    minute: group(groups, 'minute'),
    second: group(groups, 'second'),
    millisecond: milliseconds(groups.fraction),
  }
  if (parts.year === 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    throw new ScheduleInputError('invalid_rule', 'The at value must be a real ISO calendar date and time.')
  }
  const local = calendarEpoch(parts)
  if (groups.zone === 'Z') return local
  const offsetHour = group(groups, 'offsetHour')
  const offsetMinute = group(groups, 'offsetMinute')
  if (offsetHour > 23 || offsetMinute > 59 || (groups.sign === '-' && offsetHour === 0 && offsetMinute === 0)) {
    throw new ScheduleInputError('invalid_rule', 'The at numeric offset is invalid.')
  }
  return local - (groups.sign === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60_000
}

/** Parse strict local calendar fields without consulting any zone (SVC:225-243). */
function parseLocalAt(value: { readonly date: string; readonly time: string }): { readonly date: PlainDate; readonly time: PlainTime } {
  const date = LOCAL_DATE.exec(value.date)?.groups
  const time = LOCAL_TIME.exec(value.time)?.groups
  if (date === undefined || time === undefined) {
    throw new ScheduleInputError(
      'invalid_rule',
      'Local at requires date YYYY-MM-DD and time HH:mm:ss with optional one-to-three digit milliseconds.',
    )
  }
  const parts: CalendarParts = {
    year: group(date, 'year'),
    month: group(date, 'month'),
    day: group(date, 'day'),
    hour: group(time, 'hour'),
    minute: group(time, 'minute'),
    second: group(time, 'second'),
    millisecond: milliseconds(time.fraction),
  }
  if (parts.year === 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    throw new ScheduleInputError('invalid_rule', 'The local at value must be a real ISO calendar date and time.')
  }
  calendarEpoch(parts)
  return {
    date: { year: parts.year, month: parts.month, day: parts.day },
    time: { hour: parts.hour, minute: parts.minute, second: parts.second, millisecond: parts.millisecond },
  }
}

/**
 * Parse an absolute selector without requiring it to be future (SVC:977-996).
 *
 * A string carries its own offset; an object is a local date and time in a named zone, where a wall time in a DST gap
 * is refused and one in an overlap resolves to its earlier instant.
 */
export function parseAtInput(at: unknown): number {
  if (typeof at === 'string') return parseOffsetInstant(at)
  if (!isRecord(at)) throw new ScheduleInputError('invalid_rule', 'at must be an explicit-offset string or local calendar object.')
  if (!hasExactKeys(at, ['date', 'time', 'time_zone'])) {
    throw new ScheduleInputError('invalid_rule', 'Local at must contain exactly date, time, and time_zone.')
  }
  if (typeof at.date !== 'string' || typeof at.time !== 'string') throw new ScheduleInputError('invalid_rule', 'Local at date and time must be strings.')
  const rawTimeZone = at.time_zone
  if (typeof rawTimeZone !== 'string') throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
  const local = parseLocalAt({ date: at.date, time: at.time })
  const target = localInstant(local.date, local.time, canonicalizeTimeZone(rawTimeZone))
  if (target === undefined) throw new ScheduleInputError('invalid_rule', 'The local at time does not exist in the selected time zone.')
  return target
}

// ---------------------------------------------------------------------------------------------------------------
// Wall-clock selectors
// ---------------------------------------------------------------------------------------------------------------

function parsePlainTime(value: string): PlainTime {
  const [clock = '', fraction] = value.split('.')
  const [hour = 0, minute = 0, second = 0] = clock.split(':').map(Number)
  return { hour, minute, second, millisecond: milliseconds(fraction) }
}

/** `HH:mm:ss.SSS`, the stored spelling of a wall-clock selector's time. */
export function formatPlainTime(time: PlainTime): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(time.hour)}:${two(time.minute)}:${two(time.second)}.${String(time.millisecond).padStart(3, '0')}`
}

/** Parse the strict local clock time shared by daily and weekly (SVC:333-336). */
function localClockTime(value: string, selector: 'daily' | 'weekly'): PlainTime {
  if (!LOCAL_CLOCK_TIME.test(value)) {
    throw new ScheduleInputError('invalid_rule', `${selector}.time must use HH:mm:ss with optional 1-3 fractional digits, without leap seconds or 24:00.`)
  }
  return parsePlainTime(value)
}

/** Normalize the ISO weekday set of a weekly rule: non-empty, unique, 1-7, returned ascending (SVC:394-405). */
export function normalizeWeekdays(weekdays: unknown): readonly number[] {
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    throw new ScheduleInputError('invalid_rule', 'weekly.weekdays must be a non-empty array of ISO weekday numbers.')
  }
  const unique = new Set<number>()
  for (const weekday of weekdays as unknown[]) {
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new ScheduleInputError('invalid_rule', 'Each weekly.weekdays entry must be an integer from 1 (Monday) through 7 (Sunday).')
    }
    if (unique.has(weekday)) throw new ScheduleInputError('invalid_rule', `weekly.weekdays must not repeat weekday ${weekday}.`)
    unique.add(weekday)
  }
  return [...unique].sort((left, right) => left - right)
}

/** Normalize a daily selector without computing a target. */
export function parseDailyInput(daily: unknown): { readonly time: string; readonly timeZone: string } {
  if (!isRecord(daily) || !hasExactKeys(daily, ['time', 'time_zone']) || typeof daily.time !== 'string') {
    throw new ScheduleInputError('invalid_rule', 'daily must contain exactly time and time_zone, with time HH:mm:ss and optional 1-3 fractional digits.')
  }
  if (typeof daily.time_zone !== 'string') throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
  return { time: formatPlainTime(localClockTime(daily.time, 'daily')), timeZone: canonicalizeTimeZone(daily.time_zone) }
}

/** Normalize a weekly selector without computing a target. */
export function parseWeeklyInput(weekly: unknown): { readonly time: string; readonly timeZone: string; readonly weekdays: readonly number[] } {
  if (!isRecord(weekly) || !hasExactKeys(weekly, ['time', 'time_zone', 'weekdays']) || typeof weekly.time !== 'string') {
    throw new ScheduleInputError(
      'invalid_rule',
      'weekly must contain exactly time, time_zone, and weekdays, with time HH:mm:ss and optional 1-3 fractional digits.',
    )
  }
  if (typeof weekly.time_zone !== 'string') throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
  return {
    time: formatPlainTime(localClockTime(weekly.time, 'weekly')),
    timeZone: canonicalizeTimeZone(weekly.time_zone),
    weekdays: normalizeWeekdays(weekly.weekdays),
  }
}

/** Normalize a cron selector without computing a target. */
export function parseCronInput(cron: unknown): { readonly expression: string; readonly timeZone: string } {
  if (!isRecord(cron) || !hasExactKeys(cron, ['expression', 'time_zone']) || typeof cron.expression !== 'string') {
    throw new ScheduleInputError('invalid_rule', 'cron must contain exactly expression and time_zone, with a five-field cron expression.')
  }
  if (typeof cron.time_zone !== 'string') throw new ScheduleInputError('invalid_time_zone', 'time_zone must be a string.')
  return { expression: parseCronExpression(cron.expression).expression, timeZone: canonicalizeTimeZone(cron.time_zone) }
}

// ---------------------------------------------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------------------------------------------

function normalizedPromptOf(prompt: unknown): string {
  const normalized = typeof prompt === 'string' ? prompt.trim() : ''
  if (normalized.length === 0) throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  return normalized
}

function requireCreationTime(now: number, label: 'Daily' | 'Weekly' | 'Cron'): void {
  if (!Number.isSafeInteger(now) || now < MIN_FOUR_DIGIT_YEAR_MS || now > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleInputError('time_out_of_range', `${label} creation time must be a representable four-digit-year UTC instant.`)
  }
}

/** An `after_seconds` reminder: target = now + seconds (SVC:938-951). */
export function createAfterScheduleRecord(id: string, prompt: unknown, afterSeconds: unknown, now: number, title: unknown): AfterRecord {
  const normalizedPrompt = normalizedPromptOf(prompt)
  if (typeof afterSeconds !== 'number' || !Number.isSafeInteger(afterSeconds) || afterSeconds <= 0) {
    throw new ScheduleInputError('invalid_rule', 'after_seconds must be a positive safe integer.')
  }
  const target = now + afterSeconds * 1000
  return { id, kind: 'after', title: scheduleTitle(title), prompt: normalizedPrompt, afterSeconds, scheduledAt: futureInstant(target, now) }
}

/** An absolute reminder: the selector's instant, which must be strictly future (SVC:961-971). */
export function createAtScheduleRecord(id: string, prompt: unknown, at: unknown, now: number, title: unknown): AtRecord {
  const normalizedPrompt = normalizedPromptOf(prompt)
  const validTitle = scheduleTitle(title)
  return { id, kind: 'at', title: validTitle, prompt: normalizedPrompt, scheduledAt: futureInstant(parseAtInput(at), now) }
}

/** A fixed-rate reminder: first target = now + interval, anchoring every later occurrence (SVC:1006-1020). */
export function createEveryScheduleRecord(id: string, prompt: unknown, everySeconds: unknown, now: number, title: unknown): EveryRecord {
  const normalizedPrompt = normalizedPromptOf(prompt)
  if (typeof everySeconds !== 'number' || !Number.isSafeInteger(everySeconds)) throw new ScheduleInputError('invalid_rule', 'every_seconds must be a safe integer.')
  if (everySeconds < MIN_EVERY_INTERVAL_SECONDS) throw new ScheduleInputError('frequency_too_high', `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`)
  const target = now + everySeconds * 1000
  return { id, kind: 'every', title: scheduleTitle(title), prompt: normalizedPrompt, everySeconds, scheduledAt: futureInstant(target, now) }
}

/** A daily reminder: the first actual local occurrence after now (SVC:1030-1046). */
export function createDailyScheduleRecord(id: string, prompt: unknown, daily: unknown, now: number, title: unknown): DailyRecord {
  const normalizedPrompt = normalizedPromptOf(prompt)
  const { time, timeZone } = parseDailyInput(daily)
  requireCreationTime(now, 'Daily')
  const scheduledAt = nextDailyTarget(parsePlainTime(time), timeZone, now)
  if (scheduledAt === undefined) throw new ScheduleInputError('time_out_of_range', 'No future daily occurrence is representable as a four-digit-year UTC instant.')
  return { id, kind: 'daily', title: scheduleTitle(title), prompt: normalizedPrompt, time, timeZone, scheduledAt }
}

/** A weekly reminder: the first actual local occurrence on a chosen weekday after now (SVC:1069-1086). */
export function createWeeklyScheduleRecord(id: string, prompt: unknown, weekly: unknown, now: number, title: unknown): WeeklyRecord {
  const normalizedPrompt = normalizedPromptOf(prompt)
  const { time, timeZone, weekdays } = parseWeeklyInput(weekly)
  requireCreationTime(now, 'Weekly')
  const scheduledAt = nextWeeklyTarget(parsePlainTime(time), timeZone, weekdays, now)
  if (scheduledAt === undefined) throw new ScheduleInputError('time_out_of_range', 'No future weekly occurrence is representable as a four-digit-year UTC instant.')
  return { id, kind: 'weekly', title: scheduleTitle(title), prompt: normalizedPrompt, time, timeZone, weekdays, scheduledAt }
}

/** A cron reminder: the first matching local occurrence after now (SVC:1096-1112). */
export function createCronScheduleRecord(id: string, prompt: unknown, cron: unknown, now: number, title: unknown): CronRecord {
  const normalizedPrompt = normalizedPromptOf(prompt)
  const { expression, timeZone } = parseCronInput(cron)
  requireCreationTime(now, 'Cron')
  const scheduledAt = nextCronTarget(parseCronExpression(expression), timeZone, now)
  if (scheduledAt === undefined) throw new ScheduleInputError('time_out_of_range', 'No future cron occurrence is representable as a four-digit-year UTC instant.')
  return { id, kind: 'cron', title: scheduleTitle(title), prompt: normalizedPrompt, expression, timeZone, scheduledAt }
}

// ---------------------------------------------------------------------------------------------------------------
// Next targets and the latest missed occurrence
// ---------------------------------------------------------------------------------------------------------------

/** Every date matches; the predicate of a rule that selects by time alone. */
const EVERY_DATE = (): boolean => true

function weekdaySet(weekdays: readonly number[]): (date: PlainDate) => boolean {
  const selected = new Set(weekdays)
  return (date) => selected.has(isoDayOfWeek(date))
}

/** The local date after the last four-digit-year instant, where every forward walk stops. */
const WALK_CEILING = addDays(localDate(MAX_FOUR_DIGIT_YEAR_MS, 'UTC'), 1)

/**
 * The first actual occurrence strictly after now — and, when `afterDate` is given, on a later local date than it
 * (SVC:624-635). A date whose wall time falls in a gap is **skipped**, never shifted; an overlap takes its earlier
 * instant.
 */
function nextMatchingTarget(time: PlainTime, timeZone: string, now: number, matches: (date: PlainDate) => boolean, afterDate?: PlainDate): string | undefined {
  let date = localDate(now, timeZone)
  if (afterDate !== undefined && compareDates(date, afterDate) <= 0) date = addDays(afterDate, 1)
  for (; compareDates(date, WALK_CEILING) <= 0; date = addDays(date, 1)) {
    if (!matches(date)) continue
    const target = localInstant(date, time, timeZone)
    if (target === undefined) continue
    if (target > MAX_FOUR_DIGIT_YEAR_MS) return undefined
    if (target >= MIN_FOUR_DIGIT_YEAR_MS && target > now) return formatInstant(target)
  }
  return undefined
}

/**
 * The latest actual occurrence at or before the decision, never earlier than the committed target (SVC:637-645).
 *
 * The walk starts the day after the decision's **UTC** date — DSH's own choice, which covers every zone's local date of
 * that instant — and goes back. DSH's loop has no floor because a daily or weekly rule always matches within a week;
 * the floor here only makes that assumption explicit, falling back to the committed target as the cron walk does.
 */
function latestDueOccurrence(timeZone: string, matches: (date: PlainDate) => boolean, time: PlainTime, acceptedAt: number, savedTarget: number): number {
  const floor = addDays(localDate(MIN_FOUR_DIGIT_YEAR_MS, 'UTC'), -1)
  for (let date = addDays(localDate(acceptedAt, 'UTC'), 1); compareDates(date, floor) >= 0; date = addDays(date, -1)) {
    if (!matches(date)) continue
    const candidate = localInstant(date, time, timeZone)
    if (candidate === undefined || candidate > acceptedAt) continue
    return Math.max(candidate, savedTarget)
  }
  return savedTarget
}

function acceptedDecision(selector: 'daily' | 'weekly' | 'cron', acceptedAt: number): number {
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt < MIN_FOUR_DIGIT_YEAR_MS || acceptedAt > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleLogError(`${selector} acceptedAt must be a representable four-digit-year instant`)
  }
  return acceptedAt
}

/** The first actual daily occurrence after now (and after a delivered local date, when given). */
export function nextDailyTarget(time: PlainTime, timeZone: string, now: number, afterDate?: PlainDate): string | undefined {
  return nextMatchingTarget(time, timeZone, now, EVERY_DATE, afterDate)
}

/** The first actual weekly occurrence after now (and after a delivered local date, when given). */
export function nextWeeklyTarget(time: PlainTime, timeZone: string, weekdays: readonly number[], now: number, afterDate?: PlainDate): string | undefined {
  return nextMatchingTarget(time, timeZone, now, weekdaySet(weekdays), afterDate)
}

/**
 * One fixed-rate decision without enumerating missed occurrences (SVC:595-611): the occurrence is the anchor plus a
 * whole number of intervals at or before the decision, and the next target is one interval later.
 */
export function resolveEveryOccurrence(record: EveryRecord, acceptedAt: number): Occurrence {
  const target = Date.parse(record.scheduledAt)
  const interval = record.everySeconds * 1000
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt < MIN_FOUR_DIGIT_YEAR_MS || acceptedAt > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ScheduleLogError('every acceptedAt must be a representable four-digit-year instant')
  }
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new ScheduleLogError('every interval milliseconds must be a positive safe integer')
  if (acceptedAt < target) throw new ScheduleLogError('every dispatch cannot precede the active scheduledAt')
  const occurrence = target + Math.floor((acceptedAt - target) / interval) * interval
  const occurrenceAt = formatInstant(occurrence)
  const next = occurrence + interval
  if (!Number.isSafeInteger(next) || next > MAX_FOUR_DIGIT_YEAR_MS) return { occurrenceAt }
  return { occurrenceAt, nextScheduledAt: formatInstant(next) }
}

/** One daily decision: the latest due occurrence, and the next one on a later local date (SVC:661-673). */
export function resolveDailyOccurrence(record: DailyRecord, acceptedAt: number): Occurrence {
  const decision = acceptedDecision('daily', acceptedAt)
  const savedTarget = Date.parse(record.scheduledAt)
  if (decision < savedTarget) throw new ScheduleLogError('daily dispatch cannot precede the active scheduledAt')
  const time = localClockTime(record.time, 'daily')
  const occurrence = latestDueOccurrence(record.timeZone, EVERY_DATE, time, decision, savedTarget)
  const occurrenceAt = formatInstant(occurrence)
  const nextScheduledAt = nextDailyTarget(time, record.timeZone, decision, localDate(occurrence, record.timeZone))
  return nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt }
}

/** One weekly decision: the latest due occurrence, and the next one on a later selected local date (SVC:692-705). */
export function resolveWeeklyOccurrence(record: WeeklyRecord, acceptedAt: number): Occurrence {
  const decision = acceptedDecision('weekly', acceptedAt)
  const savedTarget = Date.parse(record.scheduledAt)
  if (decision < savedTarget) throw new ScheduleLogError('weekly dispatch cannot precede the active scheduledAt')
  const time = localClockTime(record.time, 'weekly')
  const weekdays = normalizeWeekdays(record.weekdays)
  const occurrence = latestDueOccurrence(record.timeZone, weekdaySet(weekdays), time, decision, savedTarget)
  const occurrenceAt = formatInstant(occurrence)
  const nextScheduledAt = nextWeeklyTarget(time, record.timeZone, weekdays, decision, localDate(occurrence, record.timeZone))
  return nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt }
}

/** How far a cron walk searches before it calls a rule exhausted. */
const CRON_SEARCH_HORIZON_YEARS = 400

/**
 * The first matching cron occurrence strictly after `floor` (SVC:753-777): dates walk forward from the floor's local
 * date, skipping non-matching months; times run ascending, and on the first date a time before the floor's own time
 * is skipped. A gap skips that time, an overlap takes the earlier instant, and the walk stops at the 400-year horizon.
 */
export function nextCronTarget(parsed: ParsedCron, timeZone: string, floor: number): string | undefined {
  const times = cronTimes(parsed)
  const matches = cronDateMatch(parsed)
  const months = new Set(parsed.months)
  const firstDate = localDate(floor, timeZone)
  const floorTime = localTime(floor, timeZone)
  const horizon = addYears(firstDate, CRON_SEARCH_HORIZON_YEARS)
  const lastDate = compareDates(horizon, WALK_CEILING) < 0 ? horizon : WALK_CEILING
  let date = firstDate
  while (compareDates(date, lastDate) <= 0) {
    if (!months.has(date.month)) {
      date = firstOfNextMonth(date)
      continue
    }
    if (matches(date)) {
      const onFirstDate = compareDates(date, firstDate) === 0
      for (const time of times) {
        if (onFirstDate && compareTimes(time, floorTime) < 0) continue
        const target = localInstant(date, time, timeZone)
        if (target === undefined) continue
        if (target > MAX_FOUR_DIGIT_YEAR_MS) return undefined
        if (target >= MIN_FOUR_DIGIT_YEAR_MS && target > floor) return formatInstant(target)
      }
    }
    date = addDays(date, 1)
  }
  return undefined
}

/**
 * The latest matching cron occurrence at or before the decision, never earlier than the committed target
 * (SVC:791-819). A matching date whose earliest time is still after the decision is passed over whole; a rule with no
 * match inside the horizon keeps the committed target.
 */
export function latestCronOccurrence(parsed: ParsedCron, timeZone: string, decision: number, savedTarget: number): number {
  const times = cronTimes(parsed)
  const reversed = [...times].reverse()
  const matches = cronDateMatch(parsed)
  const months = new Set(parsed.months)
  let date = addDays(localDate(decision, 'UTC'), 1)
  const floorDate = localDate(MIN_FOUR_DIGIT_YEAR_MS, timeZone)
  const horizon = addYears(date, -CRON_SEARCH_HORIZON_YEARS)
  const firstDate = compareDates(horizon, floorDate) > 0 ? horizon : floorDate
  while (compareDates(date, firstDate) >= 0) {
    if (!months.has(date.month)) {
      date = lastOfPreviousMonth(date)
      continue
    }
    if (matches(date)) {
      let earliest: number | undefined
      for (const time of times) {
        earliest = localInstant(date, time, timeZone)
        if (earliest !== undefined) break
      }
      if (earliest !== undefined && earliest > decision) {
        date = addDays(date, -1)
        continue
      }
      for (const time of reversed) {
        const candidate = localInstant(date, time, timeZone)
        if (candidate === undefined || candidate > decision || candidate < MIN_FOUR_DIGIT_YEAR_MS) continue
        return Math.max(candidate, savedTarget)
      }
    }
    date = addDays(date, -1)
  }
  return savedTarget
}

/** One cron decision: the latest due occurrence, and the first match after the decision (SVC:826-838). */
export function resolveCronOccurrence(record: CronRecord, acceptedAt: number): Occurrence {
  const decision = acceptedDecision('cron', acceptedAt)
  const savedTarget = Date.parse(record.scheduledAt)
  if (decision < savedTarget) throw new ScheduleLogError('cron dispatch cannot precede the active scheduledAt')
  const parsed = parseCronExpression(record.expression)
  const occurrence = latestCronOccurrence(parsed, record.timeZone, decision, savedTarget)
  const occurrenceAt = formatInstant(occurrence)
  const nextScheduledAt = nextCronTarget(parsed, record.timeZone, decision)
  return nextScheduledAt === undefined ? { occurrenceAt } : { occurrenceAt, nextScheduledAt }
}

/** Whether a record recurs (every, daily, weekly, cron) rather than firing once (after, at). */
export function isRecurringScheduleRecord(record: ScheduleRecord): record is RecurringRecord {
  return record.kind === 'every' || record.kind === 'daily' || record.kind === 'weekly' || record.kind === 'cron'
}

/** One due recurring record's decision, by its own arithmetic. */
export function resolveRecurringOccurrence(record: RecurringRecord, acceptedAt: number): Occurrence {
  switch (record.kind) {
    case 'every':
      return resolveEveryOccurrence(record, acceptedAt)
    case 'daily':
      return resolveDailyOccurrence(record, acceptedAt)
    case 'weekly':
      return resolveWeeklyOccurrence(record, acceptedAt)
    case 'cron':
      return resolveCronOccurrence(record, acceptedAt)
  }
}

/** A record as a reader sees it at one instant (SVC:1379-1385). */
export function scheduleView(record: ScheduleRecord, now: number): ScheduleView {
  return { ...record, state: now >= Date.parse(record.scheduledAt) ? 'overdue' : 'scheduled', deliveryMode: 'host' }
}

// ---------------------------------------------------------------------------------------------------------------
// The strict decoder for stored records
// ---------------------------------------------------------------------------------------------------------------

function rethrowLogError(error: unknown): never {
  if (error instanceof ScheduleLogError) throw error
  throw new ScheduleLogError(String(error))
}

function decodeStoredPrompt(value: unknown, kind: ScheduleKind): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new ScheduleLogError(`${kind} prompt must be non-empty and already trimmed`)
  return value
}

/** The one-shot and fixed-rate variants check their key set before the title, as DSH's historical decoder does. */
function decodeLegacyShapedTitle(value: Record<string, unknown>, expected: readonly string[], message: string): string | undefined {
  if (!hasKeysWithOptional(value, expected.filter((key) => key !== 'title'), ['title'])) throw new ScheduleLogError(message)
  return value.title === undefined ? undefined : decodeStoredTitle(value.title)
}

/** The wall-clock variants check their title before their key set. */
function decodeRecordTitle(value: Record<string, unknown>, expected: readonly string[], message: string): string {
  const title = decodeStoredTitle(value.title)
  if (!hasExactKeys(value, expected)) throw new ScheduleLogError(message)
  return title
}

function requireTitle(title: string | undefined): string {
  if (title === undefined) throw new ScheduleLogError(REQUIRED_TITLE_MESSAGE)
  return title
}

/**
 * Decode one stored record strictly, preserving its committed target and its stored zone spelling (SVC:255-532).
 *
 * Exact keys, a trimmed non-empty prompt, a trimmed title of 1-120 characters, a normalized time, a canonical cron
 * expression, ascending unique weekdays and a canonical UTC instant — anything else is a {@link ScheduleLogError}.
 */
export function decodeScheduleRecord(value: unknown): ScheduleRecord {
  if (!isRecord(value)) throw new ScheduleLogError('schedule record must be an object')
  switch (value.kind) {
    case 'after': {
      const title = decodeLegacyShapedTitle(value, ['id', 'kind', 'title', 'prompt', 'afterSeconds', 'scheduledAt'], 'after schedule must contain exactly id, kind, title, prompt, afterSeconds, and scheduledAt')
      const prompt = decodeStoredPrompt(value.prompt, 'after')
      const afterSeconds = value.afterSeconds
      if (typeof afterSeconds !== 'number' || !Number.isSafeInteger(afterSeconds) || afterSeconds <= 0) throw new ScheduleLogError('afterSeconds must be a positive safe integer')
      const id = decodeId(value.id)
      const scheduledAt = decodeInstant(value.scheduledAt)
      return { id, kind: 'after', title: requireTitle(title), prompt, afterSeconds, scheduledAt }
    }
    case 'at': {
      const title = decodeLegacyShapedTitle(value, ['id', 'kind', 'title', 'prompt', 'scheduledAt'], 'at schedule must contain exactly id, kind, title, prompt, and scheduledAt')
      const prompt = decodeStoredPrompt(value.prompt, 'at')
      const id = decodeId(value.id)
      const scheduledAt = decodeInstant(value.scheduledAt)
      return { id, kind: 'at', title: requireTitle(title), prompt, scheduledAt }
    }
    case 'every': {
      const title = decodeLegacyShapedTitle(value, ['id', 'kind', 'title', 'prompt', 'everySeconds', 'scheduledAt'], 'every schedule must contain exactly id, kind, title, prompt, everySeconds, and scheduledAt')
      const prompt = decodeStoredPrompt(value.prompt, 'every')
      const everySeconds = value.everySeconds
      const interval = typeof everySeconds === 'number' ? everySeconds * 1000 : Number.NaN
      if (typeof everySeconds !== 'number' || !Number.isSafeInteger(everySeconds) || everySeconds < MIN_EVERY_INTERVAL_SECONDS || !Number.isSafeInteger(interval)) {
        throw new ScheduleLogError(`everySeconds must be a safe integer of at least ${MIN_EVERY_INTERVAL_SECONDS}`)
      }
      const id = decodeId(value.id)
      const scheduledAt = decodeInstant(value.scheduledAt)
      return { id, kind: 'every', title: requireTitle(title), prompt, everySeconds, scheduledAt }
    }
    case 'daily': {
      const title = decodeRecordTitle(value, ['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'scheduledAt'], 'daily schedule must contain exactly id, kind, title, prompt, time, timeZone, and scheduledAt')
      const prompt = decodeStoredPrompt(value.prompt, 'daily')
      const { time, timeZone } = value
      if (typeof time !== 'string' || typeof timeZone !== 'string') throw new ScheduleLogError('daily time and timeZone must be strings')
      let normalized = ''
      try {
        normalized = formatPlainTime(localClockTime(time, 'daily'))
        canonicalizeTimeZone(timeZone)
      } catch (error) {
        rethrowLogError(error)
      }
      if (time !== normalized) throw new ScheduleLogError('daily time must be normalized to HH:mm:ss.SSS')
      const id = decodeId(value.id)
      const scheduledAt = decodeInstant(value.scheduledAt)
      return { id, kind: 'daily', title, prompt, time, timeZone, scheduledAt }
    }
    case 'weekly': {
      const title = decodeRecordTitle(value, ['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'weekdays', 'scheduledAt'], 'weekly schedule must contain exactly id, kind, title, prompt, time, timeZone, weekdays, and scheduledAt')
      const prompt = decodeStoredPrompt(value.prompt, 'weekly')
      const { time, timeZone } = value
      if (typeof time !== 'string' || typeof timeZone !== 'string') throw new ScheduleLogError('weekly time and timeZone must be strings')
      let normalized = ''
      let weekdays: readonly number[] = []
      try {
        canonicalizeTimeZone(timeZone)
        normalized = formatPlainTime(localClockTime(time, 'weekly'))
      } catch (error) {
        rethrowLogError(error)
      }
      if (time !== normalized) throw new ScheduleLogError('weekly time must be normalized to HH:mm:ss.SSS')
      const stored = value.weekdays
      try {
        weekdays = normalizeWeekdays(stored)
      } catch (error) {
        rethrowLogError(error)
      }
      if (weekdays.some((weekday, index) => weekday !== (stored as unknown[])[index])) {
        throw new ScheduleLogError('weekly weekdays must be normalized to unique ascending ISO weekday numbers')
      }
      const id = decodeId(value.id)
      const scheduledAt = decodeInstant(value.scheduledAt)
      return { id, kind: 'weekly', title, prompt, time, timeZone, weekdays, scheduledAt }
    }
    case 'cron': {
      const title = decodeRecordTitle(value, ['id', 'kind', 'title', 'prompt', 'expression', 'timeZone', 'scheduledAt'], 'cron schedule must contain exactly id, kind, title, prompt, expression, timeZone, and scheduledAt')
      const prompt = decodeStoredPrompt(value.prompt, 'cron')
      const { expression, timeZone } = value
      if (typeof expression !== 'string' || typeof timeZone !== 'string') throw new ScheduleLogError('cron expression and timeZone must be strings')
      let canonical = ''
      try {
        canonicalizeTimeZone(timeZone)
        canonical = parseCronExpression(expression).expression
      } catch (error) {
        rethrowLogError(error)
      }
      if (expression !== canonical) throw new ScheduleLogError('cron expression must be canonical')
      const id = decodeId(value.id)
      const scheduledAt = decodeInstant(value.scheduledAt)
      return { id, kind: 'cron', title, prompt, expression, timeZone, scheduledAt }
    }
    default:
      throw new ScheduleLogError('v1 schedule kind must be "after", "at", or "every"')
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The in-place update
// ---------------------------------------------------------------------------------------------------------------

/** One timing replacement: a kind and exactly its matching selector (TYP:340-381). */
export type TimingChange =
  | { readonly kind: 'at'; readonly at: unknown }
  | { readonly kind: 'every'; readonly every_seconds: unknown }
  | { readonly kind: 'daily'; readonly daily: unknown }
  | { readonly kind: 'weekly'; readonly weekly: unknown }
  | { readonly kind: 'cron'; readonly cron: unknown }

/** What resolving an update gives: the record (changed or not), a conflict, or a bounded input refusal. */
export type UpdateResolution =
  | { readonly id: string; readonly updated: boolean; readonly record: ScheduleRecord }
  | { readonly id: string; readonly updated: false; readonly code: 'schedule_conflict' }
  | { readonly code: string; readonly message: string }

function timingSelector(kind: unknown): string | undefined {
  switch (kind) {
    case 'at':
      return 'at'
    case 'every':
      return 'every_seconds'
    case 'daily':
      return 'daily'
    case 'weekly':
      return 'weekly'
    case 'cron':
      return 'cron'
    default:
      return undefined
  }
}

/** Validate the exact keys of a timing change received from outside (SVC:1710-1717). */
function validateChange(value: unknown): TimingChange {
  if (!isRecord(value)) throw new ScheduleInputError('invalid_rule', 'Timing change must be an object with exactly one supported timing selector.')
  const selector = timingSelector(value.kind)
  const keys = Object.keys(value)
  if (selector === undefined || keys.length !== 2 || !keys.includes('kind') || !keys.includes(selector)) {
    throw new ScheduleInputError('invalid_rule', 'Timing change must contain exactly kind and its matching timing selector.')
  }
  return value as unknown as TimingChange
}

/** The same record when name and instruction are unchanged, else a copy carrying the new ones in place. */
function withContent(current: ScheduleRecord, title: string, prompt: string): ScheduleRecord {
  return title === current.title && prompt === current.prompt ? current : { ...current, title, prompt }
}

/**
 * Apply the requested rule to the current record (SVC:1760-1791).
 *
 * Any kind may become any kind. An equivalent normalized rule within the same kind keeps the committed target and
 * only takes the new name and instruction — the same interval, the same normalized time and canonical zone, the same
 * weekdays, the same canonical expression, or (for a one-shot) the same instant, where the kind stays `after`. Any
 * other change computes its target exactly as creation does, from the save time.
 */
function changedRecord(current: ScheduleRecord, title: string, prompt: string, value: unknown, now: number): ScheduleRecord {
  if (value === undefined) return withContent(current, title, prompt)
  const change = validateChange(value)
  switch (change.kind) {
    case 'at':
      if ((current.kind === 'after' || current.kind === 'at') && parseAtInput(change.at) === Date.parse(current.scheduledAt)) return withContent(current, title, prompt)
      return createAtScheduleRecord(current.id, prompt, change.at, now, title)
    case 'every':
      if (current.kind === 'every' && change.every_seconds === current.everySeconds) return withContent(current, title, prompt)
      return createEveryScheduleRecord(current.id, prompt, change.every_seconds, now, title)
    case 'daily':
      if (current.kind === 'daily') {
        const normalized = parseDailyInput(change.daily)
        if (normalized.time === current.time && normalized.timeZone === canonicalizeTimeZone(current.timeZone)) return withContent(current, title, prompt)
      }
      return createDailyScheduleRecord(current.id, prompt, change.daily, now, title)
    case 'weekly':
      if (current.kind === 'weekly') {
        const normalized = parseWeeklyInput(change.weekly)
        if (normalized.time === current.time && normalized.timeZone === canonicalizeTimeZone(current.timeZone) && isDeepStrictEqual(normalized.weekdays, current.weekdays)) {
          return withContent(current, title, prompt)
        }
      }
      return createWeeklyScheduleRecord(current.id, prompt, change.weekly, now, title)
    case 'cron':
      if (current.kind === 'cron') {
        const normalized = parseCronInput(change.cron)
        if (normalized.expression === canonicalizeCronExpression(current.expression) && normalized.timeZone === canonicalizeTimeZone(current.timeZone)) {
          return withContent(current, title, prompt)
        }
      }
      return createCronScheduleRecord(current.id, prompt, change.cron, now, title)
  }
}

/**
 * Compare the complete observed record with the current one and resolve a name, instruction and timing update from
 * one queue-time sample (SVC:1806-1837).
 *
 * An `expected` that is not a complete valid record is an `invalid_rule`; one that differs from the current record is
 * a `schedule_conflict`. Input refusals come back as `{code, message}`; anything else throws.
 */
export function resolveScheduleUpdate(
  current: ScheduleRecord,
  expected: unknown,
  change: unknown,
  now: number,
  content: { readonly title?: unknown; readonly prompt?: unknown } = {},
): UpdateResolution {
  let decoded: ScheduleRecord
  try {
    decoded = decodeScheduleRecord(expected)
  } catch (error) {
    if (!(error instanceof ScheduleLogError)) throw error
    return { code: 'invalid_rule', message: 'expected must be a complete valid Schedule record.' }
  }
  if (!isDeepStrictEqual(current, decoded)) return { id: current.id, updated: false, code: 'schedule_conflict' }
  try {
    const retained = decodeStoredTitle(current.title)
    const title = content.title === undefined ? retained : scheduleTitle(content.title)
    const prompt = content.prompt === undefined ? current.prompt : schedulePrompt(content.prompt)
    const record = changedRecord(current, title, prompt, change, now)
    return { id: current.id, updated: record !== current, record }
  } catch (error) {
    if (!(error instanceof ScheduleInputError)) throw error
    return { code: error.code, message: error.message }
  }
}
