import type { ToolContext, ToolDefinition, ToolResult } from '../tools/service.ts'
import type { TeamService } from './service.ts'
import { TeamError } from './state.ts'

/**
 * The nine model-facing team tools, modelled on DSH's `tool-agent-team`.
 *
 * They are thin on purpose: every rule lives in the service or the pure state layer, so the same refusal a
 * teammate meets here is the one a test asserts. The tools only translate arguments, call the service, and
 * report the outcome — including `noProgress`, which is an answer rather than an error.
 */

export interface TeamToolOptions {
  /** Called after a successful spawn, so the profile can make the collaboration policy durable for the child. */
  readonly onSpawn?: (lead: string, member: string) => void
}

const ok = (output: string, data?: unknown): ToolResult => ({ output, ...(data !== undefined ? { data: data as Record<string, unknown> } : {}) })
const fail = (error: unknown): ToolResult => {
  if (error instanceof TeamError) return { output: '', error: { code: error.code, message: error.message } }
  return { output: '', error: { code: 'TEAM_FAILED', message: error instanceof Error ? error.message : String(error) } }
}

function callerOf(context: ToolContext): TeamContext {
  if (context.session === undefined) return { error: { code: 'TEAM_NO_SESSION', message: 'the team tools need a session' } }
  return { session: context.session }
}

type TeamContext = { readonly session: NonNullable<ToolContext['session']>; readonly error?: undefined } | { readonly error: { readonly code: string; readonly message: string } }

