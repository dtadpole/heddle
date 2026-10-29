import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { Chunk } from '../src/llm/types.ts'
import TurnsPlugin from '../src/plugins/turns.ts'
import SessionPlugin from '../src/plugins/session.ts'
import * as SchedulePlugin from '../src/plugins/schedule.ts'
import { MAX_TIMER_DELAY_MS, renderRecurringReminderBatchFraming, renderReminderFraming, ScheduleDriver, type DeliveryHost } from '../src/schedule/delivery.ts'
import { createAfterScheduleRecord, createDailyScheduleRecord, type ScheduleRecord } from '../src/schedule/rules.ts'
import { ScheduleService } from '../src/schedule/service.ts'
import { ScheduleStore, type ScheduleTask } from '../src/schedule/store.ts'
import type { SessionEvent } from '../src/session/store.ts'

/**
 * Delivery: a due reminder becomes the user message of a turn in its own session, and the delivery commits only once
 * that message is found in the session's own log.
 *
 * The driver is judged first against a fake host and fake timers, so every edge is deterministic: an idle session
 * starts a turn with the exact DSH template; a busy one waits for its turn to end; an unproven delivery is not committed
 * and is not retried until the next drive; recurring reminders of a session share one batch carrying only each task's
 * latest missed occurrence. Then the plugin is judged end to end over a **real** session store and the real turn loop.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-schedule-delivery-'))
after(() => rmSync(root, { recursive: true, force: true }))
let counter = 0

const T0 = Date.parse('2026-10-29T12:00:00.000Z')

/** A session host whose logs are arrays and whose busy state a test sets. */
class FakeHost implements DeliveryHost {
  readonly logs = new Map<string, { text: string; kind: string }[]>()
  readonly busy = new Set<string>()
  readonly missing = new Set<string>()
  readonly started: { sessionId: string; text: string }[] = []
  /** When set, a started turn writes nothing — the delivery cannot be proven. */
  dropWrites = false

  private log(sessionId: string) {
    let log = this.logs.get(sessionId)
    if (log === undefined) {
      log = []
      this.logs.set(sessionId, log)
    }
    return log
  }

  resolve(sessionId: string): void {
    if (this.missing.has(sessionId)) throw new Error(`session "${sessionId}" is not available`)
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId)
  }

  cursor(sessionId: string): number {
    return this.log(sessionId).length
  }

  async startTurn(sessionId: string, text: string, source: { readonly kind: string }): Promise<void> {
    this.started.push({ sessionId, text })
    if (!this.dropWrites) this.log(sessionId).push({ text, kind: source.kind })
    this.busy.add(sessionId)
  }

  find(sessionId: string, cursor: number, text: string): { readonly messageId: string } | undefined {
    const log = this.log(sessionId)
    const index = log.findIndex((entry, at) => at >= cursor && entry.kind === 'schedule' && entry.text === text)
    return index === -1 ? undefined : { messageId: `message-${sessionId}-${index}` }
  }

  /** The session's turn ended. */
  idle(sessionId: string, driver: ScheduleDriver): void {
    this.busy.delete(sessionId)
    driver.turnEnded(sessionId)
  }
}

/** One fake timer slot and a deferred-callback queue. */
class FakeTimers {
  current: { callback: () => void; ms: number; cleared: boolean } | undefined
  readonly deferred: (() => void)[] = []

  readonly options = {
    setTimer: (callback: () => void, ms: number) => {
      const timer = { callback, ms, cleared: false }
      this.current = timer
      return timer
    },
    clearTimer: (handle: unknown) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    defer: (callback: () => void) => {
      this.deferred.push(callback)
    },
  }

  /** The armed delay, or undefined when no timer is armed. */
  get armed(): number | undefined {
    return this.current === undefined || this.current.cleared ? undefined : this.current.ms
  }

  fire(): void {
    const timer = this.current
    assert.ok(timer !== undefined && !timer.cleared, 'a timer is armed')
    timer.cleared = true
    timer.callback()
  }

  flushDeferred(): void {
    for (const callback of this.deferred.splice(0)) callback()
  }
}

