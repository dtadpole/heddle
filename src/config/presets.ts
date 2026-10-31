import Schema from '@deepseek-ai/schemastery'

import { ConfigError } from './schema.ts'

/**
 * Agent presets (inventory A96): DSH's dsh-agent-preset, dsh-agent-preset-registry and dsh-persona, as a profile row.
 *
 * A preset is a named composition a session runs under. In DSH it is a list of child plugin rows; heddle's tools and
 * system prompt are already rows of one profile, so a preset here names what it narrows: the **tools** its sessions are
 * offered (absent means every tool the profile registers) and the **persona** their system prompt is written from
 * (absent means the profile's own). The registry's `default` is the preset a new session gets when it names none.
 *
 * DSH's rules kept here:
 * - a session records its preset id when it is created and keeps it, so editing a preset or the default affects
 *   sessions created afterwards (the session store records the id; this module only resolves it);
 * - duplicate preset ids fail the declaration;
 * - a recorded id that is no longer declared is **rejected**, not silently replaced ("recovery after restart uses the
 *   current definition of that ID and rejects a missing definition").
 *
 * A profile that declares no presets gets one implicit `standard` preset with every tool, so nothing changes until a
 * profile opts in. The Rust port's twin is `heddle-config`'s `presets` module.
 */

/** One declared preset. */
export interface PresetDefinition {
  /** The stable identity a session records. */
  readonly id: string
  /** What a person reads; the id when absent. */
  readonly name?: string
  readonly description?: string
  /** Roster order, lowest first; declaration order breaks ties. */
  readonly order?: number
  /** The tools its sessions are offered, by name. Absent means every registered tool. */
  readonly tools?: readonly string[]
  /** The system prompt its sessions are written from, shadowing the profile's (DSH's persona `prefix`). */
  readonly persona?: string
}

/** The validated roster: every preset, in roster order, and the one a new session gets. */
export interface PresetRoster {
  readonly default: string
  readonly presets: readonly PresetDefinition[]
}

/** The implicit preset of a profile that declares none: every tool, the profile's own system prompt. */
export const STANDARD_PRESET: PresetDefinition = {
  id: 'standard',
  name: 'Standard',
  description: 'Every tool this profile registers, with its own system prompt.',
}

const PresetSchema = Schema.object({
  id: Schema.string().required(),
  name: Schema.string(),
  description: Schema.string(),
  order: Schema.number(),
  /**
   * A union with `undefined` keeps an absent list absent: Schemastery otherwise resolves a missing array to `[]`, which
   * would read as "no tools" and leave a preset that named none with nothing to offer (measured through the loader).
   */
  tools: Schema.union([Schema.array(Schema.string()), Schema.const(undefined)]),
  persona: Schema.string(),
})

/** The `presets` row's configuration. */
export const PresetsConfig = Schema.object({
  /** The preset a new session gets when it names none. */
  default: Schema.string(),
  /** The declared presets. Empty means the implicit `standard` preset. */
  presets: Schema.array(PresetSchema).default([]),
})

/** The row's configuration as the loader hands it over. */
export interface PresetsRowConfig {
  readonly default?: string
  readonly presets?: readonly PresetDefinition[]
}

/**
 * Validate a `presets` row into its roster, or throw a `ConfigError` that names every problem.
 *
 * An id must be non-empty and declared once; `default` must name a declared preset, and defaults to `standard` (or the
 * only declared preset, when there is one). The roster is sorted by `order`, then by declaration.
 */
export function presetRoster(config: PresetsRowConfig = {}): PresetRoster {
  const declared = config.presets ?? []
  if (declared.length === 0) {
    const wanted = config.default
    if (wanted !== undefined && wanted !== STANDARD_PRESET.id) {
      throw new ConfigError([`presets: the default preset '${wanted}' is not declared; declared: ${STANDARD_PRESET.id}`])
    }
    return { default: STANDARD_PRESET.id, presets: [STANDARD_PRESET] }
  }
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [index, preset] of declared.entries()) {
    const id = typeof preset.id === 'string' ? preset.id.trim() : ''
    if (id.length === 0) problems.push(`presets: entry ${index + 1} has no id`)
    else if (seen.has(id)) problems.push(`presets: the preset '${id}' is declared twice`)
    else seen.add(id)
  }
  const ids = [...seen]
  const wanted = config.default ?? (ids.length === 1 ? ids[0] : STANDARD_PRESET.id)
  if (wanted !== undefined && !seen.has(wanted)) {
    problems.push(`presets: the default preset '${wanted}' is not declared; declared: ${ids.join(', ')}`)
  }
  if (problems.length > 0) throw new ConfigError(problems)
  const presets = declared
    .map((preset, index) => ({ preset: { ...preset, id: preset.id.trim() }, index }))
    .sort((a, b) => (a.preset.order ?? 0) - (b.preset.order ?? 0) || a.index - b.index)
    .map((entry) => entry.preset)
  return { default: wanted ?? STANDARD_PRESET.id, presets }
}

/** What resolving a session's preset answered: the definition, or the id that is no longer declared. */
export type PresetResolution =
  | { readonly preset: PresetDefinition }
  | { readonly missing: string; readonly declared: readonly string[] }

/** The preset `id` names, or the roster's default for a session that recorded none. */
export function resolvePreset(roster: PresetRoster, id: string | undefined): PresetResolution {
  const wanted = id === undefined || id.length === 0 ? roster.default : id
  const preset = roster.presets.find((entry) => entry.id === wanted)
  if (preset !== undefined) return { preset }
  return { missing: wanted, declared: roster.presets.map((entry) => entry.id) }
}

/** The sentence a turn is refused with when its session's preset is no longer declared. */
export function missingPresetMessage(resolution: { readonly missing: string; readonly declared: readonly string[] }): string {
  return `the session's preset '${resolution.missing}' is not declared in this profile; declared: ${resolution.declared.join(', ')}`
}

/**
 * The tool specs a preset's sessions are offered, in the registry's order.
 *
 * A preset with no `tools` list keeps every spec. A name the preset lists that nothing registered is simply absent,
 * as it is for the profile's own tools; the preset narrows what exists, it does not create tools.
 */
export function presetToolSpecs<T extends { readonly name: string }>(preset: PresetDefinition, specs: readonly T[]): readonly T[] {
  if (preset.tools === undefined) return specs
  const allowed = new Set(preset.tools)
  return specs.filter((spec) => allowed.has(spec.name))
}

/** Whether a preset's sessions may call `tool`. */
export function presetAllows(preset: PresetDefinition, tool: string): boolean {
  return preset.tools === undefined || preset.tools.includes(tool)
}
