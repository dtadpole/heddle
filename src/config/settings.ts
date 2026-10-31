import { existsSync, readFileSync, renameSync, rmSync, statSync, chmodSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { compose, ConfigError, defaultLayers, expandHome, readLayerText, referencesIn, resolveEnv, resolveProfile, type ComposedRow, type Layer, type NamedLayer } from './schema.ts'
import { rowSchemaJson, validateRows, type ValidationResult } from './validate.ts'

/**
 * Settings: the active profile's patch layer as a writable surface, the way DSH's `dsh-settings` over
 * `dsh-config-editor` offers it. The Rust port's `heddle-config` `settings` module is the same design, and
 * the two write byte-identical files.
 *
 * **What DSH does** (its package READMEs and type declarations): forms identify each plugin by its profile
 * entry id; a write persists into the active profile's patch, validates the complete candidate before
 * touching disk and replaces the file atomically; invalid values and higher-layer overrides leave the file
 * unchanged; home patches and command-line overlays are read for precedence and never written; a stale write
 * is refused with `settings-conflict`, every other refusal is `settings-rejected`; secrets cross only as
 * presence markers; a reset restores the value beneath the profile override. The writes are `update` (merge
 * fields), `replace` (reset every field, then set the given ones) and `mutate` (path `set` and `unset`).
 *
 * **How heddle does it.** The target is the active profile's `heddle.patch.yml` (with `--profile`, the
 * profile's own; otherwise the project patch beside the base, when the run applies it; a `--patch` overlay
 * run with no profile has none). Neither YAML library keeps comments, so the writer owns one block at the end
 * of the target, between `SETTINGS_BEGIN` and `SETTINGS_END`, and leaves everything else byte for byte. A
 * heddle patch replaces `config` whole, so the block restates the entry's complete **raw** config with the
 * edits applied (DSH's own "a complete config override pins their current raw values"); an `${ENV}` or
 * `!env` value stays a reference. An unset restores the value beneath the block; an entry back at its base
 * leaves the block, and an empty block leaves the file. Secrets (environment values and credential-named
 * fields) are redacted and never writable. Revisions count changes to the target's sections per entry, per
 * process. With an `Applier` (the web server gives the loader's `update`) a committed write is applied to the
 * running tree at once and `applies` is `live`, as DSH's settings are; without one it is `restart`, and the next boot
 * composes the written value.
 */

export const SETTINGS_BEGIN = '# >>> heddle settings'
export const SETTINGS_END = '# <<< heddle settings'
const BEGIN_NOTE = ' (written by the settings API; a value may be edited here, keep both marker lines)'
const PROJECT_PATCH = 'heddle.patch.yml'

export interface SettingsTarget {
  /** The active profile's `heddle.patch.yml`, absolute; it need not exist yet. */
  readonly path: string
  /** The layer name provenance reports for it. */
  readonly label: string
  /** Its index in the boot's layers, or the index the first write gives it. */
  readonly index: number
}

export interface LayerOptions {
  readonly profile?: string
  readonly base?: string
  readonly patches?: readonly string[]
  readonly includeProjectPatch?: boolean
}

export type SettingsPathOp = { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown } | { readonly op: 'unset'; readonly path: readonly string[] }

export type SettingsWrite =
  | { readonly kind: 'update'; readonly fields: Record<string, unknown> }
  | { readonly kind: 'replace'; readonly fields: Record<string, unknown> }
  | { readonly kind: 'mutate'; readonly ops: readonly SettingsPathOp[] }

export interface SecretSlot {
  readonly path: readonly string[]
  readonly set: boolean
}

export interface SettingsNamespace {
  readonly ns: string
  readonly component: string
  readonly autoGenerate: boolean
  readonly schema: unknown
  readonly value: unknown
  readonly base?: unknown
  readonly user?: unknown
  /** `live` when a write is applied to the running tree as it lands (DSH's settings), `restart` when the next boot applies it. */
  readonly applies: 'restart' | 'live'
  readonly secrets: readonly SecretSlot[]
  readonly revision: number
  readonly editable: boolean
  readonly reason?: string
  /** Set on a write's answer when the file was written but the running tree refused the value; the next boot applies it. */
  readonly applyError?: string
}

/**
 * Apply entry `ns`'s newly composed config to the running tree (the server gives `ctx.loader.update(ns, { config })`).
 * DSH's config editor applies a committed settings write the same way: the loader re-applies the entry, committing a
 * volatile value in place and remounting otherwise.
 */
export type Applier = (ns: string, config: unknown) => Promise<void>

export interface SettingsView {
  readonly writable: boolean
  readonly hasDocument: boolean
  readonly namespaces: readonly SettingsNamespace[]
}

/** A refused write; `code` is DSH's wire code. */
export class SettingsError extends Error {
  readonly code: 'settings-conflict' | 'settings-rejected'
  readonly expected?: number
  readonly actual?: number
  constructor(code: 'settings-conflict' | 'settings-rejected', message: string, revisions?: { expected: number; actual: number }) {
    super(message)
    this.code = code
    if (revisions !== undefined) {
      this.expected = revisions.expected
      this.actual = revisions.actual
    }
  }
}

const rejected = (message: string) => new SettingsError('settings-rejected', message)
const conflict = (expected: number, actual: number) =>
  new SettingsError('settings-conflict', `the entry changed since it was read (revision ${actual}, the write expected ${expected}); read it again`, {
    expected,
    actual,
  })

/** Validation of a complete candidate; `validateRows` by default. */
export type Validator = (layers: readonly NamedLayer[], env: NodeJS.ProcessEnv) => Promise<ValidationResult>
/** A row's schema as JSON, or `null`; `rowSchemaJson` by default. */
export type SchemaReader = (row: ComposedRow['row'], layers: readonly NamedLayer[]) => Promise<unknown>

/** Per-entry revisions for one process. */
export class SettingsRevisions {
  private readonly seen = new Map<string, { revision: number; digest: string }>()
  revision(ns: string, digest: string): number {
    const known = this.seen.get(ns)
    if (known === undefined) {
      this.seen.set(ns, { revision: 1, digest })
      return 1
    }
    if (known.digest !== digest) {
      known.revision += 1
      known.digest = digest
    }
    return known.revision
  }
}

/** A field name that holds a credential, whatever the case. */
export function isSecretKey(key: string): boolean {
  return ['apikey', 'apitoken', 'token', 'secret', 'password'].includes(key.toLowerCase())
}

/** The file a settings write lands in, or `undefined` when the run has no profile patch. */
export function settingsTarget(options: LayerOptions, layers: readonly NamedLayer[], env: NodeJS.ProcessEnv = process.env): SettingsTarget | undefined {
  let path: string
  let label: string
  let defaultIndex: number
  if (options.profile !== undefined) {
    let profile
    try {
      profile = resolveProfile(options.profile, env)
    } catch {
      return undefined
    }
    path = join(profile.dir, PROJECT_PATCH)
    label = `${profile.name}/${PROJECT_PATCH}`
    defaultIndex = 0
    for (const layer of layers) {
      if (layer.file.startsWith(`${profile.dir}/`) || layer.file === profile.dir) defaultIndex += 1
      else break
    }
  } else if (options.base !== undefined) {
    if (options.includeProjectPatch !== true) return undefined
    path = join(dirname(resolve(expandHome(options.base))), PROJECT_PATCH)
    label = path
    defaultIndex = 1
  } else {
    return undefined
  }
  const index = layers.findIndex((layer) => layer.file === path)
  if (index >= 0) return { path, label: layers[index]?.layer ?? label, index }
  return { path, label, index: Math.min(defaultIndex, layers.length) }
}

/** The settings surface over one run's layers. */
export class SettingsService {
  readonly revisions = new SettingsRevisions()
  readonly layers: readonly NamedLayer[]
  readonly target: SettingsTarget | undefined
  readonly env: NodeJS.ProcessEnv
  private readonly validate: Validator
  private readonly schemaOf: SchemaReader
  private readonly applier: Applier | undefined
  private serial: Promise<unknown> = Promise.resolve()

  // Fields are assigned explicitly: Node runs this file by stripping types, which parameter properties defeat.
  constructor(
    layers: readonly NamedLayer[],
    target: SettingsTarget | undefined,
    env: NodeJS.ProcessEnv = process.env,
    validate: Validator = validateRows,
    schemaOf: SchemaReader = rowSchemaJson,
    apply?: Applier,
  ) {
    this.layers = layers
    this.target = target
    this.env = env
    this.validate = validate
    this.schemaOf = schemaOf
    this.applier = apply
  }

  /** Every entry's form, the target re-read. */
  async describe(): Promise<SettingsView> {
    const state = readState(this.layers, this.target, this.env)
    const rows = compose(state.current, this.env)
    let baseRows: readonly ComposedRow[] | undefined
    try {
      baseRows = compose(state.base, this.env)
    } catch {
      baseRows = undefined
    }
    const namespaces: SettingsNamespace[] = []
    for (const row of rows) {
      const ns = row.row.id
      if (ns === undefined) continue
      namespaces.push(await namespaceOf(state, ns, row, baseRows, this.env, this.revisions, this.schemaOf, this.applier !== undefined))
    }
    return { writable: this.target !== undefined, hasDocument: this.target !== undefined && existsSync(this.target.path), namespaces }
  }

  /** Check, write and re-read entry `ns`; resolves to its new form. Writes run one at a time. */
  write(ns: string, write: SettingsWrite, expectedRevision?: number): Promise<SettingsNamespace> {
    const run = this.serial.then(async () => {
      const text = await planWrite(this, ns, write, expectedRevision)
      commitWrite(this.target as SettingsTarget, text)
      // Applied to the running tree as it lands, when the server can: the entry's composed, resolved config is what
      // the next boot would hand it. A refusal does not undo the write; the answer says so and the next boot applies it.
      let applyError: string | undefined
      if (this.applier !== undefined) {
        try {
          const composed = compose(readState(this.layers, this.target, this.env).current, this.env).find((row) => row.row.id === ns)
          await this.applier(ns, composed?.row.config ?? {})
        } catch (error) {
          applyError = error instanceof ConfigError ? error.problems.join('; ') : (error as Error).message
        }
      }
      const view = await this.describe()
      const entry = view.namespaces.find((candidate) => candidate.ns === ns)
      if (entry === undefined) throw rejected(`entry '${ns}' vanished after the write`)
      return applyError === undefined ? entry : { ...entry, applyError }
    })
    this.serial = run.catch(() => undefined)
    return run
  }

  /** The planned text for a write, nothing written (exposed for tests). */
  plan(ns: string, write: SettingsWrite, expectedRevision?: number): Promise<string> {
    return planWrite(this, ns, write, expectedRevision)
  }

  validator(): Validator {
    return this.validate
  }
}

/**
 * The settings surface for a run booted with these options: its layers are built exactly as `boot` builds
 * them (the default layers, then each in-memory override as `override N`), so a write is judged against the
 * tree the server is running.
 */
export function settingsServiceFor(
  options: LayerOptions & { readonly overrides?: readonly Layer[]; readonly configDir?: string },
  env: NodeJS.ProcessEnv = process.env,
  apply?: Applier,
): SettingsService {
  const layers: NamedLayer[] = [...defaultLayers({ ...options, env })]
  for (const [index, override] of (options.overrides ?? []).entries()) {
    layers.push({ layer: `override ${index + 1}`, file: '(inline)', entries: [override] })
  }
  return new SettingsService(layers, settingsTarget(options, layers, env), env, validateRows, rowSchemaJson, apply)
}

/** Answer `GET /api/settings`, `GET /api/settings/{ns}` and `POST /api/settings/{ns}`; `undefined` for any other path. */
export async function handleSettingsRequest(
  service: SettingsService,
  method: string,
  path: string,
  body: string,
): Promise<{ readonly status: number; readonly body: unknown } | undefined> {
  const pathname = path.split('?')[0] ?? path
  if (!pathname.startsWith('/api/settings')) return undefined
  const rest = pathname.slice('/api/settings'.length)
  let ns: string | undefined
  if (rest === '' || rest === '/') ns = undefined
  else if (rest.startsWith('/')) {
    try {
      ns = decodeURIComponent(rest.slice(1))
    } catch {
      return undefined
    }
  } else return undefined
  const fail = (status: number, code: string, error: string) => ({ status, body: { code, error } })
  const problems = (error: unknown) => (error instanceof ConfigError ? error.problems.join('; ') : (error as Error).message)

  if (method === 'GET') {
    let view: SettingsView
    try {
      view = await service.describe()
    } catch (error) {
      return fail(422, 'settings-rejected', problems(error))
    }
    if (ns === undefined) return { status: 200, body: view }
    const entry = view.namespaces.find((candidate) => candidate.ns === ns)
    return entry === undefined ? fail(404, 'settings-rejected', `no entry '${ns}'`) : { status: 200, body: entry }
  }
  if (method !== 'POST' || ns === undefined) return fail(405, 'bad-request', `${method} is not a settings method here`)

  let request: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    request = parsed as Record<string, unknown>
  } catch {
    return fail(400, 'bad-request', 'the body must be a JSON object')
  }
  const expected = request.expectedRevision
  if (expected !== undefined && expected !== null && !(typeof expected === 'number' && Number.isInteger(expected) && expected >= 0)) {
    return fail(400, 'bad-request', 'expectedRevision must be a whole number')
  }
  const object = (value: unknown) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)
  const update = object(request.update)
  const replace = object(request.replace)
  const ops = request.ops
  let write: SettingsWrite
  if (update !== undefined && replace === undefined && ops === undefined) write = { kind: 'update', fields: update }
  else if (replace !== undefined && update === undefined && ops === undefined) write = { kind: 'replace', fields: replace }
  else if (ops !== undefined && update === undefined && replace === undefined) {
    const parsed = parseOps(ops)
    if (typeof parsed === 'string') return fail(400, 'bad-request', `ops: ${parsed}`)
    write = { kind: 'mutate', ops: parsed }
  } else return fail(400, 'bad-request', 'send exactly one of update or replace (an object) or ops (a list)')

  try {
    const entry = await service.write(ns, write, typeof expected === 'number' ? expected : undefined)
    return { status: 200, body: entry }
  } catch (error) {
    if (error instanceof SettingsError && error.code === 'settings-conflict') {
      return { status: 409, body: { code: error.code, error: error.message, expected: error.expected, actual: error.actual } }
    }
    return fail(422, 'settings-rejected', problems(error))
  }
}

