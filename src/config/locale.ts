import Schema from '@deepseek-ai/schemastery'

/**
 * The interface language (issue #80): DSH's dsh-client-locale, as heddle's `locale` profile row.
 *
 * DSH ships English and Chinese. A person's choice is a setting: it persists as `locale.preference` through the
 * settings service, here the `locale` row's `preference`, which the existing settings API reads and writes like any
 * other row. With no stored preference, a browser gets the first supported language it asks for, matched by full
 * tag and then by primary subtag, else English. The Rust port's `heddle-config` `locale` module is the same rule.
 */

/** The languages heddle ships, in the order a tie is broken. */
export const SUPPORTED_LOCALES = ['en', 'zh'] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

/** The language a browser gets when nothing it asks for is supported. */
export const FALLBACK_LOCALE: Locale = 'en'

/** What the settings row offers, as DSH labels its shipped locales (dsh-client-locale BUILT_IN_LOCALE_METADATA). */
export const LOCALE_LABELS: Readonly<Record<Locale, string>> = { en: 'English', zh: '中文' }

/**
 * The `<html lang>` tag for a locale: DSH's `syncDocumentLanguage` writes `zh-CN` for Chinese and the id otherwise.
 *
 * DSH's preference field takes any BCP 47 id because client plugins may add language packs; heddle ships no
 * language-pack mechanism, so its `preference` takes the two shipped ids only.
 */
export function documentLanguage(locale: Locale): string {
  return locale === 'zh' ? 'zh-CN' : locale
}

export interface LocaleRowConfig {
  /** The person's choice; absent means "follow the browser". */
  readonly preference?: Locale
}

export const LocaleConfig: Schema<LocaleRowConfig> = Schema.object({
  preference: Schema.union([Schema.const('en'), Schema.const('zh')]).description(
    'The interface language: en or zh. Absent: the first supported language the browser asks for, else English.',
  ),
})

/**
 * The languages an `Accept-Language` header asks for, most wanted first: q-values order them, a `q=0` entry is
 * refused, and `*` names nothing in particular so it is dropped.
 */
export function acceptedLanguages(header: string | undefined): readonly string[] {
  if (header === undefined) return []
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='))
      const weight = q === undefined ? 1 : Number(q.slice(2))
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index }
    })
    .filter((entry) => entry.tag.length > 0 && entry.tag !== '*' && entry.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.index - right.index)
    .map((entry) => entry.tag)
}

/**
 * The language to use: the stored preference when there is one, else the first requested language that matches a
 * supported one by full tag and then by primary subtag (`zh-CN` -> `zh`), else English. DSH's selection rule.
 */
export function negotiateLocale(preference: string | undefined, requested: readonly string[]): Locale {
  const supported = (tag: string): Locale | undefined => SUPPORTED_LOCALES.find((locale) => locale === tag.toLowerCase())
  if (preference !== undefined) {
    const chosen = supported(preference)
    if (chosen !== undefined) return chosen
  }
  for (const tag of requested) {
    const exact = supported(tag)
    if (exact !== undefined) return exact
    const primary = supported(tag.split('-')[0] ?? '')
    if (primary !== undefined) return primary
  }
  return FALLBACK_LOCALE
}
