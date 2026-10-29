import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { ScheduleService } from '../src/schedule/service.ts'
import type { ScheduleTask } from '../src/schedule/store.ts'
import { scheduleTools, validateArgs, CREATE_PARAMETERS } from '../src/schedule/tool.ts'
import type { SessionHandle } from '../src/session/store.ts'
import type { ToolDefinition, ToolResult, ToolRunContext } from '../src/tools/service.ts'

/**
 * The four reminder tools, judged on what the model reads back.
 *
 * Every DSH value — a view, a list, a receipt, and every `{code, message}` refusal — must come back as `output` equal to
 * `JSON.stringify(value)` with no `error`, because DSH renders them as ordinary results; only a schema violation is an
 * error (`INVALID_ARGS`). Key order is part of the text, so it is asserted on the exact string.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-schedule-tools-'))
after(() => rmSync(root, { recursive: true, force: true }))
let counter = 0

const T0 = Date.parse('2026-10-29T12:00:00.000Z')

function setup(depths: Record<string, number> = {}) {
  counter += 1
  const clock = { now: T0 }
  let ids = 0
  const service = new ScheduleService({ file: join(root, `case-${counter}`, 'schedule.json'), now: () => clock.now, newId: () => `schedule-${(ids += 1)}` })
  const tools = new Map(scheduleTools(service, { delegationDepth: (id) => depths[id] ?? 0 }).map((tool) => [tool.spec.name, tool] as const))
  const call = (name: string, args: Record<string, unknown>, options: { session?: string | null; signal?: AbortSignal } = {}): Promise<ToolResult> => {
    const session = options.session === null ? undefined : ({ id: options.session ?? 'session-1', dir: root, transcript: '', meta: '' } as SessionHandle)
    const context: ToolRunContext = {
      cwd: root,
      mode: 'workspace-write',
      log: () => undefined,
      ...(session !== undefined ? { session } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }
    return (tools.get(name) as ToolDefinition).run(args, context)
  }
  return { service, clock, tools, call }
}

/** A DSH value: the exact JSON text, no error. */
function value(result: ToolResult): unknown {
  assert.equal(result.error, undefined, `expected a value, got ${JSON.stringify(result.error)}`)
  return JSON.parse(result.output)
}

const coded = (code: string, message: string) => ({ code, message })

test('four tools, with DSH names, descriptions and an open root schema', () => {
  const { tools } = setup()
  assert.deepEqual([...tools.keys()], ['schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update'])
  const create = tools.get('schedule_create')?.spec
  assert.equal(
    create?.description,
    'Create a reminder in the current session that delivers prompt when it becomes due. Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. Local times that do not exist in the zone are skipped; repeated local times fire once, at the earlier instant. After downtime, a recurring reminder delivers only its latest missed occurrence. Delivery can repeat after a crash.',
  )
  const parameters = create?.parameters as { properties: Record<string, { additionalProperties?: boolean; required?: string[] }>; required: string[]; additionalProperties?: boolean }
  assert.equal(parameters.additionalProperties, undefined, 'the root is open; the tool refuses unknown keys itself')
  assert.deepEqual(Object.keys(parameters.properties), ['prompt', 'title', 'after_seconds', 'every_seconds', 'daily', 'weekly', 'cron', 'at'])
  assert.deepEqual(parameters.required, ['prompt', 'title'])
  assert.equal(parameters.properties.daily?.additionalProperties, false)
  assert.deepEqual(parameters.properties.weekly?.required, ['time', 'time_zone', 'weekdays'])
  const update = tools.get('schedule_update')?.spec.parameters as { properties: Record<string, unknown>; required: string[] }
  assert.deepEqual(Object.keys(update.properties), ['id', 'title', 'prompt', 'every_seconds', 'daily', 'weekly', 'cron', 'at'], 'no after_seconds on update')
  assert.deepEqual(update.required, ['id'])
  assert.equal(tools.get('schedule_list')?.spec.description, 'List the active reminders in the current session.')
  assert.equal(
    tools.get('schedule_delete')?.spec.description,
    'Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued.',
  )
  assert.equal(
    tools.get('schedule_update')?.spec.description,
    'Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; omitted fields keep their stored values. To change a relative delay, create a new reminder.',
  )
})

