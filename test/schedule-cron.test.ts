import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canonicalizeCronExpression, cronDateMatch, cronTimes, parseCronExpression } from '../src/schedule/cron.ts'
import { ScheduleInputError } from '../src/schedule/errors.ts'

/**
 * Five-field Vixie cron: DSH's grammar, its exact diagnostics, its canonical spelling and its day rule.
 *
 * The day rule is the part people get wrong: when **both** day fields are restricted (neither text starts with `*`), a
 * date matches if either matches; otherwise both must match. A stepped star such as `*` + `/2` is still a star — it
 * selects the AND branch while restricting the values — and canonicalization must keep that flag.
 */

const refuses = (expression: unknown, message: string) =>
  assert.throws(
    () => parseCronExpression(expression),
    (error: unknown) => error instanceof ScheduleInputError && error.code === 'invalid_rule' && error.message === message,
    String(expression),
  )

test('the expression must be a trimmed non-empty string of exactly five fields', () => {
  refuses('', 'cron.expression must be a non-empty trimmed string.')
  refuses(' * * * * *', 'cron.expression must be a non-empty trimmed string.')
  refuses(5, 'cron.expression must be a non-empty trimmed string.')
  const five = 'cron.expression must contain exactly five whitespace-separated fields: minute hour day-of-month month day-of-week.'
  refuses('* * * *', five)
  refuses('0 * * * * *', five)
})

test('each field element error names the field and the element, with DSH wording', () => {
  refuses('MON * * * *', 'cron.expression minute field element "MON" must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.')
  refuses('* L * * *', 'cron.expression hour field element "L" must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.')
  refuses('* * * * 5/2', 'cron.expression day-of-week field element "5/2" must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.')
  refuses('*/x * * * *', 'cron.expression minute field element "*/x" must be *, a value, a-b, */n, a-b/n, or a comma-separated list of those.')
  refuses('60 * * * *', 'cron.expression minute field value 60 is outside 0-59.')
  refuses('* 24 * * *', 'cron.expression hour field value 24 is outside 0-23.')
  refuses('* * 0 * *', 'cron.expression day-of-month field value 0 is outside 1-31.')
  refuses('* * * 13 *', 'cron.expression month field value 13 is outside 1-12.')
  refuses('* * * * 8', 'cron.expression day-of-week field value 8 is outside 0-7.')
  refuses('*/0 * * * *', 'cron.expression minute field step must be a positive integer.')
  refuses('1-5/0 * * * *', 'cron.expression minute field step must be a positive integer.')
  refuses('5-1 * * * *', 'cron.expression minute field range 5-1 is inverted.')
  refuses('1,,2 * * * *', 'cron.expression minute field must not contain an empty list element.')
})

test('canonicalization dedupes, merges runs, folds Sunday 7 to 0, drops a step of 1 and keeps star-led fields star-led', () => {
  const cases: [string, string][] = [
    ['*/15 9-17 * * 1-5', '*/15 9-17 * * 1-5'],
    ['0,15,30,45 * * * *', '0-45/15 * * * *'],
    ['5,10,15,20 * * * *', '5-20/5 * * * *'],
    ['1,2,3,5 * * * *', '1-3,5 * * * *'],
    ['3,1,2,2 * * * *', '1-3 * * * *'],
    ['0-59/1 * * * *', '0-59 * * * *'],
    ['* * * * 7', '* * * * 0'],
    ['* * * * 0,7', '* * * * 0'],
    ['* * * * 0-7', '* * * * 0-6'],
    ['* * * * */1', '* * * * *'],
    ['*/1 * * * *', '* * * * *'],
    ['*/2,1 * * * *', '*/2,1 * * * *'],
    ['*/30,15,45 * * * *', '*/15 * * * *'],
    ['*/30,15 * * * *', '*/30,15 * * * *'],
    ['0 0 1-31 * *', '0 0 1-31 * *'],
    ['007 * * * *', '7 * * * *'],
    ['0  9   * * 1', '0 9 * * 1'],
  ]
  for (const [input, canonical] of cases) assert.equal(canonicalizeCronExpression(input), canonical, input)
  for (const [, canonical] of cases) assert.equal(canonicalizeCronExpression(canonical), canonical, `${canonical} is a fixed point`)
})

test('parsing exposes matched values and the two day-field star flags', () => {
  const parsed = parseCronExpression('*/20 9 1,15 * */2')
  assert.deepEqual(parsed.minutes, [0, 20, 40])
  assert.deepEqual(parsed.hours, [9])
  assert.deepEqual(parsed.daysOfMonth, [1, 15])
  assert.equal(parsed.months.length, 12)
  assert.deepEqual(parsed.daysOfWeek, [0, 2, 4, 6])
  assert.equal(parsed.dayOfMonthStar, false)
  assert.equal(parsed.dayOfWeekStar, true)
  assert.deepEqual(cronTimes(parseCronExpression('0,30 9-10 * * *')), [
    { hour: 9, minute: 0, second: 0, millisecond: 0 },
    { hour: 9, minute: 30, second: 0, millisecond: 0 },
    { hour: 10, minute: 0, second: 0, millisecond: 0 },
    { hour: 10, minute: 30, second: 0, millisecond: 0 },
  ])
})

test('the Vixie day rule: both restricted is OR; a star on either side is AND', () => {
  const firstOfMonth = { year: 2026, month: 10, day: 1 } // a Thursday
  const monday = { year: 2026, month: 10, day: 26 }
  const otherDay = { year: 2026, month: 10, day: 28 } // a Wednesday

  const either = cronDateMatch(parseCronExpression('0 9 1 * 1'))
  assert.equal(either(firstOfMonth), true, 'day 1 matches although it is not a Monday')
  assert.equal(either(monday), true, 'a Monday matches although it is not day 1')
  assert.equal(either(otherDay), false)

  const mondaysOnly = cronDateMatch(parseCronExpression('0 9 * * 1'))
  assert.equal(mondaysOnly(firstOfMonth), false, 'a bare star degrades the AND to the other field')
  assert.equal(mondaysOnly(monday), true)

  const steppedStar = cronDateMatch(parseCronExpression('0 9 */2 * 1'))
  assert.equal(steppedStar(monday), false, 'a stepped star is a star: AND, and day 26 is not in 1,3,5…')
  assert.equal(steppedStar({ year: 2026, month: 10, day: 5 }), true, 'day 5 is odd and a Monday')

  const months = cronDateMatch(parseCronExpression('0 9 1 3 1'))
  assert.equal(months(firstOfMonth), false, 'the month must match before the day rule is asked')

  const sunday = cronDateMatch(parseCronExpression('0 9 * * 7'))
  assert.equal(sunday({ year: 2026, month: 11, day: 1 }), true, '7 means Sunday')
})
