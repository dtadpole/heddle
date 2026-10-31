import Schema from '@deepseek-ai/schemastery'

/**
 * Appearance and typography preferences (issue #81): DSH's dsh-client-ui-theme `ui-theme` settings namespace, as
 * heddle's `ui-theme` profile row. The Rust port's twin is `heddle-config`'s `theme` module; the rules are the same.
 *
 * The row stores the theme preference (`light`, `dark` or `system`, DSH's default `system`), the text, code and
 * terminal font sizes (whole pixels: 10-22 default 14, 10-16 default 11, 10-20 default 13) and three font-family lists
 * (empty means the built-in stack). Every browser shares them, because they are a setting, not browser storage. The
 * server hands them to the page on the served `<html>` element, as a `data-theme` attribute and CSS custom properties,
 * so the first paint already uses them. DSH embeds a boot style and script for the same purpose; heddle uses
 * attributes, because the page's script policy hashes its inline scripts.
 */

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const
export type ThemePreference = (typeof THEME_PREFERENCES)[number]

/** The preference when the row stores none: DSH's `DEFAULT_PREFERENCE`. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'

/** One font role's size: its settings field, the CSS custom property the page reads, and its range in pixels. */
export interface FontSizeSpec {
  readonly field: 'fontSize' | 'codeFontSize' | 'terminalFontSize'
  readonly variable: string
  readonly min: number
  readonly max: number
  readonly default: number
}

/** DSH's `FONT_SIZE_SPECS`: text is the conversation content, code the code blocks, terminal the sidebar terminal. */
export const FONT_SIZE_SPECS: readonly FontSizeSpec[] = [
  { field: 'fontSize', variable: '--heddle-content-font-size', min: 10, max: 22, default: 14 },
  { field: 'codeFontSize', variable: '--heddle-code-font-size', min: 10, max: 16, default: 11 },
  { field: 'terminalFontSize', variable: '--heddle-terminal-font-size', min: 10, max: 20, default: 13 },
]

/** Each role's font-family field and the CSS custom property that carries its list ahead of the built-in stack. */
export const FONT_FAMILY_FIELDS = [
  ['textFontFamily', '--heddle-font-family-text'],
  ['codeFontFamily', '--heddle-font-family-code'],
  ['terminalFontFamily', '--heddle-font-family-terminal'],
] as const

function fontSize(spec: FontSizeSpec): Schema<number> {
  return Schema.number().step(1).min(spec.min).max(spec.max).default(spec.default)
}

export interface ThemeRowConfig {
  readonly preference?: ThemePreference
  readonly fontSize?: number
  readonly codeFontSize?: number
  readonly terminalFontSize?: number
  readonly textFontFamily?: string
  readonly codeFontFamily?: string
  readonly terminalFontFamily?: string
}

/** DSH's `ui-theme` schema. */
export const ThemeConfig: Schema<ThemeRowConfig> = Schema.object({
  preference: Schema.union([Schema.const('light'), Schema.const('dark'), Schema.const('system')]).default(DEFAULT_THEME_PREFERENCE),
  fontSize: fontSize(FONT_SIZE_SPECS[0] as FontSizeSpec),
  codeFontSize: fontSize(FONT_SIZE_SPECS[1] as FontSizeSpec),
  terminalFontSize: fontSize(FONT_SIZE_SPECS[2] as FontSizeSpec),
  textFontFamily: Schema.string().default(''),
  codeFontFamily: Schema.string().default(''),
  terminalFontFamily: Schema.string().default(''),
}) as Schema<ThemeRowConfig>

/** The row's settings, defaults filled in. */
export interface ThemeSettings {
  readonly preference: ThemePreference
  /** Text, code and terminal sizes in pixels, in `FONT_SIZE_SPECS` order. */
  readonly fontSizes: readonly [number, number, number]
  /** Text, code and terminal font lists, normalized, in `FONT_FAMILY_FIELDS` order; empty means the built-in stack. */
  readonly fontFamilies: readonly [string, string, string]
}

/** The settings a validated row configuration describes. */
export function themeSettings(config: ThemeRowConfig = {}): ThemeSettings {
  const preference = THEME_PREFERENCES.find((candidate) => candidate === config.preference) ?? DEFAULT_THEME_PREFERENCE
  const sizes = FONT_SIZE_SPECS.map((spec) => {
    const value = config[spec.field]
    return typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max ? value : spec.default
  })
  const families = FONT_FAMILY_FIELDS.map(([field]) => normalizeFontFamily(config[field] ?? ''))
  return {
    preference,
    fontSizes: [sizes[0] ?? 14, sizes[1] ?? 11, sizes[2] ?? 13],
    fontFamilies: [families[0] ?? '', families[1] ?? '', families[2] ?? ''],
  }
}

/** CSS generic and system family keywords, which stay unquoted (DSH's `GENERIC_FAMILIES`). */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
  'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont',
])

/**
 * DSH's `normalizeFontFamily`: comma-separated names; quotes, backslashes, angle brackets and control characters
 * dropped; runs of whitespace folded; every name but a generic family double-quoted. Normalizing a result returns it
 * unchanged, and the result is always a valid list, safe inside CSS.
 */
export function normalizeFontFamily(value: string): string {
  return value
    .split(',')
    // eslint-disable-next-line no-control-regex
    .map((name) => name.replace(/["'\\<>\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim())
    .filter((name) => name !== '')
    .map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name}"`))
    .join(', ')
}

/**
 * What the served `<html>` element carries: ` data-theme="…" style="…"`, with a leading space. The style holds each
 * font size, and each font list that is not empty, as the custom properties the page's CSS reads.
 */
export function documentAttributes(settings: ThemeSettings): string {
  let style = ''
  FONT_SIZE_SPECS.forEach((spec, index) => {
    style += `${spec.variable}:${settings.fontSizes[index]}px;`
  })
  FONT_FAMILY_FIELDS.forEach(([, variable], index) => {
    const list = settings.fontFamilies[index] ?? ''
    if (list !== '') style += `${variable}:${list};`
  })
  return ` data-theme="${settings.preference}" style="${style.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`
}
