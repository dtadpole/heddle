import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  DEFINITION_FILE,
  SESSIONS_FOLDER,
  existingSessionNames,
  ensureSessionsFolder,
  readSessionDefinition,
  sessionName,
  updateSessionDefinition,
  writeSessionDefinition,
} from '../src/session/definition.ts'
import { workspaceKey } from '../src/session/layout.ts'
import { canonicalPath } from '../src/paths.ts'

/**
 * The two files a session is filed as, and the name it is filed under.
 *
 * These are the functions that decide where a session lives on disk and what a reader of the repository sees, so
 * each claim here is one that a wrong implementation would break silently: a name that is not a valid instance
 * name fails the conventions linter, a folder without an entry point fails it too, and a definition that describes
 * a different session than the one it belongs to leaves the log and the record disagreeing.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-definition-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function branch(): string {
  counter += 1
  const path = join(scratch, `branch-${counter}`)
  mkdirSync(path, { recursive: true })
  return path
}

/** A handle-shaped record; the definition writer only reads these three fields. */
function handle(id: string, log: string): { id: string; dir: string; transcript: string; meta: string } {
  return { id, dir: '/nowhere', transcript: log, meta: '/nowhere/meta.json' }
}

test('a session name is a valid instance name, and two in one minute do not collide', () => {
  const at = new Date(2026, 9, 17, 14, 5)
  const first = sessionName(at)
  assert.match(first, /^[a-z0-9]+(-[a-z0-9]+){1,3}$/, 'the conventions require two to four kebab-case words')
  assert.equal(first, 'session-20261017-1405', 'the name is the clock, so a name order is a time order')

  /** A second session in the same minute takes an ordinal rather than the first one's folder. */
  const second = sessionName(at, [first])
  assert.equal(second, 'session-20261017-1405-2')
  assert.notEqual(second, first)

  /** And within the same minute the ordinal keeps rising for as long as it must. */
  assert.equal(sessionName(at, [first, second]), 'session-20261017-1405-3', 'and so on, rather than a duplicate')
})

test('writing a definition creates the folder, its entry point, and a record of the right session', () => {
  const root = branch()
  const at = '2026-10-17T21:05:00.000Z'
  const definition = writeSessionDefinition(handle('session-abc', '/logs/session-abc.jsonl'), root, {
    createdAt: at,
    title: 'a conversation with a name',
    endpoint: 'scripted',
    model: 'scripted',
  })

  const dir = join(canonicalPath(root), SESSIONS_FOLDER, definition.name)
  assert.equal(definition.dir, dir, 'the definition lands under the sessions folder of the branch')
  assert.ok(existsSync(join(dir, 'INDEX.md')), 'an instance carries an entry point, like every content folder')
  assert.ok(existsSync(join(dir, DEFINITION_FILE)), 'and the machine-readable half beside it')
  assert.ok(existsSync(join(canonicalPath(root), SESSIONS_FOLDER, 'INDEX.md')), 'and so does the type folder heddle created')

  const fields = readSessionDefinition(dir)
  assert.equal(fields?.id, 'session-abc', 'the record names the session it belongs to')
  assert.equal(fields?.log, '/logs/session-abc.jsonl', 'and the log it references, outside the repository')
  assert.equal(fields?.cwd, canonicalPath(root), 'and the folder the session is bound to, canonical rather than as typed')
  assert.equal(fields?.title, 'a conversation with a name')
  assert.equal(fields?.endpoint, 'scripted')
  assert.equal(fields?.model, 'scripted')

  /** The entry point is a document with frontmatter, not a stray file: the linter would refuse it otherwise. */
  const index = readFileSync(join(dir, 'INDEX.md'), 'utf8')
  assert.match(index, /^---\ntitle: /, 'an entry point opens with frontmatter')
  assert.ok(index.includes('/logs/session-abc.jsonl'), 'and says which log it is the record of')
})

test('a definition is retitled in place, and an empty title is a deletion rather than a blank name', () => {
  const root = branch()
  const created = writeSessionDefinition(handle('session-def', '/logs/def.jsonl'), root, {
    createdAt: '2026-10-17T21:06:00.000Z',
    title: 'before',
  })
  assert.equal(updateSessionDefinition(created.dir, { title: 'after' }), true)
  assert.equal(readSessionDefinition(created.dir)?.title, 'after', 'the new name is on disk')

  assert.equal(updateSessionDefinition(created.dir, { title: '   ' }), true)
  assert.equal(readSessionDefinition(created.dir)?.title, undefined, 'a blank title is removed, not stored as empty')

  /** A folder that holds no definition is refused rather than written to. */
  assert.equal(updateSessionDefinition(join(root, 'not-a-session'), { title: 'x' }), false)
})

test('the sessions folder is created once, and its entry point is never rewritten', () => {
  const root = branch()
  const first = ensureSessionsFolder(root)
  const index = join(first, 'INDEX.md')
  const before = readFileSync(index, 'utf8')

  /** A person may have edited the folder's entry point; a second session must not undo that. */
  writeFileSync(index, `${before}\nA sentence a person added.\n`)
  const second = ensureSessionsFolder(root)
  assert.equal(first, second, 'the same folder')
  assert.ok(readFileSync(index, 'utf8').includes('A sentence a person added.'), 'and the edited entry point survives')
})

test('the names taken in a branch are read from disk, so a new one does not reuse a folder', () => {
  const root = branch()
  assert.deepEqual(existingSessionNames(root), [], 'an empty branch has no names')
  const first = writeSessionDefinition(handle('session-1', '/logs/1.jsonl'), root, { createdAt: '2026-10-17T21:07:00.000Z' })
  const taken = existingSessionNames(root)
  assert.deepEqual(taken, [first.name], 'the folder just written is one of them')
  writeSessionDefinition(handle('session-2', '/logs/2.jsonl'), root, { createdAt: '2026-10-17T21:07:00.000Z', taken })
  assert.equal(existingSessionNames(root).length, 2, 'and the second took a different name rather than the same folder')
})

test('a working directory becomes a readable, bounded folder key', () => {
  assert.equal(workspaceKey('/Users/zhenc/heddle'), '--Users-zhenc-heddle--', 'separators become dashes, and the key is wrapped')
  assert.equal(workspaceKey('/Users/zhenc/heddle/'), '--Users-zhenc-heddle--', 'a trailing separator changes nothing')

  /**
   * The key is **lossy on purpose** — it files a log, it does not identify a session — so two paths may share one,
   * and a path with characters a filesystem dislikes is reduced rather than refused.
   */
  assert.equal(workspaceKey('/a/b c'), '--a-b~c--', 'a space becomes a substitution, not a new segment')
  assert.ok(workspaceKey('/x').length < 200, 'and the key is bounded, so a deep path cannot overflow a file name')
  assert.equal(workspaceKey('/'), '--root--', 'the root itself still has a key')
})
