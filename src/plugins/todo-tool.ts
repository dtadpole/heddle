import type { Context } from '@deepseek-ai/cordis'

import { todoTools, TodoToolConfig } from '../todo/tool.ts'

/** Name this plugin is registered and logged under. */
export const name = 'todo-tool'

/** The tools need the todo service to mutate, and the registry to appear in. */
export const inject = ['todo', 'tools']

/**
 * The tool's one setting, DSH's `allowParallelInProgress`: a required boolean with no default, so a row
 * that mounts this plugin without it fails to load rather than quietly picking a policy.
 */
export const Config = TodoToolConfig

/**
 * Register the model-facing todo tool.
 *
 * A separate plugin from the todo service so a profile can keep the durable list without offering the
 * verb — the same split goals use, for the same reason: a capability is removed by configuration.
 */
export function apply(ctx: Context, config: TodoToolConfig): void {
  for (const tool of todoTools(ctx.todo, config)) ctx.tools.register(tool)
}
