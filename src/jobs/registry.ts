import { randomUUID } from 'node:crypto'

import { OutputRing, type AppendOptions, type JobChunk, type RingRead } from './ring.ts'

/**
 * The background-job substrate: DSH's `ctx.jobs` (`dsh-jobs` contract, `dsh-jobs-local` provider), in memory.
 *
 * A producer — background `bash` today, anything with a non-empty kind later — registers work with `start`, gets a
 * handle to append output and progress through, and hands back `cancel` and a `done` promise. The registry owns the
 * job's state, its bounded output ring, the model's read cursor, ownership, and the lifecycle facts other layers
 * react to (the completion notice, the page's job list). Jobs live in memory, die with the process, and are not
 * resumed, as in DSH.
 *
 * Citations are `LOCAL:n` for `dsh-jobs-local/lib/index.js` and `TYPES` for `dsh-jobs/lib/types/*.d.ts`.
 */

/** DSH's five statuses (TYPES view.d.ts:15). Registration sets `running`; a kill or a teardown sets `stopping`. */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** What ended a job: its producer, a kill, or a teardown (TYPES types.d.ts:20-60). */
export type SettleCause = 'producer' | 'kill' | 'teardown'

/** The tool call that started a job: heddle has no programmatic sub-calls, so both ids are the model's call id. */
export interface JobToolCall {
  readonly callId: string
  readonly rootCallId: string
}

/** A fresh read-only projection of one job (TYPES view.d.ts:54-93). There is no exit-code field; it lives in `detail`. */
export interface JobView {
  readonly id: string
  readonly kind: string
  readonly label: string
  /** The owning session's id; absent for an unowned job, which every caller may reach. */
  readonly owner?: string
  readonly outputLimitBytes?: number
  readonly status: JobStatus
  /** The live progress line; cleared at settle. */
  readonly progress?: string
  /** The terminal reason, with any kill reason merged in as `<detail>; <reason>`. */
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly output: { readonly total: number; readonly earliest: number; readonly spillPaths?: readonly string[] }
}

/** What a producer writes through while its work runs. */
export interface JobHandle {
  readonly id: string
  append(text: string, options?: AppendOptions): void
  updateProgress(line: string): void
}

/** A producer's terminal report. `done` must resolve with one and must not reject. */
export interface JobOutcome {
  readonly status: 'completed' | 'killed' | 'failed'
  readonly detail?: string
  /** A final-output job's result, handed to the first consuming read after settle. */
  readonly result?: string
}

/** What `run` hands back: a synchronous, idempotent cancel, and the end of the work. */
export interface JobHooks {
  cancel(reason?: string): void
  readonly done: Promise<JobOutcome>
}

/** One pull read: the text from `fromByte`, the next offset, and whether bytes before it were lost. */
export interface PullRead {
  readonly text: string
  readonly nextOffset: number
  readonly lossy: boolean
  readonly spillPath?: string
}

/** A stream the registry drains on its own clock instead of the producer pushing (DSH's pull sources). */
export interface PullSource {
  readonly channel?: AppendOptions['channel']
  read(fromByte: number): PullRead
}

/** A producer's registration (TYPES types.d.ts:166-200). */
export interface JobSpec {
  readonly kind: string
  readonly label: string
  /** The owning session's id. It must exist in the session store. */
  readonly owner?: string
  readonly toolCall?: JobToolCall
  readonly outputLimitBytes?: number
  /** Streams drained every `pumpPollMs`, then once more before the job settles. */
  readonly output?: readonly PullSource[]
  run(handle: JobHandle): JobHooks
}

/** The consuming read: the delta since the model's cursor, the result once, and the job. */
export interface JobRead {
  readonly chunks: readonly JobChunk[]
  readonly lossy: boolean
  readonly result?: string
  readonly job: JobView
}

/** The in-memory event stream: lifecycle changes and output advances, for notices and the page. */
export type JobEvent =
  | { readonly type: 'registered'; readonly job: JobView }
  | { readonly type: 'progress'; readonly job: JobView }
  | { readonly type: 'stopping'; readonly job: JobView }
  | { readonly type: 'settled'; readonly job: JobView; readonly cause: SettleCause; readonly awaited: boolean }
  | { readonly type: 'removed'; readonly job: JobView }
  | { readonly type: 'output'; readonly id: string; readonly owner?: string; readonly total: number }

