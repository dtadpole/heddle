import { isSerializedSchema, normalizeProjection } from './form-projection.ts'
import { compose, type NamedLayer } from './schema.ts'

/**
 * Configuration validation, without starting anything.
 *
 * The claim this exists for is narrow and worth stating: **a bad configuration fails where
 * it is written**. Starting a tree to discover that row `model` has a typo in a field name
 * means the failure arrives as a plugin that loaded but misbehaved, or as a pending entry,
 * or not at all — and none of those names the field.
 *
 * So validation does what the loader does *before* a plugin body runs: import the module,
 * find its schema where Cordis finds it (a static `Config` on the class, or the named
 * `Config` export of a function plugin), and run it over the composed row. The row is
 * named in every problem, because "expected string but got number" without a row is a
 * sentence that sends its reader to the wrong file.
 */

export interface ValidationResult {
  readonly rows: number
  readonly checked: number
  readonly problems: readonly string[]
}

/** Compose the layers and validate every row's config against its plugin's schema. */
export async function validateRows(layers: readonly NamedLayer[], env: NodeJS.ProcessEnv = process.env): Promise<ValidationResult> {
  /**
   * Relative specifiers resolve against the first layer's directory, which is the same
   * anchor `boot` uses. Measured: importing them bare resolved against *this file's*
   * directory, so every row failed with a path under `dist/config/` and the check
   * reported eight problems on a tree that was correct.
   */
  const { pathToFileURL } = await import('node:url')
  const anchor = layers[0]?.file
  const baseUrl = anchor === undefined ? undefined : pathToFileURL(anchor.replace(/[^/]*$/, '')).href
  const rows = compose(layers, env)
  const problems: string[] = []
  let checked = 0

  for (const composed of rows) {
    const row = composed.row
    const label = row.id ?? row.name
    if (row.disabled === true) continue

    const specifier =
      baseUrl !== undefined && (row.name.startsWith('.') || row.name.startsWith('/'))
        ? new URL(row.name, baseUrl).href
        : row.name
    let module: Record<string, unknown>
    try {
      module = (await import(specifier)) as Record<string, unknown>
    } catch (error) {
      problems.push(`${label}: cannot import '${row.name}' — ${(error as Error).message}`)
      continue
    }

    const schema = findSchema(module)
    if (schema === undefined) {
      // No schema is not a problem: a plugin is allowed to take no config, and saying so
      // would make this check fail on correct trees.
      continue
    }
    /**
     * A Schemastery schema is a **callable function**, measured: `typeof schema` is
     * `'function'` and calling it validates and fills defaults. The first version looked
     * for a `__call` marker, which Schemastery does not define, so every schema-carrying
     * row was reported as "not a schema" — a check failing on correct input, which is the
     * worst way for a check to be wrong.
     */
    if (typeof schema !== 'function') {
      problems.push(`${label}: the plugin's Config export is not a schema`)
      continue
    }

    checked += 1
    let resolved: unknown
    try {
      resolved = (schema as (value: unknown) => unknown)(row.config ?? {})
    } catch (error) {
      problems.push(`${label}: ${(error as Error).message}`)
      continue
    }
    /**
     * Schemastery's default resolve **coerces** rather than rejecting — measured: a string
     * where a number belongs becomes `NaN` in the resolved object with no error raised,
     * and a missing required field is absent rather than refused. That is right for a
     * running plugin, which may fill a field later, and wrong for this check, whose whole
     * claim is that a bad value fails where it is written. So the resolved value is
     * inspected for the two silent failures a coerced config produces.
     */
    for (const problem of inspectRow(resolved, label)) problems.push(problem)
  }

  return { rows: rows.length, checked, problems }
}

/**
 * The JSON form of a row's plugin schema (Schemastery's `toJSON()`), or `null` when the plugin declares
 * none or cannot be imported: what the settings view sends so a page can build a form. The row's name
 * resolves against the first layer's directory, as `validateRows` resolves it.
 */
export async function rowSchemaJson(row: { readonly name: string }, layers: readonly NamedLayer[]): Promise<unknown> {
  const { pathToFileURL } = await import('node:url')
  const anchor = layers[0]?.file
  const baseUrl = anchor === undefined ? undefined : pathToFileURL(anchor.replace(/[^/]*$/, '')).href
  const specifier =
    baseUrl !== undefined && (row.name.startsWith('.') || row.name.startsWith('/')) ? new URL(row.name, baseUrl).href : row.name
  try {
    const schema = findSchema((await import(specifier)) as Record<string, unknown>) as { toJSON?: () => unknown } | undefined
    const serialized = typeof schema?.toJSON === 'function' ? schema.toJSON() : null
    // DSH's form projection with deterministic uids, so both builds answer the same descriptor (#123).
    return isSerializedSchema(serialized) ? normalizeProjection(serialized) : serialized
  } catch {
    return null
  }
}

/**
 * Where a Cordis plugin's schema lives.
 *
 * Two shapes, both measured against the loader's own behaviour: a class plugin carries
 * `static Config`, and a function plugin exports `Config` by name. Trying only one of them
 * is how a validation pass silently checks half a tree.
 */
export function findSchema(module: Record<string, unknown>): unknown {
  const named = module.Config
  if (named !== undefined) return named
  /**
   * A class plugin is **itself a function**, measured: `typeof default` is `'function'` and
   * its static `Config` sits on it. The first version required `typeof default === 'object'`,
   * which excluded every class plugin — so validation reported "0 checked, 0 problems" on a
   * row with a string where a number belongs, which is the worst possible outcome for a
   * check: it looked green while checking nothing.
   */
  const exported = module.default
  if (exported !== undefined && exported !== null && (typeof exported === 'object' || typeof exported === 'function')) {
    const config = (exported as { Config?: unknown }).Config
    if (config !== undefined) return config
  }
  return undefined
}

/**
 * The silent failures a coerced config can produce.
 *
 * `NaN` where a number was meant is the one that matters: it reaches a URL and becomes the
 * string `NaN` in a request, which fails somewhere that names nothing useful. A missing
 * value is not reported, because `default()` and a plugin's own fallback both legitimately
 * produce one.
 */
function inspectRow(value: unknown, label: string, path = ''): readonly string[] {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [] : [`${label}: ${path || '(root)'} is not a number, which means the value in the layer could not be read as one`]
  }
  if (value === null || value === undefined || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((entry, index) => inspectRow(entry, label, `${path}[${index}]`))
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    inspectRow(child, label, path === '' ? key : `${path}.${key}`),
  )
}
