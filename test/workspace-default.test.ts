import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { canonicalPath } from '../src/paths.ts'
import type { SessionMeta } from '../src/session/store.ts'
import { DEFAULT_WORKSPACE_DIRECTORY, defaultWorkspaceDirectory, WorkspaceService } from '../src/workspace/service.ts'

/**
 * First use — DSH's `workspace/initializeDefault`, mapped onto heddle's home.
 *
 * DSH (dsh-workspace lib/index.js:425-440, dsh-api-workspace-controller lib/index.js:609-640) creates or reuses
 * `<Documents>/deepseek-harness/default-workspace` only while the registry **and** the session history are empty,
 * records which workspace that was, reuses it on a repeated call, and never creates it again once its registration is
 * deleted. Heddle keeps every one of those rules and puts the folder under its own home, `$HEDDLE_HOME`, so nothing
 * outside heddle's directory is touched.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-workspace-default-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
/** A store and the default folder it would use, both inside this test's scratch home. */
function install(): { readonly workspaces: WorkspaceService; readonly home: string; readonly directory: string } {
  counter += 1
  const home = join(scratch, `home-${counter}`)
  return {
    workspaces: new WorkspaceService(new Context(), { file: join(home, 'workspaces.json') }),
    home,
    directory: defaultWorkspaceDirectory({ HEDDLE_HOME: home }),
  }
}

function session(id: string, cwd: string): SessionMeta {
  return { id, created: new Date().toISOString(), cwd, turns: 1 }
}

test("the default folder is heddle's own home's default-workspace, never the user's Documents", () => {
  assert.equal(DEFAULT_WORKSPACE_DIRECTORY, 'default-workspace', "DSH's fixed, language-neutral leaf name")
  assert.equal(defaultWorkspaceDirectory({ HEDDLE_HOME: '/fixture/home' }), '/fixture/home/default-workspace')
  assert.equal(defaultWorkspaceDirectory({}), join(homedir(), '.heddle', 'default-workspace'))
  assert.ok(!defaultWorkspaceDirectory({}).includes('Documents'))
})

test('an empty install creates the default workspace once, and a repeated call reuses it', () => {
  const { workspaces, directory } = install()
  const created = workspaces.initializeDefault([], directory)
  assert.ok(created !== undefined, 'an empty install gets a workspace')
  assert.equal(created.path, canonicalPath(directory))
  assert.equal(created.title, 'default-workspace', 'titled after its folder, as DSH stores it')
  assert.equal(created.origin, 'added', 'a workspace the tree draws, not an adopted folder')
  assert.ok(existsSync(directory), 'and its folder exists')
  assert.deepEqual(workspaces.list().map((record) => record.id), [created.id])

  const again = workspaces.initializeDefault([], directory)
  assert.equal(again?.id, created.id, 'the same workspace, not a second one')
  assert.equal(workspaces.list().length, 1)
})

test('a default folder that already exists is reused as it is', () => {
  const { workspaces, directory } = install()
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'notes.md'), 'kept\n')
  const record = workspaces.initializeDefault([], directory)
  assert.equal(record?.path, canonicalPath(directory))
  assert.equal(readFileSync(join(directory, 'notes.md'), 'utf8'), 'kept\n', 'nothing in it is replaced')
})

test('first use is only for an empty install: a workspace or a session anywhere makes it a no-op', () => {
  const withWorkspace = install()
  const chosen = join(withWorkspace.home, 'chosen')
  mkdirSync(chosen, { recursive: true })
  withWorkspace.workspaces.add(chosen)
  assert.equal(withWorkspace.workspaces.initializeDefault([], withWorkspace.directory), undefined)
  assert.equal(existsSync(withWorkspace.directory), false, 'and no folder is made')

  const withSession = install()
  const elsewhere = join(withSession.home, 'elsewhere')
  assert.equal(withSession.workspaces.initializeDefault([session('session-1', elsewhere)], withSession.directory), undefined)
  assert.equal(existsSync(withSession.directory), false, 'a history that is not empty is not a first use')
  assert.equal(withSession.workspaces.list().length, 0)
})

test('deleting the default workspace turns first use off for good, and keeps its folder', () => {
  const { workspaces, directory } = install()
  const created = workspaces.initializeDefault([], directory)
  assert.ok(created !== undefined)
  workspaces.remove(created.id, { all: [] })
  assert.equal(workspaces.list().length, 0)
  assert.equal(workspaces.initializeDefault([], directory), undefined, 'an empty registry is not asked again')
  assert.equal(workspaces.list().length, 0)
  assert.ok(existsSync(directory), 'the folder outlives its registration')
})

test('the record remembers the default workspace through other writes, after the fields both builds write', () => {
  const { workspaces, home, directory } = install()
  const created = workspaces.initializeDefault([], directory)
  assert.ok(created !== undefined)
  const other = join(home, 'other')
  mkdirSync(other, { recursive: true })
  workspaces.add(other)
  workspaces.rename(created.id, 'Mine')
  const file = JSON.parse(readFileSync(workspaces.file, 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(file), ['version', 'workspaceIds', 'workspaces', 'defaultWorkspaceId'])
  assert.equal(file.defaultWorkspaceId, created.id)
  assert.equal(workspaces.read().defaultWorkspaceId, created.id)

  const plain = install()
  plain.workspaces.add(other)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(plain.workspaces.file, 'utf8'))), ['version', 'workspaceIds', 'workspaces'], 'absent until a first use happens')
})
