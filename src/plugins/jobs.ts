import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { runTurn } from '../agent/loop.ts'
import type { TurnRegistry } from '../agent/turns.ts'
import { bashBackground } from '../jobs/bash.ts'
import { NoticeDelivery, type NoticeHost } from '../jobs/notice.ts'
import { JobRegistry } from '../jobs/registry.ts'
import { jobTools, withJobsSection } from '../jobs/tools.ts'
import { pendingInbox, queueSteer } from '../session/inbox.ts'
import { attachBashBackground } from '../tools/builtin.ts'

/** Name this plugin is registered and logged under. */
export const name = 'jobs'

/**
 * A notice can start a turn, so the row needs what a turn needs — the list the schedule and goal rows declare — plus
 * the tool registry its three tools appear in and the sandbox background `bash` is confined by. The live-turn
 * registry is read without the inject requirement (`ctx.get('turns')`), because a profile may leave that row out.
 */
export const inject = ['session', 'model', 'tools', 'sandbox', 'context']

export interface Config {
  /** Active (running + stopping) jobs one session may hold, 1 or more; DSH's default is 10. */
  readonly maxConcurrentJobsPerOwner?: number
  /** Live output kept per job, in UTF-8 bytes; DSH's default is 262144. */
  readonly retainBytes?: number
  /** Output kept per job after it settles, in UTF-8 bytes; DSH's default is 16384. */
  readonly settledRetainBytes?: number
  /** How often pull sources are drained, in milliseconds; DSH's default is 150. */
  readonly pumpPollMs?: number
  /** `job_output`'s wait when `timeout_ms` is absent; DSH's default is 30000. */
  readonly waitTimeoutMs?: number
  /** The longest wait `job_output` grants; DSH's default is 600000. */
  readonly maxWaitTimeoutMs?: number
  /** `wakeup` starts a turn in an idle owner session; `quiet` only injects into the next step. */
  readonly completionDelivery?: 'wakeup' | 'quiet'
  /** Wakes per session before a person writes again; unset is unbounded (DSH's default). */
  readonly maxConsecutiveWakes?: number
  /** Milliseconds between a killed command's SIGTERM and SIGKILL; DSH's 3000. */
  readonly killGraceMs?: number
  /** The round cap of a notice's turn; the loop's own default when absent. */
  readonly maxRounds?: number
}

