import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { canonicalPath, depthOf, isUnder } from '../src/paths.ts'

/**
 * The path rules a workspace and a folder tree are both made of.
 *
 * These were judged only by the workspaces verifier, which asked the implementation's own `isUnder`
 * whether the implementation had behaved — a check that agrees with the rule it is judging cannot catch
 * that rule being wrong. The rule therefore gets component tests here, and the verifier now spells its
 * own check independently.
 */

/** A real directory to canonicalise, because `realpath` is the half that needs the filesystem. */
test('a path is canonicalised through the filesystem when it exists, and resolved when it does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-paths-'))
  try {
    assert.equal(canonicalPath(dir), realpathSync(dir), 'an existing directory is its real path')
    assert.equal(canonicalPath(join(dir, 'not-yet')), join(dir, 'not-yet'), 'a missing path is resolved but not realpathed')
    assert.equal(canonicalPath(join(dir, '..', '.')), canonicalPath(join(dir, '..')), 'and dots are resolved away')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The letter case the disk stores, not the case a caller typed.
 *
 * On a case-insensitive volume (macOS by default) `proj` and `PROJ` are one folder, and DSH's canon is the native
 * `realpath`, which answers with the stored spelling. Node's JavaScript `realpathSync` echoes the typed case, so
 * each spelling used to become a workspace of its own. Skipped on a case-sensitive volume, where the two spellings
 * really are two folders.
 */
test('an existing folder is canonicalised to the letter case the disk stores', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-paths-case-'))
  try {
    const lower = join(dir, 'proj')
    mkdirSync(lower)
    const upper = join(dir, 'PROJ')
    if (!existsSync(upper)) {
      context.skip('this volume is case-sensitive, so the two spellings are two folders')
      return
    }
    assert.equal(canonicalPath(upper), canonicalPath(lower), 'two spellings of one folder are one canonical path')
    assert.equal(canonicalPath(upper), realpathSync(lower), 'and it is the spelling the disk stores')
    assert.equal(canonicalPath(`${upper}/`), realpathSync(lower), 'with a trailing separator too')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A symlink is resolved to the folder it names, as DSH does on purpose.
 *
 * Pinned because phase A of the DSH-parity audit read the opposite into DSH's client README: DSH's store
 * canonicalises with `realpath`, so "a symlink to an owned directory collides" (`dsh-workspace/README.md:93`).
 */
test('a symlink canonicalises to the folder it points at', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-paths-link-'))
  try {
    const target = join(dir, 'proj')
    mkdirSync(target)
    const link = join(dir, 'proj-link')
    symlinkSync(target, link)
    assert.equal(canonicalPath(link), realpathSync(target), 'the link and its target are one canonical path')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The segment-wise rule, and the sibling trap that is the reason it is segment-wise. */
test('a child is under its parent by path segment, and a shared prefix is not a parent', () => {
  assert.equal(isUnder('/a/b', '/a/b'), true, 'a path is under itself')
  assert.equal(isUnder('/a/b', '/a/b/c'), true, 'a child is under it')
  assert.equal(isUnder('/a/b/', '/a/b/c'), true, 'a trailing separator on the parent changes nothing')
  assert.equal(isUnder('/a/b', '/a/b-sibling'), false, 'a sibling sharing the prefix is NOT under it')
  assert.equal(isUnder('/a/b', '/a'), false, 'a parent is not under its child')
  assert.equal(isUnder('/a/b', '/other/c'), false, 'an unrelated path is not under it')
})

/** Depth is what orders a set of roots nearest-first, so off-by-one is a visible defect. */
test('depth counts the path segments', () => {
  assert.equal(depthOf('/'), 0)
  assert.equal(depthOf('/a'), 1)
  assert.equal(depthOf('/a/b/c'), 3)
  assert.equal(depthOf('/a/b/'), 2, 'a trailing separator is not a segment')
})
