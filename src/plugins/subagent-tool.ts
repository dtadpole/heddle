import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { runTurn } from '../agent/loop.ts'
import { SubagentError, type SubagentDeps } from '../agent/subagent.ts'
import { subagentTools } from '../tools/subagent.ts'

/** Name this plugin is registered and logged under. */
export const name = 'subagent-tool'

/**
 * A child turn needs everything a turn needs; the session store and the model are what the child is created
 * with, so they are declared rather than assumed.
 */
export const inject = ['tools', 'session', 'model', 'sandbox', 'context']

export interface Config {
  /** Deepest allowed delegation chain. */
  readonly maxDepth?: number
  /** How many children one parent may run at once. */
  readonly maxActive?: number
}

export const Config: Schema<Config> = Schema.object({
  maxDepth: Schema.number().default(2),
  maxActive: Schema.number().default(1),
})

/**
 * Register the delegation tool.
 *
 * The runner is `runTurn` itself: a child is a normal turn in a normal session, which is what keeps the child's
 * context, tools and budget on the same code path as the parent's rather than in a second implementation.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const deps: SubagentDeps = {
    store: ctx.session.store,
    run: async (child, prompt, signal) => {
      const meta = ctx.session.list().find((one) => one.id === child.id)
      const endpoint = meta?.endpoint ?? ctx.model.defaultEndpoint()
      if (endpoint === undefined) throw new SubagentError('no endpoint is configured for a subagent run', 'SUBAGENT_FAILED')
      await runTurn(ctx, {
        session: child,
        endpoint,
        prompt,
        ...(meta?.model !== undefined ? { model: meta.model } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
    },
  }
  for (const tool of subagentTools(deps, { maxDepth: config.maxDepth ?? 2, maxActive: config.maxActive ?? 1 })) {
    ctx.tools.register(tool)
  }
}