function parseOps(value: unknown): readonly SettingsPathOp[] | string {
  if (!Array.isArray(value)) return 'expected a list'
  const ops: SettingsPathOp[] = []
  for (const [index, entry] of value.entries()) {
    const record = entry as Record<string, unknown> | null
    const path = record?.path
    if (record === null || typeof record !== 'object' || !Array.isArray(path) || !path.every((segment) => typeof segment === 'string')) {
      return `op ${index} needs a path of strings`
    }
    if (record.op === 'set' && 'value' in record) ops.push({ op: 'set', path: path as string[], value: record.value })
    else if (record.op === 'unset') ops.push({ op: 'unset', path: path as string[] })
    else return `op ${index} must be set (with a value) or unset`
  }
  return ops
}

interface State {
  readonly target: SettingsTarget | undefined
  readonly boot: readonly NamedLayer[]
  readonly before: string
  readonly after: string
  readonly managed: readonly (readonly [string, unknown])[]
  readonly current: readonly NamedLayer[]
  readonly base: readonly NamedLayer[]
}

function readState(layers: readonly NamedLayer[], target: SettingsTarget | undefined, env: NodeJS.ProcessEnv): State {
  if (target === undefined) return { target, boot: layers, before: '', after: '', managed: [], current: layers, base: layers }
  let text = ''
  try {
    text = readFileSync(target.path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError([`could not read ${target.path}: ${(error as Error).message}`])
  }
  const split = splitBlock(text)
  if (typeof split === 'string') throw new ConfigError([`${target.path}: ${split}`])
  const managed = split.block === undefined ? [] : parseBlock(split.block, target.path, env)
  const partial = { target, boot: layers }
  return {
    ...partial,
    before: split.before,
    after: split.after,
    managed,
    current: withTargetText(partial, text, env),
    base: withTargetText(partial, split.before + split.after, env),
  }
}

function withTargetText(state: { readonly target: SettingsTarget | undefined; readonly boot: readonly NamedLayer[] }, text: string, env: NodeJS.ProcessEnv): readonly NamedLayer[] {
  const target = state.target
  if (target === undefined) return state.boot
  const layers = state.boot.filter((layer) => layer.file !== target.path)
  const entries = readLayerText(text, target.path, { env })
  if (entries.length > 0) layers.splice(Math.min(target.index, layers.length), 0, { layer: target.label, file: target.path, entries })
  return layers
}

function splitBlock(text: string): { before: string; block?: string; after: string } | string {
  const begin = lineStart(text, SETTINGS_BEGIN, 0)
  if (begin === undefined) return { before: text, after: '' }
  const newline = text.indexOf('\n', begin)
  const bodyStart = newline < 0 ? text.length : newline + 1
  const end = lineStart(text, SETTINGS_END, bodyStart)
  if (end === undefined) return 'the settings block has no end marker'
  const endLine = text.indexOf('\n', end)
  const afterStart = endLine < 0 ? text.length : endLine + 1
  return { before: text.slice(0, begin), block: text.slice(bodyStart, end), after: text.slice(afterStart) }
}

function lineStart(text: string, marker: string, from: number): number | undefined {
  let offset = from
  while (offset <= text.length) {
    if (text.startsWith(marker, offset)) return offset
    const next = text.indexOf('\n', offset)
    if (next < 0) return undefined
    offset = next + 1
  }
  return undefined
}

function parseBlock(block: string, path: string, env: NodeJS.ProcessEnv): readonly (readonly [string, unknown])[] {
  const managed: [string, unknown][] = []
  for (const layer of readLayerText(block, path, { env })) {
    for (const item of layer.patch ?? []) {
      const record = item as unknown as Record<string, unknown>
      if (typeof record.id === 'string' && 'config' in record) {
        const at = managed.findIndex(([id]) => id === record.id)
        if (at >= 0) managed.splice(at, 1)
        managed.push([record.id, record.config])
      }
    }
  }
  return managed
}

function outsideIsBlockList(text: string): boolean {
  const first = text
    .split('\n')
    .map((line) => line.trimStart())
    .find((line) => line.length > 0 && !line.startsWith('#'))
  return first === undefined || first.startsWith('-')
}

function render(state: State, managed: readonly (readonly [string, unknown])[]): string {
  let text = state.before
  if (managed.length > 0) {
    if (!outsideIsBlockList(state.before + state.after)) {
      throw rejected('the profile patch is not a block list of layers, so the settings block cannot be appended; write the entry by hand')
    }
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    text += `${SETTINGS_BEGIN}${BEGIN_NOTE}\n- patch:\n`
    for (const [id, config] of managed) text += `    - id: ${JSON.stringify(id)}\n      config: ${flow(config)}\n`
    text += `${SETTINGS_END}\n`
  }
  return text + state.after
}

const isEnv = (value: unknown): value is { __env: string } =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { __env?: unknown }).__env === 'string' && Object.keys(value).length === 1