function setup(seed: readonly ScheduleTask[] = [], start = true) {
  counter += 1
  const clock = { now: T0 }
  const file = join(root, `case-${counter}`, 'schedule.json')
  if (seed.length > 0) {
    const store = new ScheduleStore(file)
    for (const task of seed) store.put(task.record.id, task)
  }
  let ids = 0
  const service = new ScheduleService({ file, now: () => clock.now, newId: () => `schedule-${(ids += 1)}` })
  const changes: number[] = []
  service.onChange(() => changes.push(clock.now))
  const host = new FakeHost()
  const timers = new FakeTimers()
  const warnings: string[] = []
  const driver = new ScheduleDriver(service, host, { ...timers.options, busyRecheckMs: 60_000, warn: (message) => warnings.push(message) })
  if (start) driver.start()
  return { service, clock, host, timers, driver, warnings, changes, file }
}

const task = (record: ScheduleRecord, sessionId = 'session-1'): ScheduleTask => ({ sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } })

test('the templates are DSH’s, with JSON-escaped dynamic fields', () => {
  const record = createAfterScheduleRecord('schedule-1', 'say "hi"\nthen stop', 60, T0, 't')
  assert.equal(
    renderReminderFraming(record),
    '[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: "schedule-1"\noccurrence_at: 2026-10-29T12:01:00.000Z\nreminder_prompt_json: "say \\"hi\\"\\nthen stop"',
  )
  assert.equal(
    renderRecurringReminderBatchFraming([{ record, occurrenceAt: '2026-10-29T12:00:00.000Z' }]),
    '[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: [{"schedule_id":"schedule-1","occurrence_at":"2026-10-29T12:00:00.000Z","reminder_prompt":"say \\"hi\\"\\nthen stop"}]',
  )
})

test('an idle session gets a turn with the one-shot template; the delivery commits after the proof', async () => {
  const { service, clock, host, timers, driver, changes } = setup()
  await service.create('session-1', { prompt: 'check CI', title: 'CI', after_seconds: 60 })
  await driver.settled()
  assert.equal(timers.armed, 60_000, 'one timer, to the earliest target')
  assert.equal(host.started.length, 0)

  clock.now = T0 + 61_000
  timers.fire()
  await driver.settled()
  assert.deepEqual(host.started, [
    {
      sessionId: 'session-1',
      text: '[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: "schedule-1"\noccurrence_at: 2026-10-29T12:01:00.000Z\nreminder_prompt_json: "check CI"',
    },
  ])
  const [stored] = service.tasks()
  assert.equal(stored?.status, 'inactive', 'a delivered one-shot becomes inactive')
  assert.deepEqual(stored?.lastDelivery, { scheduledAt: '2026-10-29T12:01:00.000Z', deliveredAt: '2026-10-29T12:01:01.000Z', messageId: 'message-session-1-0' })
  assert.deepEqual(stored?.deliveryHistory, {
    records: [{ scheduledAt: '2026-10-29T12:01:00.000Z', deliveredAt: '2026-10-29T12:01:01.000Z', messageId: 'message-session-1-0', prompt: 'check CI' }],
    earlierRecordsUnavailable: false,
    earlierRecordsPruned: false,
  })
  assert.equal(changes.length, 2, 'the create and the delivery were each announced')
  assert.equal(timers.armed, undefined, 'nothing active is left to time')
})

test('a busy session waits for its turn to end, then the reminder is its next turn', async () => {
  const { service, clock, host, timers, driver } = setup()
  await service.create('session-1', { prompt: 'p', title: 't', after_seconds: 60 })
  await service.create('session-2', { prompt: 'q', title: 't', after_seconds: 600 })
  await driver.settled()
  host.busy.add('session-1')
  clock.now = T0 + 60_000
  timers.fire()
  await driver.settled()
  assert.equal(host.started.length, 0, 'nothing is written into a running turn')
  assert.equal(driver.isWaiting('session-1'), true)
  assert.equal(service.tasks()[0]?.status, 'active')
  assert.equal(timers.armed, 60_000, 'the waiting reminder is left out of the timer; only the busy recheck and session-2 remain')

  host.idle('session-2', driver)
  assert.equal(timers.deferred.length, 0, 'another session ending is not this edge')
  clock.now = T0 + 65_000
  host.idle('session-1', driver)
  assert.equal(host.started.length, 0, 'the drive is deferred past the turn that is completing')
  timers.flushDeferred()
  await driver.settled()
  assert.equal(host.started.length, 1)
  assert.equal(host.started[0]?.sessionId, 'session-1')
  assert.equal(service.tasks()[0]?.status, 'inactive')
  assert.equal(service.tasks()[0]?.lastDelivery?.deliveredAt, '2026-10-29T12:01:05.000Z')
  assert.equal(driver.isWaiting('session-1'), false)
})

