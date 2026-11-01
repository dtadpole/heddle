import { ScheduleInputError, ScheduleLogError } from './errors.ts'
import { isoDayOfWeek, type PlainDate, type PlainTime } from './time.ts'

/**
 * Five-field Vixie cron, exactly as DSH parses, canonicalizes and matches it (SVC:706-741, 1131-1359).
 *
 * The grammar: `minute hour day-of-month month day-of-week`, each field a comma list of `*`, `n`, `a-b`, `*` + `/n`
 * or `a-b/n` (n at least 1). No names, `L`, `W`, `#`, `@` macros or seconds. Day-of-week runs 0-7 and 7 means Sunday,
 * stored as 0.
 *
 * Canonicalization keeps one fact the matched values alone would lose: whether the field **text started with `*`**.
 * That is Vixie's `DOM_STAR`/`DOW_STAR`, and it decides the day rule — when both day fields are restricted (neither
 * starts with `*`) a date matches if **either** matches; otherwise both must match, and a bare `*` is always true. So a
 * `*`-led field is always re-spelled `*`-led (a bare `*`, or the widest `*` + `/n` walk plus a list of the rest), and a
 * field that did not start with `*` is never spelled as a star-step. Re-parsing a canonical expression reproduces both
 * the matched set and the flag, which is what keeps the stored rule's meaning stable.
 */

/** One field's range, and the value it folds its maximum onto (Sunday 7 becomes 0). */
interface CronFieldSpec {
  readonly name: string
  readonly min: number
  readonly max: number
  readonly canonicalMax: number
}

const CRON_FIELDS: readonly CronFieldSpec[] = [
  { name: 'minute', min: 0, max: 59, canonicalMax: 59 },
  { name: 'hour', min: 0, max: 23, canonicalMax: 23 },
  { name: 'day-of-month', min: 1, max: 31, canonicalMax: 31 },
  { name: 'month', min: 1, max: 12, canonicalMax: 12 },
  { name: 'day-of-week', min: 0, max: 7, canonicalMax: 6 },
]

/** One parsed field: its matched values ascending, its canonical text, and its star flag. */
interface CronField {
  readonly values: readonly number[]
  readonly canonical: string
  readonly star: boolean
}

/** A parsed expression: canonical text, each field's matched values, and the two day-field star flags. */
export interface ParsedCron {
  readonly expression: string
  readonly minutes: readonly number[]
  readonly hours: readonly number[]
  readonly daysOfMonth: readonly number[]
  readonly months: readonly number[]
  readonly daysOfWeek: readonly number[]
  readonly dayOfMonthStar: boolean
  readonly dayOfWeekStar: boolean
}

function invalidCronField(spec: CronFieldSpec, element: string): ScheduleInputError {
  return new ScheduleInputError(
    'invalid_rule',
    `cron.expression ${spec.name} field element ${JSON.stringify(element)} must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.`,
  )
}

function cronFieldValue(text: string, spec: CronFieldSpec): number {
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw new ScheduleInputError('invalid_rule', `cron.expression ${spec.name} field value ${text} is outside ${spec.min}-${spec.max}.`)
  }
  return value
}

function cronFieldStep(text: string, spec: CronFieldSpec): number {
  const step = Number(text)
  if (!Number.isSafeInteger(step) || step < 1) {
    throw new ScheduleInputError('invalid_rule', `cron.expression ${spec.name} field step must be a positive integer.`)
  }
  return step
}

/** Expand one comma-separated field into its matched values, folding the maximum where the field says so. */
function cronFieldValues(raw: string, spec: CronFieldSpec): number[] {
  const matched = new Set<number>()
  for (const element of raw.split(',')) {
    if (element.length === 0) {
      throw new ScheduleInputError('invalid_rule', `cron.expression ${spec.name} field must not contain an empty list element.`)
    }
    if (element === '*') {
      for (let value = spec.min; value <= spec.max; value += 1) matched.add(value)
      continue
    }
    if (element.startsWith('*')) {
      const stepText = /^\*\/(?<step>\d+)$/.exec(element)?.groups?.step
      if (stepText === undefined) throw invalidCronField(spec, element)
      const step = cronFieldStep(stepText, spec)
      for (let value = spec.min; value <= spec.max; value += step) matched.add(value)
      continue
    }
    const groups = /^(?<start>\d+)(?:-(?<end>\d+))?(?:\/(?<step>\d+))?$/.exec(element)?.groups
    const startText = groups?.start
    if (groups === undefined || startText === undefined) throw invalidCronField(spec, element)
    const start = cronFieldValue(startText, spec)
    const end = groups.end
    const stepText = groups.step
    if (end === undefined) {
      if (stepText !== undefined) throw invalidCronField(spec, element)
      matched.add(start)
      continue
    }
    const last = cronFieldValue(end, spec)
    if (start > last) throw new ScheduleInputError('invalid_rule', `cron.expression ${spec.name} field range ${start}-${last} is inverted.`)
    const step = stepText === undefined ? 1 : cronFieldStep(stepText, spec)
    for (let value = start; value <= last; value += step) matched.add(value)
  }
  const values = new Set<number>()
  for (const value of matched) values.add(spec.canonicalMax !== spec.max && value === spec.max ? spec.min : value)
  return [...values].sort((left, right) => left - right)
}

function at(values: readonly number[], index: number): number {
  const value = values[index]
  if (value === undefined) throw new ScheduleLogError('cron field encoding requires a non-empty value set')
  return value
}