/** A raw value as one line of YAML flow: JSON, with `!env NAME` for an environment value. */
export function flow(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`
  if (isEnv(value)) return `!env ${value.__env}`
  const record = value as Record<string, unknown>
  if (typeof record.__include === 'string') throw rejected(`a config value written as !include ${record.__include} cannot be restated by the settings block`)
  return `{${Object.entries(record)
    .map(([key, child]) => `${JSON.stringify(key)}: ${flow(child)}`)
    .join(', ')}}`
}

const idOf = (item: unknown): string | undefined => {
  const id = (item as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : undefined
}

/** The raw `config` row `ns` composes to: that of the last insert or patch naming it with one. */
function rawConfig(layers: readonly NamedLayer[], ns: string): unknown {
  let config: unknown
  for (const layer of layers) {
    for (const entry of layer.entries) {
      for (const item of entry.insert ?? []) if (idOf(item) === ns) config = (item as { config?: unknown }).config ?? null
      for (const item of entry.patch ?? []) if (idOf(item) === ns && 'config' in (item as object)) config = (item as { config?: unknown }).config
    }
  }
  return config === null ? undefined : config
}

const isMapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && !isEnv(value)

function secretSlots(raw: unknown, env: NodeJS.ProcessEnv): SecretSlot[] {
  const slots: SecretSlot[] = []
  const resolves = (names: readonly string[]) => names.every((name) => env[name] !== undefined)
  const walk = (value: unknown, path: string[]) => {
    if (isEnv(value)) slots.push({ path: [...path], set: resolves([value.__env]) })
    else if (typeof value === 'string' && referencesIn(value).length > 0) slots.push({ path: [...path], set: resolves(referencesIn(value)) })
    else if (Array.isArray(value)) value.forEach((child, index) => walk(child, [...path, String(index)]))
    else if (isMapping(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (isSecretKey(key)) slots.push({ path: [...path, key], set: child !== null && child !== undefined })
        else walk(child, [...path, key])
      }
    }
  }
  walk(raw, [])
  return slots
}

function redact(value: unknown, secrets: readonly SecretSlot[]): unknown {
  const copy = structuredClone(value)
  for (const slot of secrets) {
    const parents = slot.path.slice(0, -1)
    const last = slot.path[slot.path.length - 1]
    if (last === undefined) continue
    let cursor: unknown = copy
    for (const segment of parents) cursor = (cursor as Record<string, unknown> | undefined)?.[segment]
    if (Array.isArray(cursor)) {
      const index = Number(last)
      if (Number.isInteger(index) && index < cursor.length) cursor[index] = null
    } else if (cursor !== null && typeof cursor === 'object') delete (cursor as Record<string, unknown>)[last]
  }
  return copy
}

function digest(state: State, ns: string): string {
  const target = state.target
  if (target === undefined) return ''
  let text = ''
  for (const layer of state.current.filter((candidate) => candidate.file === target.path)) {
    for (const entry of layer.entries) {
      for (const item of [...(entry.insert ?? []), ...(entry.patch ?? [])]) if (idOf(item) === ns) text += `${flowSafe(item)}\n`
      for (const id of entry.remove ?? []) if (id === ns) text += 'remove\n'
    }
  }
  return text
}

const flowSafe = (value: unknown) => {
  try {
    return flow(value)
  } catch {
    return ''
  }
}

function notEditable(state: State, ns: string): string | undefined {
  const target = state.target
  if (target === undefined) return undefined
  const position = state.current.findIndex((layer) => layer.file === target.path)
  const overlaysFrom = position >= 0 ? position + 1 : Math.min(target.index, state.current.length)
  let insertedAt: number | undefined
  state.current.forEach((layer, index) => {
    for (const entry of layer.entries) if ((entry.insert ?? []).some((item) => idOf(item) === ns)) insertedAt = index
  })
  if (insertedAt === undefined) return `entry '${ns}' is not inserted by any layer`
  if (insertedAt >= overlaysFrom) return `entry '${ns}' is inserted by ${state.current[insertedAt]?.layer}, which is not the profile's own layer`
  for (const layer of state.current.slice(overlaysFrom)) {
    for (const entry of layer.entries) {
      const restated = [...(entry.insert ?? []), ...(entry.patch ?? [])].some((item) => idOf(item) === ns && 'config' in (item as object))
      const removed = (entry.remove ?? []).includes(ns)
      if (restated || removed) return `entry '${ns}' is ${removed ? 'removed' : 'restated'} by ${layer.layer}, which takes precedence over the profile patch`
    }
  }
  return undefined
}

