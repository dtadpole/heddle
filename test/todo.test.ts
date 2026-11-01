import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { failedEntries, settle } from '../src/boot.ts'
import { SessionStore } from '../src/session/store.ts'
import { countsOf, foldTodos, TodoError, TodoService, validateTodos } from '../src/todo/service.ts'
import { describeTodoWrite, todoTools, type TodoToolConfig } from '../src/todo/tool.ts'
import type { ToolDefinition, ToolRunContext } from '../src/tools/service.ts'

/**
 * The todo list: the durable fold, its strict refusals, and the model's one tool.
 *
 * The list is small but it is a **durable record**, so the tests pin the properties a panel relies on: last
 * write wins, an empty list is a list, the log is decoded strictly, and the list survives turns and a reopened
 * store. The tool is pinned to DSH's `dsh-tool-todo`: its description and its two active-status clauses, the
 * required `allowParallelInProgress` setting, DSH's four refusal sentences, validation before the session
 * check, and no `todo_read`.
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

function refusalOf(run: () => unknown): TodoError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof TodoError, `expected a TodoError, got ${String(error)}`)
    return error
  }
  assert.fail('expected a refusal')
}

function codeOf(run: () => unknown): string {
  return refusalOf(run).code
}

const PARALLEL: TodoToolConfig = { allowParallelInProgress: true }
const SINGLE: TodoToolConfig = { allowParallelInProgress: false }

/** The one tool the todo tool registers, for a setting. */
function writeTool(todos: TodoService, config: TodoToolConfig): ToolDefinition {
  const tools = todoTools(todos, config)
  assert.equal(tools.length, 1, 'one tool, as DSH registers')
  const [write] = tools
  assert.equal(write?.spec.name, 'todo_write')
  return write
}

function runContext(session?: ReturnType<SessionStore['create']>): ToolRunContext {
  return { cwd: root, mode: 'workspace-write', log: () => {}, ...(session !== undefined ? { session } : {}) }
}

const HEAD =
  'Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. '
const TAIL = 'Mark each todo `completed` as soon as it is done.'

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

test('the refusals are DSH sentences, content trimmed first', () => {
  const { todos, handle } = setup()
  assert.equal(refusalOf(() => todos.write(handle, [{ content: '   ', status: 'pending' }])).message, 'invalid todo: `content` must be a non-empty string')
  assert.equal(refusalOf(() => todos.write(handle, [{ content: 7, status: 'pending' }])).message, 'invalid todo: `content` must be a non-empty string', 'a non-string content is the same refusal')
  assert.equal(
    refusalOf(() => todos.write(handle, [{ content: 'ship it', status: 'pending' }, { content: '  ship it ', status: 'completed' }])).message,
    'invalid todos: duplicate content "ship it"',
    'the duplicate is found after trimming and named as JSON',
  )
  assert.equal(
    refusalOf(() => todos.write(handle, [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'in_progress' }])).message,
    'invalid todos: at most one task may be in_progress (got 3)',
  )
})

test('the service applies the caller policy for parallel work, defaulting to one in progress', () => {
  const { todos, handle } = setup()
  const two = [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }]
  assert.equal(codeOf(() => todos.write(handle, two)), 'TODO_INVALID_LIST', 'no policy named: one in progress')
  assert.deepEqual(todos.write(handle, two, { allowParallelInProgress: true }).counts, { pending: 0, inProgress: 2, completed: 0 })
  assert.equal(codeOf(() => todos.write(handle, two, { allowParallelInProgress: false })), 'TODO_INVALID_LIST')
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

test('the todo tool registers todo_write alone: there is no todo_read', () => {
  const { todos } = setup()
  for (const config of [PARALLEL, SINGLE]) {
    const names = todoTools(todos, config).map((definition) => definition.spec.name)
    assert.deepEqual(names, ['todo_write'], 'the model knows its list from its own todo_write arguments, as in DSH')
  }
})

test('the description is DSH HEAD, the clause the setting selects, and TAIL', () => {
  const { todos } = setup()
  const parallel = 'While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. '
  const single = 'While work remains, keep exactly one todo `in_progress`. '
  assert.equal(describeTodoWrite(true), HEAD + parallel + TAIL)
  assert.equal(describeTodoWrite(false), HEAD + single + TAIL)
  assert.equal(writeTool(todos, PARALLEL).spec.description, HEAD + parallel + TAIL, 'true: several only when work runs in parallel')
  assert.equal(writeTool(todos, SINGLE).spec.description, HEAD + single + TAIL, 'false: exactly one')
})

test('the parameter descriptions are DSH, verbatim', () => {
  const { todos } = setup()
  const parameters = writeTool(todos, PARALLEL).spec.parameters as {
    properties: { todos: { description: string; items: { additionalProperties: boolean; properties: Record<string, { description: string; enum?: string[] }> } } }
  }
  const list = parameters.properties.todos
  assert.equal(list.description, 'The COMPLETE task list, replacing any previous list.')
  assert.equal(list.items.additionalProperties, false)
  assert.equal(list.items.properties.content?.description, 'What the task is — a short imperative line.')
  assert.equal(list.items.properties.status?.description, 'pending (not started) | in_progress (now) | completed (done).')
  assert.deepEqual(list.items.properties.status?.enum, ['pending', 'in_progress', 'completed'])
})

test('the setting is required, with no default', () => {
  const { todos } = setup()
  for (const bad of [undefined, {}, { allowParallelInProgress: 'true' }, { allowParallelInProgress: 1 }]) {
    assert.throws(() => todoTools(todos, bad as never), /allowParallelInProgress/, `refused: ${JSON.stringify(bad)}`)
  }
})

test('a todo-tool row without the setting fails to load', async () => {
  class FakeTodo extends Service {
    constructor(ctx: Context) {
      super(ctx, 'todo')
    }
  }
  class FakeTools extends Service {
    readonly registered: string[] = []
    constructor(ctx: Context) {
      super(ctx, 'tools')
    }
    register(definition: ToolDefinition): void {
      this.registered.push(definition.spec.name)
    }
  }
  const plugin = pathToFileURL(join(import.meta.dirname, '..', 'src', 'plugins', 'todo-tool.ts')).href
  const load = async (config: unknown): Promise<{ readonly failed: number; readonly names: readonly string[] }> => {
    const ctx = new Context()
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(`${root}/`).href })
    await ctx.plugin(FakeTodo)
    await ctx.plugin(FakeTools)
    await ctx.loader.create({ name: plugin, ...(config !== undefined ? { config } : {}) })
    await ctx.loader.await()
    await settle(ctx, 2_000)
    const result = { failed: failedEntries(ctx).length, names: [...(ctx.get('tools') as unknown as FakeTools).registered] }
    await ctx.fiber.dispose()
    return result
  }
  assert.deepEqual(await load(undefined), { failed: 1, names: [] }, 'a row with no config fails')
  assert.deepEqual(await load({}), { failed: 1, names: [] }, 'a row without the setting fails')
  assert.deepEqual(await load({ allowParallelInProgress: 'yes' }), { failed: 1, names: [] }, 'a non-boolean fails')
  assert.deepEqual(await load({ allowParallelInProgress: true }), { failed: 0, names: ['todo_write'] })
  assert.deepEqual(await load({ allowParallelInProgress: false }), { failed: 0, names: ['todo_write'] })
})

