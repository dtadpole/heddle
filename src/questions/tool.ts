import { readFileSync } from 'node:fs'

import type { ToolDefinition, ToolResult } from '../tools/service.ts'
import type { SessionHandle } from '../session/store.ts'
import { MAX_TIMEOUT_SECONDS, QuestionError, type QuestionService } from './service.ts'

/**
 * The model-facing `ask_user_question` tool, as DSH's `dsh-tool-ask-user` defines it.
 *
 * The schema is DSH's: a batch of questions with ids the answer echoes, an optional header, options with a label and a
 * one-sentence description, and a multi-select flag; in timed mode a per-call `timeout` in seconds. The result is
 * compact JSON - `{"answers":[...]}`, or `{"pending":true,"callId":...,"message":...}` when a timed wait ran out - and
 * a delegated agent is refused with `DELEGATED_CALLER`, because a child must carry the decision back to its parent.
 */

export const ASK_USER_TOOL = 'ask_user_question'

const DESCRIPTION =
  'Ask the user for confirmation, a choice, or missing information. Send one or more questions with ids unique within ' +
  'the call; the answer echoes those ids. Put a recommended option first and append "(Recommended)" to its label. A ' +
  'skipped question comes back with empty selected and no custom.'

const PENDING_MESSAGE =
  'The user has not answered yet. The questions stay answerable; continue with work that does not depend on the answer. ' +
  'A later answer arrives as a user message naming this callId. A timeout is never approval.'

/** The JSON Schema the model is shown; `timed` adds DSH's per-call wait. */
export function askUserParameters(timed: boolean, defaultTimeout: number): Record<string, unknown> {
  const question = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stable id for this question; echoed in the answer.' },
      question: { type: 'string', description: 'The specific question to ask the user.' },
      header: { type: 'string', description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".' },
      options: {
        type: 'array',
        description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short user-facing option label.' },
            description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
          },
          required: ['label'],
        },
      },
      multi_select: { type: 'boolean', description: 'Whether the user may select more than one option. Defaults to false.' },
    },
    required: ['id', 'question'],
  }
  const properties: Record<string, unknown> = {
    questions: { type: 'array', minItems: 1, description: timed ? 'Questions to ask the user before continuing.' : 'Questions to ask the user.', items: question },
  }
  if (timed) {
    properties.timeout = {
      type: 'integer',
      minimum: -1,
      maximum: MAX_TIMEOUT_SECONDS,
      description: `Wait seconds for the entire batch (default ${defaultTimeout}); omit unless the user specifies a duration. Use -1 only when an answer is required before proceeding.`,
    }
  }
  return { type: 'object', properties, required: ['questions'] }
}

/** Whether a session is a delegated child: its record names a parent. */
function delegatedParent(handle: SessionHandle): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(handle.meta, 'utf8')) as { parentSession?: unknown }
    return typeof meta.parentSession === 'string' ? meta.parentSession : undefined
  } catch {
    return undefined
  }
}

const refusal = (code: string, message: string): ToolResult => ({ output: message, error: { code, message } })

/** The tool, bound to one question service. */
export function askUserTool(questions: QuestionService): ToolDefinition {
  const timed = questions.mode === 'timed'
  return {
    spec: { name: ASK_USER_TOOL, description: DESCRIPTION, parameters: askUserParameters(timed, questions.defaultTimeout) },
    async run(args, context) {
      const session = context.session
      if (session === undefined) return refusal('NO_SESSION', 'ask_user_question needs a session a person can answer in')
      if (delegatedParent(session) !== undefined) {
        return refusal('DELEGATED_CALLER', 'a delegated agent cannot ask the user; include the unresolved question or decision in your final result')
      }
      try {
        const outcome = await questions.ask(session, args.questions, { timeout: args.timeout, signal: context.signal })
        if (outcome.kind === 'pending') {
          return { output: JSON.stringify({ pending: true, callId: outcome.callId, message: PENDING_MESSAGE }), data: { callId: outcome.callId, pending: true } }
        }
        return { output: JSON.stringify({ answers: outcome.answers }), data: { answers: outcome.answers } }
      } catch (error) {
        if (error instanceof QuestionError) return refusal(error.code, error.message)
        throw error
      }
    },
  }
}
