import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readSessionDefinition, updateSessionDefinition, writeSessionDefinition } from '../src/session/definition.ts'
import { SessionStore } from '../src/session/store.ts'
import { normalizeSessionTitle } from '../src/session/title-text.ts'

/**
 * A session title is cleaned the way DSH cleans an accepted one (live-testing draft developer-six-1).
 *
 * `dsh-session-title` `normalizeSessionTitle` (lib/index.js:10-54): terminal control sequences, non-whitespace C0/C1
 * controls and directional/invisible controls removed, whitespace collapsed to one trimmed line, then cut to
 * `maxTitleBytes` UTF-8 bytes on a code point — 80 in DSH's shipped profile (`dsh-base/cordis.patch.yml:60-65`). The
 * rename applies it before accepting (lib/index.js:295-306). Measured before this rule: both stores kept every title as
 * sent — 300 bytes, an ANSI colour sequence, a right-to-left override, a NUL.
 */

const CASES: readonly (readonly [string, string, string])[] = [
  ['an ANSI colour sequence', 'a\u001b[31mred\u001b[0m b', 'ared b'],
  ['an OSC title sequence', 'x\u001b]0;evil\u0007y', 'xy'],
  ['a newline and a tab', 'line1\n\tline2', 'line1 line2'],
  ['a right-to-left override', 'abc\u202edcba', 'abcdcba'],
  ['a zero-width space', 'zero\u200bwidth', 'zerowidth'],
  ['NUL and BEL', 'nul\u0000ctl\u0007x', 'nulctlx'],
  ['a C1 control', 'c1\u0085here', 'c1here'],
  ['surrounding and inner runs of space', '  two   words  ', 'two words'],
  ['300 ASCII letters', 'a'.repeat(300), 'a'.repeat(80)],
  ['60 CJK characters', '字'.repeat(60), '字'.repeat(26)],
  ['a cut that would leave a trailing space', `${'a'.repeat(79)} b`, 'a'.repeat(79)],
]

function scratch(): { readonly root: string; readonly store: SessionStore } {
  const root = mkdtempSync(join(tmpdir(), 'heddle-title-text-'))
  return { root, store: new SessionStore(join(root, 'sessions')) }
}

test('a rename stores the title cleaned as DSH cleans it, within 80 UTF-8 bytes on a code point', () => {
  const { root, store } = scratch()
  try {
    const handle = store.create({ cwd: root })
    for (const [what, sent, kept] of CASES) {
      const meta = store.rename(handle.id, sent)
      assert.equal(meta?.title, kept, what)
      assert.ok(Buffer.byteLength(meta?.title ?? '', 'utf8') <= 80, `${what}: within the cap`)
      const onDisk = JSON.parse(readFileSync(handle.meta, 'utf8')) as { title?: string }
      assert.equal(onDisk.title, kept, `${what}: the record on disk holds the cleaned title`)
    }
    /** A title with nothing visible left clears the record's title, the store's rule for a blank one. */
    assert.equal(store.rename(handle.id, ' \u200b\u0007\n ')?.title, undefined, 'nothing visible left clears it')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a session created with a title stores it cleaned, and one with nothing visible stores none', () => {
  const { root, store } = scratch()
  try {
    const made = store.create({ cwd: root, title: 'made\u001b[31m red\u001b[0m\n\there \u202e' })
    assert.equal((JSON.parse(readFileSync(made.meta, 'utf8')) as { title?: string }).title, 'made red here')
    const blank = store.create({ cwd: root, title: '\u200b \u0000' })
    assert.equal('title' in (JSON.parse(readFileSync(blank.meta, 'utf8')) as object), false, 'no empty title key is written')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * A title of only terminal sequences and whitespace has nothing visible left, so it is a blank title: the rename clears
 * as three spaces do and a session created with it stores none (the Web route refuses it, verifier 70). None of the
 * sequence reaches the record.
 */
const ONLY_CONTROLS: readonly (readonly [string, string])[] = [
  ['three spaces', '   '],
  ['a clear-screen sequence and a tab', '\u001b[2J\t'],
  ['an empty window-title command', '\u001b]0;\u0007'],
  ['a C1 control sequence, a reverse index and a line break', '\u009b31m\u001bM\r\n'],
]

test('a title of only control or escape characters is cleaned to nothing, as a blank one is', () => {
  const { root, store } = scratch()
  try {
    const handle = store.create({ cwd: root, title: 'kept title' })
    for (const [what, sent] of ONLY_CONTROLS) {
      assert.equal(normalizeSessionTitle(sent), '', `${what}: nothing visible is left`)
      assert.equal(store.rename(handle.id, 'kept title')?.title, 'kept title')
      assert.equal(store.rename(handle.id, sent)?.title, undefined, `${what}: the rename clears, as a blank one does`)
      assert.equal('title' in (JSON.parse(readFileSync(handle.meta, 'utf8')) as object), false, `${what}: no title key is left`)
      const made = store.create({ cwd: root, title: sent })
      assert.equal('title' in (JSON.parse(readFileSync(made.meta, 'utf8')) as object), false, `${what}: a session created with it stores none`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a session's definition takes the same cleaned title as its store record", () => {
  const { root, store } = scratch()
  try {
    const handle = store.create({ cwd: root })
    const written = writeSessionDefinition(handle, root, { createdAt: '2026-10-30T12:00:00.000Z', title: 'line1\n\tline2\u202e' })
    assert.equal(readSessionDefinition(written.dir)?.title, 'line1 line2')
    assert.equal(updateSessionDefinition(written.dir, { title: '字'.repeat(60) }), true)
    assert.equal(readSessionDefinition(written.dir)?.title, '字'.repeat(26))
    assert.equal(updateSessionDefinition(written.dir, { title: '\u0007' }), true)
    assert.equal(readSessionDefinition(written.dir)?.title, undefined, 'nothing visible left deletes the key')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
