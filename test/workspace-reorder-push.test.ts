import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { WorkspaceOrderInvalid, WorkspaceService } from '../src/workspace/service.ts'

/**
 * Another client's workspace reorder reaches every open page (GitHub issue #136).
 *
 * DSH clients follow the host's workspace list, order included: `insertBefore` commits the new order to the registry
 * state, whose change every client hears, and a move that changes nothing returns before it writes, so nothing is
 * announced (dsh-workspace lib/index.js:479-499, :484 and :492 the early returns). Heddle's route pushed a `workspace`
 * frame for an added, renamed or removed workspace and nothing for a move, so an open page kept the old order until a
 * reload. The route now asks the registry whether the move moved anything, and pushes only then.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-workspace-reorder-push-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function service(): WorkspaceService {
  counter += 1
  return new WorkspaceService(new Context(), { file: join(scratch, `workspaces-${counter}.json`) })
}

test('a reorder says whether it moved anything, with the complete order, so the route announces only a real move', () => {
  const workspaces = service()
  const one = workspaces.add('/work/one', 'one').record.id
  const two = workspaces.add('/work/two', 'two').record.id
  const three = workspaces.add('/work/three', 'three').record.id

  assert.deepEqual(workspaces.reorder(one, three), { workspaceIds: [one, three, two], moved: true }, 'a move before another moves it')
  const written = readFileSync(workspaces.file, 'utf8')
  assert.deepEqual(workspaces.reorder(two, two), { workspaceIds: [one, three, two], moved: false }, 'itself as the anchor moves nothing')
  assert.deepEqual(workspaces.reorder(two), { workspaceIds: [one, three, two], moved: false }, 'nor does sending the last one last')
  assert.deepEqual(workspaces.reorder(three, two), { workspaceIds: [one, three, two], moved: false }, 'nor one already just before its anchor')
  assert.equal(readFileSync(workspaces.file, 'utf8'), written, 'and a move that moves nothing writes nothing')
  assert.deepEqual(workspaces.reorder('/work/three'), { workspaceIds: [one, two, three], moved: true }, 'a path names a workspace as an id does')
  assert.deepEqual(workspaces.insertBefore(three, one), [three, one, two], 'insertBefore still answers the complete order alone')
  assert.throws(() => workspaces.reorder('w-nowhere'), WorkspaceOrderInvalid, 'and an unknown workspace is refused as before')
})