async function namespaceOf(
  state: State,
  ns: string,
  row: ComposedRow,
  baseRows: readonly ComposedRow[] | undefined,
  env: NodeJS.ProcessEnv,
  revisions: SettingsRevisions,
  schemaOf: SchemaReader,
  live: boolean,
): Promise<SettingsNamespace> {
  const raw = rawConfig(state.current, ns)
  const secrets = raw === undefined ? [] : secretSlots(raw, env)
  const value = redact(row.row.config ?? {}, secrets)
  const baseRow = baseRows?.find((candidate) => candidate.row.id === ns)
  const managed = state.managed.find(([id]) => id === ns)
  let user: unknown
  if (managed !== undefined) {
    const below = rawConfig(state.base, ns)
    const fields: Record<string, unknown> = {}
    if (isMapping(managed[1])) {
      for (const [key, child] of Object.entries(managed[1])) {
        const beneath = isMapping(below) ? below[key] : undefined
        if (JSON.stringify(beneath) !== JSON.stringify(child)) {
          try {
            fields[key] = resolveEnv(child, { file: 'settings', env })
          } catch {
            // an unresolved reference is reported by describe's own composition
          }
        }
      }
    }
    user = redact(fields, secrets)
  }
  const reason = state.target === undefined ? 'this run has no profile patch to write' : notEditable(state, ns)
  return {
    ns,
    component: row.row.name,
    autoGenerate: true,
    schema: await schemaOf(row.row, state.current),
    value,
    ...(baseRow !== undefined ? { base: redact(baseRow.row.config ?? {}, secrets) } : {}),
    ...(user !== undefined ? { user } : {}),
    applies: live ? 'live' : 'restart',
    secrets,
    revision: revisions.revision(ns, digest(state, ns)),
    editable: reason === undefined,
    ...(reason !== undefined ? { reason } : {}),
  }
}

