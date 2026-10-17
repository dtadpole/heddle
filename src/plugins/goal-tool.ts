import type { Context } from '@deepseek-ai/cordis'

import { goalTools } from '../goal/tool.ts'

/** Name this plugin is registered and logged under. */
export const name = 'goal-tool'

/** The tools need the goal service to mutate, and the registry to appear in. */
export const inject = ['goal', 'tools']

/**
 * Register the model-facing goal tools.
 *
 * A separate plugin from the goal service so a profile can keep the state without offering the tools —
 * a person driving goals from the UI does not need the model to have the verbs, and removing a
 * capability by configuration is the property this project's tool registry exists to provide.
 */
export function apply(ctx: Context): void {
  for (const tool of goalTools(ctx.goal)) ctx.tools.register(tool)
}
