import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import yaml from 'js-yaml'

/**
 * The configuration system.
 *
 * Modelled on how DSH composes a profile, and every piece here is one of its
 * decisions:
 *
 * - **The base tree is empty.** A profile's `cordis.yml` is `[]` and the whole tree
 *   arrives as patch layers over it. Composition is data, so no plugin knows about
 *   any other and a machine can restate one row without touching the rest.
 * - **Rows are addressed by `id`.** A later layer restates a row's whole `config`,
 *   because a patch replaces rather than merges — DSH states that explicitly, and the
 *   consequence is that no row's value is spread across two layers where neither is
 *   readable on its own.
 * - **Row order carries no load semantics.** Activation is service-availability
 *   driven, which is what `inject` is for. The order is for a reader.
 * - **Named profiles are directories.** `$HEDDLE_HOME/profiles/<name>/` holds the
 *   profile's own layers, so which tree runs is a name rather than a path.
 *
 * Three things are added to DSH's shape, each because a person configuring this
 * harness needs it and none of them changes the model:
 *
 * - **`!include`** — another layer file, resolved relative to the file that names it,
 *   with a cycle refused by path rather than by depth.
 * - **Environment references** — `!env NAME` for a whole value and `${NAME}` inside a
 *   string. A whole-value reference is what keeps a type: `${PORT}` substituted into a
 *   string is a string, while `!env PORT` stays a number when the variable holds one.
 * - **Provenance** — every row records which layer supplied which field, so
 *   `heddle config show` can answer "where did this value come from", which is the
 *   question a composed tree otherwise makes unanswerable.
 */

/** One configured plugin row. */
export interface EntryRow {
  readonly id?: string
  readonly name: string
  readonly config?: unknown
  readonly group?: boolean
  readonly disabled?: boolean
  readonly inject?: readonly string[] | null
}

/** Which layer supplied one field of one row. */
export interface Provenance {
  /** The layer, named as a person would name it. */
  readonly layer: string
  /** The absolute file, or `(inline)` for a layer supplied in memory. */
  readonly file: string
  /** The field path within the row, `config.transport.timeoutMs` style. */
  readonly field: string
}

/** A composed row: the row itself, its index, and where each field came from. */
export interface ComposedRow {
  readonly row: EntryRow
  readonly position: number
  readonly fields: readonly Provenance[]
}

/** A directory of layers recognised as a profile. */
export interface ProfileInfo {
  readonly name: string
  readonly dir: string
  readonly layers: readonly string[]
}

/** Raised for a configuration that cannot be composed. Carries every problem found. */
export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(problems.join('\n'))
    this.name = 'ConfigError'
    this.problems = problems
  }
}

/** Where a layer was read from, and what to call it when reporting. */
export interface LayerSource {
  readonly file: string
  readonly layer: string
}

/** A layer file's parsed contents. */
export interface Layer {
  readonly insert?: readonly EntryRow[]
  readonly patch?: readonly (Partial<EntryRow> & { readonly id: string })[]
  readonly remove?: readonly string[]
}

/** Where `$HEDDLE_HOME` is, honouring the environment first. */
export function heddleHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEDDLE_HOME ?? join(homedir(), '.heddle')
}

/** Where named profiles live. */
export function profilesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(heddleHome(env), 'profiles')
}

/** Expand a leading `~`, because a configuration may write every path that way. */
export function expandHome(path: string): string {
  return path.startsWith('~') ? `${homedir()}${path.slice(1)}` : path
}

/** The profiles this machine holds, each with the layer files it carries. */
export function listProfiles(env: NodeJS.ProcessEnv = process.env): readonly ProfileInfo[] {
  const root = profilesDir(env)
  let names: string[]
  try {
    names = readdirSync(root).sort()
  } catch {
    return []
  }
  const profiles: ProfileInfo[] = []
  for (const name of names) {
    const dir = join(root, name)
    const layers = ['cordis.yml', 'heddle.patch.yml'].filter((file) => existsSync(join(dir, file)))
    // A profile is recognised by the layer files it holds, not by `isDirectory`, because
    // a profile is commonly a symlink to the project it configures — measured: the first
    // version listed zero profiles while `ls` showed one.
    if (layers.length > 0) profiles.push({ name, dir, layers })
  }
  return profiles
}

