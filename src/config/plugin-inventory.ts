/**
 * The plugin inventory: DSH's read-only `pluginInventory/list` (`dsh-host-plugin-inventory`'s
 * `readPluginInventory`), served as `GET /api/plugin-inventory`.
 *
 * A point-in-time view of the loader's entries: one per non-group entry, in the loader's order, with the
 * module name, whether the entry is enabled, and the phase its fiber is in. The loader is read on every
 * call, as DSH reads it, so a phase that changes while the server runs is the phase the next request sees;
 * there is no second cache to keep in step. Nothing here starts, stops or installs anything. DSH reports
 * `managementAvailable: true` only when a plugin manager is loaded, and heddle has none, so the key is
 * absent, as DSH leaves it absent.
 *
 * The module name is the one **the layer wrote**. `boot` hands the loader a relative or absolute row name
 * already resolved to a `file://` URL against the base layer's directory, so the loader's own
 * `options.name` would show this machine's path where the configuration said `./alpha.ts`. The rows the
 * boot composed carry the declared names, by the ids the loader gave them ({@link declaredModuleNames});
 * an entry with no declared name, such as one a group created, keeps the loader's.
 */

/** An entry's lifecycle as the inventory reports it; `null` when the entry has no live fiber. */
export type PluginFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

/** One non-group loader entry: DSH's `PluginInventoryEntry`, without the package display metadata. */
export interface PluginInventoryEntry {
  readonly entryId: string
  /** The module the entry names, as the layer wrote it. */
  readonly moduleName: string
  /** Effective enablement, including a disabled group above the entry. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** DSH's `PluginInventorySnapshot`, without the agent-preset compositions this build does not have. */
export interface PluginInventorySnapshot {
  /** `true` only where a plugin manager can change the profile; absent otherwise. */
  readonly managementAvailable?: boolean
  readonly entries: readonly PluginInventoryEntry[]
}

/**
 * Cordis's `FiberState`, by number, as DSH projects it: `DISPOSED` (4) has no phase. The numbers are the
 * declaration order in cordis `src/fiber.ts`, the same table `STATES` in `src/cli.ts` prints.
 */
const FIBER_PHASE: readonly PluginFiberPhase[] = ['pending', 'loading', 'active', 'failed', null, 'unloading']

/** The part of a Cordis loader entry the inventory reads. */
export interface InventoryLoaderEntry {
  readonly id: string
  readonly options: { readonly name: string; readonly group?: unknown }
  readonly disabled: boolean
  readonly fiber?: { readonly state: number } | undefined
}

/** The part of the Cordis loader the inventory reads: every entry, nested trees included. */
export interface InventoryLoader {
  entries(): Iterable<InventoryLoaderEntry>
}

/**
 * Read the inventory from the loader now.
 *
 * @param loader the boot's loader; a context built without one has no entries.
 * @param declared the module name each row declared, by entry id.
 */
export function readPluginInventory(
  loader: InventoryLoader | undefined,
  declared: ReadonlyMap<string, string> = new Map(),
): PluginInventorySnapshot {
  const entries: PluginInventoryEntry[] = []
  for (const entry of loader?.entries() ?? []) {
    if (entry.options.group) continue
    entries.push({
      entryId: entry.id,
      moduleName: declared.get(entry.id) ?? entry.options.name,
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? null),
    })
  }
  return { entries }
}

/**
 * The name each composed row declared, by the id the loader gave its entry.
 *
 * `boot` creates one entry per row, in row order, and returns the ids in that order, so the two lists pair
 * up one to one; a disabled row is created too, disabled.
 */
export function declaredModuleNames(boot: {
  readonly rows: readonly { readonly row: { readonly name: string } }[]
  readonly ids: readonly string[]
}): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  boot.ids.forEach((id, index) => {
    const row = boot.rows[index]
    if (row !== undefined) names.set(id, row.row.name)
  })
  return names
}
