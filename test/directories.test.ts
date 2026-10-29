import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

import { createDirectory, DirectoryError, listDirectory } from '../src/server/directories.ts'

/**
 * The page's folder chooser, judged at its two host primitives — DSH's browse backend: one directory level, and one
 * new child folder. The rules are the decisions: directories only, sorted, links followed and broken ones skipped,
 * dot-names marked rather than dropped, the home when no path is named, and refusals carrying DSH's codes.
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-directories-')))
after(() => rmSync(scratch, { recursive: true, force: true }))

function refusal(run: () => unknown): DirectoryError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof DirectoryError, `a DirectoryError, not ${String(error)}`)
    return error
  }
  throw new Error('expected a refusal')
}

test('a listing names folders only, sorted, with hidden marks, crumbs and followed links', () => {
  const place = join(scratch, 'listing')
  for (const name of ['beta', 'Alpha', '.hidden', 'gamma']) mkdirSync(join(place, name), { recursive: true })
  writeFileSync(join(place, 'a-file.txt'), 'x')
  symlinkSync(join(place, 'gamma'), join(place, 'link'))
  symlinkSync(join(place, 'nowhere'), join(place, 'broken'))
  const listing = listDirectory(place, place)
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['.hidden', 'Alpha', 'beta', 'gamma', 'link'])
  assert.deepEqual(listing.entries.map((entry) => entry.hidden), [true, false, false, false, false])
  assert.equal(listing.entries[1]?.path, join(place, 'Alpha'))
  assert.equal(listing.path, place)
  assert.equal(listing.parent, dirname(place))
  assert.equal(listing.crumbs[0]?.path, '/')
  assert.equal(listing.crumbs.at(-1)?.path, place)
  assert.equal(listing.truncated, false)
  assert.equal(listDirectory(undefined, place).path, place, 'no path lists the home')
  assert.equal(listDirectory('  ', place).path, place, 'nor does a blank one')
  assert.equal(listDirectory('~', place).path, place, '~ is the home')
  assert.equal(listDirectory('/', place).parent, null, 'the root has nothing above it')
})

test('a listing refuses a relative, missing or file path with the unreadable code', () => {
  const place = join(scratch, 'refusals')
  mkdirSync(place, { recursive: true })
  writeFileSync(join(place, 'a-file.txt'), 'x')
  for (const [path, message] of [
    ['not/absolute', 'the path must be absolute'],
    [join(place, 'nope'), `${join(place, 'nope')} does not exist`],
    [join(place, 'a-file.txt'), `${join(place, 'a-file.txt')} is not a folder`],
  ] as const) {
    const error = refusal(() => listDirectory(path, place))
    assert.equal(error.status, 400)
    assert.equal(error.code, 'directory-picker/unreadable')
    assert.equal(error.message, message)
  }
})

test('creation takes one segment under an existing parent and refuses a duplicate', () => {
  const place = join(scratch, 'creation')
  mkdirSync(place, { recursive: true })
  const made = createDirectory(place, ' fresh ', place)
  assert.equal(made.path, join(place, 'fresh'))
  assert.ok(existsSync(made.path))
  const again = refusal(() => createDirectory(place, 'fresh', place))
  assert.equal(again.status, 409)
  assert.equal(again.code, 'directory-picker/exists')
  for (const name of ['', '.', '..', 'a/b', 42]) {
    const error = refusal(() => createDirectory(place, name, place))
    assert.equal(error.status, 400, `the name ${JSON.stringify(name)} is refused`)
    assert.equal(error.code, 'directory-picker/create-failed')
  }
  assert.equal(refusal(() => createDirectory(undefined, 'x', place)).message, 'a parent folder is required')
  assert.equal(refusal(() => createDirectory(join(place, 'missing'), 'x', place)).status, 400, 'a missing parent is not invented')
})