/**
 * Resolve a profile name to its directory, or say which names exist.
 *
 * A name is normally a directory under the profiles root, but an **absolute path** is also
 * accepted when it holds layer files. That is not a convenience: it is how a check states the
 * profile it wants without writing into the machine's own profiles directory, and how a person
 * runs a tree kept beside a project. Measured need — the first version of the context check
 * failed with "no profile named '/Users/.../context-profile-2'".
 */
export function resolveProfile(name: string, env: NodeJS.ProcessEnv = process.env): ProfileInfo {
  if (isAbsolute(expandHome(name))) {
    const dir = resolve(expandHome(name))
    const layers = ['cordis.yml', 'heddle.patch.yml'].filter((file) => existsSync(join(dir, file)))
    if (layers.length > 0) return { name: dir, dir, layers }
    throw new ConfigError([`${dir} holds no cordis.yml or heddle.patch.yml, so it is not a profile directory`])
  }
  const found = listProfiles(env).find((profile) => profile.name === name)
  if (found === undefined) {
    const known = listProfiles(env).map((profile) => profile.name)
    throw new ConfigError([
      `no profile named '${name}' under ${profilesDir(env)}${known.length > 0 ? `; known profiles: ${known.join(', ')}` : '; that directory holds none'}`,
    ])
  }
  return found
}

/**
 * Read one layer file, expanding includes and references.
 *
 * `stack` is the chain of files currently being read. A file that appears twice in it
 * is a cycle, and it is refused by path rather than by a depth limit, because a depth
 * limit reports "too deep" where the useful sentence is which file includes which.
 */
export function readLayer(file: string, options: { readonly stack?: readonly string[]; readonly env?: NodeJS.ProcessEnv } = {}): readonly Layer[] {
  const env = options.env ?? process.env
  const absolute = resolve(expandHome(file))
  const stack = options.stack ?? []
  if (stack.includes(absolute)) {
    throw new ConfigError([`include cycle: ${[...stack, absolute].join(' -> ')}`])
  }

  let text: string
  try {
    text = readFileSync(absolute, 'utf8')
  } catch (error) {
    throw new ConfigError([`could not read the layer ${absolute}: ${(error as Error).message}`])
  }
  return readLayerText(text, absolute, { stack, env })
}

/**
 * The layers in `text`, read as if it were the file `absolute`: problems name that file and an `include`
 * resolves against its directory. `readLayer` reads the file and lands here; the settings writer parses a
 * candidate patch it has not written yet.
 */
export function readLayerText(
  text: string,
  absolute: string,
  options: { readonly stack?: readonly string[]; readonly env?: NodeJS.ProcessEnv } = {},
): readonly Layer[] {
  const env = options.env ?? process.env
  const stack = options.stack ?? []
  const schema = includeSchema()
  let parsed: unknown
  try {
    parsed = yaml.load(text, { schema })
  } catch (error) {
    throw new ConfigError([`${absolute} is not valid YAML: ${(error as Error).message}`])
  }
  if (parsed === null || parsed === undefined) return []
  if (!Array.isArray(parsed)) {
    throw new ConfigError([`${absolute}: expected a top-level array of layers`])
  }

  const layers: Layer[] = []
  for (const [index, entry] of parsed.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConfigError([`${absolute}: layer ${index} must be a mapping of insert, patch, remove or include`])
    }
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!['insert', 'patch', 'remove', 'include'].includes(key)) {
        throw new ConfigError([`${absolute}: layer ${index} has unknown key '${key}'; expected insert, patch, remove or include`])
      }
    }

    if (record.include !== undefined) {
      const includes = Array.isArray(record.include) ? record.include : [record.include]
      for (const include of includes) {
        if (typeof include !== 'string') {
          throw new ConfigError([`${absolute}: include must be a path, not ${JSON.stringify(include)}`])
        }
        const target = isAbsolute(include) ? include : join(dirname(absolute), include)
        layers.push(...readLayer(target, { stack: [...stack, absolute], env }))
      }
    }

    const layer: Layer = {
      ...(record.insert !== undefined ? { insert: record.insert as EntryRow[] } : {}),
      ...(record.patch !== undefined ? { patch: record.patch as Layer['patch'] } : {}),
      ...(record.remove !== undefined ? { remove: record.remove as string[] } : {}),
    }
    if (record.insert !== undefined || record.patch !== undefined || record.remove !== undefined) layers.push(layer)
  }
  return layers
}

