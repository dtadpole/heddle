/**
 * Writes the two copies of the **unicode61 tables** content search tokenizes with, from SQLite itself.
 *
 * `node src/session/unicode61-generate.ts` rewrites `src/session/unicode61.ts` and
 * `rust/crates/heddle-session/src/unicode61.rs`. It is a developer tool, not part of a run: it needs Node's built-in
 * `node:sqlite`, which is the engine DSH's session index runs on (`dsh-session-query-sqlite` opens it with
 * `await import("node:sqlite")` and indexes with `fts5(..., tokenize = 'unicode61')`).
 *
 * Why tables and not SQLite: the Rust build has no SQLite and must give the same answers, and a second tokenizer
 * written from the Unicode standard drifts from FTS5's own (it calls every unassigned code point a token character,
 * folds only Deseret outside the BMP, strips a diacritic only from a letter that carries exactly one, and treats 25
 * combining marks as part of a token but every other mark as a separator). So the tables are **measured**: every
 * code point is put between two letters and tokenized, and what FTS5 answered is written down.
 *
 * - a separator splits `a<c>b` into `a` and `b`;
 * - a diacritic joins it into `ab`, dropping itself (and at a token's start it separates — checked below);
 * - anything else joins it as one folded character, `a<f>b`.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Range = [number, number]
type Fold = [number, number, number, number, number]

const MAX = 0x10ffff

function isSurrogate(cp: number): boolean {
  return cp >= 0xd800 && cp <= 0xdfff
}

/** What FTS5's unicode61 tokenizer makes of every code point, read back through `fts5vocab`. */
async function measure(): Promise<{ version: string; separators: Range[]; diacritics: number[]; folds: Fold[] }> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE VIRTUAL TABLE d USING fts5(text, tokenize = 'unicode61')")
  db.exec("CREATE VIRTUAL TABLE v USING fts5vocab(d, 'instance')")
  const insert = db.prepare('INSERT INTO d(rowid, text) VALUES (?, ?)')
  const START = 0x200000
  db.exec('BEGIN')
  for (let cp = 0; cp <= MAX; cp += 1) {
    if (isSurrogate(cp)) continue
    insert.run(cp, `a${String.fromCodePoint(cp)}b`)
    insert.run(START + cp, `${String.fromCodePoint(cp)}b`)
  }
  db.exec('COMMIT')
  const terms = new Map<number, string[]>()
  for (const row of db.prepare('SELECT term, doc FROM v ORDER BY doc, offset').iterate() as Iterable<{ term: string; doc: number }>) {
    const list = terms.get(row.doc) ?? []
    list.push(row.term)
    terms.set(row.doc, list)
  }
  const version = String((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v)
  db.close()

  const separatorPoints: number[] = []
  const diacritics: number[] = []
  const foldPairs: [number, number][] = []
  for (let cp = 0; cp <= MAX; cp += 1) {
    if (isSurrogate(cp)) continue
    const inside = (terms.get(cp) ?? []).join('|')
    const atStart = (terms.get(START + cp) ?? []).join('|')
    if (inside === 'a|b') {
      if (atStart !== 'b') throw new Error(`U+${cp.toString(16)} separates inside a token but not at its start (${atStart})`)
      separatorPoints.push(cp)
      continue
    }
    if (inside === 'ab') {
      if (atStart !== 'b') throw new Error(`U+${cp.toString(16)} is dropped inside a token but not separating at its start (${atStart})`)
      diacritics.push(cp)
      continue
    }
    const folded = Array.from(inside.slice(1, -1))
    if (!inside.startsWith('a') || !inside.endsWith('b') || inside.includes('|') || folded.length !== 1) {
      throw new Error(`U+${cp.toString(16)} tokenized unexpectedly: ${inside}`)
    }
    const to = folded[0]!.codePointAt(0)!
    if (atStart !== `${folded[0]}b`) throw new Error(`U+${cp.toString(16)} folds differently at a token's start (${atStart})`)
    if (to !== cp) foldPairs.push([cp, to])
  }

  /** Separator code points as inclusive ranges; the surrogate gap never splits one, because no surrogate is text. */
  const separators: Range[] = []
  for (const cp of separatorPoints) {
    const last = separators[separators.length - 1]
    if (last !== undefined && (last[1] === cp - 1 || (last[1] === 0xd7ff && cp === 0xe000))) last[1] = cp
    else separators.push([cp, cp])
  }

  /**
   * Folds as runs `[start, count, step, kind, value]`: `kind` 0 maps `cp` to `cp + value`, `kind` 1 maps every member to
   * `value`. A run steps by 1 or 2 and only over code points that fold by its own rule, so runs never overlap and a
   * reader can find a code point's run by binary search on `start`.
   */
  const folds: Fold[] = []
  for (const [cp, to] of foldPairs) {
    const run = folds[folds.length - 1]
    if (run !== undefined) {
      const [start, count, step, kind] = run
      const gap = cp - (start + (count - 1) * step)
      const stepFits = count === 1 ? gap === 1 || gap === 2 : gap === step
      if (stepFits) {
        const nextStep = count === 1 ? gap : step
        if ((count === 1 || kind === 0) && to - cp === deltaOf(run)) {
          run[1] = count + 1
          run[2] = nextStep
          run[3] = 0
          run[4] = to - cp
          continue
        }
        if ((count === 1 || kind === 1) && to === targetOf(run)) {
          run[1] = count + 1
          run[2] = nextStep
          run[3] = 1
          run[4] = to
          continue
        }
      }
    }
    folds.push([cp, 1, 1, 0, to - cp])
  }
  return { version, separators, diacritics, folds }
}

