import type { JobEvent, JobRegistry, JobView } from './registry.ts'
import { publicJob, statusLine } from './tools.ts'

/**
 * The completion notice: how a session learns that a job it started has finished without polling for it
 * (`dsh-tool-jobs/lib/index.js:163-179, 262-296`, cited `TOOL:n`).
 *
 * The notice is a user message with source `{kind: 'tool-jobs', form: 'notice', summary}`. With `wakeup` delivery an
 * idle owner is woken by a new turn whose prompt is the notice; a running owner gets it injected into its next step,
 * which in heddle is the session inbox's next-step list (`queueSteer`, DSH's `inject`). Deliveries to one session run
 * one at a time.
 */

/** The notice's source: who wrote the message, and the one-line summary a collapsed row shows. */
export interface NoticeSource {
  readonly kind: 'tool-jobs'
  readonly form: 'notice'
  readonly summary: string
}

/** DSH's summary bound (`dsh-llm` `boundContextSummary`: 120 characters, the last one an ellipsis). */
function boundSummary(summary: string): string {
  return summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`
}

/** `background job <id> (<kind>: <label>) finished [status: <s>[, <detail>]]. Read its output with job_output.` */
export function noticeText(job: JobView): string {
  return `background job ${job.id} (${job.kind}: ${job.label}) finished ${statusLine(publicJob(job))}. Read its output with job_output.`
}

/** `<kind> <label> [status: …]`, bounded (TOOL:160-162). */
export function noticeSource(job: JobView): NoticeSource {
  return { kind: 'tool-jobs', form: 'notice', summary: boundSummary(`${job.kind} ${job.label} ${statusLine(publicJob(job))}`) }
}

/** What delivery needs from its host — the session store, the live-turn registry and the turn starter. */
export interface NoticeHost {
  /** Whether the session still exists; a notice for a session that is gone is dropped. */
  exists(sessionId: string): boolean
  /** Whether a turn is in flight in the session. */
  isRunning(sessionId: string): boolean
  /** Resolves once the session has no turn in flight. */
  whenIdle(sessionId: string): Promise<void>
  /** Put the notice into the session's next-step input and answer the pending message's id. */
  inject(sessionId: string, text: string, source: NoticeSource): string
  /** Whether that pending message is still waiting to be claimed by a step. */
  isPending(sessionId: string, messageId: string): boolean
  /**
   * Start a turn in the session, without waiting for it to finish. With `answerPending` the notice is already in
   * the session's input and the turn claims it rather than writing it again.
   */
  wake(sessionId: string, text: string, source: NoticeSource, options: { readonly answerPending: boolean }): void
  warn(message: string): void
}

export interface NoticeOptions {
  /** `wakeup` (DSH's default) starts a turn for an idle owner; `quiet` only ever injects. */
  readonly completionDelivery?: 'wakeup' | 'quiet'
  /**
   * Wakes per session before a person's message; unset is unbounded (DSH's default). Past the budget a notice is
   * injected without a wake, and no cap text is added.
   */
  readonly maxConsecutiveWakes?: number
}

/** Delivers completion notices for one registry. */
export class NoticeDelivery {
  private readonly host: NoticeHost
  private readonly delivery: 'wakeup' | 'quiet'
  private readonly wakeBudget: number | undefined
  private readonly spentWakes = new Map<string, number>()
  private readonly killedByModel = new Set<string>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(jobs: JobRegistry, host: NoticeHost, options: NoticeOptions = {}) {
    this.host = host
    this.delivery = options.completionDelivery ?? 'wakeup'
    this.wakeBudget = options.maxConsecutiveWakes
    if (this.wakeBudget !== undefined && (!Number.isSafeInteger(this.wakeBudget) || this.wakeBudget < 1)) {
      throw new Error(`jobs: maxConsecutiveWakes (${this.wakeBudget}) must be a whole number of turns`)
    }
    this.unsubscribe = jobs.subscribe((event) => this.onEvent(event))
  }

  /** The model asked this job to stop with `job_kill`; its settle sends no notice. */
  markModelKill(id: string): void {
    this.killedByModel.add(id)
  }

  /** A person wrote in the session: the wake count starts again (DSH resets it on a claimed user message). */
  resetWakes(sessionId: string): void {
    this.spentWakes.delete(sessionId)
  }

  /** Deliveries in flight or queued, settled; for tests and teardown. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()])
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  /**
   * No notice when the model killed the job itself, when a waiter collected the settle, on teardown, for an unowned
   * job, or when the owner is gone (TOOL:263-271). A person's kill still notifies.
   */
  private onEvent(event: JobEvent): void {
    if (event.type === 'removed') {
      this.killedByModel.delete(event.job.id)
      return
    }
    if (event.type !== 'settled') return
    if (this.killedByModel.delete(event.job.id) || event.awaited || event.cause === 'teardown' || event.job.owner === undefined) return
    const owner = event.job.owner
    const job = event.job
    this.enqueue(owner, () => this.deliverNow(owner, job))
  }

  private enqueue(sessionId: string, task: () => void | Promise<void>): void {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const tail = previous.then(task).then(
      () => undefined,
      (error: unknown) => this.host.warn(`jobs: a completion notice for session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`),
    )
    this.tails.set(sessionId, tail)
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    })
  }

  /** Spend one wake if the budget allows it. */
  private spendWake(sessionId: string): boolean {
    if (this.wakeBudget === undefined) return true
    const spent = this.spentWakes.get(sessionId) ?? 0
    if (spent >= this.wakeBudget) return false
    this.spentWakes.set(sessionId, spent + 1)
    return true
  }

  private deliverNow(owner: string, job: JobView): void {
    if (this.disposed || !this.host.exists(owner)) return
    const text = noticeText(job)
    const source = noticeSource(job)
    if (this.delivery === 'wakeup' && !this.host.isRunning(owner) && this.spendWake(owner)) {
      this.host.wake(owner, text, source, { answerPending: false })
      return
    }
    const pending = this.host.inject(owner, text, source)
    /**
     * A running turn takes injected input at its next step, and asks once more before it ends; a notice written in
     * the gap after that last look would wait for the next person. So, as heddle's background-subagent notice does,
     * the deliverer waits for the session to go idle and answers a notice still pending with a turn of its own. The
     * wait runs outside the session's queue, so later notices still reach the running turn.
     */
    if (this.delivery === 'wakeup' && this.host.isRunning(owner)) {
      void this.host.whenIdle(owner).then(() =>
        this.enqueue(owner, () => {
          if (this.disposed || !this.host.exists(owner)) return
          if (this.host.isRunning(owner) || !this.host.isPending(owner, pending)) return
          if (this.spendWake(owner)) this.host.wake(owner, text, source, { answerPending: true })
        }),
      )
    }
  }
}
