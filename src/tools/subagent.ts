import type { ToolContext, ToolDefinition, ToolResult } from './service.ts'
import { SubagentError, type SubagentDeps, type SubagentLimits } from '../agent/subagent.ts'
import { delegateSubagent } from '../agent/subagent.ts'

/**
 * The model-facing delegation tool, modelled on DSH's `dsh-tool-subagent`.
 *
 * One call = one child agent: the tool creates the child session (with its parent, origin and depth in the
 * metadata), runs one bounded child turn, and returns the child's **final answer** as the tool result. The
 * parent's own turn then continues with that text, which is how a delegation looks from the parent's side —
 * a tool call and a result, exactly as DSH's subagent run appears in the parent's transcript.
 *
 * Depth and active limits belong to the runtime (`SubagentLimits`), not to the tool's description, so a model
 * cannot be talked past them by a prompt.
 */
export function subagentTools(deps: SubagentDeps, limits: SubagentLimits = {}): ToolDefinition[] {
  return [
    {
      spec: {
        name: 'delegate',
        description:
          'Delegate one task to a child agent that works in its own session and returns its final answer. Use it for a scoped piece of work that benefits from a fresh context; the child sees only the prompt you give it, not this conversation.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The complete task for the child agent; it has no access to this conversation.' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
      run: async (args, context): Promise<ToolResult> => {
        const prompt = String(args.prompt ?? '')
        try {
          const result = await delegateSubagent(
            deps,
            context.session,
            prompt,
            limits,
            { ...(context.signal !== undefined ? { signal: context.signal } : {}), active: activeFor(context, deps) },
          )
          return {
            output: `child ${result.childSession} (depth ${result.depth}) answered:\n${result.text}`,
            data: { childSession: result.childSession, depth: result.depth, text: result.text },
          }
        } catch (error) {
          if (error instanceof SubagentError) return { output: '', error: { code: error.code, message: error.message } }
          return { output: '', error: { code: 'SUBAGENT_FAILED', message: error instanceof Error ? error.message : String(error) } }
        }
      },
    },
  ]
}

/** One in-flight set per tool instance, keyed by parent id by the delegation itself. */
const inflight = new WeakMap<SubagentDeps, Set<string>>()
function activeFor(_context: ToolContext, deps: SubagentDeps): Set<string> {
  const existing = inflight.get(deps)
  if (existing !== undefined) return existing
  const created = new Set<string>()
  inflight.set(deps, created)
  return created
}