test('a waiting reminder is rechecked when no turn-ended edge arrives', async () => {
  const { service, clock, host, timers, driver } = setup()
  await service.create('session-1', { prompt: 'p', title: 't', after_seconds: 60 })
  await driver.settled()
  host.busy.add('session-1')
  clock.now = T0 + 60_000
  timers.fire()
  await driver.settled()
  assert.equal(timers.armed, 60_000, 'the busy recheck')
  host.busy.delete('session-1')
  clock.now = T0 + 120_000
  timers.fire()
  await driver.settled()
  assert.equal(host.started.length, 1)
})

test('a delivery that cannot be proven is not committed, is logged with DSH’s text, and waits for the next drive', async () => {
  const { service, clock, host, timers, driver, warnings } = setup()
  await service.create('session-1', { prompt: 'p', title: 't', after_seconds: 60 })
  await driver.settled()
  host.dropWrites = true
  clock.now = T0 + 60_000
  timers.fire()
  await driver.settled()
  assert.equal(host.started.length, 1, 'the turn was attempted')
  assert.equal(service.tasks()[0]?.status, 'active', 'but nothing was committed')
  assert.equal(service.tasks()[0]?.lastDelivery, undefined)
  assert.deepEqual(warnings, ['schedule: reminders ["schedule-1"] were not acknowledged: Error: Session persistence did not acknowledge the reminder'])
  assert.equal(timers.armed, undefined, 'a failed reminder is left out of this drive’s timer, so it does not spin')

  host.dropWrites = false
  host.busy.clear()
  await service.create('session-2', { prompt: 'q', title: 't', after_seconds: 600 })
  await driver.settled()
  assert.equal(service.tasks()[0]?.status, 'inactive', 'any committed write drives again, which retries it')
})

test('a missing session is a warning and the reminder stays due', async () => {
  const { service, clock, host, timers, driver, warnings } = setup()
  await service.create('session-gone', { prompt: 'p', title: 't', after_seconds: 60 })
  await driver.settled()
  host.missing.add('session-gone')
  clock.now = T0 + 60_000
  timers.fire()
  await driver.settled()
  assert.deepEqual(warnings, ['schedule: reminders ["schedule-1"] were not acknowledged: Error: session "session-gone" is not available'])
  assert.equal(service.tasks()[0]?.status, 'active')
  assert.equal(host.started.length, 0)
})

test('after downtime, recurring reminders of a session share one batch with only each latest occurrence', async () => {
  const every60 = { id: 'schedule-a', kind: 'every', title: 'a', prompt: 'ping a', everySeconds: 60, scheduledAt: '2026-10-29T12:01:00.000Z' } as const
  const every120 = { id: 'schedule-b', kind: 'every', title: 'b', prompt: 'ping b', everySeconds: 120, scheduledAt: '2026-10-29T12:02:00.000Z' } as const
  const elsewhere = { ...every60, id: 'schedule-c', prompt: 'ping c' }
  const { service, clock, host, driver } = setup([task(every60), task(every120), task(elsewhere, 'session-2')], false)
  clock.now = T0 + 630_000
  driver.start()
  await driver.settled()
  assert.deepEqual(host.started.map((one) => one.sessionId), ['session-1', 'session-2'], 'one message per session')
  assert.equal(
    host.started[0]?.text,
    '[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: [{"schedule_id":"schedule-a","occurrence_at":"2026-10-29T12:10:00.000Z","reminder_prompt":"ping a"},{"schedule_id":"schedule-b","occurrence_at":"2026-10-29T12:10:00.000Z","reminder_prompt":"ping b"}]',
  )
  const [a, b] = service.tasks()
  assert.equal(a?.record.scheduledAt, '2026-10-29T12:11:00.000Z', 'the next target keeps the fixed-rate phase')
  assert.equal(b?.record.scheduledAt, '2026-10-29T12:12:00.000Z')
  assert.equal(a?.status, 'active')
  assert.equal(a?.deliveryHistory?.records.length, 1, 'the nine earlier missed occurrences leave no record')
  assert.equal(a?.lastDelivery?.messageId, b?.lastDelivery?.messageId, 'a batch shares its message id')
  assert.equal(a?.lastDelivery?.scheduledAt, '2026-10-29T12:10:00.000Z')
})

