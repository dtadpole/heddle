/**
 * The settings view's schema descriptor (issue #123): DSH's form projection, the Schemastery serialization a settings
 * page builds its forms from (`{ uid, refs }`, each node with its `type`, its `meta` — `default`, `min`, `max`, `step`,
 * `required`, `description` — and its children by uid), with the uids made deterministic.
 *
 * Schemastery numbers nodes from a process-wide counter, so the same schema serializes with different uids in two
 * processes, and two builds could never agree on the bytes. `normalizeProjection` renumbers the nodes 1..n in the order
 * a depth-first walk from the root finishes them (children before their parent, so the root is the largest uid, as
 * Schemastery's own output has it) and lists `refs` in uid order. The Rust build serves the same normalized projection,
 * generated from these schemas (`builtin-forms.ts`), so both builds answer the same descriptor byte for byte.
 */

/** Schemastery's serialized schema: the root's uid and every node by uid. */
export interface SerializedSchema {
  readonly uid: number
  readonly refs: Readonly<Record<string, Record<string, unknown>>>
}

/** Node fields that hold one child uid. */
const ONE_CHILD = ['inner', 'sKey'] as const
/** Node fields that hold a list of child uids. */
const CHILD_LIST = ['list'] as const
/** Node fields that hold a mapping of child uids. */
const CHILD_MAP = ['dict'] as const

export function isSerializedSchema(value: unknown): value is SerializedSchema {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { uid?: unknown }).uid === 'number' &&
    typeof (value as { refs?: unknown }).refs === 'object'
  )
}

/** The projection with its uids renumbered deterministically; see the module comment. */
export function normalizeProjection(serialized: SerializedSchema): SerializedSchema {
  const renumbered = new Map<number, number>()
  const nodes = new Map<number, Record<string, unknown>>()
  let next = 1
  const visit = (uid: number): number => {
    const known = renumbered.get(uid)
    if (known !== undefined) return known
    const node = serialized.refs[String(uid)]
    if (node === undefined) throw new Error(`the projection names a node it does not hold: ${uid}`)
    const copy: Record<string, unknown> = { ...node }
    for (const field of ONE_CHILD) {
      if (typeof node[field] === 'number') copy[field] = visit(node[field] as number)
    }
    for (const field of CHILD_LIST) {
      if (Array.isArray(node[field])) copy[field] = (node[field] as unknown[]).map((child) => (typeof child === 'number' ? visit(child) : child))
    }
    for (const field of CHILD_MAP) {
      const map = node[field]
      if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
        copy[field] = Object.fromEntries(
          Object.entries(map as Record<string, unknown>).map(([key, child]) => [key, typeof child === 'number' ? visit(child) : child]),
        )
      }
    }
    const id = next
    next += 1
    renumbered.set(uid, id)
    nodes.set(id, copy)
    return id
  }
  const root = visit(serialized.uid)
  const refs: Record<string, Record<string, unknown>> = {}
  for (const id of [...nodes.keys()].sort((left, right) => left - right)) refs[String(id)] = nodes.get(id) as Record<string, unknown>
  return { uid: root, refs }
}