/** `!include` and `!env` are resolved during the load, so a layer never holds them. */
function includeSchema(): yaml.Schema {
  return yaml.DEFAULT_SCHEMA.extend([
    new yaml.Type('!include', {
      kind: 'scalar',
      resolve: (value: unknown) => typeof value === 'string',
      construct: (value: string) => ({ __include: value }),
    }),
    new yaml.Type('!env', {
      kind: 'scalar',
      resolve: (value: unknown) => typeof value === 'string',
      construct: (value: string) => ({ __env: value }),
    }),
  ])
}

/** Every `${NAME}` reference in a scalar, in order. */
export function referencesIn(value: unknown): readonly string[] {
  if (typeof value !== 'string') return []
  const names: string[] = []
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  return names
}

/**
 * Resolve environment references in a whole config value.
 *
 * Three shapes, and the distinction between the first two is the point:
 *
 * - `!env NAME` — the whole value, parsed so a number stays a number and a boolean a
 *   boolean. This is what a port or a flag needs.
 * - `${NAME}` inside a string — textual substitution. This is what a URL prefix needs.
 * - A missing variable is an **error**, never an empty string: a configuration that
 *   silently resolves a missing credential to `''` fails somewhere much further away.
 */
export function resolveEnv(value: unknown, options: { readonly file: string; readonly env?: NodeJS.ProcessEnv } = { file: '(inline)' }): unknown {
  const env = options.env ?? process.env
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((entry) => resolveEnv(entry, options))
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.__env === 'string') {
      const name = record.__env
      const raw = env[name]
      if (raw === undefined) throw new ConfigError([`${options.file}: the environment reference !env ${name} is not set`])
      return parseScalar(raw)
    }
    if (typeof record.__include === 'string') {
      throw new ConfigError([`${options.file}: include is only allowed as a layer entry, not inside a value`])
    }
    const resolved: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) resolved[key] = resolveEnv(entry, options)
    return resolved
  }
  if (typeof value === 'string' && value.includes('${')) {
    const names = referencesIn(value)
    let text = value
    for (const name of names) {
      const raw = env[name]
      if (raw === undefined) throw new ConfigError([`${options.file}: the environment reference \${${name}} is not set`])
      text = text.split(`\${${name}}`).join(raw)
    }
    return text
  }
  return value
}

/** Interpret an environment string as the value it spells, keeping JSON types. */
function parseScalar(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (trimmed !== '' && !Number.isNaN(Number(trimmed)) && /^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return raw
}

/** One layer with the name a report should use for it. */
export interface NamedLayer {
  readonly layer: string
  readonly file: string
  readonly entries: readonly Layer[]
}

/** Compose named layers into rows, with the last write winning and provenance kept. */
export function compose(layers: readonly NamedLayer[], env: NodeJS.ProcessEnv = process.env): readonly ComposedRow[] {
  const rows: ComposedRow[] = []
  const index = new Map<string, number>()
  const problems: string[] = []

  layers.forEach((named) => {
    named.entries.forEach((layer, layerIndex) => {
      for (const raw of layer.insert ?? []) {
        if (raw === null || typeof raw !== 'object' || typeof raw.name !== 'string') {
          problems.push(`${named.file}: layer ${layerIndex}: every inserted row needs a name`)
          continue
        }
        if (raw.id !== undefined && index.has(raw.id)) {
          problems.push(`${named.file}: layer ${layerIndex}: '${raw.id}' is inserted twice; use patch to restate it`)
          continue
        }
        let row: EntryRow
        try {
          row = resolveEnv(raw, { file: named.file, env }) as EntryRow
        } catch (error) {
          problems.push(...(error as ConfigError).problems)
          continue
        }
        const position = rows.length
        if (row.id !== undefined) index.set(row.id, position)
        rows.push({ row, position, fields: provenanceOf(row, named.layer, named.file, 'insert') })
      }

      for (const edit of layer.patch ?? []) {
        if (edit === null || typeof edit !== 'object' || typeof edit.id !== 'string') {
          problems.push(`${named.file}: layer ${layerIndex}: every patched row needs an id`)
          continue
        }
        const at = index.get(edit.id)
        if (at === undefined) {
          problems.push(`${named.file}: layer ${layerIndex}: patch names '${edit.id}', which no earlier layer inserted`)
          continue
        }
        const current = rows[at]
        if (current === undefined) continue
        const { id: _id, ...rest } = edit
        let resolved: Partial<EntryRow>
        try {
          resolved = resolveEnv(rest, { file: named.file, env }) as Partial<EntryRow>
        } catch (error) {
          problems.push(...(error as ConfigError).problems)
          continue
        }
        const merged: EntryRow = { ...current.row, ...resolved }
        // A patch's fields supersede the older provenance for exactly those fields.
        const replaced = new Set(Object.keys(resolved).map((key) => key))
        rows[at] = {
          row: merged,
          position: current.position,
          fields: [...current.fields.filter((entry) => !replaced.has(entry.field.split('.')[0] ?? '')), ...provenanceOf(resolved, named.layer, named.file, 'patch')],
        }
      }

      for (const id of layer.remove ?? []) {
        const at = index.get(id)
        if (at === undefined) {
          problems.push(`${named.file}: layer ${layerIndex}: remove names '${id}', which no earlier layer inserted`)
          continue
        }
        const current = rows[at]
        if (current === undefined) continue
        rows[at] = {
          row: { ...current.row, disabled: true },
          position: current.position,
          fields: [...current.fields, { layer: named.layer, file: named.file, field: 'disabled' }],
        }
      }
    })
  })

  if (problems.length > 0) throw new ConfigError(problems)
  return rows
}

/** One provenance entry per leaf field of a partial row. */
function provenanceOf(value: object, layer: string, file: string, _how: string): readonly Provenance[] {
  const entries: Provenance[] = []
  const walk = (node: unknown, path: string) => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, path === '' ? key : `${path}.${key}`)
      }
      return
    }
    entries.push({ layer, file, field: path })
  }
  walk(value, '')
  return entries
}

