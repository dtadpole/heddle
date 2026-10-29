import type { ToolDefinition, ToolResult } from './service.ts'
import { SubagentError, type SubagentService } from '../agent/subagent.ts'

/**
 * The model-facing delegation tool, modelled on DSH's `dsh-tool-subagent`.
 *
 * One call = one child agent, started in the background: the tool creates the child session (with its parent,
 * origin and depth in the metadata), starts the child's turn and returns **at once** with `started subagent <id>`,
 * DSH's start result word for word. The parent keeps working; when the child settles, the parent receives a
 * settlement notice carrying the child's closing message (`SubagentService`), steered into its running turn or
 * starting a new one.
 *
 * Depth and active limits belong to the runtime (`SubagentLimits`), not to the tool's description, so a model
 * cannot be talked past them by a prompt.
 */
export function subagentTools(service: SubagentService): ToolDefinition[] {
  return [
    {
      spec: {
        name: 'delegate',
        description:
          'Start one task in a child agent that works in its own session. Returns at once with the child id; the child’s final answer arrives later in this conversation as a notice. Use it for a scoped piece of work that benefits from a fresh context; the child sees only the prompt you give it, not this conversation.',
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
          const started = service.start(context.session, prompt, context.signal !== undefined ? { signal: context.signal } : {})
          return {
            output: `started subagent ${started.childSession}`,
            data: { childSession: started.childSession, depth: started.depth, kind: 'activation' },
          }
        } catch (error) {
          if (error instanceof SubagentError) return { output: '', error: { code: error.code, message: error.message } }
          return { output: '', error: { code: 'SUBAGENT_FAILED', message: error instanceof Error ? error.message : String(error) } }
        }
      },
    },
  ]
}
