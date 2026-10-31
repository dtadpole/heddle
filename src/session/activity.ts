/**
 * The running work that keeps a session from being archived quietly — DSH's `workspace/session-activity`.
 *
 * DSH refuses a plain `workspace/archiveSession` while a session has work in flight and names that work by family
 * (`dsh-workspace` `archiveSession`, `WorkspaceActiveSessionError.activity`, `lib/index.js:527-541`):
 *
 * - `{ kind: 'turn' }` from `dsh-agent` when the session's own turn is running;
 * - `{ kind: 'job', items }` from `dsh-jobs` for the running or stopping background jobs the session owns;
 * - `{ kind: 'subagent', items }` from `dsh-subagent` for its running subagent descendants, found by durable lineage —
 *   a child whose record names its parent **and** carries the subagent origin, at any depth (a fork shares the lineage
 *   field without the origin and is an independent conversation, so it never holds its source);
 * - `{ kind: 'schedule', items }` from `dsh-schedule` for its active reminders, each labelled by its title.
 *
 * The sidebar lists exactly this in its stop-and-archive dialog, one family per line, in the order received.
 *
 * **The order is DSH's listener order.** `workspace/session-activity` is a Cordis waterfall: listeners run in
 * registration order (`cordis/lib/index.js:317-325`, pushed at `:335-345`), and each computes its own family, awaits
 * `next()` and returns `[own, ...rest]`, so the first registered family comes first. The four register:
 *
 * 1. `turn` in the Agent registry's constructor (`dsh-agent/lib/index.js:26-37`, installed at `:358`; the class
 *    injects nothing);
 * 2. `job` in the job registry seam's constructor (`dsh-jobs/lib/index.js:19-43`, installed at `:119`; the local
 *    registry, `dsh-jobs-local/lib/index.js:356-391`, injects nothing either, and its row follows `agent` in
 *    `dsh-base/cordis.patch.yml:82-97`);
 * 3. `subagent` inside `ctx.inject(['agents'], …)` of the Subagent service (`dsh-subagent/lib/index.js:2510-2529`,
 *    installed at `:3014-3016`; the service itself injects `workingDirectory`, `:2982`), so only once the Agent
 *    registry — whose constructor already registered `turn` — is up;
 * 4. `schedule` in the Schedule service's constructor effect (`dsh-schedule/lib/index.js:2043-2064`), whose service
 *    injects `agents`, `sessions`, `storageDomain`, `sessionController` and `sessionPersistence` (`:1969-1975`).
 *
 * A fiber starts one microtask after it is asked (`cordis/lib/index.js:1349-1356`), so a constructor finishes before
 * any dependant starts: turn before subagent and schedule is fixed, and job, with nothing to wait for, precedes both.
 * Turn against job is which of two dependency-free rows finishes importing first; the loader starts every row at once,
 * in row order (`cordis-plugin-loader/lib/index.js:87-92`, `:451-463`), and `agent` is the earlier row. DSH's own type
 * comment lists the shipped providers the same way — "`turn` (the Agent registry), `job` (the job registry seam),
 * `subagent` (the Subagent runtime), and `schedule` (the Schedule plugin)" (`dsh-workspace/lib/types/types.d.ts:28-35`).
 * The order is read from the code, not observed in a running DSH.
 *
 * Heddle reads the turn and the lineage here, and takes the other two families from their rows: the reminders from
 * the schedule row's public `list` and `stopSessionTasks` (`src/schedule/service.ts`, DSH's `list({sessionId})` and
 * `stopSessionTasks`, `dsh-schedule/lib/index.js:2273-2292`), and the jobs slot from the jobs row's own archive
 * admission.
 */

/** A family's kind, as DSH spells it. */
export type ActivityKind = 'turn' | 'job' | 'subagent' | 'schedule'

/** One item of a counted family: its id, and its label when it has one. */
export interface ActivityItem {
  readonly id: string
  readonly label?: string
}

/** One family of running work, in DSH's shape: the kind, and for a counted family its items. */
export interface ActivityEntry {
  readonly kind: ActivityKind
  readonly items?: readonly ActivityItem[]
}

/** What the lineage walk reads of a session record. */
export interface LineageMeta {
  readonly id: string
  readonly title?: string
  readonly parentSession?: string
  readonly origin?: string
}

/**
 * The families the session's other rows report, already read: its live background jobs (DSH's `runningJobs`) and its
 * active reminders. An absent or empty family is not reported.
 */
export interface RowActivity {
  readonly jobs?: readonly ActivityItem[]
  readonly schedules?: readonly ActivityItem[]
}

