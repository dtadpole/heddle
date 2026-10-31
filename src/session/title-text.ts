/**
 * How an accepted session title is cleaned: DSH's `normalizeSessionTitle`, verbatim (live-testing draft developer-six-1).
 *
 * `dsh-session-title` `lib/index.js:10-54` removes terminal control sequences (OSC, CSI, two-character ESC), non-whitespace
 * C0/C1 controls and the directional and invisible controls that can make a displayed title deceptive, collapses whitespace
 * into one trimmed line, and cuts the result to `maxTitleBytes` UTF-8 bytes without splitting a code point. Its `rename`
 * applies the rule before accepting a title (`:295-306`), and the session controller answers `session/title-invalid` when
 * nothing visible is left (`dsh-api-session-controller` `lib/index.js:827-840`). `maxTitleBytes` is 80 in DSH's shipped
 * profile (`dsh-base/cordis.patch.yml:60-65`); the README's 120 is an example configuration.
 *
 * Both stores apply it to every title they write — a rename, a session created with a title, and a definition's title —
 * so a title can neither carry escape sequences to a terminal (the CLI's session list prints it raw) nor reorder how a row
 * reads. The rule and its regular expressions are the ones `hd/developer-eight-auto-title` uses for a generated title
 * (`src/session/title.ts`); once both land, that module can import them from here.
 */

/** `session-title.maxTitleBytes` in DSH's shipped profile: the most UTF-8 bytes an accepted title holds. */
export const MAX_TITLE_BYTES = 80

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/** DSH's `cleanTitleText`: controls removed, one trimmed line with whitespace runs collapsed. */
export function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** The longest leading code-point prefix of `input` within `maxBytes` UTF-8 bytes (DSH's `truncateTitleUtf8`). */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/** DSH's `normalizeSessionTitle`: a terminal-safe one-line title within `maxBytes`, possibly empty. */
export function normalizeSessionTitle(input: string, maxBytes: number = MAX_TITLE_BYTES): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd()
}

/** DSH's refusal of a title with nothing visible left, word for word (`SessionTitleInvalidError`, `session/title-invalid`). */
export const TITLE_INVALID = Object.freeze({
  code: 'session/title-invalid',
  message: 'session title must contain visible characters',
})
