import { randomUUID } from 'node:crypto'

import { ScheduleInputError } from './errors.ts'
import {
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createCronScheduleRecord,
  createDailyScheduleRecord,
  createEveryScheduleRecord,
  createWeeklyScheduleRecord,
  resolveScheduleUpdate,
  scheduleTitle,
  type ScheduleRecord,
  type UpdateResolution,
} from './rules.ts'
import { ScheduleStore, type DeliveryHistory, type DeliveryReceipt, type DeliveryRecord, type ScheduleTask } from './store.ts'
import { DAY_MS } from './time.ts'

/**
 * The schedule service: host-wide durable reminders, shared by the model's tools and any management surface.
 *
 * A port of DSH's `ScheduleService` (SVC:1879-2300) over heddle's own pieces: the task table is a
 * {@link ScheduleStore} file instead of a storage domain, the "is this a delegated child" question is answered from
 * the session's metadata, and "a write was committed" is a callback list the plugin forwards as `schedule/changed`.
 *
 * The rules that carry weight, all DSH's:
 *
 * - **one FIFO** serializes create, update, delete, the archive stop and delivery, so a delivery can never interleave
 *   with an edit of the task it is delivering;
 * - **create samples its clock before queueing** — a create that waits behind a long operation keeps its request-time
 *   anchor and may already be due when the queue reaches it — while **update samples inside the queue**, so a timing
 *   change is anchored to the moment it is saved;
 * - **update is a compare-and-set** on the complete record the caller observed;
 * - **every committed write** is followed by a change notification and a request to the delivery driver.
 *
 * Reads (`list`, `catalog`, `history`) are not queued: the table in memory is already the committed state.
 */

/** Retained delivery-history window when the deployment states none. */
export const DEFAULT_DELIVERY_HISTORY_DAYS = 30

/** Retained delivery-history record cap when the deployment states none. */
export const DEFAULT_DELIVERY_HISTORY_RECORDS = 200

/** How much delivery history each task keeps. */
export interface ScheduleRetention {
  readonly days: number
  readonly records: number
}

/** A create request: the tool's arguments, passed through. */
export interface CreateRequest {
  readonly prompt?: unknown
  readonly title?: unknown
  readonly after_seconds?: unknown
  readonly at?: unknown
  readonly every_seconds?: unknown
  readonly daily?: unknown
  readonly weekly?: unknown
  readonly cron?: unknown
}

/** An update request (TYP:340-381): the binding, the complete observed record, and what to change. */
export interface UpdateRequest {
  readonly sessionId: string
  readonly id: string
  readonly expected: unknown
  readonly title?: unknown
  readonly prompt?: unknown
  readonly change?: unknown
}

/** What an update gives: the resolution, a lookup miss, or the subagent refusal. */
export type UpdateResult =
  | UpdateResolution
  | { readonly id: string; readonly updated: false; readonly code: 'schedule_not_found' | 'schedule_ended' }

/** What a delete gives. */
export type DeleteResult = { readonly id: string; readonly deleted: true } | { readonly id: string; readonly deleted: false; readonly code: 'schedule_not_found' }

/** A history page request: the binding, the task, a page size of 1-100 and an exclusive message cursor. */
export interface HistoryRequest {
  readonly sessionId: string
  readonly id: string
  readonly limit: number
  readonly before?: string
}

/** One history page, newest first, or a lookup miss. */
export type HistoryResult =
  | {
      readonly id: string
      readonly records: readonly DeliveryRecord[]
      readonly earlierRecordsUnavailable: boolean
      readonly earlierRecordsPruned: boolean
      readonly retention: ScheduleRetention
      readonly nextBefore?: string
    }
  | { readonly id: string; readonly code: 'schedule_not_found' | 'delivery_cursor_not_found' }

/** One catalog row: the record plus its binding, status and last delivery. */
export type CatalogEntry = ScheduleRecord & {
  readonly sessionId: string
  readonly status: 'active' | 'inactive'
  readonly lastDelivery?: DeliveryReceipt
}

/** What the service needs from a delivery driver. */
export interface ScheduleDriverHandle {
  requestDrive(): void
  start(): void
}

export interface ScheduleServiceOptions {
  /** The store file, normally `$HEDDLE_HOME/schedule.json`; a test passes a temp path. */
  readonly file: string
  /** The clock, in epoch milliseconds. Injectable so a test can stand at a DST edge. */
  readonly now?: () => number
  readonly retention?: Partial<ScheduleRetention>
  /** Whether a session is a delegated child's (delegation depth above 0), which no delivery may target. */
  readonly isDelegated?: (sessionId: string) => boolean
  /** Where a contained failure is reported. */
  readonly warn?: (message: string) => void
  /** The id generator; `schedule-<uuid>` by default. */
  readonly newId?: () => string
}

/** The subagent refusal the service itself gives (SVC:2254-2261). */
const SUBAGENT_TARGET = { code: 'subagent_session', message: 'This Session belongs to subagent routing, which never receives reminder delivery.' } as const

