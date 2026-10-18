import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { SessionStore } from '../src/session/store.ts'
import { countsOf, foldTodos, TodoError, TodoService, validateTodos } from '../src/todo/service.ts'
import { todoTools } from '../src/todo/tool.ts'
import type { ToolRunContext } from '../src/tools/service.ts'

/**
 * The todo list: the durable fold, its strict refusals, and the two model tools.
 *
 * The list is small but it is a **durable record**, so the tests pin the properties a panel and a resumed
 * model rely on: last write wins, an empty list is a list, the log is decoded strictly, one item may be
 * in progress, and the list survives turns and a reopened store.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-todo-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function store(): SessionStore {
  counter += 1
  return new SessionStore(join(root, `store-${counter}`))
}

function setup(): { readonly store: SessionStore; readonly todos: TodoService; readonly handle: ReturnType<SessionStore['create']> } {
  const sessionStore = store()
  const todos = new TodoService(new Context(), sessionStore)
  const handle = sessionStore.create({ cwd: root })
  return { store: sessionStore, todos, handle }
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof TodoError, `expected a TodoError, got ${String(error)}`)
    return error.code
  }
  assert.fail('expected a refusal')
}

test('a session with no write has no list', () => {
  const { todos, handle } = setup()
  assert.equal(todos.get(handle), undefined)
})

test('a write replaces the whole list, and the last write wins', () => {
  const { todos, handle } = setup()
  const first = todos.write(handle, [
    { content: 'research DSH', status: 'in_progress' },
    { content: 'write the service', status: 'pending' },
  ])
  assert.deepEqual(first.todos, [
    { content: 'research DSH', status: 'in_progress' },
    { content: 'write the service', status: 'pending' },
  ])
  assert.deepEqual(first.counts, { pending: 1, inProgress: 1, completed: 0 })

  const second = todos.write(handle, [{ content: 'research DSH', status: 'completed' }])
  assert.deepEqual(second.todos, [{ content: 'research DSH', status: 'completed' }])
  assert.deepEqual(todos.get(handle)?.todos, [{ content: 'research DSH', status: 'completed' }], 'the last write is the list')
})

test('an empty list is a list, not an absent one', () => {
  const { todos, handle } = setup()
  todos.write(handle, [{ content: 'one', status: 'pending' }])
  const cleared = todos.clear(handle)
  assert.deepEqual(cleared.todos, [])
  assert.deepEqual(cleared.counts, { pending: 0, inProgress: 0, completed: 0 })
  assert.deepEqual(todos.get(handle)?.todos, [], 'cleared is a written empty list, not undefined')
})

test('content is trimmed and stored trimmed', () => {
  const { todos, handle } = setup()
  const view = todos.write(handle, [{ content: '  a task  ', status: 'pending' }])
  assert.deepEqual(view.todos, [{ content: 'a task', status: 'pending' }])
})

test('the write path refuses invalid lists with a stable code', () => {
  const { todos, handle } = setup()
  const refusals: readonly [string, unknown][] = [
    ['not an array', 'nope'],
    ['empty content', [{ content: '   ', status: 'pending' }]],
    ['duplicate content', [{ content: 'a', status: 'pending' }, { content: 'a', status: 'completed' }]],
    ['unknown status', [{ content: 'a', status: 'doing' }]],
    ['unknown key', [{ content: 'a', status: 'pending', note: 'x' }]],
    ['two in progress', [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }]],
  ]
  for (const [name, raw] of refusals) {
    assert.equal(codeOf(() => todos.write(handle, raw)), 'TODO_INVALID_LIST', name)
  }
})

test('the fold refuses a malformed log rather than guessing', () => {
  const { store: sessionStore, todos, handle } = setup()
  sessionStore.append(handle, { type: 'todo/write', version: 99, todos: [], updatedAt: 'now' })
  assert.equal(codeOf(() => todos.get(handle)), 'TODO_INVALID_LOG')

  const second = setup()
  second.store.append(second.handle, { type: 'todo/write', version: 1, todos: [{ content: 'a', status: 'done' }], updatedAt: 'now' })
  assert.equal(codeOf(() => second.todos.get(second.handle)), 'TODO_INVALID_LOG')
})

test('a list survives turns and a reopened store', () => {
  const { store: sessionStore, todos, handle } = setup()
  todos.write(handle, [{ content: 'persist', status: 'pending' }])
  sessionStore.append(handle, { type: 'turn/completed' })
  sessionStore.append(handle, { type: 'message', message: { role: 'user', content: [] } })
  assert.deepEqual(todos.get(handle)?.todos, [{ content: 'persist', status: 'pending' }], 'turns do not clear it')

  const reopened = new TodoService(new Context(), sessionStore)
  assert.deepEqual(reopened.get(handle)?.todos, [{ content: 'persist', status: 'pending' }], 'a new process folds the same list')
})

test('the model writes and reads the list through the tools', async () => {
  const { todos, handle } = setup()
  const tools = todoTools(todos)
  const write = tools.find((definition) => definition.spec.name === 'todo_write')
  const read = tools.find((definition) => definition.spec.name === 'todo_read')
  assert.ok(write !== undefined && read !== undefined)

  const noSession = await write.run({ todos: [] }, { cwd: root, mode: 'workspace-write' } as ToolRunContext)
  assert.equal(noSession.error?.code, 'TODO_TOOL_NO_SESSION')

  const written = await write.run(
    { todos: [{ content: 'first', status: 'in_progress' }, { content: 'second', status: 'pending' }] },
    { cwd: root, session: handle, mode: 'workspace-write' } as ToolRunContext,
  )
  assert.equal(written.error, undefined)
  assert.match(written.output, /1 pending, 1 in progress, 0 completed/)

  const readBack = await read.run({}, { cwd: root, session: handle, mode: 'workspace-write' } as ToolRunContext)
  assert.deepEqual(JSON.parse(readBack.output).todos, [
    { content: 'first', status: 'in_progress' },
    { content: 'second', status: 'pending' },
  ])

  const refused = await write.run({ todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] }, { cwd: root, session: handle, mode: 'workspace-write' } as ToolRunContext)
  assert.equal(refused.error?.code, 'TODO_INVALID_LIST')
})

test('counts are derived from the list, never stored', () => {
  assert.deepEqual(countsOf([]), { pending: 0, inProgress: 0, completed: 0 })
  assert.deepEqual(
    countsOf([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'completed' },
      { content: 'd', status: 'completed' },
    ]),
    { pending: 1, inProgress: 1, completed: 2 },
  )
  assert.deepEqual(validateTodos([{ content: ' a ', status: 'pending' }], 'TODO_INVALID_LIST', false), [{ content: 'a', status: 'pending' }])
  assert.equal(foldTodos([]), undefined)
})