/**
 * A refusal with a stable code beside DSH's message.
 *
 * The message is DSH's text, adapted only where it names a DSH package; the code is heddle's, so a tool result and a
 * route can carry heddle's `{code, message}` shape. The codes are listed in `INDEX.md`.
 */
export class JobError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'JobError'
    this.code = code
  }
}

/** The facts the registry needs from its host, so it can be tested without a Context. */
export interface JobRegistryOptions {
  /**
   * Whether a session id names a session that exists. Absent means no session store is reachable, and an owned
   * registration is refused with DSH's "ownership requires the agent registry" sentence, adapted.
   */
  readonly sessionExists?: (sessionId: string) => boolean
  /** Append one lifecycle event to an owned job's session log. A throw is reported and swallowed (LOCAL:616-624). */
  readonly record?: (sessionId: string, type: 'job/registered' | 'job/settled', data: Record<string, unknown>) => void
  readonly warn?: (message: string) => void
  /** Active (running + stopping) jobs one owner may hold; DSH's default is 10. */
  readonly maxConcurrentJobsPerOwner?: number
  /** Live ring retention per job, in UTF-8 bytes; DSH's default is 262144. */
  readonly retainBytes?: number
  /** Ring retention kept after settlement, in UTF-8 bytes; DSH's default is 16384. */
  readonly settledRetainBytes?: number
  /** Pull-source poll interval; DSH's default is 150 ms. */
  readonly pumpPollMs?: number
  /** The 32-hex-digit randomness an id is cut from; a test replaces it to force a collision. */
  readonly randomHex?: () => string
}

/** DSH's defaults (LOCAL:339-346). */
export const DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER = 10
export const DEFAULT_RETAIN_BYTES = 256 * 1024
export const DEFAULT_SETTLED_RETAIN_BYTES = 16 * 1024
export const DEFAULT_PUMP_POLL_MS = 150

/** True for the three terminal statuses. */
export function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

interface JobRecord {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly owner: string | undefined
  readonly toolCall: JobToolCall | undefined
  readonly outputLimitBytes: number | undefined
  readonly cancel: (reason?: string) => void
  readonly ring: OutputRing
  readonly state: { progress: string | undefined; job: JobRecord | undefined }
  status: JobStatus
  modelCursor: number
  resultDelivered: boolean
  detail: string | undefined
  result: string | undefined
  readonly startedAt: number
  finishedAt: number | undefined
  killReason: string | undefined
  settleCause: SettleCause | undefined
  readonly settled: Promise<void>
  readonly markSettled: () => void
  readonly waitResolvers: Set<() => void>
  pump: { readonly done: Promise<void> } | undefined
  readonly spillPaths: (string | undefined)[]
}

/**
 * Drain every source in order, sleep `pollMs` or until `until` settles, repeat, then drain once more (DSH's
 * `startPump`, LOCAL:120-161). A lossy read lands as a `gapBefore` chunk so the discontinuity stays visible.
 */
function startPump(
  sources: readonly PullSource[],
  sink: { append(text: string, options?: AppendOptions): void; spill(index: number, path: string | undefined): void },
  pollMs: number,
  until: Promise<unknown>,
): { readonly done: Promise<void> } {
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`invalid pump pollMs: expected a positive finite number of milliseconds, got ${JSON.stringify(pollMs)}`)
  }
  const states = sources.map((source) => ({ source, cursor: 0 }))
  const drain = (): void => {
    for (const [index, state] of states.entries()) {
      const read = state.source.read(state.cursor)
      state.cursor = read.nextOffset
      sink.spill(index, read.spillPath)
      if (read.text.length === 0) continue
      if (state.source.channel === undefined && !read.lossy) sink.append(read.text)
      else
        sink.append(read.text, {
          ...(state.source.channel !== undefined ? { channel: state.source.channel } : {}),
          ...(read.lossy ? { gapBefore: true } : {}),
        })
    }
  }
  return {
    done: (async () => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let wake: (() => void) | undefined
      const finish = (): void => {
        settled = true
        clearTimeout(timer)
        wake?.()
      }
      until.then(finish, finish)
      while (!settled) {
        drain()
        await new Promise<void>((resolve) => {
          wake = resolve
          timer = setTimeout(resolve, pollMs)
        })
        wake = undefined
        timer = undefined
      }
      drain()
    })(),
  }
}