export const Config: Schema<Config> = Schema.object({
  maxConcurrentJobsPerOwner: Schema.number().step(1).min(1).default(10),
  retainBytes: Schema.number().step(1).min(1).default(262_144),
  settledRetainBytes: Schema.number().step(1).min(1).default(16_384),
  pumpPollMs: Schema.number().step(1).min(1).default(150),
  waitTimeoutMs: Schema.number().min(1).default(30_000),
  maxWaitTimeoutMs: Schema.number().min(1).default(600_000),
  completionDelivery: Schema.union(['wakeup', 'quiet']).default('wakeup'),
  maxConsecutiveWakes: Schema.number().step(1).min(1),
  killGraceMs: Schema.number().min(0).default(3_000),
  maxRounds: Schema.number(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['jobs']`. */
    jobs: JobRegistry
  }
  interface Events {
    /** A job was registered, made progress, began stopping, settled or was removed. */
    'jobs/changed'(): void
  }
}

/** Events a turn writes; seen while no live-turn registry is present, they mark the session busy. */
const TURN_EVENTS = new Set(['model/request', 'assistant/chunk', 'turn/retry', 'tool/result'])

/**
 * One row for the whole subsystem: the registry (`ctx.jobs`), the three job tools, background `bash`, the completion
 * notices, and the `jobs/changed` event the server forwards to the page.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const store = ctx.session.store
  const metaOf = (id: string) => store.list().find((one) => one.id === id)

  const registry = new JobRegistry({
    sessionExists: (id) => store.open(id) !== null,
    record: (sessionId, type, data) => {
      const handle = store.open(sessionId)
      if (handle === null) throw new Error(`session "${sessionId}" is not available`)
      store.append(handle, { type, ...data })
    },
    warn: (message) => ctx.logger.warn(message),
    ...(config.maxConcurrentJobsPerOwner !== undefined ? { maxConcurrentJobsPerOwner: config.maxConcurrentJobsPerOwner } : {}),
    ...(config.retainBytes !== undefined ? { retainBytes: config.retainBytes } : {}),
    ...(config.settledRetainBytes !== undefined ? { settledRetainBytes: config.settledRetainBytes } : {}),
    ...(config.pumpPollMs !== undefined ? { pumpPollMs: config.pumpPollMs } : {}),
  })
  ctx.provide('jobs')
  ctx.set('jobs', registry)

  /**
   * Busy is the live-turn registry's answer when the profile has one. Without it, the session's own turn events stand
   * in, as they do for the schedule row, and a turn's end releases whoever waits for the session to go idle.
   */
  const inTurn = new Set<string>()
  const idleWaiters = new Map<string, (() => void)[]>()
  const turns = (): TurnRegistry | undefined => ctx.get('turns') as TurnRegistry | undefined
  let disposed = false

  const host: NoticeHost = {
    exists: (sessionId) => store.open(sessionId) !== null,
    isRunning: (sessionId) => {
      const live = turns()
      return live !== undefined ? live.isRunning(sessionId) : inTurn.has(sessionId)
    },
    whenIdle: (sessionId) => {
      const live = turns()
      if (live !== undefined) return live.whenIdle(sessionId)
      if (!inTurn.has(sessionId)) return Promise.resolve()
      return new Promise<void>((resolve) => idleWaiters.set(sessionId, [...(idleWaiters.get(sessionId) ?? []), resolve]))
    },
    inject: (sessionId, text, source) => {
      const handle = store.open(sessionId)
      if (handle === null) throw new Error(`session "${sessionId}" is not available`)
      return queueSteer(store, handle, [{ type: 'text', text }], source).id
    },
    isPending: (sessionId, messageId) => {
      const handle = store.open(sessionId)
      return handle !== null && pendingInbox(store, handle)['next-step'].some((message) => message.id === messageId)
    },
    wake: (sessionId, text, source, options) => {
      if (disposed) return
      const handle = store.open(sessionId)
      if (handle === null) return
      const meta = metaOf(sessionId)
      const endpoint = meta?.endpoint ?? ctx.model.defaultEndpoint()
      if (endpoint === undefined) {
        ctx.logger.warn('jobs: no endpoint is configured for a completion-notice turn in session %s', sessionId)
        return
      }
      /**
       * Started, not awaited, as the schedule row starts a reminder's turn: the turn writes its user message before
       * its first await, which is all delivery needs, and a later notice must find this turn running and be injected.
       */
      const turn = runTurn(ctx, {
        session: handle,
        endpoint,
        prompt: text,
        source,
        purpose: 'jobs-notice',
        ...(options.answerPending ? { answerPending: true } : {}),
        ...(meta?.model !== undefined ? { model: meta.model } : {}),
        ...(meta?.reasoningEffort !== undefined ? { reasoningEffort: meta.reasoningEffort } : {}),
        ...(config.maxRounds !== undefined ? { maxRounds: config.maxRounds } : {}),
      })
      void turn.catch((error: unknown) => {
        ctx.logger.warn('jobs: the completion-notice turn in session %s failed — %s', sessionId, error instanceof Error ? error.message : String(error))
      })
    },
    warn: (message) => ctx.logger.warn(message),
  }

  const delivery = new NoticeDelivery(registry, host, {
    ...(config.completionDelivery !== undefined ? { completionDelivery: config.completionDelivery } : {}),
    ...(config.maxConsecutiveWakes !== undefined ? { maxConsecutiveWakes: config.maxConsecutiveWakes } : {}),
  })

  const detachController = registry.attachController('tool-jobs')
  for (const tool of jobTools(registry, {
    ...(config.waitTimeoutMs !== undefined ? { waitTimeoutMs: config.waitTimeoutMs } : {}),
    ...(config.maxWaitTimeoutMs !== undefined ? { maxWaitTimeoutMs: config.maxWaitTimeoutMs } : {}),
    onModelKill: (id) => delivery.markModelKill(id),
  })) {
    ctx.tools.register(tool)
  }
  const detachBash = attachBashBackground(
    ctx.sandbox,
    bashBackground(registry, ctx.sandbox, {
      readLog: (handle) => store.read(handle),
      ...(config.killGraceMs !== undefined ? { killGraceMs: config.killGraceMs } : {}),
    }),
  )

  /**
   * DSH's `tool:jobs` prompt section, on every request that offers the job tools: the `model/request` waterfall is the
   * one seam through which a row reaches the system prompt the adapter is sent (`withJobsSection`).
   */
  ctx.on('model/request', (request, next) => withJobsSection(next()))

  /** Every lifecycle change, so the page's job views refresh. Output advances are left to the page's follow poll. */
  const unsubscribe = registry.subscribe((event) => {
    if (event.type === 'output' || disposed) return
    ctx.emit('jobs/changed')
  })

  ctx.on('session/event', ({ session, event }) => {
    if (event.type === 'turn/completed' || event.type === 'turn/failed') {
      inTurn.delete(session)
      const waiters = idleWaiters.get(session) ?? []
      idleWaiters.delete(session)
      for (const resolve of waiters) resolve()
      return
    }
    if (TURN_EVENTS.has(event.type)) inTurn.add(session)
    /** A person's message — a user message no automation wrote — resets the session's wake count. */
    if (event.type === 'message') {
      const message = event.message as { role?: string; source?: unknown } | undefined
      if (message?.role === 'user' && message.source === undefined) delivery.resetWakes(session)
    }
  })

  ctx.effect(
    () => () => {
      disposed = true
      detachBash()
      delivery.dispose()
      unsubscribe()
      detachController()
      void registry.dispose()
    },
    'jobs.teardown()',
  )
}