/** The delta a run applies (its first member's, for a one-member run). */
function deltaOf(run: Fold): number {
  return run[3] === 0 ? run[4] : run[4] - run[0]
}

/** The target a run maps to (its first member's, for a one-member run). */
function targetOf(run: Fold): number {
  return run[3] === 1 ? run[4] : run[0] + run[4]
}

/** Lay numbers out a few to a line, so the generated arrays stay reviewable. */
function wrap(items: readonly string[], indent: string, width = 110): string {
  const lines: string[] = []
  let line = ''
  for (const item of items) {
    const next = line.length === 0 ? `${indent}${item},` : `${line} ${item},`
    if (next.length > width && line.length > 0) {
      lines.push(line)
      line = `${indent}${item},`
    } else line = next
  }
  if (line.length > 0) lines.push(line)
  return lines.join('\n')
}

function typescript(data: Awaited<ReturnType<typeof measure>>): string {
  return `/**
 * The **unicode61 tables** content search tokenizes with — generated, do not edit.
 *
 * Written by \`node src/session/unicode61-generate.ts\` from SQLite ${data.version}'s FTS5 \`unicode61\` tokenizer with its default
 * \`remove_diacritics 1\`, which is what DSH's session index uses (\`dsh-session-query-sqlite\` lib/index.js:106-115). The
 * Rust build carries the same tables in \`rust/crates/heddle-session/src/unicode61.rs\`, and \`test/session-search.test.ts\`
 * holds both copies equal and, where \`node:sqlite\` is available, holds this one to SQLite code point by code point.
 */

/** The SQLite the tables were measured on. */
export const UNICODE61_SQLITE_VERSION = '${data.version}'

/** Inclusive code-point ranges that end a token. Every other code point is a token character. */
export const SEPARATORS: readonly (readonly [number, number])[] = [
${wrap(data.separators.map(([a, b]) => `[${a}, ${b}]`), '  ')}
]

/** Combining marks that continue a token and are dropped from it; at a token's start they separate. */
export const DIACRITICS: readonly number[] = [
${wrap(data.diacritics.map(String), '  ')}
]

/**
 * How a token character folds, as runs \`[start, count, step, kind, value]\` over \`start + i * step\` (i < count):
 * \`kind\` 0 maps a code point to itself plus \`value\`, \`kind\` 1 maps it to \`value\`. Runs do not overlap and are sorted by
 * \`start\`; a code point in none folds to itself.
 */
export const FOLDS: readonly (readonly [number, number, number, number, number])[] = [
${wrap(data.folds.map((run) => `[${run.join(', ')}]`), '  ')}
]
`
}

function rust(data: Awaited<ReturnType<typeof measure>>): string {
  return `//! The **unicode61 tables** content search tokenizes with — generated, do not edit.
//!
//! Written by \`node src/session/unicode61-generate.ts\` from SQLite ${data.version}'s FTS5 \`unicode61\` tokenizer with its
//! default \`remove_diacritics 1\`, which is what DSH's session index uses (\`dsh-session-query-sqlite\`
//! lib/index.js:106-115). \`src/session/unicode61.ts\` carries the same tables, and \`test/session-search.test.ts\` holds
//! the two copies equal. See [\`crate::search\`] for how they are read.

/// The SQLite the tables were measured on.
pub const UNICODE61_SQLITE_VERSION: &str = "${data.version}";

/// Inclusive code-point ranges that end a token. Every other code point is a token character.
#[rustfmt::skip]
pub const SEPARATORS: &[(u32, u32)] = &[
${wrap(data.separators.map(([a, b]) => `(${a}, ${b})`), '    ')}
];

/// Combining marks that continue a token and are dropped from it; at a token's start they separate.
#[rustfmt::skip]
pub const DIACRITICS: &[u32] = &[
${wrap(data.diacritics.map(String), '    ')}
];

/// How a token character folds, as runs \`(start, count, step, kind, value)\` over \`start + i * step\`
/// (i < count): \`kind\` 0 maps a code point to itself plus \`value\`, \`kind\` 1 maps it to \`value\`. Runs do
/// not overlap and are sorted by \`start\`; a code point in none folds to itself.
#[rustfmt::skip]
pub const FOLDS: &[(u32, u32, u32, u8, i64)] = &[
${wrap(data.folds.map((run) => `(${run.join(', ')})`), '    ')}
];
`
}

const here = dirname(fileURLToPath(import.meta.url))
const data = await measure()
writeFileSync(join(here, 'unicode61.ts'), typescript(data))
writeFileSync(join(here, '..', '..', 'rust', 'crates', 'heddle-session', 'src', 'unicode61.rs'), rust(data))
console.log(
  `unicode61 tables from SQLite ${data.version}: ${data.separators.length} separator ranges, ${data.diacritics.length} diacritics, ${data.folds.length} fold runs`,
)