test('schedule_create answers with the view, as exact JSON text in DSH key order', async () => {
  const { call } = setup()
  const result = await call('schedule_create', { prompt: "Review today's tasks", title: 'Daily review', daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } })
  assert.equal(result.error, undefined)
  assert.equal(
    result.output,
    '{"id":"schedule-1","kind":"daily","title":"Daily review","prompt":"Review today\'s tasks","time":"23:00:00.000","timeZone":"Asia/Shanghai","scheduledAt":"2026-10-29T15:00:00.000Z","state":"scheduled","deliveryMode":"host"}',
  )
  const after = await call('schedule_create', { prompt: 'p', title: 't', after_seconds: 30 })
  assert.equal(after.output, '{"id":"schedule-2","kind":"after","title":"t","prompt":"p","afterSeconds":30,"scheduledAt":"2026-10-29T12:00:30.000Z","state":"scheduled","deliveryMode":"host"}')
  const weekly = value(await call('schedule_create', { prompt: 'p', title: 't', weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [5, 1] } })) as Record<string, unknown>
  assert.deepEqual(Object.keys(weekly), ['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'weekdays', 'scheduledAt', 'state', 'deliveryMode'])
  assert.deepEqual(weekly.weekdays, [1, 5])
  const cron = value(await call('schedule_create', { prompt: 'p', title: 't', cron: { expression: '0,30 * * * *', time_zone: 'UTC' } })) as Record<string, unknown>
  assert.deepEqual(Object.keys(cron), ['id', 'kind', 'title', 'prompt', 'expression', 'timeZone', 'scheduledAt', 'state', 'deliveryMode'])
  assert.equal(cron.expression, '0-30/30 * * * *')
  const everyView = value(await call('schedule_create', { prompt: 'p', title: 't', every_seconds: 60 })) as Record<string, unknown>
  assert.deepEqual(Object.keys(everyView), ['id', 'kind', 'title', 'prompt', 'everySeconds', 'scheduledAt', 'state', 'deliveryMode'])
  const atView = value(await call('schedule_create', { prompt: 'p', title: 't', at: '2026-10-30T00:00:00+08:00' })) as Record<string, unknown>
  assert.deepEqual(Object.keys(atView), ['id', 'kind', 'title', 'prompt', 'scheduledAt', 'state', 'deliveryMode'])
})

test('schedule_create refusals are values with DSH codes and messages, in DSH order', async () => {
  const { call } = setup()
  const selector = coded('invalid_selector', 'schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.')
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't' })), selector)
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't', after_seconds: 60, every_seconds: 60 })), selector)
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't', after_seconds: 60, session: 'x' })), selector, 'an unknown key')
  assert.deepEqual(value(await call('schedule_create', { prompt: ' ', title: ' ', after_seconds: 60 })), coded('invalid_prompt', 'prompt must be non-empty after trimming.'))
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: ' ', after_seconds: 60 })), coded('invalid_prompt', 'title is required and must be non-empty after trimming.'))
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 'x'.repeat(121), after_seconds: 60 })), coded('invalid_prompt', 'title must be at most 120 characters.'))
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't', after_seconds: 0 })), coded('invalid_rule', 'after_seconds must be a positive safe integer.'))
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't', every_seconds: 60.5 })), coded('invalid_rule', 'every_seconds must be a safe integer.'))
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't', every_seconds: 59 })), coded('frequency_too_high', 'every_seconds must be at least 60.'))
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't', at: '2026-10-29T11:00:00Z' })), coded('not_future', 'The scheduled time must be strictly in the future.'))
  assert.deepEqual(
    value(await call('schedule_create', { prompt: 'p', title: 't', daily: { time: '09:00:00', time_zone: 'PST' } })),
    coded('invalid_time_zone', 'time_zone must be UTC or a valid IANA Area/Location name.'),
  )
  assert.deepEqual(
    value(await call('schedule_create', { prompt: 'p', title: 't', at: { date: '2026-03-08', time: '02:30:00', time_zone: 'America/Los_Angeles' } })),
    coded('invalid_rule', 'The local at time does not exist in the selected time zone.'),
  )
})