/**
 * The in-memory job registry. Every call that reads or controls a job takes the caller's session id; an owned job is
 * reachable only by its owner, an unowned one by everyone (LOCAL:564-577).
 */
export class JobRegistry {
  readonly maxConcurrentJobsPerOwner: number
  readonly retainBytes: number
  readonly settledRetainBytes: number
  readonly pumpPollMs: number
  private readonly options: JobRegistryOptions
  private readonly store = new Map<string, JobRecord>()
  private readonly listeners = new Set<(event: JobEvent) => void>()
  private controllers = 0
  private disposed = false

  constructor(options: JobRegistryOptions = {}) {
    this.options = options
    this.maxConcurrentJobsPerOwner = options.maxConcurrentJobsPerOwner ?? DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER
    this.retainBytes = options.retainBytes ?? DEFAULT_RETAIN_BYTES
    this.settledRetainBytes = options.settledRetainBytes ?? DEFAULT_SETTLED_RETAIN_BYTES
    this.pumpPollMs = options.pumpPollMs ?? DEFAULT_PUMP_POLL_MS
  }

  /**
   * Declare that something collects and stops these jobs — the job tools. DSH refuses a registration no controller
   * serves (LOCAL:414), because a job nobody can read or kill is a leak; the jobs row attaches one with its tools.
   */
  attachController(_name: string): () => void {
    this.controllers += 1
    let attached = true
    return () => {
      if (!attached) return
      attached = false
      this.controllers -= 1
    }
  }

  /** Listen to every lifecycle and output event; answers the unsubscribe. A throwing listener is reported, not fatal. */
  subscribe(listener: (event: JobEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Register one job and answer its id.
   *
   * The preflight runs in DSH's order (LOCAL:412-419, 537-544): the owner, a controller, the kind, the label, the
   * output limit, then the per-owner cap.
   */
  start(spec: JobSpec): string {
    if (this.disposed) throw new JobError('JOB_DISPOSED', 'jobs service disposed')
    const owner = spec.owner
    if (owner !== undefined) {
      if (this.options.sessionExists === undefined) {
        throw new JobError('JOB_OWNER_UNAVAILABLE', 'background job ownership requires the session store (load the session row)')
      }
      if (!this.options.sessionExists(owner)) {
        throw new JobError('JOB_OWNER_UNAVAILABLE', `session "${owner}" has no live agent (background job owner must be live)`)
      }
    }
    if (this.controllers === 0) {
      throw new JobError(
        'JOB_UNAVAILABLE',
        'background jobs unavailable: no job controller serves this agent (load the jobs row, src/plugins/jobs.ts, in its composition)',
      )
    }
    if (typeof spec.kind !== 'string' || spec.kind.length === 0) throw new JobError('JOB_INVALID_ARGS', 'invalid job kind: expected a non-empty string')
    if (typeof spec.label !== 'string' || spec.label.length === 0) throw new JobError('JOB_INVALID_ARGS', 'invalid job label: expected a non-empty string')
    if (spec.outputLimitBytes !== undefined && (!Number.isSafeInteger(spec.outputLimitBytes) || spec.outputLimitBytes <= 0)) {
      throw new JobError('JOB_INVALID_ARGS', `invalid outputLimitBytes: expected a positive safe integer, got ${JSON.stringify(spec.outputLimitBytes)}`)
    }
    if (this.activeJobCount(owner) >= this.maxConcurrentJobsPerOwner) {
      throw new JobError(
        'JOB_LIMIT',
        `background job limit reached for this owner (limit: ${this.maxConcurrentJobsPerOwner}); use job_kill to stop an unneeded job, wait for it to finish, then retry`,
      )
    }

    const randomHex = this.options.randomHex ?? (() => randomUUID().replaceAll('-', ''))
    let id: string
    do id = `${spec.kind}-${randomHex().slice(0, 16)}`
    while (this.store.has(id))

    const ring = new OutputRing()
    const state: JobRecord['state'] = { progress: undefined, job: undefined }
    const handle: JobHandle = {
      id,
      append: (text, options) => this.appendRing(state, ring, text, options, 'producer'),
      updateProgress: (line) => this.updateProgress(state, line),
    }
    const hooks = spec.run(handle)
    let markSettled: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve
    })
    const job: JobRecord = {
      id,
      kind: spec.kind,
      label: spec.label,
      owner,
      toolCall: spec.toolCall === undefined ? undefined : { ...spec.toolCall },
      outputLimitBytes: spec.outputLimitBytes,
      cancel: hooks.cancel.bind(hooks),
      ring,
      state,
      status: 'running',
      modelCursor: 0,
      resultDelivered: false,
      detail: undefined,
      result: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      killReason: undefined,
      settleCause: undefined,
      settled,
      markSettled,
      waitResolvers: new Set(),
      pump: undefined,
      spillPaths: [],
    }
    state.job = job
    this.store.set(id, job)
    this.recordSessionEvent(job)
    this.emit({ type: 'registered', job: this.view(job) })

    const producerDone = hooks.done.then(
      (outcome) => ({ outcome, producerReported: true }),
      (error: unknown) => {
        this.warn(`jobs: job ${job.id} producer done promise rejected (producer contract violation): ${String(error)}`)
        return { outcome: { status: 'failed', detail: String(error) } as JobOutcome, producerReported: false }
      },
    )
    if (spec.output !== undefined && spec.output.length > 0) {
      job.pump = startPump(
        spec.output.map((source) => this.guardSource(job, source)),
        {
          append: (text, options) => this.appendRing(state, ring, text, options, 'pump'),
          spill: (index, path) => {
            job.spillPaths[index] = path
          },
        },
        this.pumpPollMs,
        Promise.race([producerDone, settled]),
      )
    }
    void producerDone.then(async ({ outcome, producerReported }) => {
      if (job.pump !== undefined) await job.pump.done
      this.settle(job, outcome, job.settleCause ?? 'producer', producerReported)
    })
    return id
  }