/**
 * The session's running work, in DSH's listener order: its turn, its live jobs, its running subagent descendants, its
 * active reminders.
 *
 * `running` answers whether one session has a turn in flight in this process. The walk is breadth-first from the
 * session and visits each id once, so a damaged chain that loops cannot hang it. A child's label is its title when it
 * has one (DSH labels a child by its creation label and falls back to the id).
 */
export function sessionActivity(sessionId: string, metas: readonly LineageMeta[], running: (id: string) => boolean, rows: RowActivity = {}): ActivityEntry[] {
  const childrenOf = new Map<string, LineageMeta[]>()
  for (const meta of metas) {
    if (meta.parentSession === undefined || meta.origin !== 'subagent') continue
    const siblings = childrenOf.get(meta.parentSession) ?? []
    siblings.push(meta)
    childrenOf.set(meta.parentSession, siblings)
  }
  const subagents: LineageMeta[] = []
  const pending = [sessionId]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const parent = pending.shift() as string
    if (visited.has(parent)) continue
    visited.add(parent)
    for (const child of childrenOf.get(parent) ?? []) {
      if (running(child.id)) subagents.push(child)
      pending.push(child.id)
    }
  }
  const activity: ActivityEntry[] = []
  if (running(sessionId)) activity.push({ kind: 'turn' })
  if (rows.jobs !== undefined && rows.jobs.length > 0) activity.push({ kind: 'job', items: rows.jobs })
  if (subagents.length > 0) {
    activity.push({
      kind: 'subagent',
      items: subagents.map((child) => ({ id: child.id, ...(child.title !== undefined && child.title.length > 0 ? { label: child.title } : {}) })),
    })
  }
  if (rows.schedules !== undefined && rows.schedules.length > 0) activity.push({ kind: 'schedule', items: rows.schedules })
  return activity
}

/**
 * The sessions a stop-and-archive stops: the session itself and every running subagent the activity named. A job's or
 * a reminder's id names no session; those families are stopped by their own rows.
 */
export function activitySessions(sessionId: string, activity: readonly ActivityEntry[]): string[] {
  const ids = [sessionId]
  for (const entry of activity) {
    if (entry.kind !== 'subagent') continue
    for (const item of entry.items ?? []) if (!ids.includes(item.id)) ids.push(item.id)
  }
  return ids
}

/**
 * The refusal's sentence: what blocks the archive, and that `stop: true` stops it. A turn or a subagent is the session
 * running; with neither, the sentence names the row's work instead (the jobs sentence is the jobs row's own).
 * `heddle_session::refusal_sentence` says the same.
 */
export function refusalSentence(sessionId: string, activity: readonly ActivityEntry[]): string {
  const kinds = new Set(activity.map((entry) => entry.kind))
  if (kinds.has('turn') || kinds.has('subagent')) return `session ${sessionId} is running; pass stop: true to stop it and archive`
  if (kinds.has('job')) return `session ${sessionId} has running background jobs; pass stop: true to stop them and archive`
  return `session ${sessionId} has active scheduled reminders; pass stop: true to stop them and archive`
}

/** What the schedule family reads of the schedule row: `ScheduleService`'s public `list` and `stopSessionTasks`. */
export interface ScheduleSource {
  list(request: { readonly sessionId: string }): Promise<readonly { readonly id: string; readonly title: string }[]>
  stopSessionTasks(sessionId: string): Promise<void>
}

/**
 * The session's active reminders as the `schedule` family's items, each labelled by its title — DSH's
 * `{ id: record.id, label: record.title }` over `list({ sessionId })` (`dsh-schedule/lib/index.js:2044-2055`). Empty
 * without the schedule row.
 */
export async function scheduleActivity(schedule: ScheduleSource | undefined, sessionId: string): Promise<ActivityItem[]> {
  if (schedule === undefined) return []
  return (await schedule.list({ sessionId })).map((record) => ({ id: record.id, label: record.title }))
}

/**
 * Stop the session's reminders because it is archived with its work — DSH's `workspace/session-stop` listener,
 * `await this.stopSessionTasks(sessionId)` (`dsh-schedule/lib/index.js:2056-2058`), which removes every active task
 * of the session inside the service's queue. A failure is reported, never a reason to keep the session visible, as
 * the registry's `stopSessionActivity` logs it (`dsh-workspace/lib/index.js:621-628`).
 */
export async function stopSessionSchedules(schedule: ScheduleSource | undefined, sessionId: string, warn: (message: string) => void): Promise<void> {
  if (schedule === undefined) return
  try {
    await schedule.stopSessionTasks(sessionId)
  } catch (error) {
    warn(`workspace: stopping session '${sessionId}' for archive failed: ${String(error)}`)
  }
}