/** Where one field of one row came from, or `undefined` when nothing set it. */
export function originOf(rows: readonly ComposedRow[], id: string, field: string): Provenance | undefined {
  const composed = rows.find((entry) => entry.row.id === id)
  if (composed === undefined) return undefined
  const exact = composed.fields.find((entry) => entry.field === field)
  if (exact !== undefined) return exact
  // A queried `config` covers every field beneath it.
  return composed.fields.find((entry) => entry.field.startsWith(`${field}.`))
}

/** The default layers a run uses, in order, for a profile or an explicit base. */
export function defaultLayers(options: {
  readonly profile?: string
  readonly base?: string
  readonly patches?: readonly string[]
  readonly includeProjectPatch?: boolean
  readonly configDir?: string
  readonly env?: NodeJS.ProcessEnv
}): readonly NamedLayer[] {
  const env = options.env ?? process.env
  const layers: NamedLayer[] = []

  if (options.profile !== undefined) {
    /**
     * A named profile must exist. There is deliberately **no fallback** to a profile found beside the
     * working directory.
     *
     * Tried and reverted, on the evidence of a check: a fallback made `--profile nowhere` boot the
     * repository's tree in silence, so a typo looked like success. A project's own profile is named
     * by passing its directory — which `--profile` accepts — and the failure for an unknown name
     * lists the names that do exist.
     */
    const profile = resolveProfile(options.profile, env)
    for (const file of profile.layers) {
      const path = join(profile.dir, file)
      layers.push({ layer: `${profile.name}/${file}`, file: path, entries: readLayer(path, { env }) })
    }
  } else if (options.base !== undefined) {
    const path = resolve(expandHome(options.base))
    layers.push({ layer: path, file: path, entries: readLayer(path, { env }) })
    if (options.includeProjectPatch === true) {
      /**
       * The project patch sits beside the **base layer**, not beside the working directory.
       *
       * Measured: running with `--config /path/to/project/cordis.yml` from another directory booted
       * an empty tree, because the patch was looked up in the caller's directory — so a named config
       * was only usable from the project it named. A profile is a directory's worth of layers, and
       * `--config` names one of them.
       */
      const anchor = dirname(path)
      const projectPatch = join(anchor, 'heddle.patch.yml')
      if (existsSync(projectPatch)) {
        layers.push({ layer: projectPatch, file: projectPatch, entries: readLayer(projectPatch, { env }) })
      }
    }
  }

  for (const patch of options.patches ?? []) {
    const path = resolve(expandHome(patch))
    layers.push({ layer: path, file: path, entries: readLayer(path, { env }) })
  }
  return layers
}
