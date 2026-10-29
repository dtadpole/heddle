import { isRecurringScheduleRecord, resolveRecurringOccurrence, type Occurrence, type RecurringRecord, type ScheduleRecord } from './rules.ts'
import { appendDelivery, type ScheduleDriverHandle, type ScheduleService } from './service.ts'
import type { ScheduleTask } from './store.ts'
import { formatInstant } from './time.ts'

/**
 * Delivery: when a reminder is due, its text becomes the user message of a turn in the session it belongs to.
 *
 * A port of DSH's `ScheduleRuntime` (SVC:1493-1648) and its two message templates (SVC:1386-1418), over what heddle
 * has instead of DSH's agent inbox:
 *
 * - DSH writes the message and calls `agent.followup(message)`, which "queues an ordinary follow-up turn and wakes the
 *   driver", then requires `ctx.sessions.flush()` to acknowledge it. Heddle has no inbox, so an **idle** session gets
 *   a new turn whose prompt is the reminder text, and a **busy** one is left until its turn ends — the driver records
 *   that it is waiting and drives again on the session's `turn/completed`. That is DSH's observable order: the
 *   reminder is the next turn, after the one in flight.
 * - The acknowledgement is the **session's own log**: the delivery commits only once the message is found there, as
 *   the team service proves a message landed (`src/team/service.ts`). A delivery that cannot be proven is logged with
 *   DSH's warning text and is not retried until the next drive.
 *
 * Everything else is DSH's: one timer to the earliest active target (clamped, unref'd); a drive at start, on the timer
 * and after every committed management write; a one-shot is its own group and every due recurring task of a session
 * shares one batch message; each recurring task delivers only its **latest** missed occurrence; and each task is
 * committed separately, after the message, so a crash between the two redelivers (at least once).
 */

/** The fixed origin line both templates carry. */
export const SCHEDULED_MESSAGE_FRAMING = 'This is a scheduled message from the user'

/** The source a delivered reminder's user message carries. */
export const SCHEDULE_SOURCE = { kind: 'schedule' } as const

/** Largest delay a Node timer represents without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * How long a reminder waiting on a busy session goes before the driver looks again without being told.
 *
 * The `turn/completed` edge is the normal wake-up; this is the net under it. Heddle's loop appends no event when a
 * turn **throws** (a provider failure surfaced by the Web server, for instance), so a reminder parked behind such a
 * turn would otherwise wait for an unrelated drive. DSH needs no such net because its inbox owns the queued message.
 */
export const BUSY_RECHECK_MS = 60_000

/** The one-shot template (SVC:1393-1401). */
export function renderReminderFraming(record: ScheduleRecord): string {
  return [
    '[SCHEDULE REMINDER]',
    SCHEDULED_MESSAGE_FRAMING,
    `schedule_id_json: ${JSON.stringify(record.id)}`,
    `occurrence_at: ${record.scheduledAt}`,
    `reminder_prompt_json: ${JSON.stringify(record.prompt)}`,
  ].join('\n')
}

/** The recurring template, used even for a batch of one (SVC:1407-1418). */
export function renderRecurringReminderBatchFraming(reminders: readonly { readonly record: ScheduleRecord; readonly occurrenceAt: string }[]): string {
  const payload = reminders.map(({ record, occurrenceAt }) => ({ schedule_id: record.id, occurrence_at: occurrenceAt, reminder_prompt: record.prompt }))
  return ['[SCHEDULE REMINDER BATCH]', SCHEDULED_MESSAGE_FRAMING, `reminders_json: ${JSON.stringify(payload)}`].join('\n')
}

/** What delivery needs from the host: sessions, their busy state, a way to start a turn, and their logs. */
export interface DeliveryHost {
  /** Throw when the session cannot receive a reminder — it is gone, or it is a delegated child's. */
  resolve(sessionId: string): void
  /** Whether the session has a turn in flight right now. */
  isBusy(sessionId: string): boolean
  /** A cursor into the session's log; every event appended later is at or after it. */
  cursor(sessionId: string): number
  /** Start a turn whose user message is `text`, attributed by `source`. Resolves once started, not once finished. */
  startTurn(sessionId: string, text: string, source: typeof SCHEDULE_SOURCE): Promise<void>
  /** Find that user message in the session's own log at or after `cursor`; the proof a delivery needs. */
  find(sessionId: string, cursor: number, text: string): { readonly messageId: string } | undefined
}