test('arguments that break the schema are the one error result, INVALID_ARGS with DSH diagnostics', async () => {
  const { call } = setup()
  const missing = await call('schedule_create', { after_seconds: 60 })
  assert.deepEqual(missing.error, { code: 'INVALID_ARGS', message: 'invalid arguments: missing required property "prompt"; missing required property "title"' })
  assert.equal(missing.output, '')
  assert.deepEqual((await call('schedule_create', { prompt: 'p', title: 't', every_seconds: '60' })).error?.message, 'invalid arguments: "every_seconds" must be a number')
  assert.deepEqual(
    (await call('schedule_create', { prompt: 'p', title: 't', daily: { time: '09:00:00', zone: 'UTC' } })).error?.message,
    'invalid arguments: missing required property "daily.time_zone"; "daily.zone" is not a declared property (additionalProperties: false)',
  )
  assert.deepEqual(
    (await call('schedule_create', { prompt: 'p', title: 't', at: { date: '2026-10-30', time: '09:00:00' } })).error?.message,
    'invalid arguments: "at" must match exactly one oneOf branch (matched 0)',
  )
  assert.deepEqual((await call('schedule_create', { prompt: 'p', title: 't', weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1, 'x'] } })).error?.message, 'invalid arguments: "weekly.weekdays[1]" must be an integer')
  assert.deepEqual((await call('schedule_delete', {})).error?.message, 'invalid arguments: missing required property "id"')
  assert.deepEqual(validateArgs(CREATE_PARAMETERS, 'x'), ['"arguments" must be an object'])
})

test('a call with no session is internal_error; a delegated child is refused by all four tools', async () => {
  const { call } = setup({ 'session-child': 1 })
  const internal = coded('internal_error', 'The schedule operation failed.')
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't', after_seconds: 60 }, { session: null })), internal)
  assert.deepEqual(value(await call('schedule_list', {}, { session: null })), internal)
  const refusal = coded('subagent_session', 'A delegated subagent cannot use reminders.')
  const child = { session: 'session-child' }
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't', after_seconds: 60 }, child)), refusal)
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't' }, child)), refusal, 'the refusal precedes argument rules')
  assert.deepEqual(value(await call('schedule_list', {}, child)), refusal)
  assert.deepEqual(value(await call('schedule_update', { id: 'schedule-1', title: 'x' }, child)), refusal)
  assert.deepEqual(value(await call('schedule_delete', { id: 'schedule-1' }, child)), refusal)
})

test('an aborted call is internal_error and writes nothing', async () => {
  const { call, service } = setup()
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't', after_seconds: 60 }, { signal: controller.signal })), coded('internal_error', 'The schedule operation failed.'))
  assert.equal(service.tasks().length, 0)
})

test('a failure that is not an input error is withheld behind internal_error', async () => {
  const { call, service } = setup()
  service.store.put = () => {
    throw new Error('disk full')
  }
  assert.deepEqual(value(await call('schedule_create', { prompt: 'p', title: 't', after_seconds: 60 })), coded('internal_error', 'The schedule operation failed.'))
})

test('schedule_list answers with the session’s active views, overdue when due', async () => {
  const { call, clock } = setup()
  await call('schedule_create', { prompt: 'p', title: 'a', after_seconds: 60 })
  await call('schedule_create', { prompt: 'p', title: 'b', after_seconds: 600 })
  await call('schedule_create', { prompt: 'p', title: 'other' , after_seconds: 60 }, { session: 'session-2' })
  clock.now = T0 + 120_000
  const list = value(await call('schedule_list', {})) as { title: string; state: string }[]
  assert.deepEqual(list.map((one) => [one.title, one.state]), [['a', 'overdue'], ['b', 'scheduled']])
  assert.deepEqual(value(await call('schedule_list', {}, { session: 'session-3' })), [])
})