/** The delivery history a task without one exposes: only its last receipt, with earlier records unavailable. */
export function deliveryHistoryOf(task: ScheduleTask): DeliveryHistory {
  return task.deliveryHistory ?? { records: task.lastDelivery === undefined ? [] : [task.lastDelivery], earlierRecordsUnavailable: true }
}

/**
 * Append one acknowledged delivery and prune (SVC:1445-1461): keep records delivered within the window before the new
 * one, then the last N; either cut marks earlier records unavailable **and** pruned.
 */
export function appendDelivery(
  task: ScheduleTask,
  receipt: DeliveryReceipt,
  bounds: ScheduleRetention,
): { readonly lastDelivery: DeliveryReceipt; readonly deliveryHistory: DeliveryHistory } {
  const history = deliveryHistoryOf(task)
  const appended: DeliveryRecord[] = [...history.records, { ...receipt, prompt: task.record.prompt }]
  const floor = Date.parse(receipt.deliveredAt) - bounds.days * DAY_MS
  const retained = appended.filter((record) => Date.parse(record.deliveredAt) >= floor).slice(-bounds.records)
  const dropped = retained.length !== appended.length
  return {
    lastDelivery: receipt,
    deliveryHistory: {
      records: retained,
      earlierRecordsUnavailable: history.earlierRecordsUnavailable || dropped,
      earlierRecordsPruned: history.earlierRecordsPruned === true || dropped,
    },
  }
}

function boundedInteger(value: number | undefined, fallback: number, max: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) throw new RangeError(`${name} must be an integer from 1 through ${max}`)
  return resolved
}

export class ScheduleService {
  readonly store: ScheduleStore
  readonly retention: ScheduleRetention
  private readonly clock: () => number
  private readonly isDelegated: (sessionId: string) => boolean
  private readonly warn: (message: string) => void
  private readonly newId: () => string
  private readonly listeners = new Set<() => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false
  private driver: ScheduleDriverHandle | undefined

  /** Open the store; a corrupt file throws here, which is what refuses startup. */
  constructor(options: ScheduleServiceOptions) {
    this.retention = {
      days: boundedInteger(options.retention?.days, DEFAULT_DELIVERY_HISTORY_DAYS, 3650, 'deliveryHistoryDays'),
      records: boundedInteger(options.retention?.records, DEFAULT_DELIVERY_HISTORY_RECORDS, 10_000, 'deliveryHistoryRecords'),
    }
    this.clock = options.now ?? Date.now
    this.isDelegated = options.isDelegated ?? (() => false)
    this.warn = options.warn ?? (() => undefined)
    this.newId = options.newId ?? (() => `schedule-${randomUUID()}`)
    this.store = new ScheduleStore(options.file)
  }

  /** The service's clock, which the tools and the driver share. */
  now(): number {
    return this.clock()
  }

