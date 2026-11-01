import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { pathToFileURL } from 'node:url'

import { compose, defaultLayers, expandHome, type ComposedRow, type EntryRow, type Layer } from './config/schema.ts'

/**
 * A boot: the composed rows, the running context, and how to stop it.
 *
 * `createApp` in `./app.ts` remains the way to build the framework's own plugins in
 * code, which is what the boot tests use. This is the way to build a tree from data,
 * which is what a harness needs: nothing under `src/plugins/` is imported by the
 * loader's own path, so a tree may hold a plugin this project has never heard of.
 */
export interface Boot {
  /** The root context every entry hangs off. */
  readonly ctx: Context
  /** The rows the layers composed, in order, with where each field came from. */
  readonly rows: readonly ComposedRow[]
  /** Entry ids in the loader's tree, in creation order. */
  readonly ids: readonly string[]
  /** The loader, for a caller that wants to address an entry. */
  readonly loader: Loader
  /** Stop every entry and release the context. */
  dispose(): Promise<void>
}

/** Options for {@link boot}. */
export interface BootOptions {
  /** A named profile under `$HEDDLE_HOME/profiles`, which is the normal case. */
  readonly profile?: string
  /** An explicit base layer, used when no profile is named. */
  readonly base?: string
  /** Layers applied after the base, in order; the last write wins per row. */
  readonly patches?: readonly string[]
  /** Apply `heddle.patch.yml` beside the base. */
  readonly includeProjectPatch?: boolean
  /** The directory a project patch and relative specifiers resolve against. */
  readonly configDir?: string
  /** In-memory layers applied last, which is how a flag overrides one row. */
  readonly overrides?: readonly Layer[]
  /** Who the run is for, announced on `heddle/ready`. */
  readonly target?: string
  /** Environment for references; the process environment by default. */
  readonly env?: NodeJS.ProcessEnv
  /**
   * The most verbose logger level a plugin's records reach an exporter at: `0` errors only, `1` (Cordis's
   * default) adds `info`. Unset leaves Cordis's default.
   *
   * It exists for a command whose stdout is a machine's: `--json`. The console exporter writes `info` to stdout,
   * so a plugin's boot line (`model: 1 endpoint(s) — …`) landed ahead of the JSON and the output did not parse.
   * Setting it on the context the loader runs under is Cordis's own mechanism (`ctx.intercept('logger', …)`), so
   * every row's logger inherits it with no plugin knowing about the flag; errors still reach stderr.
   */
  readonly logLevel?: number
}

/**
 * Boot a tree from configuration.
 *
 * The composition is done by `src/config/schema.ts` and this function only starts what
 * it produced, so every rule about layers can be reasoned about — and checked — without
 * starting anything.
 *
 * Two measured details are load-bearing here. `create` resolves to the entry's **id**,
 * not to an entry, and a relative specifier resolves against the loader's `baseUrl`
 * rather than against the importing file. Both were wrong in the first draft and both
 * failed silently: an entry that never started still appeared in `loader.entries()`.
 */
