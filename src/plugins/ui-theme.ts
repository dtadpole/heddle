import { Service, type Context } from '@deepseek-ai/cordis'

import { ThemeConfig, themeSettings, type ThemeRowConfig, type ThemeSettings } from '../config/theme.ts'

export const name = 'ui-theme'

/**
 * The `ui-theme` row: appearance and typography preferences (issue #81, DSH's dsh-client-ui-theme).
 *
 * The row exists so the choices are a setting every browser shares: the settings API lists it as namespace `ui-theme`
 * and writes its fields into the active profile's patch, as DSH writes its `ui-theme` namespace. Optional: a server
 * reads it with `ctx.get('uiTheme')`, and a profile without the row serves DSH's defaults. See `src/config/theme.ts`.
 */
export default class UiThemeService extends Service {
  static readonly Config = ThemeConfig

  readonly settings: ThemeSettings

  constructor(ctx: Context, config: ThemeRowConfig = {}) {
    super(ctx, 'uiTheme')
    this.settings = themeSettings(config)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by the optional `ui-theme` row; read with `ctx.get('uiTheme')`. */
    uiTheme: UiThemeService
  }
}