/** The shortest list spelling of an ascending value set, never `*`-led: a uniform run becomes `a-b` or `a-b/n`. */
function encodeCronField(values: readonly number[]): string {
  const first = at(values, 0)
  if (values.length === 1) return String(first)
  const last = at(values, values.length - 1)
  const step = at(values, 1) - first
  let uniform = true
  for (let index = 2; index < values.length; index += 1) {
    if (at(values, index) - at(values, index - 1) !== step) {
      uniform = false
      break
    }
  }
  if (uniform) return step === 1 ? `${first}-${last}` : `${first}-${last}/${step}`
  const parts: string[] = []
  let runStart = first
  for (let index = 1; index < values.length; index += 1) {
    const current = at(values, index)
    const previous = at(values, index - 1)
    if (current === previous + 1) continue
    parts.push(runStart === previous ? String(runStart) : `${runStart}-${previous}`)
    runStart = current
  }
  const final = at(values, values.length - 1)
  parts.push(runStart === final ? String(runStart) : `${runStart}-${final}`)
  return parts.join(',')
}

/** The values one `*` + `/step` walk produces, folded the way a parsed field folds. */
function starWalk(spec: CronFieldSpec, step: number): number[] {
  const walked = new Set<number>()
  for (let value = spec.min; value <= spec.max; value += step) walked.add(spec.canonicalMax !== spec.max && value === spec.max ? spec.min : value)
  return [...walked].sort((left, right) => left - right)
}

/** The canonical `*`-led spelling: a bare `*`, or the widest star-step walk plus the remaining values as a list. */
function encodeStarCronField(values: readonly number[], spec: CronFieldSpec): string {
  if (values.length === spec.canonicalMax - spec.min + 1) return '*'
  const present = new Set(values)
  let bestStep: number | undefined
  let bestWalk: number[] = []
  for (let step = 1; step <= spec.max - spec.min + 1; step += 1) {
    const walk = starWalk(spec, step)
    if (walk.length > bestWalk.length && walk.every((value) => present.has(value))) {
      bestStep = step
      bestWalk = walk
    }
  }
  if (bestStep === undefined) throw new ScheduleInputError('invalid_rule', `${spec.name} cannot keep a leading \`*\`.`)
  const walked = new Set(bestWalk)
  const remaining = values.filter((value) => !walked.has(value))
  const walkText = `*/${bestStep}`
  return remaining.length === 0 ? walkText : `${walkText},${encodeCronField(remaining)}`
}

function parseCronField(raw: string, spec: CronFieldSpec): CronField {
  const values = cronFieldValues(raw, spec)
  const star = raw.startsWith('*')
  return { values, canonical: star ? encodeStarCronField(values, spec) : encodeCronField(values), star }
}

/** Parse and canonicalize one strict five-field cron expression, with DSH's exact diagnostics. */
export function parseCronExpression(expression: unknown): ParsedCron {
  if (typeof expression !== 'string' || expression.length === 0 || expression.trim() !== expression) {
    throw new ScheduleInputError('invalid_rule', 'cron.expression must be a non-empty trimmed string.')
  }
  const fields = expression.split(/\s+/)
  if (fields.length !== 5) {
    throw new ScheduleInputError(
      'invalid_rule',
      'cron.expression must contain exactly five whitespace-separated fields: minute hour day-of-month month day-of-week.',
    )
  }
  const parsed = fields.map((field, index) => {
    const spec = CRON_FIELDS[index]
    if (spec === undefined) throw new ScheduleLogError('cron field specification is missing')
    return parseCronField(field, spec)
  })
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as [CronField, CronField, CronField, CronField, CronField]
  return {
    expression: parsed.map((field) => field.canonical).join(' '),
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek: dayOfWeek.values,
    dayOfMonthStar: dayOfMonth.star,
    dayOfWeekStar: dayOfWeek.star,
  }
}

/** The canonical spelling of one strict five-field expression. */
export function canonicalizeCronExpression(expression: string): string {
  return parseCronExpression(expression).expression
}

/**
 * The local-date predicate of a parsed rule, under the Vixie day rule (SVC:718-732).
 *
 * The star flag selects the branch only; it never excuses a field's matched values. Both day fields restricted
 * combine with OR; otherwise AND, where a bare `*` matches every value and so degrades the AND to the other field.
 */
export function cronDateMatch(parsed: ParsedCron): (date: PlainDate) => boolean {
  const months = new Set(parsed.months)
  const daysOfMonth = new Set(parsed.daysOfMonth)
  const daysOfWeek = new Set(parsed.daysOfWeek)
  const dayOfMonthRestricted = !parsed.dayOfMonthStar
  const dayOfWeekRestricted = !parsed.dayOfWeekStar
  return (date) => {
    if (!months.has(date.month)) return false
    const dayOfMonth = daysOfMonth.has(date.day)
    const dayOfWeek = daysOfWeek.has(isoDayOfWeek(date) % 7)
    if (dayOfMonthRestricted && dayOfWeekRestricted) return dayOfMonth || dayOfWeek
    return dayOfMonth && dayOfWeek
  }
}

/** A parsed rule's local times of day, ascending (hours outer, minutes inner). */
export function cronTimes(parsed: ParsedCron): readonly PlainTime[] {
  const times: PlainTime[] = []
  for (const hour of parsed.hours) for (const minute of parsed.minutes) times.push({ hour, minute, second: 0, millisecond: 0 })
  return times
}