export async function boot(options: BootOptions = {}): Promise<Boot> {
  const env = options.env ?? process.env
  const layers = [
    ...defaultLayers({
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(options.base !== undefined ? { base: options.base } : {}),
      ...(options.patches !== undefined ? { patches: options.patches } : {}),
      ...(options.includeProjectPatch !== undefined ? { includeProjectPatch: options.includeProjectPatch } : {}),
      ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
      env,
    }),
  ]
  for (const [index, override] of (options.overrides ?? []).entries()) {
    layers.push({ layer: `override ${index + 1}`, file: '(inline)', entries: [override] })
  }

  const rows = compose(layers, env)

  /**
   * Relative specifiers resolve against the **base layer's own directory**, not the
   * process's working directory. Measured while writing this: the first version used the
   * working directory, so a fixture at `.heddle-tmp/config-1/heddle.yml` declaring
   * `./alpha.ts` resolved to `<cwd>/alpha.ts`, and the loader reported no error for the
   * missing module — it only logged one — so the run finished with an empty tree.
   */
  const anchor = layers[0]?.file ?? options.configDir ?? process.cwd()
  const baseUrl = pathToFileURL(anchor.replace(/[^/]*$/, '')).href

  const root = new Context()
  /**
   * The loader, every row it creates, **and the caller** run under the requested logger level, so the handle
   * returned is the intercepted child rather than the root. Measured: with the root returned, a `--turn --json`
   * whose model called `write_file` still printed `turn: wrote …` ahead of the document, because the turn logs
   * through the context its caller passes. The child inherits the root's services and fiber, so `dispose` still
   * stops the whole tree.
   */
  const ctx = options.logLevel !== undefined ? root.intercept('logger', { level: options.logLevel }) : root
  await ctx.plugin(Loader, { baseUrl })

  const ids: string[] = []
  for (const composed of rows) {
    const row: EntryRow = composed.row
    const id = await ctx.loader.create({
      ...(row.id !== undefined ? { id: row.id } : {}),
      name: row.name.startsWith('.') || row.name.startsWith('/') ? new URL(row.name, baseUrl).href : row.name,
      ...(row.config !== undefined ? { config: row.config } : {}),
      ...(row.group !== undefined ? { group: row.group } : {}),
      ...(row.disabled !== undefined ? { disabled: row.disabled } : {}),
      ...(row.inject !== undefined ? { inject: row.inject } : {}),
    })
    ids.push(id)
  }
  await ctx.loader.await()

  /**
   * Announce the tree, exactly as `createApp` does. Without it a configured tree had no
   * point at which a plugin could act once everything it depends on exists: `inject`
   * gates a plugin's body but says nothing about when the tree is finished.
   */
  ctx.emit('heddle/ready', options.target ?? 'heddle')

  return {
    ctx,
    rows,
    ids,
    loader: ctx.loader,
    dispose: () => ctx.fiber.dispose(),
  }
}

/**
 * Wait until no entry is still pending, or give up and report which are.
 *
 * A pending entry is the honest signal of a missing service, and a caller that reported
 * success while something sat pending would be reporting a tree that never finished
 * loading.
 */
/**
 * Entries that failed to load, by id.
 *
 * A plugin whose body throws is left in the loader's **failed** state with the error only in a log
 * line, which measured as the worst kind of silence: an unnamed tool was registered by a fixture
 * plugin, the registration refused it, and the harness exited `0` while printing four healthy tools.
 * A row that failed is a broken configuration and the caller has to be able to see it.
 */
export function failedEntries(ctx: Context): readonly { readonly id: string; readonly name: string }[] {
  return [...ctx.loader.entries()]
    .filter((entry) => entry.fiber !== undefined && entry.fiber.state === 3)
    .map((entry) => ({ id: entry.options.id, name: entry.options.name }))
}

export async function settle(ctx: Context, timeoutMs = 5_000): Promise<readonly string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    /**
     * Pending **and loading** are both unsettled.
     *
     * `pending` (0) is a plugin waiting for an injected service; `loading` (1) is one whose `apply` is
     * running. Waiting only for 0 returned while a row's `apply` had not finished, so a `--turn` could
     * start before that row had registered its tool — measured: the subagent tool's `apply` logged after
     * the turn, and the model's `delegate` call was refused as `UNKNOWN_TOOL` in a profile that names the
     * row. The states are declared in cordis `src/fiber.ts`.
     */
    const pending = [...ctx.loader.entries()]
      .filter((entry) => entry.fiber !== undefined && (entry.fiber.state === 0 || entry.fiber.state === 1))
      .map((entry) => entry.options.id)
    if (pending.length === 0 || Date.now() > deadline) return pending
    await new Promise((done) => setTimeout(done, 20))
  }
}

export { expandHome }