async function planWrite(service: SettingsService, ns: string, write: SettingsWrite, expectedRevision: number | undefined): Promise<string> {
  const target = service.target
  if (target === undefined) {
    throw rejected(
      'this run has no profile patch to write: start it with --profile, or from a project whose heddle.patch.yml it applies (a --patch overlay is never a write target)',
    )
  }
  let state: State
  let rows: readonly ComposedRow[]
  try {
    state = readState(service.layers, target, service.env)
    rows = compose(state.current, service.env)
  } catch (error) {
    throw rejected(error instanceof ConfigError ? error.problems.join('; ') : (error as Error).message)
  }
  if (!rows.some((row) => row.row.id === ns)) throw rejected(`no entry '${ns}' in this run's configuration`)
  const reason = notEditable(state, ns)
  if (reason !== undefined) throw rejected(reason)
  const actual = service.revisions.revision(ns, digest(state, ns))
  if (expectedRevision !== undefined && expectedRevision !== actual) throw conflict(expectedRevision, actual)

  const current = rawConfig(state.current, ns) ?? {}
  const base = rawConfig(state.base, ns) ?? {}
  const next = applyWrite(current, base, write)
  const managed = state.managed.filter(([id]) => id !== ns).map(([id, config]) => [id, config] as const)
  if (JSON.stringify(next) !== JSON.stringify(base)) {
    const at = state.managed.findIndex(([id]) => id === ns)
    if (at >= 0) managed.splice(at, 0, [ns, next])
    else managed.push([ns, next])
  }
  const text = render(state, managed)
  let result: ValidationResult
  try {
    result = await service.validator()(withTargetText(state, text, service.env), service.env)
  } catch (error) {
    throw rejected(error instanceof ConfigError ? error.problems.join('; ') : (error as Error).message)
  }
  if (result.problems.length > 0) throw rejected(result.problems.join('; '))
  return text
}