test('the shipped profile sets allowParallelInProgress true, as every DSH preset ships', () => {
  const patch = readFileSync(join(import.meta.dirname, '..', 'heddle.patch.yml'), 'utf8')
  const row = /- id: todo-tool\n((?: {6}.*\n)+)/.exec(patch)
  assert.ok(row !== null, 'the profile mounts the todo tool')
  assert.match(row[1] ?? '', /config:\n {8}allowParallelInProgress: true\n/)
})

test('the model writes the list through the tool, answered with the counts', async () => {
  const { todos, handle } = setup()
  const write = writeTool(todos, SINGLE)
  const written = await write.run({ todos: [{ content: 'first', status: 'in_progress' }, { content: 'second', status: 'pending' }] }, runContext(handle))
  assert.equal(written.error, undefined)
  assert.equal(written.output, 'Updated todo list: 1 pending, 1 in progress, 0 completed.', 'DSH result sentence')
  assert.deepEqual(todos.get(handle)?.todos, [
    { content: 'first', status: 'in_progress' },
    { content: 'second', status: 'pending' },
  ])
})

test('two in progress: accepted when the setting is true, refused with DSH sentence only when false', async () => {
  const two = { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'completed' }] }

  const parallel = setup()
  const accepted = await writeTool(parallel.todos, PARALLEL).run(two, runContext(parallel.handle))
  assert.equal(accepted.error, undefined)
  assert.equal(accepted.output, 'Updated todo list: 0 pending, 2 in progress, 1 completed.')
  assert.equal(parallel.todos.get(parallel.handle)?.counts.inProgress, 2, 'the durable list keeps both')

  const single = setup()
  const refused = await writeTool(single.todos, SINGLE).run(two, runContext(single.handle))
  assert.deepEqual(refused.error, { code: 'TODO_INVALID_LIST', message: 'invalid todos: at most one task may be in_progress (got 2)' })
  assert.equal(single.todos.get(single.handle), undefined, 'a refused write appends nothing')
})

test('the tool refuses with DSH sentences under either setting', async () => {
  for (const config of [PARALLEL, SINGLE]) {
    const { todos, handle } = setup()
    const write = writeTool(todos, config)
    const empty = await write.run({ todos: [{ content: '  ', status: 'pending' }] }, runContext(handle))
    assert.deepEqual(empty.error, { code: 'TODO_INVALID_LIST', message: 'invalid todo: `content` must be a non-empty string' })
    const duplicate = await write.run({ todos: [{ content: 'same', status: 'pending' }, { content: 'same ', status: 'pending' }] }, runContext(handle))
    assert.deepEqual(duplicate.error, { code: 'TODO_INVALID_LIST', message: 'invalid todos: duplicate content "same"' })
    assert.equal(todos.get(handle), undefined)
  }
})

test('a call with no owning session is refused, after validation', async () => {
  const { todos } = setup()
  const write = writeTool(todos, PARALLEL)
  const noSession = await write.run({ todos: [] }, runContext())
  assert.deepEqual(noSession.error, { code: 'TODO_TOOL_NO_SESSION', message: 'todo_write requires an owning agent session' })
  const invalidFirst = await write.run({ todos: [{ content: '', status: 'pending' }] }, runContext())
  assert.deepEqual(invalidFirst.error, { code: 'TODO_INVALID_LIST', message: 'invalid todo: `content` must be a non-empty string' }, 'validation runs before the session check')
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