/** A timer handle, whatever the injected timer functions return. */
export type TimerHandle = unknown

export interface DriverOptions {
  readonly setTimer?: (callback: () => void, ms: number) => TimerHandle
  readonly clearTimer?: (handle: TimerHandle) => void
  /** Run a callback after the current turn of the event loop; how a `turn/completed` edge is deferred. */
  readonly defer?: (callback: () => void) => void
  /** The recheck delay for reminders waiting on a busy session; {@link BUSY_RECHECK_MS} by default. */
  readonly busyRecheckMs?: number
  readonly warn?: (message: string) => void
}

function defaultSetTimer(callback: () => void, ms: number): TimerHandle {
  const timer = setTimeout(callback, ms)
  timer.unref()
  return timer
}

function defaultClearTimer(handle: TimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** The driver: at most one timer, one drive at a time, every drive inside the service's FIFO. */
export class ScheduleDriver implements ScheduleDriverHandle {
  private readonly service: ScheduleService
  private readonly host: DeliveryHost
  private readonly setTimer: (callback: () => void, ms: number) => TimerHandle
  private readonly clearTimerFn: (handle: TimerHandle) => void
  private readonly defer: (callback: () => void) => void
  private readonly busyRecheckMs: number
  private readonly warn: (message: string) => void
  private timer: TimerHandle | undefined
  private running: Promise<void> | undefined
  private requested = false
  private started = false
  private stopping = false
  /** Sessions whose due reminders wait for the turn in flight to end. */
  private readonly waiting = new Set<string>()

  constructor(service: ScheduleService, host: DeliveryHost, options: DriverOptions = {}) {
    this.service = service
    this.host = host
    this.setTimer = options.setTimer ?? defaultSetTimer
    this.clearTimerFn = options.clearTimer ?? defaultClearTimer
    this.defer = options.defer ?? ((callback) => setImmediate(callback))
    this.busyRecheckMs = options.busyRecheckMs ?? BUSY_RECHECK_MS
    this.warn = options.warn ?? (() => undefined)
    service.attachDriver(this)
  }

  /** Begin delivering: from now on committed writes drive, and the first drive runs at once. Idempotent. */
  start(): void {
    if (this.started || this.stopping) return
    this.started = true
    this.requestDrive()
  }

  /** Whether a session's reminders are waiting for its turn to end. */
  isWaiting(sessionId: string): boolean {
    return this.waiting.has(sessionId)
  }

  /**
   * Recompute the nearest obligation (SVC:1524-1551). A request while a drive runs is folded into one more pass after
   * it, so no edge is lost; refused deliveries are not retried by the pass they failed in.
   */
  requestDrive(): void {
    if (!this.started || this.stopping) return
    this.requested = true
    this.clearTimer()
    if (this.running !== undefined) return
    const run = (async () => {
      while (this.requested && !this.stopping) {
        this.requested = false
        await this.service.serialize(() => this.drive())
      }
    })()
    this.running = run
    run
      .catch((error: unknown) => {
        this.warn(`schedule: dispatch stopped: ${String(error)}`)
      })
      .finally(() => {
        this.running = undefined
        if (this.requested && !this.stopping) this.requestDrive()
      })
  }

  /**
   * A session's turn ended. If its reminders were waiting, drive again — deferred past the current event-loop turn,
   * so the turn registry has settled the turn whose completion this is.
   */
  turnEnded(sessionId: string): void {
    if (!this.waiting.delete(sessionId)) return
    this.defer(() => this.requestDrive())
  }

  /** Resolve once no drive is running and none is requested; what a test or a shutdown waits on. */
  async settled(): Promise<void> {
    while (this.running !== undefined) await this.running.catch(() => undefined)
  }

  /** Stop the timer and drain the drive in flight. */
  async dispose(): Promise<void> {
    this.stopping = true
    this.clearTimer()
    await this.running?.catch(() => undefined)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clearTimerFn(this.timer)
    this.timer = undefined
  }

  /** One drive (SVC:1562-1647), with heddle's busy-session wait. */
  private async drive(): Promise<void> {
    this.clearTimer()
    const failed = new Set<string>()
    const deferred = new Set<string>()
    const handled = new Set<string>()
    const scanNow = this.service.now()
    const due = this.service.tasks().filter((task) => task.status === 'active' && Date.parse(task.record.scheduledAt) <= scanNow)
    for (const task of due) {
      if (this.stopping) return
      if (handled.has(task.record.id)) continue
      const recurring = isRecurringScheduleRecord(task.record)
      const group = recurring ? due.filter((candidate) => candidate.sessionId === task.sessionId && isRecurringScheduleRecord(candidate.record)) : [task]
      for (const member of group) handled.add(member.record.id)
      let admitted = group
      const committed = new Set<string>()
      try {
        this.host.resolve(task.sessionId)
        if (this.host.isBusy(task.sessionId)) {
          /** Heddle's followup: the reminder becomes the session's next turn, once the one in flight ends. */
          this.waiting.add(task.sessionId)
          for (const member of group) deferred.add(member.record.id)
          continue
        }
        this.waiting.delete(task.sessionId)
        const now = this.service.now()
        admitted = group.filter((member) => Date.parse(member.record.scheduledAt) <= now)
        if (admitted.length === 0) continue
        const occurrences = admitted
          .filter((member): member is ScheduleTask & { readonly record: RecurringRecord } => isRecurringScheduleRecord(member.record))
          .map((member) => ({ task: member, occurrence: resolveRecurringOccurrence(member.record, now) as Occurrence }))
        const text = recurring
          ? renderRecurringReminderBatchFraming(occurrences.map(({ task: member, occurrence }) => ({ record: member.record, occurrenceAt: occurrence.occurrenceAt })))
          : renderReminderFraming(task.record)
        const cursor = this.host.cursor(task.sessionId)
        await this.host.startTurn(task.sessionId, text, SCHEDULE_SOURCE)
        const proof = this.host.find(task.sessionId, cursor, text)
        if (proof === undefined) throw new Error('Session persistence did not acknowledge the reminder')
        const deliveredAt = formatInstant(this.service.now())
        if (!recurring) {
          this.service.commitDelivery({
            ...task,
            status: 'inactive',
            ...appendDelivery(task, { scheduledAt: task.record.scheduledAt, deliveredAt, messageId: proof.messageId }, this.service.retention),
          })
          committed.add(task.record.id)
        }
        for (const { task: member, occurrence } of occurrences) {
          this.service.commitDelivery({
            ...member,
            record: { ...member.record, scheduledAt: occurrence.nextScheduledAt ?? occurrence.occurrenceAt },
            status: occurrence.nextScheduledAt === undefined ? 'inactive' : 'active',
            ...appendDelivery(member, { scheduledAt: occurrence.occurrenceAt, deliveredAt, messageId: proof.messageId }, this.service.retention),
          })
          committed.add(member.record.id)
        }
      } catch (error) {
        const pending = admitted.filter((member) => !committed.has(member.record.id))
        const failedAt = this.service.now()
        for (const member of pending) if (Date.parse(member.record.scheduledAt) <= failedAt) failed.add(member.record.id)
        this.warn(`schedule: reminders ${JSON.stringify(pending.map((member) => member.record.id))} were not acknowledged: ${String(error)}`)
      }
    }
    if (this.stopping) return
    /** The earliest active target, leaving out what failed in this drive (DSH) and what waits on a busy session. */
    let next: number | undefined
    for (const task of this.service.tasks()) {
      if (task.status !== 'active' || failed.has(task.record.id) || deferred.has(task.record.id)) continue
      const target = Date.parse(task.record.scheduledAt)
      next = next === undefined ? target : Math.min(next, target)
    }
    if (deferred.size > 0) {
      const recheck = this.service.now() + this.busyRecheckMs
      next = next === undefined ? recheck : Math.min(next, recheck)
    }
    if (next !== undefined) {
      const delay = Math.max(0, Math.min(next - this.service.now(), MAX_TIMER_DELAY_MS))
      this.timer = this.setTimer(() => {
        this.timer = undefined
        this.requestDrive()
      }, delay)
    }
  }
}