test('schedule_update: argument rules, then not-found and ended from the catalog, then the view', async () => {
  const { call, service } = setup()
  const created = value(await call('schedule_create', { prompt: 'p', title: 't', every_seconds: 60 })) as { id: string; scheduledAt: string }
  const atMostOne = coded('invalid_selector', 'schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.')
  assert.deepEqual(value(await call('schedule_update', { id: created.id, every_seconds: 60, at: '2026-11-01T00:00:00Z' })), atMostOne)
  assert.deepEqual(value(await call('schedule_update', { id: created.id, after_seconds: 60 })), atMostOne, 'after_seconds is not an update key')
  assert.deepEqual(value(await call('schedule_update', { id: ` ${created.id}`, title: 'x' })), coded('invalid_rule', 'schedule_update id must be non-empty without surrounding whitespace.'))
  assert.deepEqual(value(await call('schedule_update', { id: created.id })), coded('invalid_selector', 'schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.'))
  assert.deepEqual(value(await call('schedule_update', { id: created.id, title: ' ' })), coded('invalid_prompt', 'title is required and must be non-empty after trimming.'))
  assert.deepEqual(value(await call('schedule_update', { id: created.id, title: 'x'.repeat(121) })), coded('invalid_prompt', 'title must be at most 120 characters.'))
  assert.deepEqual(value(await call('schedule_update', { id: created.id, prompt: ' ' })), coded('invalid_prompt', 'prompt must be non-empty after trimming.'))
  assert.deepEqual(value(await call('schedule_update', { id: created.id, every_seconds: 30 })), coded('frequency_too_high', 'every_seconds must be at least 60.'))

  assert.equal((await call('schedule_update', { id: 'schedule-x', title: 'x' })).output, '{"id":"schedule-x","updated":false,"code":"schedule_not_found"}')
  assert.equal((await call('schedule_update', { id: created.id, title: 'x' }, { session: 'session-2' })).output, `{"id":"${created.id}","updated":false,"code":"schedule_not_found"}`)

  const renamed = value(await call('schedule_update', { id: created.id, title: 'Renamed', prompt: ' new ' })) as Record<string, unknown>
  assert.deepEqual(renamed, { id: created.id, kind: 'every', title: 'Renamed', prompt: 'new', everySeconds: 60, scheduledAt: created.scheduledAt, state: 'scheduled', deliveryMode: 'host' })
  const noop = value(await call('schedule_update', { id: created.id, every_seconds: 60 })) as Record<string, unknown>
  assert.equal(noop.scheduledAt, created.scheduledAt, 'a no-op still answers with the view')
  const moved = value(await call('schedule_update', { id: created.id, cron: { expression: '0 13 * * *', time_zone: 'UTC' } })) as Record<string, unknown>
  assert.equal(moved.kind, 'cron')
  assert.equal(moved.scheduledAt, '2026-10-29T13:00:00.000Z')

  service.commitDelivery({ ...(service.tasks()[0] as ScheduleTask), status: 'inactive' })
  assert.equal((await call('schedule_update', { id: created.id, title: 'x' })).output, `{"id":"${created.id}","updated":false,"code":"schedule_ended"}`)
})

test('schedule_delete checks the id first, then deletes in any state', async () => {
  const { call } = setup()
  const idRule = coded('invalid_rule', 'schedule_delete id must be non-empty without surrounding whitespace.')
  assert.deepEqual(value(await call('schedule_delete', { id: '' }, { session: null })), idRule, 'before the missing caller')
  assert.deepEqual(value(await call('schedule_delete', { id: 'schedule-1 ' })), idRule)
  const created = value(await call('schedule_create', { prompt: 'p', title: 't', after_seconds: 60 })) as { id: string }
  assert.equal((await call('schedule_delete', { id: created.id }, { session: 'session-2' })).output, `{"id":"${created.id}","deleted":false,"code":"schedule_not_found"}`)
  assert.equal((await call('schedule_delete', { id: created.id })).output, `{"id":"${created.id}","deleted":true}`)
  assert.deepEqual(value(await call('schedule_list', {})), [])
})
