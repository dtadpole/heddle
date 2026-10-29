import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { runTurn } from '../agent/loop.ts'
import type { TurnRegistry } from '../agent/turns.ts'
import { ScheduleDriver, type DeliveryHost } from '../schedule/delivery.ts'
import { ScheduleService } from '../schedule/service.ts'
import { defaultScheduleFile } from '../schedule/store.ts'
import { scheduleTools } from '../schedule/tool.ts'
import { expandHome } from '../config/schema.ts'

/** Name this plugin is registered and logged under. */
export const name = 'schedule'

/**
 * A delivered reminder is a turn, so the row needs everything a turn needs — the same list the goal driver declares —
 * plus the tool registry the four tools appear in. The live-turn registry is read without the inject requirement
 * (`ctx.get('turns')`), because a profile may leave that row out.
 */
export const inject = ['session', 'model', 'tools', 'sandbox', 'context']

export interface Config {
  /** The store file. Defaults to `$HEDDLE_HOME/schedule.json`, resolved when the plugin loads. */
  readonly file?: string
  /** Days of delivery history each task keeps, 1-3650. */
  readonly deliveryHistoryDays?: number
  /** Delivery records each task keeps, 1-10000. */
  readonly deliveryHistoryRecords?: number
  /**
   * Start delivering as soon as the plugin loads. Off by default: the long-running host (`heddle web`) calls
   * `ctx.schedule.startDelivery()` after its boot sweeps, the shape the goal and team sweeps use, so a one-shot command
   * that loads this row (`heddle --turn`, `heddle tree`) never starts turns for sessions it is not working on.
   */
  readonly autoStart?: boolean
  /** The round cap of a reminder's turn; the loop's own default when absent. */
  readonly maxRounds?: number
}

export const Config: Schema<Config> = Schema.object({
  file: Schema.string(),
  deliveryHistoryDays: Schema.number().step(1).min(1).max(3650).default(30),
  deliveryHistoryRecords: Schema.number().step(1).min(1).max(10_000).default(200),
  autoStart: Schema.boolean().default(false),
  maxRounds: Schema.number(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['schedule']`. */
    schedule: ScheduleService
  }
  interface Events {
    /** A schedule write was committed: a create, update, delete, archive stop or delivery. */
    'schedule/changed'(): void
  }
}

/** Events a turn writes; seen while no live-turn registry is present, they mark the session busy. */
const TURN_EVENTS = new Set(['model/request', 'assistant/chunk', 'turn/retry', 'tool/result'])

/**
 * One plugin for the whole subsystem: the service (`ctx.schedule`), the four tools, and the delivery driver.
 *
 * Loading it opens the store, and a corrupt store file throws here — the row fails to load rather than running with
 * reminders silently missing.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const store = ctx.session.store
  const metaOf = (id: string) => store.list().find((one) => one.id === id)
  const delegationDepth = (id: string): number => metaOf(id)?.delegationDepth ?? 0

  const service = new ScheduleService({
    file: expandHome(config.file ?? defaultScheduleFile()),
    retention: {
      ...(config.deliveryHistoryDays !== undefined ? { days: config.deliveryHistoryDays } : {}),
      ...(config.deliveryHistoryRecords !== undefined ? { records: config.deliveryHistoryRecords } : {}),
    },
    isDelegated: (id) => delegationDepth(id) > 0,
    warn: (message) => ctx.logger.warn(message),
  })
  ctx.provide('schedule')
  ctx.set('schedule', service)
  service.onChange(() => ctx.emit('schedule/changed'))
  for (const tool of scheduleTools(service, { delegationDepth })) ctx.tools.register(tool)

  /**
   * Busy is the live-turn registry's answer when the profile has one — it is set before a turn writes anything and
   * cleared when the turn settles, however it ends. Without it, the session's own turn events stand in, as they do for
   * the goal driver.
   */
  const inTurn = new Set<string>()
  const registry = (): TurnRegistry | undefined => ctx.get('turns') as TurnRegistry | undefined

  let driver: ScheduleDriver | undefined
  const host: DeliveryHost = {
    resolve: (sessionId) => {
      if (store.open(sessionId) === null) throw new Error(`session "${sessionId}" is not available`)
      if (delegationDepth(sessionId) > 0) throw new Error('This Session belongs to subagent routing, which never receives reminder delivery.')
    },
    isBusy: (sessionId) => {
      const turns = registry()
      return turns !== undefined ? turns.isRunning(sessionId) : inTurn.has(sessionId)
    },
    cursor: (sessionId) => {
      const handle = store.open(sessionId)
      return handle === null ? 0 : store.count(handle)
    },
    startTurn: async (sessionId, text, source) => {
      const handle = store.open(sessionId)
      if (handle === null) throw new Error(`session "${sessionId}" is not available`)
      const meta = metaOf(sessionId)
      const endpoint = meta?.endpoint ?? ctx.model.defaultEndpoint()
      if (endpoint === undefined) throw new Error('no endpoint is configured for a reminder turn')
      /**
       * Started, not awaited: the turn writes its user message before its first await, which is all delivery needs,
       * and a drive must not hold the schedule queue for the length of a model call.
       */
      const turn = runTurn(ctx, {
        session: handle,
        endpoint,
        prompt: text,
        source,
        ...(meta?.model !== undefined ? { model: meta.model } : {}),
        ...(meta?.reasoningEffort !== undefined ? { reasoningEffort: meta.reasoningEffort } : {}),
        ...(config.maxRounds !== undefined ? { maxRounds: config.maxRounds } : {}),
      })
      void turn.catch((error: unknown) => {
        ctx.logger.warn('schedule: the reminder turn in session %s failed — %s', sessionId, error instanceof Error ? error.message : String(error))
        driver?.turnEnded(sessionId)
      })
    },
    find: (sessionId, cursor, text) => {
      const handle = store.open(sessionId)
      if (handle === null) return undefined
      for (const event of store.read(handle).slice(cursor)) {
        if (event.type !== 'message') continue
        const message = event.message as { role?: string; id?: unknown; source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] } | undefined
        if (message?.role !== 'user' || message.source?.kind !== 'schedule') continue
        const body = (message.content ?? []).map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('')
        if (body !== text) continue
        const id = typeof event.id === 'string' ? event.id : typeof message.id === 'string' ? message.id : `message-${randomUUID()}`
        return { messageId: id }
      }
      return undefined
    },
  }

  driver = new ScheduleDriver(service, host, { warn: (message) => ctx.logger.warn(message) })
  const delivery = driver

  /** A turn ending is the edge a reminder waiting on a busy session needs. */
  ctx.on('session/event', ({ session, event }) => {
    if (event.type === 'turn/completed' || event.type === 'turn/failed') {
      inTurn.delete(session)
      delivery.turnEnded(session)
      return
    }
    if (TURN_EVENTS.has(event.type)) inTurn.add(session)
  })

  ctx.effect(() => () => {
    void delivery.dispose().then(() => service.dispose())
  }, 'schedule.delivery()')

  if (config.autoStart === true) delivery.start()
}
