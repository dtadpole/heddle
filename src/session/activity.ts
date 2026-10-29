/**
 * The running work that keeps a session from being archived quietly — DSH's `workspace/session-activity`.
 *
 * DSH refuses a plain `workspace/archiveSession` while a session has work in flight and names that work by family
 * (`dsh-workspace` `archiveSession`, `WorkspaceActiveSessionError.activity`): `{ kind: 'turn' }` from `dsh-agent` when
 * the session's own turn is running, and `{ kind: 'subagent', items }` from `dsh-subagent` for its running subagent
 * descendants, found by durable lineage — a child whose record names its parent **and** carries the subagent origin,
 * at any depth (a fork shares the lineage field without the origin and is an independent conversation, so it never
 * holds its source). The sidebar lists exactly this in its stop-and-archive dialog.
 *
 * Heddle reports those two families. DSH's background jobs (`dsh-jobs`) have no runtime here. Scheduled reminders
 * (`dsh-schedule`) landed on main (`src/schedule/`, `heddle-schedule`) after this walk was written, with DSH's
 * `list({sessionId})` and `stopSessionTasks`; asking them is a follow-up for both builds.
 */

/** One family of running work, in DSH's shape: the kind, and for a counted family its items. */
export interface ActivityEntry {
  readonly kind: 'turn' | 'subagent'
  readonly items?: readonly { readonly id: string; readonly label?: string }[]
}

/** What the lineage walk reads of a session record. */
export interface LineageMeta {
  readonly id: string
  readonly title?: string
  readonly parentSession?: string
  readonly origin?: string
}

/**
 * The session's running work, in DSH's listener order: its turn first, then its running subagent descendants.
 *
 * `running` answers whether one session has a turn in flight in this process. The walk is breadth-first from the
 * session and visits each id once, so a damaged chain that loops cannot hang it. A child's label is its title when it
 * has one (DSH labels a child by its creation label and falls back to the id).
 */
export function sessionActivity(sessionId: string, metas: readonly LineageMeta[], running: (id: string) => boolean): ActivityEntry[] {
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
  if (subagents.length > 0) {
    activity.push({
      kind: 'subagent',
      items: subagents.map((child) => ({ id: child.id, ...(child.title !== undefined && child.title.length > 0 ? { label: child.title } : {}) })),
    })
  }
  return activity
}

/** The sessions a stop-and-archive stops: the session itself and every running subagent the activity named. */
export function activitySessions(sessionId: string, activity: readonly ActivityEntry[]): string[] {
  const ids = [sessionId]
  for (const entry of activity) for (const item of entry.items ?? []) if (!ids.includes(item.id)) ids.push(item.id)
  return ids
}
