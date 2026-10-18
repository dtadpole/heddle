import { Context, Service } from '@deepseek-ai/cordis'

import type { SessionEvent, SessionHandle, SessionStore } from '../session/store.ts'

/**
 * Todo management, modelled on DSH's `dsh-tool-todo` — read as
 * [`_context_/dsh-mechanisms/dsh-todo.md`](../../_context_/dsh-mechanisms/dsh-todo.md).
 *
 * One idea, the same as goals: a todo list is not a record that is updated but an event that is
 * appended. Each model write appends one `todo/write` event carrying the **whole list**, and the
 * current list is the fold of the log, last write wins. That makes the write atomic, the history
 * auditable, and replay from a durable log the only source of truth.
 *
 * One deliberate divergence from DSH: DSH resets its list on `turn/start` because its list is a
 * per-turn plan. This project's durable unit is the **session**, and a task list that vanishes between
 * turns is not a list a person can read; so the list persists until it is replaced (or written empty,
 * which the UI hides). The cost is recorded in the reading: a stale list can linger until the model
 * replaces it, which is why `todo_read` exists for a model resuming after a restart.
 */

/** Version of the `todo/write` payload shape. A log written by a later version fails loudly. */
export const TODO_WRITE_VERSION = 1

/** The statuses a todo item may carry; DSH's own closed set. */
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

/** One item as it is stored and shown: a short line and its status. */
export interface TodoItem {
  readonly content: string
  readonly status: TodoStatus
}

/** The three counts the UI and the tool answer report; zero-count segments are derived, never stored. */
export interface TodoCounts {
  readonly pending: number
  readonly inProgress: number
  readonly completed: number
}

/** The current list of one session, with the counts a caller needs to render it. */
export interface TodoView {
  readonly todos: readonly TodoItem[]
  readonly counts: TodoCounts
  readonly updatedAt: string
}

/** Refusals carry a stable code, so a tool or a Web client can branch without parsing prose. */
export class TodoError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TodoError'
    this.code = code
  }
}

const STATUSES: ReadonlySet<string> = new Set(TODO_STATUSES)
const ITEM_KEYS: ReadonlySet<string> = new Set(['content', 'status'])
const ZERO_COUNTS: TodoCounts = { pending: 0, inProgress: 0, completed: 0 }

function fail(code: string, message: string): never {
  throw new TodoError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one list, the way both the write path and the fold need it.
 *
 * `code` names the refusal — `TODO_INVALID_LIST` for a model's write, `TODO_INVALID_LOG` for a
 * replay — and `allowParallel` is a **policy**: the write path applies it, but the fold accepts any
 * structurally valid list so that changing a deployment's policy cannot make an older log unreadable.
 */
export function validateTodos(raw: unknown, code: string, allowParallel: boolean): TodoItem[] {
  if (!Array.isArray(raw)) fail(code, 'todos must be an array')
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    if (!isRecord(item)) fail(code, 'a todo must be an object')
    for (const key of Object.keys(item)) if (!ITEM_KEYS.has(key)) fail(code, `unknown todo key ${JSON.stringify(key)}`)
    if (typeof item.content !== 'string') fail(code, 'todo content must be a string')
    const content = item.content.trim()
    if (content.length === 0) fail(code, 'todo content must be non-empty')
    if (seen.has(content)) fail(code, `duplicate todo content ${JSON.stringify(content)}`)
    seen.add(content)
    if (typeof item.status !== 'string' || !STATUSES.has(item.status)) fail(code, `unknown todo status ${JSON.stringify(item.status)}`)
    if (item.status === 'in_progress') active += 1
    todos.push({ content, status: item.status as TodoStatus })
  }
  if (!allowParallel && active > 1) fail(code, `at most one todo may be in_progress (got ${active})`)
  return todos
}

/** Count one list; the only place the three numbers are derived. */
export function countsOf(todos: readonly TodoItem[]): TodoCounts {
  return {
    pending: todos.filter((todo) => todo.status === 'pending').length,
    inProgress: todos.filter((todo) => todo.status === 'in_progress').length,
    completed: todos.filter((todo) => todo.status === 'completed').length,
  }
}

/** The payload a `todo/write` event carries. */
export interface TodoWrite {
  readonly todos: readonly TodoItem[]
  readonly updatedAt: string
}

/** Decode and validate one `todo/write` event; malformed events fail loudly rather than being skipped. */
export function decodeTodoWrite(event: SessionEvent): TodoWrite | undefined {
  if (event.type !== 'todo/write') return undefined
  if (event.version !== TODO_WRITE_VERSION) fail('TODO_INVALID_LOG', `unsupported todo write version ${String(event.version)}`)
  const todos = validateTodos(event.todos, 'TODO_INVALID_LOG', true)
  if (typeof event.updatedAt !== 'string' || event.updatedAt.length === 0) fail('TODO_INVALID_LOG', 'a todo write needs updatedAt')
  return { todos, updatedAt: event.updatedAt }
}

/** Fold a session's events into its current list: the last write wins, and the log must be well formed. */
export function foldTodos(events: readonly SessionEvent[]): TodoView | undefined {
  let view: TodoView | undefined
  for (const event of events) {
    const write = decodeTodoWrite(event)
    if (write === undefined) continue
    view = { todos: write.todos, counts: countsOf(write.todos), updatedAt: write.updatedAt }
  }
  return view
}

/** The todo service: read a session's list, replace it, or clear it. */
export class TodoService extends Service {
  private readonly store: SessionStore
  private readonly allowParallel: boolean

  constructor(ctx: Context, store: SessionStore, options: { readonly allowParallelInProgress?: boolean } = {}) {
    super(ctx, 'todo')
    this.store = store
    this.allowParallel = options.allowParallelInProgress === true
  }

  /** The session's current list, or `undefined` when nothing has been written yet. */
  get(handle: SessionHandle): TodoView | undefined {
    return foldTodos(this.store.read(handle))
  }

  /** Replace the whole list; returns the view the write produced. */
  write(handle: SessionHandle, raw: unknown): TodoView {
    const todos = validateTodos(raw, 'TODO_INVALID_LIST', this.allowParallel)
    return this.commit(handle, todos)
  }

  /** Replace the list with the empty one: the UI hides it, and the log keeps the event. */
  clear(handle: SessionHandle): TodoView {
    return this.commit(handle, [])
  }

  private commit(handle: SessionHandle, todos: readonly TodoItem[]): TodoView {
    const updatedAt = new Date().toISOString()
    this.store.append(handle, { type: 'todo/write', version: TODO_WRITE_VERSION, todos, updatedAt })
    return { todos, counts: countsOf(todos), updatedAt }
  }
}

/** The todo plugin: the service wired to the session store, loaded by the profile. */
export default class TodoPlugin extends TodoService {
  static readonly inject = ['session']

  constructor(ctx: Context) {
    super(ctx, ctx.session.store)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['todo']`. */
    todo: TodoService
  }
}
