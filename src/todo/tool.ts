import Schema from '@deepseek-ai/schemastery'

import type { ToolDefinition, ToolResult } from '../tools/service.ts'
import { TodoError, TODO_STATUSES, validateTodos, type TodoService } from './service.ts'

/**
 * The model-facing todo tool, ported from DSH's `dsh-tool-todo` (0.2.1-rc.2) for parity.
 *
 * One tool, `todo_write`: the whole list replaced, answered with its counts. There is **no read tool**, as in
 * DSH (R-developer-nine-10): the model knows its list from its own earlier `todo_write` arguments in its
 * history, and the answer carries only counts. The durable list still exists for people — the page's dock
 * and `GET /api/todo` read the todo service, never a tool.
 *
 * The description, the parameter descriptions and the four refusal sentences are DSH's, verbatim. A refusal
 * keeps this project's rendering, a stable code plus the message: `TODO_INVALID_LIST` for a list the rules
 * refuse, `TODO_TOOL_NO_SESSION` for a call with no owning session.
 */

/** The tool's one setting. */
export interface TodoToolConfig {
  /**
   * Whether several todos may be `in_progress` at once.
   *
   * DSH's `allowParallelInProgress`: **required, with no default**, so a profile that mounts the tool has to
   * choose. It picks the description's active-status clause and, only when false, the refusal of a list with
   * more than one item in progress.
   */
  readonly allowParallelInProgress: boolean
}

/** Schemastery form of {@link TodoToolConfig}; a row without the setting fails to load. */
export const TodoToolConfig: Schema<TodoToolConfig> = Schema.object({
  allowParallelInProgress: Schema.boolean()
    .required()
    .description('Whether several todos may be in_progress at once. Required, with no default, as in DSH.'),
})

const DESCRIPTION_HEAD =
  'Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. '
const DESCRIPTION_PARALLEL = 'While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. '
const DESCRIPTION_SINGLE = 'While work remains, keep exactly one todo `in_progress`. '
const DESCRIPTION_TAIL = 'Mark each todo `completed` as soon as it is done.'

/** The refusal of a call with no owning session, DSH's sentence. */
export const TODO_NO_SESSION_MESSAGE = 'todo_write requires an owning agent session'

/**
 * The `todo_write` description for one setting: HEAD, the active-status clause, TAIL.
 *
 * The clause is the only part that varies, because it is the only instruction the parallel policy changes.
 */
export function describeTodoWrite(allowParallelInProgress: boolean): string {
  return DESCRIPTION_HEAD + (allowParallelInProgress ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE) + DESCRIPTION_TAIL
}

/** Turn a refusal into the tool-result shape, keeping the stable code. */
function refused(error: unknown): ToolResult {
  if (error instanceof TodoError) return { output: '', error: { code: error.code, message: error.message } }
  return { output: '', error: { code: 'TODO_TOOL_ERROR', message: error instanceof Error ? error.message : String(error) } }
}

/** The setting, checked here too, so a caller that builds the tool in code cannot skip the choice. */
function policyOf(config: TodoToolConfig | undefined): boolean {
  const value = (config as { readonly allowParallelInProgress?: unknown } | undefined)?.allowParallelInProgress
  if (typeof value !== 'boolean') throw new TypeError('the todo tool requires allowParallelInProgress, a boolean with no default')
  return value
}

/** The todo tool, bound to one todo service and its required setting. */
export function todoTools(todos: TodoService, config: TodoToolConfig): ToolDefinition[] {
  const allowParallel = policyOf(config)
  return [
    {
      spec: {
        name: 'todo_write',
        description: describeTodoWrite(allowParallel),
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
        /** Validation first, then the owner, in DSH's order: a bad list is refused for what it is. */
        let list
        try {
          list = validateTodos(args.todos, 'TODO_INVALID_LIST', allowParallel)
        } catch (error) {
          return refused(error)
        }
        if (context.session === undefined) {
          return { output: '', error: { code: 'TODO_TOOL_NO_SESSION', message: TODO_NO_SESSION_MESSAGE } }
        }
        try {
          const view = todos.write(context.session, list, { allowParallelInProgress: allowParallel })
          return {
            output: `Updated todo list: ${view.counts.pending} pending, ${view.counts.inProgress} in progress, ${view.counts.completed} completed.`,
            data: { todo: view },
          }
        } catch (error) {
          return refused(error)
        }
      },
    },
  ]
}