  /** The caller's jobs plus the unowned ones, in registration order. */
  list(caller: string | undefined): readonly JobView[] {
    return [...this.store.values()].filter((job) => job.owner === undefined || job.owner === caller).map((job) => this.view(job))
  }

  /** One job's view; moves nothing. */
  get(id: string, caller: string | undefined): JobView {
    return this.view(this.expect(id, caller))
  }

  /**
   * The one **consuming** read: the delta since the model's cursor, which then moves to the end. The result rides the
   * first read after settle, once. A read of a settled job drops its ring to the settled cap (LOCAL:631-643).
   */
  read(id: string, caller: string | undefined): JobRead {
    const job = this.expect(id, caller)
    const read = job.ring.readFrom(job.modelCursor)
    job.modelCursor = job.ring.total
    const result = isTerminal(job.status) && !job.resultDelivered ? job.result : undefined
    if (result !== undefined) job.resultDelivered = true
    if (isTerminal(job.status)) job.ring.trim(this.settledRetainBytes)
    return { chunks: read.chunks, lossy: read.lossy, ...(result !== undefined ? { result } : {}), job: this.view(job) }
  }

  /** A **non-consuming** read from an absolute offset: the page's follow, which never moves the model's cursor. */
  readAt(id: string, from: number, caller: string | undefined): RingRead {
    const job = this.expect(id, caller)
    if (!Number.isSafeInteger(from) || from < 0) {
      throw new JobError('JOB_INVALID_ARGS', `invalid output read offset: expected a non-negative safe integer, got ${JSON.stringify(from)}`)
    }
    return job.ring.readFrom(from)
  }

  /**
   * Ask a job to stop, and answer at once.
   *
   * The producer's cancel runs first; if it throws, nothing changes and the error propagates. Otherwise the job is
   * `stopping`, the reason is kept for the settle, and the cause is `kill` (LOCAL:644-655). The job settles when its
   * work actually ends.
   */
  kill(id: string, caller: string | undefined, reason?: string): 'requested' | 'already-finished' {
    return this.killJob(this.expect(id, caller), reason)
  }

