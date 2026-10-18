import type { Context } from '@deepseek-ai/cordis'

import { todoTools } from '../todo/tool.ts'

/** Name this plugin is registered and logged under. */
export const name = 'todo-tool'

/** The tools need the todo service to mutate, and the registry to appear in. */
export const inject = ['todo', 'tools']

/**
 * Register the model-facing todo tools.
 *
 * A separate plugin from the todo service so a profile can keep the durable list without offering the
 * verbs — the same split goals use, for the same reason: a capability is removed by configuration.
 */
export function apply(ctx: Context): void {
  for (const tool of todoTools(ctx.todo)) ctx.tools.register(tool)
}