test('a one-shot is never batched; the second message waits for the first turn', async () => {
  const oneShot = createAfterScheduleRecord('schedule-a', 'once', 60, T0, 'once')
  const daily = { ...createDailyScheduleRecord('schedule-b', 'daily', { time: '12:00:30', time_zone: 'UTC' }, T0, 'daily') }
  const { service, clock, host, driver, timers } = setup([task(oneShot), task(daily)], false)
  clock.now = T0 + 120_000
  driver.start()
  await driver.settled()
  assert.equal(host.started.length, 1)
  assert.match(host.started[0]?.text ?? '', /^\[SCHEDULE REMINDER\]\n/)
  assert.equal(driver.isWaiting('session-1'), true, 'the batch waits behind the turn the one-shot started')
  host.idle('session-1', driver)
  timers.flushDeferred()
  await driver.settled()
  assert.equal(host.started.length, 2)
  assert.match(host.started[1]?.text ?? '', /^\[SCHEDULE REMINDER BATCH\]\n/)
  assert.equal(service.tasks()[1]?.record.scheduledAt, '2026-10-30T12:00:30.000Z')
})

test('the timer delay is clamped to what a Node timer can hold', async () => {
  const { service, timers, driver } = setup()
  await service.create('session-1', { prompt: 'p', title: 't', at: '2030-01-01T00:00:00Z' })
  await driver.settled()
  assert.equal(timers.armed, MAX_TIMER_DELAY_MS)
})

test('nothing is delivered before start, and nothing after dispose', async () => {
  const { service, clock, host, driver } = setup([], false)
  await service.create('session-1', { prompt: 'p', title: 't', after_seconds: 60 })
  clock.now = T0 + 120_000
  await service.create('session-1', { prompt: 'p', title: 't', after_seconds: 60 })
  await driver.settled()
  assert.equal(host.started.length, 0, 'writes before start do not drive')
  await driver.dispose()
  driver.start()
  driver.requestDrive()
  await driver.settled()
  assert.equal(host.started.length, 0)
})

// ---------------------------------------------------------------------------------------------------------------
// The plugin, end to end over a real session store and the real turn loop
// ---------------------------------------------------------------------------------------------------------------

/** A Context with the real session and turn-registry plugins and the smallest stand-ins a turn needs. */
async function pluginContext(file: string, autoStart?: boolean) {
  const sessionRoot = join(root, `plugin-${(counter += 1)}`)
  const ctx = new Context()
  await ctx.plugin(SessionPlugin, { root: sessionRoot })
  await ctx.plugin(TurnsPlugin)
  const prompts: string[] = []
  ctx.provide('model')
  ctx.set('model', {
    defaultEndpoint: () => 'fake',
    names: () => ['fake'],
    async *stream(request: { messages: unknown[] }): AsyncIterable<Chunk> {
      prompts.push(JSON.stringify(request.messages))
      yield { type: 'text-delta', text: 'noted' } as Chunk
      yield { type: 'done', finishReason: 'stop' } as Chunk
    },
  })
  const registered: string[] = []
  ctx.provide('tools')
  ctx.set('tools', { register: (tool: { spec: { name: string } }) => registered.push(tool.spec.name), describe: () => [] })
  ctx.provide('sandbox')
  ctx.set('sandbox', { workspaceRoot: sessionRoot, mode: 'danger-full-access', policy: () => ({ mode: 'danger-full-access' }), rootFor: (folder?: string) => folder ?? sessionRoot })
  ctx.provide('context')
  ctx.set('context', {
    recordRuntimeContext: () => undefined,
    prepare: async () => ({ messages: [], estimatedTokens: 0, thresholdTokens: 1, pruned: 0, compacted: false, breakdown: {} }),
  })
  const changed: number[] = []
  ctx.on('schedule/changed', () => changed.push(Date.now()))
  await ctx.plugin(SchedulePlugin, autoStart === undefined ? { file } : { file, autoStart })
  return { ctx, registered, changed }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const userMessages = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === 'message' && (event.message as { role?: string }).role === 'user').map((event) => event.message as { content: { text: string }[]; source?: unknown })