  /**
   * Wait until the job settles or `timeoutMs` passes, then answer its view. A timeout is not an error and leaves the
   * job running; an abort while it is live is `wait aborted` (LOCAL:656-689).
   */
  async wait(id: string, timeoutMs: number, caller: string | undefined, signal?: AbortSignal): Promise<JobView> {
    const job = this.expect(id, caller)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new JobError('JOB_INVALID_ARGS', `invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`)
    }
    if (!isTerminal(job.status)) {
      if (signal?.aborted === true) throw new JobError('JOB_WAIT_ABORTED', 'wait aborted')
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          job.waitResolvers.delete(onSettled)
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }
        const onSettled = (): void => {
          cleanup()
          resolve()
        }
        const onAbort = (): void => {
          cleanup()
          reject(new JobError('JOB_WAIT_ABORTED', 'wait aborted'))
        }
        const timer = setTimeout(() => {
          cleanup()
          resolve()
        }, timeoutMs)
        job.waitResolvers.add(onSettled)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    return this.view(job)
  }

  /** Forget a settled job. A live one is refused with DSH's sentence. */
  remove(id: string, caller: string | undefined): void {
    const job = this.expect(id, caller)
    if (!isTerminal(job.status)) throw new JobError('JOB_LIVE', `job ${id} is still ${job.status}; kill it and wait for settlement before removing it`)
    this.drop([job])
  }

  /**
   * Kill every live job one session owns, with one reason — DSH kills an archived session's jobs with
   * `session archived` (`dsh-jobs/lib/index.js:19-43`). Answers the ids asked to stop.
   */
  killOwnedBy(sessionId: string, reason: string): readonly string[] {
    const killed: string[] = []
    for (const job of this.store.values()) {
      if (job.owner !== sessionId || isTerminal(job.status)) continue
      try {
        if (this.killJob(job, reason) === 'requested') killed.push(job.id)
      } catch (error) {
        this.warn(`jobs: cancel of ${job.id} threw: ${String(error)}`)
      }
    }
    return killed
  }

  /**
   * Cancel every live job with `jobs service disposed`, wait for each to settle, and drop every record
   * (LOCAL:831-839). A cancel that throws force-fails its record rather than stalling the teardown.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const all = [...this.store.values()]
    this.cancelForTeardown(all, 'jobs service disposed')
    await Promise.all(all.map((job) => job.settled))
    this.drop(all)
  }

  private warn(message: string): void {
    this.options.warn?.(message)
  }

  private activeJobCount(owner: string | undefined): number {
    let count = 0
    for (const job of this.store.values()) if (job.owner === owner && (job.status === 'running' || job.status === 'stopping')) count += 1
    return count
  }

  private expect(id: string, caller: string | undefined): JobRecord {
    const job = this.store.get(id)
    if (job === undefined) throw new JobError('JOB_UNKNOWN', `unknown job ${id}`)
    if (job.owner !== undefined && job.owner !== caller) throw new JobError('JOB_FOREIGN', `job ${job.id} belongs to another session`)
    return job
  }

  private view(job: JobRecord): JobView {
    const spillPaths = [...new Set(job.spillPaths.filter((path): path is string => path !== undefined))]
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ...(job.owner !== undefined ? { owner: job.owner } : {}),
      ...(job.outputLimitBytes !== undefined ? { outputLimitBytes: job.outputLimitBytes } : {}),
      status: job.status,
      ...(job.state.progress !== undefined ? { progress: job.state.progress } : {}),
      ...(job.detail !== undefined ? { detail: job.detail } : {}),
      startedAt: job.startedAt,
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      output: { total: job.ring.total, earliest: job.ring.earliest, ...(spillPaths.length > 0 ? { spillPaths } : {}) },
    }
  }

  private emit(event: JobEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.warn(`jobs: an event listener threw on ${event.type}: ${String(error)}`)
      }
    }
  }

  /** The two session-log events, for owned jobs only, with DSH's fields (LOCAL:604-625). */
  private recordSessionEvent(job: JobRecord, settlement?: Record<string, unknown>): void {
    if (job.owner === undefined || this.options.record === undefined) return
    const data = {
      jobId: job.id,
      owner: job.owner,
      kind: job.kind,
      label: job.label,
      startedAt: job.startedAt,
      ...(job.toolCall !== undefined ? { toolCall: job.toolCall } : {}),
    }
    try {
      if (settlement === undefined) this.options.record(job.owner, 'job/registered', data)
      else this.options.record(job.owner, 'job/settled', { ...data, ...settlement })
    } catch (error) {
      this.warn(`jobs: failed to record lifecycle for ${job.id}: ${String(error)}`)
    }
  }

  private killJob(job: JobRecord, reason: string | undefined): 'requested' | 'already-finished' {
    if (isTerminal(job.status)) return 'already-finished'
    job.cancel(reason)
    job.status = 'stopping'
    if (reason !== undefined) job.killReason = reason
    job.settleCause = 'kill'
    this.emit({ type: 'stopping', job: this.view(job) })
    return 'requested'
  }

  /**
   * Append to the ring. A producer's chunk against a settled job is reported and dropped; the pump's is dropped
   * silently. A chunk written inside `run`, before registration commits, is kept and signals nobody (LOCAL:697-705).
   */
  private appendRing(state: JobRecord['state'], ring: OutputRing, text: string, options: AppendOptions | undefined, writer: 'producer' | 'pump'): void {
    const job = state.job
    if (job !== undefined && isTerminal(job.status)) {
      if (writer === 'producer') this.warn(`jobs: append to settled job ${job.id} dropped`)
      return
    }
    if (!ring.append(text, options, this.retainBytes)) return
    if (job !== undefined) this.emitOutput(job)
  }

  /** A failing pull source is reported once and reads as exhausted from then on (LOCAL:711-734). */
  private guardSource(job: JobRecord, source: PullSource): PullSource {
    let failed = false
    return {
      ...(source.channel !== undefined ? { channel: source.channel } : {}),
      read: (fromByte) => {
        if (failed) return { text: '', nextOffset: fromByte, lossy: false }
        try {
          return source.read(fromByte)
        } catch (error) {
          failed = true
          this.warn(`jobs: output source for ${job.id} failed; its stream stops here: ${String(error)}`)
          return { text: '', nextOffset: fromByte, lossy: false }
        }
      },
    }
  }

  private emitOutput(job: JobRecord): void {
    this.emit({ type: 'output', id: job.id, ...(job.owner !== undefined ? { owner: job.owner } : {}), total: job.ring.total })
  }

  private updateProgress(state: JobRecord['state'], line: string): void {
    const job = state.job
    if (job !== undefined && isTerminal(job.status)) {
      this.warn(`jobs: progress update on settled job ${job.id} dropped`)
      return
    }
    state.progress = line
    if (job !== undefined) this.emit({ type: 'progress', job: this.view(job) })
  }

  /**
   * Record the first terminal outcome (LOCAL:769-796): first-wins; a kill reason merged into the detail; progress
   * cleared and the finish time set; `job/settled` logged; the ring trimmed to what the model has not read (at least
   * the settled cap); waiters released; then `settled`, carrying whether a waiter collected it.
   */
  private settle(job: JobRecord, outcome: JobOutcome, cause: SettleCause, producerReported: boolean): void {
    if (isTerminal(job.status)) return
    job.status = outcome.status
    if (outcome.status === 'killed' && job.killReason !== undefined) {
      job.detail = outcome.detail !== undefined ? `${outcome.detail}; ${job.killReason}` : job.killReason
    } else if (outcome.detail !== undefined) job.detail = outcome.detail
    job.state.progress = undefined
    job.result = outcome.result
    job.finishedAt = Date.now()
    this.recordSessionEvent(job, {
      finishedAt: job.finishedAt,
      status: outcome.status,
      cause,
      producerReported,
      ...(job.detail !== undefined ? { detail: job.detail } : {}),
    })
    job.ring.trim(Math.max(this.settledRetainBytes, job.ring.total - job.modelCursor))
    const waitResolvers = [...job.waitResolvers]
    job.waitResolvers.clear()
    for (const resolveWait of waitResolvers) resolveWait()
    job.markSettled()
    this.emit({ type: 'settled', job: this.view(job), cause, awaited: waitResolvers.length > 0 })
    this.emitOutput(job)
  }

  private drop(jobs: readonly JobRecord[]): void {
    for (const job of jobs) {
      if (!this.store.delete(job.id)) continue
      this.emit({ type: 'removed', job: this.view(job) })
    }
  }

  private cancelForTeardown(jobs: readonly JobRecord[], reason: string): void {
    for (const job of jobs) {
      if (isTerminal(job.status)) continue
      job.settleCause = 'teardown'
      try {
        job.cancel(reason)
        job.status = 'stopping'
        this.emit({ type: 'stopping', job: this.view(job) })
      } catch (error) {
        this.warn(`jobs: cancel of ${job.id} threw during teardown; job record forced failed and work may be orphaned: ${String(error)}`)
        this.settle(job, { status: 'failed', detail: `cancel threw during teardown; work may be orphaned: ${String(error)}` }, 'teardown', false)
      }
    }
  }
}
