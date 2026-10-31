import { Service, type Context } from '@deepseek-ai/cordis'

import { LocaleConfig, negotiateLocale, acceptedLanguages, type Locale, type LocaleRowConfig } from '../config/locale.ts'

export const name = 'locale'

/**
 * The `locale` row: the interface language a person chose (issue #80, DSH's dsh-client-locale).
 *
 * The row exists so the choice is a setting: the settings API lists it as namespace `locale` and writes
 * `preference` into the active profile's patch, as DSH writes `locale.preference`. Optional: a server reads it with
 * `ctx.get('locale')`, and a profile without the row follows each browser's languages. See `src/config/locale.ts`.
 */
export default class LocaleService extends Service {
  static readonly Config = LocaleConfig

  readonly preference: Locale | undefined

  constructor(ctx: Context, config: LocaleRowConfig = {}) {
    super(ctx, 'locale')
    this.preference = config.preference
  }

  /** The language for a request: the stored preference, else what its `Accept-Language` asks for, else English. */
  forRequest(acceptLanguage: string | undefined): Locale {
    return negotiateLocale(this.preference, acceptedLanguages(acceptLanguage))
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by the optional `locale` row; read with `ctx.get('locale')`. */
    locale: LocaleService
  }
}
