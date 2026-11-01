import { Service, type Context } from '@deepseek-ai/cordis'

import {
  PresetsConfig,
  presetRoster,
  resolvePreset,
  type PresetDefinition,
  type PresetResolution,
  type PresetRoster,
  type PresetsRowConfig,
} from '../config/presets.ts'

export const name = 'presets'

/**
 * The `presets` row: the agent preset registry (DSH's dsh-agent-preset-registry), as the `presets` service.
 *
 * Optional, like the live-turn registry: the loop reads it with `ctx.get('presets')`, and a profile without the row
 * runs every session with every tool and the profile's own system prompt. The roster is validated when the row loads,
 * so a duplicate id or a default nothing declares fails the run at startup instead of at someone's first turn.
 * See `src/config/presets.ts` for the rules.
 */
export default class PresetService extends Service {
  static readonly Config = PresetsConfig

  readonly roster: PresetRoster

  constructor(ctx: Context, config: PresetsRowConfig = {}) {
    super(ctx, 'presets')
    this.roster = presetRoster(config)
  }

  /** Every preset, in roster order. */
  list(): readonly PresetDefinition[] {
    return this.roster.presets
  }

  /** The preset a new session gets when it names none. */
  defaultId(): string {
    return this.roster.default
  }

  /** The preset a session recorded (or the default, for none), or the id that is no longer declared. */
  resolve(id: string | undefined): PresetResolution {
    return resolvePreset(this.roster, id)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by the optional `presets` row; read with `ctx.get('presets')`. */
    presets: PresetService
  }
}