export function teamTools(service: TeamService, options: TeamToolOptions = {}): ToolDefinition[] {
  const withCaller = (
    run: (caller: NonNullable<ToolContext['session']>, args: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
  ) => async (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const caller = callerOf(context)
    if (caller.error !== undefined) return { output: '', error: caller.error }
    try {
      return await run(caller.session, args)
    } catch (error) {
      return fail(error)
    }
  }

  return [
    {
      spec: {
        name: 'spawn_teammate',
        description: 'Create one named, durable teammate. Only the Team Lead may call this tool. The teammate works in its own session and starts on the prompt you give it; use fresh context unless its work depends on the Lead’s completed turns.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique lower-kebab-case teammate name.' },
            description: { type: 'string', description: 'Short description of the delegated responsibility.' },
            prompt: { type: 'string', description: 'Complete initial task for the teammate.' },
            context: { type: 'string', enum: ['fresh', 'fork'], description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.' },
          },
          required: ['name', 'description', 'prompt'],
          additionalProperties: false,
        },
      },
      run: withCaller((caller, args) => {
        const view = service.spawn(caller, {
          name: String(args.name ?? ''),
          description: String(args.description ?? ''),
          prompt: String(args.prompt ?? ''),
          ...(args.context === 'fork' ? { context: 'fork' as const } : {}),
        })
        options.onSpawn?.(caller.id, view.id)
        return ok(JSON.stringify(view), view)
      }),
    },
    {
      spec: {
        name: 'send_message',
        description: 'Send one durable message to another team member. A running target receives it at its nearest step boundary; an inactive target starts or resumes a turn. The result’s status is accepted when the target’s own log holds it, queued when the target is still provisioning.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Member target returned by spawn_teammate or list_agents, or "lead".' },
            message: { type: 'string', description: 'The message; it is delivered as durable content with its id and sender name.' },
          },
          required: ['target', 'message'],
          additionalProperties: false,
        },
      },
      run: withCaller(async (caller, args) => {
        const sent = await service.send(caller, { target: String(args.target ?? ''), content: [{ type: 'text', text: String(args.message ?? '') }] })
        return ok(JSON.stringify(sent), sent)
      }),
    },
    {
      spec: {
        name: 'list_agents',
        description: 'List the Lead and every durable teammate with its addressable name and current availability. inactive means no turn is executing; provisioning and failed describe member creation.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      run: withCaller((caller, args) => {
        const members = service.list(caller)
        return ok(JSON.stringify(members), members)
      }),
    },
    {
      spec: {
        name: 'wait_agent',
        description: 'Wait for the next teammate status, mailbox or shared-task change after this call starts. Never wakes an inactive member, and returns noProgress immediately when no other member is running or provisioning. Re-list after waking or timing out.',
        parameters: {
          type: 'object',
          properties: { timeout_ms: { type: 'integer', description: 'Longest wait in milliseconds; defaults to 30000.' } },
          additionalProperties: false,
        },
      },
      run: withCaller(async (caller, args) => {
        const timeout = Math.min(120_000, Math.max(0, Number(args.timeout_ms ?? 30_000)))
        const result = await service.waitForChange(caller, timeout)
        if (result.noProgress === true) return ok('noProgress: no other member is running or provisioning; re-list with list_agents and wake one with send_message')
        if (result.timedOut === true) return ok('timedOut: no change before the wait ended; re-list with list_agents and team_task_list')
        return ok('changed: re-list with list_agents and team_task_list')
      }),
    },
    {
      spec: {
        name: 'interrupt_agent',
        description: 'Interrupt one teammate’s current turn while preserving its pending inbox. Team Lead only.',
        parameters: {
          type: 'object',
          properties: { target: { type: 'string', description: 'Member target from spawn_teammate or list_agents.' } },
          required: ['target'],
          additionalProperties: false,
        },
      },
      run: withCaller((caller, args) => {
        const result = service.interrupt(caller, String(args.target ?? ''))
        return ok(JSON.stringify(result), result)
      }),
    },
    {
      spec: {
        name: 'team_task_create',
        description: 'Create one unowned pending task on the shared team task board.',
        parameters: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Short task title.' },
            description: { type: 'string', description: 'Complete task details.' },
            blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
            write_scopes: { type: 'array', items: { type: 'string' }, description: 'Advisory file or directory prefixes this task expects to write.' },
          },
          required: ['subject'],
          additionalProperties: false,
        },
      },
      run: withCaller((caller, args) => {
        const view = service.createTask(caller, {
          subject: String(args.subject ?? ''),
          ...(args.description !== undefined ? { description: String(args.description) } : {}),
          ...(Array.isArray(args.blocked_by) ? { blockedBy: args.blocked_by.map(String) } : {}),
          ...(Array.isArray(args.write_scopes) ? { writeScopes: args.write_scopes.map(String) } : {}),
        })
        return ok(JSON.stringify(view), view)
      }),
    },
    {
      spec: {
        name: 'team_task_list',
        description: 'List shared tasks, including readiness, owner, revision, blockers and write-scope warnings.',
        parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] } }, additionalProperties: false },
      },
      run: withCaller((caller, args) => {
        const status = args.status
        const views = service.tasks(caller).filter((view) => status === undefined || view.status === status)
        return ok(JSON.stringify(views), views)
      }),
    },
    {
      spec: {
        name: 'team_task_get',
        description: 'Read the complete latest value of one shared task before changing or executing it.',
        parameters: { type: 'object', properties: { task_id: { type: 'string', description: 'Shared task id.' } }, required: ['task_id'], additionalProperties: false },
      },
      run: withCaller((caller, args) => {
        const task = service.tasks(caller).find((view) => view.id === String(args.task_id ?? ''))
        if (task === undefined) return { output: '', error: { code: 'TEAM_TASK_MISSING', message: 'no such shared task' } }
        return ok(JSON.stringify(task), task)
      }),
    },
    {
      spec: {
        name: 'team_task_update',
        description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list. Actions: claim, release, edit, set_dependencies, complete, reopen, reassign (Lead-only), delete.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Shared task id.' },
            revision: { type: 'integer', description: 'Current task revision used as the CAS precondition.' },
            action: { type: 'string', enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'] },
            subject: { type: 'string', description: 'Replacement title for edit.' },
            description: { type: 'string', description: 'Replacement details for edit.' },
            blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
            write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory write scopes for edit.' },
            owner: { type: 'string', description: 'Member target for a Lead-only reassign; omit to unassign.' },
          },
          required: ['task_id', 'revision', 'action'],
          additionalProperties: false,
        },
      },
      run: withCaller((caller, args) => {
        const state = service.state(caller)
        const owner = args.owner === undefined ? undefined : args.owner === 'lead' ? state.id : state.members.find((member) => member.name === String(args.owner))?.id
        if (args.owner !== undefined && owner === undefined) throw new TeamError(`no team member named '${String(args.owner)}'`, 'TEAM_MEMBER_INVALID')
        const view = service.updateTask(caller, {
          taskId: String(args.task_id ?? ''),
          revision: Number(args.revision),
          action: String(args.action) as never,
          ...(args.subject !== undefined ? { subject: String(args.subject) } : {}),
          ...(args.description !== undefined ? { description: String(args.description) } : {}),
          ...(Array.isArray(args.blocked_by) ? { blockedBy: args.blocked_by.map(String) } : {}),
          ...(Array.isArray(args.write_scopes) ? { writeScopes: args.write_scopes.map(String) } : {}),
          ...(owner !== undefined ? { ownerId: owner } : {}),
        })
        return ok(JSON.stringify(view), view)
      }),
    },
  ]
}


export const TEAM_TOOL_NAMES = [
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
] as const
