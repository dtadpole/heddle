import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { ScheduleLogError } from './errors.ts'
import { decodeScheduleRecord, type ScheduleRecord } from './rules.ts'
import { UTC_INSTANT } from './time.ts'

/**
 * Where reminders are kept: one whole-unit JSON file, in DSH's storage-domain shape.
 *
 * DSH stores its tasks in the storage domain `schedule`, version 1, table `tasks`, keyed by record id (SVC:1675-1690),
 * and its JSON backend writes the whole unit as one document (README:73, 161). This file is that document, byte-shape
 * for byte-shape, so a reader of either harness can read the other's:
 *
 * ```json
 * {"unit":{"name":"schedule","version":1},"global":null,"tables":{"tasks":{"<id>":<row>}}}
 * ```
 *
 * A row is `{sessionId, record, status, lastDelivery?, deliveryHistory?}`, decoded strictly. Three rules carry weight:
 *
 * - **an absent file is an empty store**, and a corrupt or invalid one **refuses to open** — a store that silently
 *   dropped an unreadable row would silently drop a reminder, and the owner would find out by its not firing;
 * - **every write is atomic**: a temp file beside the target, fsynced, then renamed over it, so a crash leaves either
 *   the old document or the new one;
 * - **memory follows the disk**: a write that fails leaves the in-memory table as it was, so the next reader never
 *   sees a row the file does not hold.
 */

/** What one delivery acknowledged: the occurrence, when it landed, and the message that carried it. */
export interface DeliveryReceipt {
  readonly scheduledAt: string
  readonly deliveredAt: string
  readonly messageId: string
}

/** A retained delivery: the receipt plus the prompt as it was delivered. */
export interface DeliveryRecord extends DeliveryReceipt {
  readonly prompt?: string
}

/** A task's retained deliveries, oldest first, and whether earlier ones are gone. */
export interface DeliveryHistory {
  readonly records: readonly DeliveryRecord[]
  readonly earlierRecordsUnavailable: boolean
  readonly earlierRecordsPruned?: boolean
}

/** One stored task: the record, the session it belongs to, its status, and its deliveries. */
export interface ScheduleTask {
  readonly sessionId: string
  readonly record: ScheduleRecord
  readonly status: 'active' | 'inactive'
  readonly lastDelivery?: DeliveryReceipt
  readonly deliveryHistory?: DeliveryHistory
}

/** The store's file refused to open. The message names the file and the first thing wrong with it. */
export class ScheduleStoreError extends Error {
  constructor(file: string, detail: string) {
    super(`schedule: ${file} is not a valid schedule store: ${detail}`)
    this.name = 'ScheduleStoreError'
  }
}

/** `$HEDDLE_HOME/schedule.json`, the way every other heddle store resolves its home. */
export function defaultScheduleFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HEDDLE_HOME ?? join(homedir(), '.heddle'), 'schedule.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ScheduleLogError(`${what} has an unknown key ${JSON.stringify(key)}`)
  }
}

/** A canonical millisecond UTC instant, never year 0000 — what DSH's `z.iso.datetime({precision: 3})` admits. */
function instant(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new ScheduleLogError(`${what} must be a canonical four-digit-year UTC calendar instant`)
  }
  return value
}

function messageId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new ScheduleLogError(`${what} must be a non-empty trimmed string`)
  return value
}

function decodeReceipt(value: unknown, what: string): DeliveryReceipt {
  if (!isRecord(value)) throw new ScheduleLogError(`${what} must be an object`)
  onlyKeys(value, ['scheduledAt', 'deliveredAt', 'messageId'], what)
  return {
    scheduledAt: instant(value.scheduledAt, `${what}.scheduledAt`),
    deliveredAt: instant(value.deliveredAt, `${what}.deliveredAt`),
    messageId: messageId(value.messageId, `${what}.messageId`),
  }
}

function decodeHistory(value: unknown): DeliveryHistory {
  if (!isRecord(value)) throw new ScheduleLogError('deliveryHistory must be an object')
  onlyKeys(value, ['records', 'earlierRecordsUnavailable', 'earlierRecordsPruned'], 'deliveryHistory')
  if (!Array.isArray(value.records)) throw new ScheduleLogError('deliveryHistory.records must be an array')
  const records = (value.records as unknown[]).map((entry, index): DeliveryRecord => {
    const what = `deliveryHistory.records[${index}]`
    if (!isRecord(entry)) throw new ScheduleLogError(`${what} must be an object`)
    onlyKeys(entry, ['scheduledAt', 'deliveredAt', 'messageId', 'prompt'], what)
    const receipt = decodeReceipt({ scheduledAt: entry.scheduledAt, deliveredAt: entry.deliveredAt, messageId: entry.messageId }, what)
    if (entry.prompt !== undefined && typeof entry.prompt !== 'string') throw new ScheduleLogError(`${what}.prompt must be a string`)
    return { ...receipt, ...(entry.prompt !== undefined ? { prompt: entry.prompt as string } : {}) }
  })
  if (typeof value.earlierRecordsUnavailable !== 'boolean') throw new ScheduleLogError('deliveryHistory.earlierRecordsUnavailable must be a boolean')
  if (value.earlierRecordsPruned !== undefined && typeof value.earlierRecordsPruned !== 'boolean') {
    throw new ScheduleLogError('deliveryHistory.earlierRecordsPruned must be a boolean')
  }
  if (new Set(records.map((record) => record.messageId)).size !== records.length) {
    throw new ScheduleLogError('Delivery history message identities must be unique within a task')
  }
  return {
    records,
    earlierRecordsUnavailable: value.earlierRecordsUnavailable,
    ...(value.earlierRecordsPruned !== undefined ? { earlierRecordsPruned: value.earlierRecordsPruned as boolean } : {}),
  }
}

