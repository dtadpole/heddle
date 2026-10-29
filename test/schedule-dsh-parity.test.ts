import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { canonicalizeCronExpression } from '../src/schedule/cron.ts'
import { renderRecurringReminderBatchFraming, renderReminderFraming } from '../src/schedule/delivery.ts'
import * as rules from '../src/schedule/rules.ts'

/**
 * Differential parity with DSH's own schedule domain, when a DSH install is named.
 *
 * Set `HEDDLE_DSH_SCHEDULE` to the absolute path of an installed `@deepseek-ai/dsh-schedule/lib/index.js`; the test
 * imports it read-only and compares a deterministic pseudo-random sample of inputs — cron expressions, every selector's
 * record construction across DST-heavy zones, the latest-missed-occurrence resolution, the decoder, the view and both
 * message templates — against this port, results and error messages alike. Without the variable the test is skipped:
 * a machine path is never committed, and the unit suite must run on a clone with no DSH.
 */

const dshPath = process.env.HEDDLE_DSH_SCHEDULE
const enabled = dshPath !== undefined && existsSync(dshPath)

type Outcome = { readonly ok: unknown } | { readonly err: string }

function outcome(run: () => unknown): Outcome {
  try {
    return { ok: JSON.parse(JSON.stringify(run() ?? null)) }
  } catch (error) {
    const failure = error as { name?: string; code?: string; message?: string }
    return { err: `${failure.name}:${failure.code}:${failure.message}` }
  }
}

test('the port matches DSH’s schedule domain on a deterministic sample', { skip: enabled ? false : 'set HEDDLE_DSH_SCHEDULE to an installed dsh-schedule lib/index.js' }, async () => {
  const dsh = (await import(pathToFileURL(dshPath as string).href)) as Record<string, (...args: unknown[]) => unknown>
  const heddle = rules as unknown as Record<string, (...args: unknown[]) => unknown>
  let seed = 20261029
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T
  const int = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1))
  const mismatches: string[] = []
  let compared = 0
  const compare = (label: string, ours: () => unknown, theirs: () => unknown): void => {
    compared += 1
    const left = JSON.stringify(outcome(ours))
    const right = JSON.stringify(outcome(theirs))
    if (left !== right) mismatches.push(`${label}\n  heddle ${left}\n  dsh    ${right}`)
  }

  const field = (min: number, max: number): string => {
    const roll = random()
    if (roll < 0.2) return '*'
    if (roll < 0.3) return `*/${int(1, max - min + 2)}`
    if (roll < 0.45) return String(int(min, max + 1))
    if (roll < 0.6) {
      const start = int(min, max)
      return `${start}-${int(start, max)}`
    }
    if (roll < 0.7) {
      const start = int(min, max)
      return `${start}-${int(start, max)}/${int(0, 5)}`
    }
    if (roll < 0.85) return Array.from({ length: int(2, 5) }, () => String(int(min, max))).join(',')
    if (roll < 0.92) return `*/${int(1, 4)},${int(min, max)}`
    return pick(['MON', 'L', '5-1', '*/0', `${int(min, max)},,1`])
  }
  const cron = (): string => [field(0, 59), field(0, 23), field(1, 31), field(1, 12), field(0, 7)].join(' ')
  for (let index = 0; index < 1500; index += 1) {
    const expression = cron()
    compare(`cron ${expression}`, () => canonicalizeCronExpression(expression), () => dsh.canonicalizeCronExpression?.(expression))
  }

  const zones = ['America/Los_Angeles', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Europe/London', 'Pacific/Apia', 'Asia/Kolkata', 'Asia/Shanghai', 'UTC', 'PST']
  const edges = ['2026-03-08T10:00:00Z', '2026-11-01T09:00:00Z', '2026-04-04T15:00:00Z', '2026-10-03T15:30:00Z', '2026-03-29T01:00:00Z', '2011-12-29T10:00:00Z'].map(Date.parse)
  const times = ['02:30:00', '01:30:00', '02:00:00', '00:00:00', '23:30:00', '09:15:00.5', '24:00:00']
  for (let index = 0; index < 800; index += 1) {
    const zone = pick(zones)
    const now = pick(edges) + int(-3 * 86_400_000, 3 * 86_400_000)
    const kind = pick(['daily', 'weekly', 'cron', 'at'])
    const time = pick(times)
    const selector =
      kind === 'daily'
        ? { time, time_zone: zone }
        : kind === 'weekly'
          ? { time, time_zone: zone, weekdays: [int(1, 7), int(1, 7)].filter((day, at, all) => all.indexOf(day) === at) }
          : kind === 'cron'
            ? { expression: cron(), time_zone: zone }
            : { date: new Date(now + int(0, 3 * 86_400_000)).toISOString().slice(0, 10), time, time_zone: zone }
    const create = `create${kind[0]?.toUpperCase()}${kind.slice(1)}ScheduleRecord`
    compare(`${create} ${JSON.stringify(selector)} @${new Date(now).toISOString()}`, () => heddle[create]?.('id', ' p ', selector, now, ' t '), () => dsh[create]?.('id', ' p ', selector, now, ' t '))
    let record: { kind: string; scheduledAt: string } | undefined
    try {
      record = dsh[create]?.('id', 'p', selector, now, 't') as typeof record
    } catch {
      continue
    }
    if (record === undefined || record.kind === 'at') continue
    const resolve = `resolve${record.kind[0]?.toUpperCase()}${record.kind.slice(1)}Occurrence`
    for (const delta of [0, int(1, 7_200_000), int(1, 2 * 86_400_000), int(1, 20 * 86_400_000)]) {
      const decision = Date.parse(record.scheduledAt) + delta
      compare(`${resolve} ${JSON.stringify(record)} @${new Date(decision).toISOString()}`, () => heddle[resolve]?.(record, decision), () => dsh[resolve]?.(record, decision))
    }
    compare(`decode ${JSON.stringify(record)}`, () => rules.decodeScheduleRecord(record), () => dsh.decodeScheduleRecord?.(record))
    compare('view', () => rules.scheduleView(record as rules.ScheduleRecord, now), () => dsh.scheduleView?.(record, now))
    compare('one-shot template', () => renderReminderFraming(record as rules.ScheduleRecord), () => dsh.renderReminderFraming?.(record))
    compare(
      'batch template',
      () => renderRecurringReminderBatchFraming([{ record: record as rules.ScheduleRecord, occurrenceAt: (record as rules.ScheduleRecord).scheduledAt }]),
      () => dsh.renderRecurringReminderBatchFraming?.([{ record, occurrenceAt: record?.scheduledAt }]),
    )
  }
  assert.ok(compared > 2000, `compared ${compared}`)
  assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} of ${compared} comparisons differ`)
})
