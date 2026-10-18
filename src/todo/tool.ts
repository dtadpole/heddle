import type { ToolContext, ToolDefinition, ToolResult } from '../tools/service.ts'
import { TodoError, TODO_STATUSES, type TodoService, type TodoView } from './service.ts'

/**
 * The model-facing todo tools, modelled on DSH's `dsh-tool-todo`.
 *
 * Two tools: `todo_write` replaces the whole list (the durable `todo/write` snapshot), and `todo_read`
 * returns the current durable list. DSH has no read tool because its list is cleared at every turn
 * start and the model always knows what it wrote this turn; this project keeps the list across turns
 * and restarts, so a resumed model needs a way to see what is still claimed.
 */

const WRITE_DESCRIPTION =
  'Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. While work remains, keep exactly one todo `in_progress`. Mark each todo `completed` as soon as it is done.'

const READ_DESCRIPTION =
  'Read the current session todo list. The list is durable: it survives turns and restarts until it is replaced.'

/** The wire shape both tools answer with; an absent list is an empty list plus zero counts. */
function wire(view: TodoView | undefined): Record<string, unknown> {
  return {
    todos: view?.todos ?? [],
    counts: view?.counts ?? { pending: 0, inProgress: 0, completed: 0 },
  }
}

/** Turn a refusal into the tool-result shape, keeping the stable code. */
function refused(error: unknown): ToolResult {
  if (error instanceof TodoError) return { output: '', error: { code: error.code, message: error.message } }
  return { output: '', error: { code: 'TODO_TOOL_ERROR', message: error instanceof Error ? error.message : String(error) } }
}

/** The session a list belongs to, or a refusal: a list is per session, never global. */
function sessionOf(context: ToolContext): { readonly ok: true; readonly session: NonNullable<ToolContext['session']> } | { readonly ok: false; readonly result: ToolResult } {
  if (context.session === undefined) {
    return { ok: false, result: { output: '', error: { code: 'TODO_TOOL_NO_SESSION', message: 'a todo list belongs to a session, and this call has none' } } }
  }
  return { ok: true, session: context.session }
}

/** The two todo tools, bound to one todo service. */
export function todoTools(todos: TodoService): ToolDefinition[] {
  return [
    {
      spec: {
        name: 'todo_write',
        description: WRITE_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              description: 'The COMPLETE task list, replacing any previous list.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  content: { type: 'string', description: 'What the task is — a short imperative line.' },
                  status: {
                    type: 'string',
                    enum: [...TODO_STATUSES],
                    description: 'pending (not started) | in_progress (now) | completed (done).',
                  },
                },
                required: ['content', 'status'],
              },
            },
          },
          required: ['todos'],
          additionalProperties: false,
        },
      },
      run: async (args, context): Promise<ToolResult> => {
        const resolved = sessionOf(context)
        if (!resolved.ok) return resolved.result
        try {
          const view = todos.write(resolved.session, args.todos)
          return {
            output: `Updated todo list: ${view.counts.pending} pending, ${view.counts.inProgress} in progress, ${view.counts.completed} completed.`,
            data: { todo: view },
          }
        } catch (error) {
          return refused(error)
        }
      },
    },
    {
      spec: {
        name: 'todo_read',
        description: READ_DESCRIPTION,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      run: async (_args, context): Promise<ToolResult> => {
        const resolved = sessionOf(context)
        if (!resolved.ok) return resolved.result
        const view = todos.get(resolved.session)
        return view === undefined
          ? { output: 'no todo list has been written in this session', data: { todo: null } }
          : { output: JSON.stringify(wire(view)), data: { todo: view } }
      },
    },
  ]
}