  /**
   * Create a reminder bound to a session, without touching the session (SVC:2083-2114).
   *
   * The record is built from a clock reading taken **before** the request joins the queue. A delegated child's
   * session is refused inside the queue, because no delivery could ever reach it.
   */
  async create(sessionId: string, request: CreateRequest, signal?: AbortSignal): Promise<ScheduleRecord> {
    const selectors = [request.at, request.after_seconds, request.every_seconds, request.daily, request.weekly, request.cron].filter((value) => value !== undefined).length
    if (selectors > 1) throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    const title = scheduleTitle(request.title)
    const id = this.newId()
    const now = this.now()
    let record: ScheduleRecord
    if (request.at !== undefined) record = createAtScheduleRecord(id, request.prompt, request.at, now, title)
    else if (request.after_seconds !== undefined) record = createAfterScheduleRecord(id, request.prompt, request.after_seconds, now, title)
    else if (request.every_seconds !== undefined) record = createEveryScheduleRecord(id, request.prompt, request.every_seconds, now, title)
    else if (request.daily !== undefined) record = createDailyScheduleRecord(id, request.prompt, request.daily, now, title)
    else if (request.weekly !== undefined) record = createWeeklyScheduleRecord(id, request.prompt, request.weekly, now, title)
    else if (request.cron !== undefined) record = createCronScheduleRecord(id, request.prompt, request.cron, now, title)
    else throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    return this.serialize(() => {
      if (this.isDelegated(sessionId)) throw new ScheduleInputError('subagent_session', SUBAGENT_TARGET.message)
      signal?.throwIfAborted()
      this.store.put(id, { sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } })
      this.committed()
      return record
    })
  }

  /** The session's active records, in storage order (SVC:2120-2122). */
  async list(request: { readonly sessionId: string }): Promise<readonly ScheduleRecord[]> {
    return this.store
      .entries()
      .filter((task) => task.sessionId === request.sessionId && task.status === 'active')
      .map((task) => task.record)
  }

  /** Every row, active and inactive, with its binding — by scheduledAt, then id (SVC:2129-2136). */
  async catalog(): Promise<readonly CatalogEntry[]> {
    return this.store
      .entries()
      .map((task): CatalogEntry => ({
        ...task.record,
        sessionId: task.sessionId,
        status: task.status,
        ...(task.lastDelivery !== undefined ? { lastDelivery: task.lastDelivery } : {}),
      }))
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id))
  }

  /**
   * One page of a task's saved deliveries, newest first in append order, before an exclusive message cursor
   * (SVC:2144-2152, 1469-1490).
   */
  async history(request: HistoryRequest): Promise<HistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ScheduleInputError('invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
    }
    const task = this.store.get(request.id)
    if (task === undefined || task.sessionId !== request.sessionId) return { id: request.id, code: 'schedule_not_found' }
    const history = deliveryHistoryOf(task)
    const end = request.before === undefined ? history.records.length : history.records.findIndex((record) => record.messageId === request.before)
    if (end === -1) return { id: request.id, code: 'delivery_cursor_not_found' }
    const start = Math.max(0, end - request.limit)
    const records = history.records
      .slice(start, end)
      .reverse()
      .map(({ prompt, ...receipt }) => ({ ...receipt, ...(prompt === undefined ? {} : { prompt }) }))
    const oldest = records.at(-1)
    return {
      id: request.id,
      records,
      earlierRecordsUnavailable: history.earlierRecordsUnavailable,
      earlierRecordsPruned: history.earlierRecordsPruned === true,
      retention: { ...this.retention },
      ...(oldest !== undefined && start > 0 ? { nextBefore: oldest.messageId } : {}),
    }
  }

  /** Delete one task of the session, in any state, with its history; queued messages stay (SVC:2164-2182). */
  async delete(request: { readonly sessionId: string; readonly id: string }, signal?: AbortSignal): Promise<DeleteResult> {
    return this.serialize((): DeleteResult => {
      signal?.throwIfAborted()
      const current = this.store.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) return { id: request.id, deleted: false, code: 'schedule_not_found' }
      this.store.delete(request.id)
      this.committed()
      return { id: request.id, deleted: true }
    })
  }

  /**
   * Change an active task's name, instruction or timing in place (SVC:2197-2224).
   *
   * Sampled inside the queue; a delegated child's session is refused as a result, not a throw; an inactive task is
   * `schedule_ended`; anything else is the compare-and-set resolution. A no-op writes nothing.
   */
  async update(request: UpdateRequest, signal?: AbortSignal): Promise<UpdateResult> {
    return this.serialize((): UpdateResult => {
      if (this.isDelegated(request.sessionId)) return { ...SUBAGENT_TARGET }
      signal?.throwIfAborted()
      const current = this.store.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) return { id: request.id, updated: false, code: 'schedule_not_found' }
      if (current.status === 'inactive') return { id: request.id, updated: false, code: 'schedule_ended' }
      const result = resolveScheduleUpdate(current.record, request.expected, request.change, this.now(), request)
      if (!('record' in result) || !result.updated) return result
      this.store.put(request.id, { ...current, record: result.record })
      this.committed()
      return result
    })
  }

  /** Remove every active task of one session inside the queue — the archive stop (SVC:2273-2292). */
  async stopSessionTasks(sessionId: string): Promise<void> {
    await this.serialize(() => {
      const active = this.store
        .entries()
        .filter((task) => task.sessionId === sessionId && task.status === 'active')
        .map((task) => task.record.id)
      if (active.length === 0) return
      let removed = false
      let failure: Error | undefined
      for (const id of active) {
        try {
          this.store.delete(id)
          removed = true
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(`schedule stop failed: ${String(error)}`)
        }
      }
      if (removed) this.committed()
      if (failure !== undefined) throw failure
    })
  }

  /** Listen for committed writes; returns the unsubscriber. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Bind the delivery driver every committed management write asks to drive. */
  attachDriver(driver: ScheduleDriverHandle): void {
    this.driver = driver
  }

  /** Start delivery, for a host that did not start it at load (the plugin's `autoStart: false`). */
  startDelivery(): void {
    this.driver?.start()
  }

  /** The table, in storage order — what a drive scans. */
  tasks(): readonly ScheduleTask[] {
    return this.store.entries()
  }

  /** Persist one acknowledged delivery and announce it. Called by the driver inside its serialized drive. */
  commitDelivery(task: ScheduleTask): void {
    this.store.put(task.record.id, task)
    this.emitChanged()
  }

  /** Run one operation in the FIFO, after everything queued before it; refused once the service is stopping. */
  serialize<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Schedule service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined)
    return pending
  }

  /** Stop accepting operations and wait for the queue to drain. */
  async dispose(): Promise<void> {
    this.stopping = true
    await this.chain
  }

  /** After a committed management write: tell the listeners, then ask the driver to look again. */
  private committed(): void {
    this.emitChanged()
    this.driver?.requestDrive()
  }

  /** A throwing listener must not reject the caller whose write has already landed (SVC:2231-2237). */
  private emitChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.warn(`schedule: schedule/changed listener failed: ${String(error)}`)
      }
    }
  }
}