function commitWrite(target: SettingsTarget, text: string): void {
  const temporary = join(dirname(target.path), `.${PROJECT_PATCH}.settings-${process.pid}`)
  try {
    writeFileSync(temporary, text)
    try {
      chmodSync(temporary, statSync(target.path).mode)
    } catch {
      // a new file keeps the default mode
    }
    renameSync(temporary, target.path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw rejected(`could not write ${target.path}: ${(error as Error).message}`)
  }
}

function holdsReference(value: unknown): boolean {
  if (typeof value === 'string') return referencesIn(value).length > 0
  if (Array.isArray(value)) return value.some(holdsReference)
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(holdsReference)
  return false
}

function getPath(value: unknown, path: readonly string[]): { found: boolean; value?: unknown } {
  let cursor = value
  for (const segment of path) {
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index >= cursor.length) return { found: false }
      cursor = cursor[index]
    } else if (isMapping(cursor) && segment in cursor) cursor = cursor[segment]
    else return { found: false }
  }
  return { found: true, value: cursor }
}

function setPath(value: unknown, path: readonly string[], next: unknown): unknown {
  const [first, ...rest] = path
  if (first === undefined) return next
  if (Array.isArray(value)) {
    const index = Number(first)
    if (!Number.isInteger(index)) throw rejected(`'${first}' does not index a list`)
    if (index > value.length) throw rejected(`index ${index} is past the end of a list of ${value.length}`)
    const copy = [...value]
    copy[index] = setPath(index < value.length ? value[index] : null, rest, next)
    return copy
  }
  const record = isMapping(value) ? { ...value } : {}
  record[first] = setPath(record[first] ?? (rest.length === 0 ? null : {}), rest, next)
  return record
}

