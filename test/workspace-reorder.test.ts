import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { WorkspaceOrderInvalid, WorkspaceService } from '../src/workspace/service.ts'

/**
 * Moving a workspace within the stored order — DSH's `workspace/insertBefore` (dsh-workspace lib/index.js:473-499).
 *
 * The order is the record file's `workspaceIds`, the array a new root is prepended to, so a move rewrites that array
 * and nothing else: the Rust build reads the same file, and an older build that knows nothing of moving still lists
 * the workspaces in the moved order.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-workspace-reorder-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function service(): WorkspaceService {
  counter += 1
  return new WorkspaceService(new Context(), { file: join(scratch, `workspaces-${counter}.json`) })
}

const titles = (workspaces: WorkspaceService): string[] => workspaces.list().map((record) => record.title)

test('a workspace moves before another, by id or by path, and the answer is the complete order', () => {
  const workspaces = service()
  const one = workspaces.add('/work/one', 'one').record.id
  const two = workspaces.add('/work/two', 'two').record.id
  const three = workspaces.add('/work/three', 'three').record.id
  assert.deepEqual(titles(workspaces), ['three', 'two', 'one'], 'a new root is prepended')

  assert.deepEqual(workspaces.insertBefore(one, three), [one, three, two])
  assert.deepEqual(titles(workspaces), ['one', 'three', 'two'], 'and the move is stored')
  workspaces.insertBefore('/work/two', '/work/three')
  assert.deepEqual(titles(workspaces), ['one', 'two', 'three'], 'a path names a workspace as an id does')
})

test('without an anchor a workspace goes to the end', () => {
  const workspaces = service()
  const one = workspaces.add('/work/one', 'one').record.id
  workspaces.add('/work/two', 'two')
  workspaces.add('/work/three', 'three')
  workspaces.insertBefore(workspaces.find('/work/three')!.id)
  assert.deepEqual(titles(workspaces), ['two', 'one', 'three'])
  workspaces.insertBefore(one, undefined)
  assert.deepEqual(titles(workspaces), ['two', 'three', 'one'])
})

test('itself as the anchor, or a move that changes nothing, writes nothing', () => {
  const workspaces = service()
  const one = workspaces.add('/work/one', 'one').record.id
  const two = workspaces.add('/work/two', 'two').record.id
  const before = readFileSync(workspaces.file, 'utf8')
  const modified = statSync(workspaces.file).mtimeMs
  assert.deepEqual(workspaces.insertBefore(two, two), [two, one])
  assert.deepEqual(workspaces.insertBefore(two, one), [two, one])
  assert.deepEqual(workspaces.insertBefore(one), [two, one])
  assert.equal(readFileSync(workspaces.file, 'utf8'), before)
  assert.equal(statSync(workspaces.file).mtimeMs, modified)
})

test("an unknown workspace or anchor is refused with DSH's sentence and code, and nothing moves", () => {
  const workspaces = service()
  const one = workspaces.add('/work/one', 'one').record.id
  workspaces.add('/work/two', 'two')
  for (const [id, before, named] of [
    ['w-nowhere', undefined, 'w-nowhere'],
    [one, 'w-nowhere', 'w-nowhere'],
    ['/work/nowhere', one, '/work/nowhere'],
  ] as const) {
    assert.throws(
      () => workspaces.insertBefore(id, before),
      (error: unknown) =>
        error instanceof WorkspaceOrderInvalid &&
        error.code === 'workspace/not-found' &&
        error.workspaceId === named &&
        error.message === `cannot reorder unknown workspace '${named}'`,
    )
  }
  assert.deepEqual(titles(workspaces), ['two', 'one'])
})

test('a record missing from the order is not in it, so it cannot be moved or used as an anchor', () => {
  const workspaces = service()
  const one = workspaces.add('/work/one', 'one').record.id
  const shape = JSON.parse(readFileSync(workspaces.file, 'utf8'))
  shape.workspaces['w-stray'] = { id: 'w-stray', path: '/work/stray', title: 'stray', createdAt: 'a', updatedAt: 'a' }
  writeFileSync(workspaces.file, `${JSON.stringify(shape, null, 2)}\n`)
  assert.throws(() => workspaces.insertBefore('w-stray'), WorkspaceOrderInvalid)
  assert.throws(() => workspaces.insertBefore(one, 'w-stray'), WorkspaceOrderInvalid)
})

test('the file keeps its shape: the same keys, the order in workspaceIds, and a new root still goes first', () => {
  const workspaces = service()
  const one = workspaces.add('/work/one', 'one').record.id
  const two = workspaces.add('/work/two', 'two').record.id
  workspaces.insertBefore(one, two)
  const text = readFileSync(workspaces.file, 'utf8')
  const value = JSON.parse(text)
  assert.deepEqual(Object.keys(value), ['version', 'workspaceIds', 'workspaces'])
  assert.equal(value.version, 3)
  assert.deepEqual(value.workspaceIds, [one, two])
  assert.deepEqual(Object.keys(value.workspaces[one]), ['id', 'path', 'title', 'origin', 'createdAt', 'updatedAt'])
  assert.ok(text.endsWith('}\n'))
  workspaces.add('/work/three', 'three')
  assert.deepEqual(titles(workspaces), ['three', 'one', 'two'], "DSH's rule: a new workspace is prepended to the moved order")
})