test('the plugin provides ctx.schedule, registers the four tools, and delivers a due reminder into the real session log', async () => {
  const file = join(root, `plugin-store-${(counter += 1)}`, 'schedule.json')
  const { ctx, registered, changed } = await pluginContext(file, false)
  assert.deepEqual(registered, ['schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update'])
  const handle = ctx.session.store.create({ cwd: root, endpoint: 'fake' })

  const past = Date.now() - 60_000
  const record = createAfterScheduleRecord('schedule-due', 'check the build', 30, past, 'Build')
  const store = ctx.schedule.store
  store.put(record.id, task(record, handle.id))

  ctx.schedule.startDelivery()
  await until(() => ctx.schedule.tasks()[0]?.status === 'inactive', 'the delivery to commit')
  const events = ctx.session.store.read(handle)
  const [message] = userMessages(events)
  assert.deepEqual(message?.source, { kind: 'schedule' })
  assert.equal(message?.content[0]?.text, renderReminderFraming(record))
  await until(() => ctx.session.store.read(handle).some((event) => event.type === 'turn/completed'), 'the reminder turn to complete')
  const delivered = ctx.schedule.tasks()[0]
  assert.match(delivered?.lastDelivery?.messageId ?? '', /^message-[0-9a-f-]{36}$/, 'a heddle log event has no id, so one is synthesized')
  assert.ok(changed.length >= 1, 'schedule/changed reached the context')
  await ctx.fiber.dispose()
})

test('the plugin waits for a running turn to complete before it starts the reminder turn', async () => {
  const file = join(root, `plugin-store-${(counter += 1)}`, 'schedule.json')
  const { ctx } = await pluginContext(file, false)
  const handle = ctx.session.store.create({ cwd: root, endpoint: 'fake' })
  const record = createAfterScheduleRecord('schedule-due', 'after the turn', 30, Date.now() - 60_000, 'Later')
  ctx.schedule.store.put(record.id, task(record, handle.id))

  const running = ctx.turns.begin(handle.id)
  ctx.schedule.startDelivery()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(userMessages(ctx.session.store.read(handle)).length, 0, 'nothing is written while the turn runs')
  assert.equal(ctx.schedule.tasks()[0]?.status, 'active')

  ctx.session.store.append(handle, { type: 'turn/completed', rounds: 1 })
  running.settle()
  await until(() => ctx.schedule.tasks()[0]?.status === 'inactive', 'the delivery after the turn completed')
  assert.equal(userMessages(ctx.session.store.read(handle))[0]?.content[0]?.text, renderReminderFraming(record))
  await ctx.fiber.dispose()
})

test('a corrupt store file fails the plugin row instead of running without reminders', async () => {
  const file = join(root, `plugin-store-${(counter += 1)}`, 'schedule.json')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '{"unit":{"name":"schedule","version":1},"global":null,"tables":{"tasks":{"x":{}}}}')
  await assert.rejects(pluginContext(file, false), /is not a valid schedule store/)
})

test('by default the plugin delivers nothing until the host starts delivery, so a one-shot command starts no turn', async () => {
  const file = join(root, `plugin-store-${(counter += 1)}`, 'schedule.json')
  const { ctx } = await pluginContext(file)
  const handle = ctx.session.store.create({ cwd: root, endpoint: 'fake' })
  const record = createAfterScheduleRecord('schedule-due', 'only when started', 30, Date.now() - 60_000, 'Host only')
  ctx.schedule.store.put(record.id, task(record, handle.id))

  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(userMessages(ctx.session.store.read(handle)).length, 0, 'a due reminder waits while no host has started delivery')
  assert.equal(ctx.schedule.tasks()[0]?.status, 'active')

  ctx.schedule.startDelivery()
  await until(() => ctx.schedule.tasks()[0]?.status === 'inactive', 'the delivery once the host started it')
  assert.equal(userMessages(ctx.session.store.read(handle))[0]?.content[0]?.text, renderReminderFraming(record))
  await ctx.fiber.dispose()
})