function unsetPath(value: unknown, path: readonly string[]): unknown {
  const [first, ...rest] = path
  if (first === undefined) return value
  if (Array.isArray(value)) {
    const index = Number(first)
    if (!Number.isInteger(index) || index >= value.length) return value
    if (rest.length === 0) return value.filter((_, at) => at !== index)
    const copy = [...value]
    copy[index] = unsetPath(value[index], rest)
    return copy
  }
  if (!isMapping(value) || !(first in value)) return value
  const record = { ...value }
  if (rest.length === 0) delete record[first]
  else record[first] = unsetPath(record[first], rest)
  return record
}

function applyWrite(current: unknown, base: unknown, write: SettingsWrite): unknown {
  const secrets = secretSlots(current, {}).map((slot) => slot.path)
  const check = (path: readonly string[], value?: unknown) => {
    if (path.length === 0) throw rejected('a settings write names a field, not the whole config')
    const startsWith = (long: readonly string[], short: readonly string[]) => short.every((segment, index) => long[index] === segment)
    if (path.some(isSecretKey) || secrets.some((secret) => startsWith(path, secret) || startsWith(secret, path))) {
      throw rejected(`'${path.join('.')}' is a secret: credentials come from the environment or the machine file, not the profile`)
    }
    if (value !== undefined && holdsReference(value)) throw rejected(`the value for '${path.join('.')}' holds an environment reference; write the literal value`)
  }
  let next: unknown = isMapping(current) ? structuredClone(current) : {}
  if (write.kind === 'update') {
    for (const [key, value] of Object.entries(write.fields)) {
      check([key], value)
      next = setPath(next, [key], value)
    }
  } else if (write.kind === 'replace') {
    let reset: unknown = isMapping(base) ? structuredClone(base) : {}
    for (const secret of secrets) {
      const found = getPath(current, secret)
      if (found.found) reset = setPath(reset, secret, found.value)
    }
    next = reset
    for (const [key, value] of Object.entries(write.fields)) {
      check([key], value)
      next = setPath(next, [key], value)
    }
  } else {
    for (const op of write.ops) {
      if (op.op === 'set') {
        check(op.path, op.value)
        next = setPath(next, op.path, op.value)
      } else {
        check(op.path)
        const beneath = getPath(base, op.path)
        next = beneath.found ? setPath(next, op.path, beneath.value) : unsetPath(next, op.path)
      }
    }
  }
  return next
}

