import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Reordering workspaces by drag (C37), judged out of the page that runs it.
 *
 * DSH's workspace browser lets a workspace row be dragged among its siblings and asks the host to store the result
 * (workspace/insertBefore). Where a drop may land and what it asks for are the decisions with traps in them — a drop
 * beside itself moves nothing, the lower half of the last sibling appends, a nested workspace stays in its level — so
 * the pure block lives in page.html between two markers and is loaded here, beside the tree block whose groups it reads.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const block = (name: string): string => {
  const begin = page.indexOf(`/* ${name}:begin */`)
  const end = page.indexOf(`/* ${name}:end */`)
  assert.ok(begin !== -1 && end > begin, `page.html carries the ${name} block`)
  return page.slice(begin, end)
}

interface Group {
  key: string
  workspace: { id: string } | null
  children: Group[]
}

interface Drag {
  level: (groups: Group[], key: string) => { parent: string | null; siblings: string[] } | null
  half: (clientY: number, rect: { top: number; height: number }) => 'before' | 'after'
  dropRequest: (siblings: string[], source: string, over: { id: string; half: 'before' | 'after' }) => { workspaceId: string; beforeWorkspaceId?: string } | null
}

const tree = new Function(`${block('workspace-tree')}\nreturn WorkspaceTree`)() as {
  deriveGroups: (workspaces: unknown[], sessions: unknown[], options?: Record<string, unknown>) => Group[]
}
const drag = new Function(`${block('workspace-drag')}\nreturn WorkspaceDrag`)() as Drag

function workspace(id: string, path: string, parent: string | null = null, origin = 'added') {
  return { id, path, title: id, origin, parent, createdAt: 'a', updatedAt: 'a', sessionIds: [] as string[] }
}

/** Three top-level workspaces in registry order, one of them holding a nested one, plus an adopted root. */
const registry = [
  workspace('c', '/w/c'),
  workspace('b', '/w/b'),
  workspace('a', '/w/a'),
  workspace('a1', '/w/a/one', 'a'),
  workspace('a2', '/w/a/two', 'a'),
  workspace('loose', '/loose', null, 'auto'),
]

test('a workspace drops before the target when over its upper half, after it when over its lower half', () => {
  const siblings = ['c', 'b', 'a']
  assert.deepEqual(drag.dropRequest(siblings, 'a', { id: 'c', half: 'before' }), { workspaceId: 'a', beforeWorkspaceId: 'c' })
  assert.deepEqual(drag.dropRequest(siblings, 'a', { id: 'c', half: 'after' }), { workspaceId: 'a', beforeWorkspaceId: 'b' }, 'after c is before the sibling after c')
  assert.deepEqual(drag.dropRequest(siblings, 'c', { id: 'a', half: 'after' }), { workspaceId: 'c' }, 'after the last sibling is last: no anchor')
  assert.deepEqual(drag.dropRequest(siblings, 'c', { id: 'b', half: 'after' }), { workspaceId: 'c', beforeWorkspaceId: 'a' })
})

test('a drop that would leave the order as it is asks nothing, as DSH commitWorkspaceDrag does', () => {
  const siblings = ['c', 'b', 'a']
  for (const half of ['before', 'after'] as const) {
    assert.equal(drag.dropRequest(siblings, 'b', { id: 'b', half }), null, `onto itself (${half})`)
  }
  assert.equal(drag.dropRequest(siblings, 'b', { id: 'a', half: 'before' }), null, 'just above the next sibling is where it is')
  assert.equal(drag.dropRequest(siblings, 'b', { id: 'c', half: 'after' }), null, 'just below the previous sibling is where it is')
  assert.equal(drag.dropRequest(siblings, 'a', { id: 'a', half: 'after' }), null, 'the last one, below itself')
  assert.equal(drag.dropRequest(siblings, 'x', { id: 'a', half: 'before' }), null, 'a source that is not a sibling')
  assert.equal(drag.dropRequest(siblings, 'a', { id: 'x', half: 'before' }), null, 'a target that is not a sibling')
})

test('the level is the drawn one: nested workspaces are siblings of each other only, and Ungrouped is never one', () => {
  const drawn = tree.deriveGroups(registry, [{ id: 's-loose', cwd: '/loose', created: 'a', turns: 1 }], { grouping: 'tree' })
  assert.ok(drawn.some((group) => group.workspace === null), 'the fixture draws Ungrouped')
  assert.deepEqual(drag.level(drawn, 'b'), { parent: null, siblings: ['c', 'b', 'a'] }, 'top level, in registry order, without Ungrouped or the adopted root')
  assert.deepEqual(drag.level(drawn, 'a2'), { parent: 'a', siblings: ['a1', 'a2'] }, 'a nested workspace moves among its own siblings')
  assert.equal(drag.level(drawn, ''), null, 'Ungrouped has no level to move in')
  assert.equal(drag.level(drawn, 'loose'), null, 'nor has an adopted root, which is not drawn as a workspace')

  const flat = tree.deriveGroups(registry, [], { grouping: 'workspace' })
  assert.deepEqual(drag.level(flat, 'a2'), { parent: null, siblings: ['c', 'b', 'a', 'a1', 'a2'] }, 'the Workspace grouping draws every workspace as a sibling')
})

test('which half a pointer is over is measured on the whole section', () => {
  const rect = { top: 100, height: 200 }
  assert.equal(drag.half(100, rect), 'before')
  assert.equal(drag.half(199, rect), 'before')
  assert.equal(drag.half(200, rect), 'after')
  assert.equal(drag.half(299, rect), 'after')
})
