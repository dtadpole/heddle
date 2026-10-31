import type { Context } from '@deepseek-ai/cordis'

import { askUserTool } from '../questions/tool.ts'

/** Name this plugin is registered and logged under. */
export const name = 'questions-tool'

/** The tool needs the question service to ask through, and the registry to appear in. */
export const inject = ['questions', 'tools']

/**
 * Register the model-facing `ask_user_question` tool.
 *
 * A separate row from the question service, as goal and todo are: a profile can keep the service (and the card a
 * person answers in) without offering the model the verb.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(askUserTool(ctx.questions))
}