/** Decode one stored row strictly, with DSH's refinements (SVC:1678-1689, 1997-2007). */
export function decodeTask(key: string, value: unknown): ScheduleTask {
  if (!isRecord(value)) throw new ScheduleLogError(`task ${JSON.stringify(key)} must be an object`)
  onlyKeys(value, ['sessionId', 'record', 'status', 'lastDelivery', 'deliveryHistory'], `task ${JSON.stringify(key)}`)
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) throw new ScheduleLogError(`task ${JSON.stringify(key)} needs a non-empty sessionId`)
  const record = decodeScheduleRecord(value.record)
  const status = value.status === undefined ? 'active' : value.status
  if (status !== 'active' && status !== 'inactive') throw new ScheduleLogError(`task ${JSON.stringify(key)} status must be active or inactive`)
  const lastDelivery = value.lastDelivery === undefined ? undefined : decodeReceipt(value.lastDelivery, 'lastDelivery')
  const deliveryHistory = value.deliveryHistory === undefined ? undefined : decodeHistory(value.deliveryHistory)
  if (deliveryHistory !== undefined) {
    const latest = deliveryHistory.records.at(-1)
    const matches =
      latest === undefined
        ? lastDelivery === undefined
        : lastDelivery !== undefined &&
          latest.scheduledAt === lastDelivery.scheduledAt &&
          latest.deliveredAt === lastDelivery.deliveredAt &&
          latest.messageId === lastDelivery.messageId
    if (!matches) throw new ScheduleLogError('Last delivery must match the latest saved delivery receipt')
  }
  if (key !== record.id) throw new ScheduleLogError(`stored task key "${key}" differs from record id "${record.id}"`)
  return {
    sessionId: value.sessionId,
    record,
    status,
    ...(lastDelivery !== undefined ? { lastDelivery } : {}),
    ...(deliveryHistory !== undefined ? { deliveryHistory } : {}),
  }
}

/** Decode a whole unit document; any violation throws a {@link ScheduleLogError} naming it. */
export function decodeUnit(text: string): Map<string, ScheduleTask> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ScheduleLogError(`the file is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!isRecord(parsed)) throw new ScheduleLogError('the unit must be an object')
  onlyKeys(parsed, ['unit', 'global', 'tables'], 'the unit')
  const unit = parsed.unit
  if (!isRecord(unit) || unit.name !== 'schedule' || unit.version !== 1) throw new ScheduleLogError('unit must be {"name":"schedule","version":1}')
  onlyKeys(unit, ['name', 'version'], 'unit')
  if (parsed.global !== null) throw new ScheduleLogError('global must be null')
  const tables = parsed.tables
  if (!isRecord(tables)) throw new ScheduleLogError('tables must be an object')
  onlyKeys(tables, ['tasks'], 'tables')
  const tasks = tables.tasks ?? {}
  if (!isRecord(tasks)) throw new ScheduleLogError('tables.tasks must be an object')
  const decoded = new Map<string, ScheduleTask>()
  for (const [key, row] of Object.entries(tasks)) decoded.set(key, decodeTask(key, row))
  return decoded
}

/** One row in its stored key order: sessionId, record, status, lastDelivery, deliveryHistory. */
function encodeTask(task: ScheduleTask): Record<string, unknown> {
  return {
    sessionId: task.sessionId,
    record: task.record,
    status: task.status,
    ...(task.lastDelivery !== undefined ? { lastDelivery: task.lastDelivery } : {}),
    ...(task.deliveryHistory !== undefined ? { deliveryHistory: task.deliveryHistory } : {}),
  }
}

/** The whole unit document for a table, in storage order. */
export function encodeUnit(tasks: ReadonlyMap<string, ScheduleTask>): string {
  const rows: Record<string, unknown> = {}
  for (const [key, task] of tasks) rows[key] = encodeTask(task)
  return `${JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: rows } }, null, 2)}\n`
}

/** Write a file so a reader sees the old content or the new, never a half: temp file, fsync, rename. */
function writeAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temp, 'w', 0o600)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  try {
    const directory = openSync(dirname(file), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch {
    // Not every platform can fsync a directory; the rename has already landed.
  }
}

/** The task table over one file. Reads are served from memory; every change rewrites the whole unit. */
export class ScheduleStore {
  readonly file: string
  private tasks: Map<string, ScheduleTask>

  /** Open the store at `file`: absent means empty, and anything unreadable throws a {@link ScheduleStoreError}. */
  constructor(file: string) {
    this.file = file
    let text: string | undefined
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ScheduleStoreError(file, (error as Error).message)
    }
    try {
      this.tasks = text === undefined ? new Map() : decodeUnit(text)
    } catch (error) {
      throw new ScheduleStoreError(file, error instanceof Error ? error.message : String(error))
    }
  }

  /** Every task, in storage order. */
  entries(): readonly ScheduleTask[] {
    return [...this.tasks.values()]
  }

  get(id: string): ScheduleTask | undefined {
    return this.tasks.get(id)
  }

  /** Insert or replace one task; a replaced task keeps its storage position. */
  put(id: string, task: ScheduleTask): void {
    if (id !== task.record.id) throw new ScheduleLogError(`stored task key "${id}" differs from record id "${task.record.id}"`)
    const next = new Map(this.tasks)
    next.set(id, task)
    writeAtomically(this.file, encodeUnit(next))
    this.tasks = next
  }

  /** Remove one task; whether there was one. */
  delete(id: string): boolean {
    if (!this.tasks.has(id)) return false
    const next = new Map(this.tasks)
    next.delete(id)
    writeAtomically(this.file, encodeUnit(next))
    this.tasks = next
    return true
  }
}
