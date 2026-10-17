import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import { SandboxDenial, type SandboxService } from '../sandbox/service.ts'
import type { ToolSpec } from '../llm/types.ts'
import type { ApprovalService } from '../approvals/service.ts'

/** What a tool is given when it runs. */
import type { SessionHandle } from '../session/store.ts'

export interface ToolContext {
  /** Where the effect lands, already resolved and permitted. */
  readonly cwd: string
  /**
   * The session this call belongs to, when the tool is session-scoped.
   *
   * A goal belongs to a session, so the goal tools need the handle; tools that only touch the filesystem
   * ignore it. It is passed by the loop, which is the only layer that knows which session a call is in —
   * taking it from the model's arguments would let a call name someone else's session.
   */
  readonly session?: SessionHandle
  readonly signal?: AbortSignal
  /** Where to write a line about what happened; never a secret. */
  readonly log: (message: string) => void
}

/** What a tool answers with. */
export interface ToolResult {
  /** The text a model reads back. */
  readonly output: string
  /** A refusal, with the reason a user is shown. */
  readonly error?: { readonly code: string; readonly message: string }
  /** Anything a caller wants to keep; never sent to the model unless in `output`. */
  readonly data?: Record<string, unknown>
}

/** One tool. `spec` is what the model is told; `run` is what happens. */
export interface ToolDefinition {
  readonly spec: ToolSpec
  readonly run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

/** One command: a name a person types, and the same execution path as a tool. */
export interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly run: (args: readonly string[], context: ToolContext) => Promise<ToolResult>
}

/**
 * The tool registry.
 *
 * Tools are **registered as services** rather than imported by the code that
 * needs them, which is the property the goal asks for and the one that makes a
 * tool removable by configuration. The registry also owns the order of the two
 * gates, and the order is not arbitrary:
 *
 * 1. **approval** decides whether this action may be taken at all;
 * 2. **sandbox** decides where its effect may land.
 *
 * Checking the sandbox first would report "outside the workspace" for a tool the
 * policy had already refused, which sends the reader to the wrong setting.
 */
export class ToolRegistry extends Service {
  static readonly provide = 'tools'

  private readonly tools = new Map<string, ToolDefinition>()
  private readonly commands = new Map<string, CommandDefinition>()
  /**
   * Both gates, held as fields rather than constructor parameter properties:
   * this project compiles with `erasableSyntaxOnly`, so a parameter property is
   * not available. Measured by the compiler rather than assumed.
   */
  private readonly approvals: ApprovalService
  private readonly sandbox: SandboxService

  constructor(ctx: Context, approvals: ApprovalService, sandbox: SandboxService) {
    super(ctx, 'tools')
    this.approvals = approvals
    this.sandbox = sandbox
  }

  /**
   * Add or replace a tool.
   *
   * A definition with no name or no description is refused **here**, because both are what the model
   * is told: an unnamed tool cannot be called and an undescribed one is a tool a model cannot choose.
   * Measured: without this, a malformed registration reached the listing as an empty name and the
   * failure surfaced as a confusing prompt rather than at the line that caused it.
   */
  register(definition: ToolDefinition): void {
    if (typeof definition.spec?.name !== 'string' || definition.spec.name.trim().length === 0) {
      throw new Error('a tool must be registered with a name')
    }
    if (typeof definition.spec.description !== 'string' || definition.spec.description.trim().length === 0) {
      throw new Error(`the tool '${definition.spec.name}' must be registered with a description`)
    }
    this.tools.set(definition.spec.name, definition)
  }

  /**
   * Drop every tool the allow list does not name, keeping the ones it does.
   *
   * Called once the tree has loaded rather than from the constructor, because plugins register tools
   * too and a filter applied early would remove them before they existed — measured, and it is what
   * stopped a project replacing a built-in with its own version of the same name.
   */
  filterTo(allow: readonly string[]): void {
    if (allow.length === 0) return
    for (const name of [...this.tools.keys()]) {
      if (!allow.includes(name)) this.tools.delete(name)
    }
  }

  /** Add or replace a command. */
  registerCommand(definition: CommandDefinition): void {
    this.commands.set(definition.name, definition)
  }

  /** The names a caller may ask for. */
  names(): readonly string[] {
    return [...this.tools.keys()]
  }

  /**
   * Configured names that nothing registered.
   *
   * On the base registry so the question can be asked of any implementation; the plugin that reads
   * an allow list knows what the configuration wanted, and this is where it reports it.
   */
  missing(): readonly string[] {
    return []
  }

  /** The configured allow list, empty when the configuration did not name one. */
  allowList(): readonly string[] {
    return []
  }

  /** Every tool's description, which is what `--list` prints. */
  describe(): readonly ToolSpec[] {
    return [...this.tools.values()].map((tool) => tool.spec)
  }

  /** Every command, for `--list` and for a command line to dispatch to. */
  describeCommands(): readonly { name: string; description: string }[] {
    return [...this.commands.values()].map(({ name, description }) => ({ name, description }))
  }

  /** Whether a tool exists, so a caller can distinguish unknown from refused. */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * Run one tool call.
   *
   * Never throws for an expected failure: a refusal, a sandbox denial and a tool's
   * own error all come back as a `ToolResult` with `error` set, because the caller
   * is a model turn that must be told what happened rather than a program that
   * should crash.
   */
  async call(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (tool === undefined) {
      return { output: '', error: { code: 'UNKNOWN_TOOL', message: `no tool named '${name}'; known: ${this.names().join(', ') || '(none)'}` } }
    }

    const decision = this.approvals.check(name)
    if (!decision.allowed) {
      context.log(`denied ${name}: ${decision.reason ?? 'no reason given'}`)
      return { output: '', error: { code: 'DENIED', message: decision.reason ?? `the approval policy refused '${name}'` } }
    }

    /**
     * The hook point before a tool runs, modelled on DSH's `tools/pre-execute`.
     *
     * A waterfall, so a listener can refuse by not calling `next()` — which is the
     * only veto mechanism that composes: each listener decides whether the chain after
     * it runs at all. DSH's decision type is allow/deny/ask and it deliberately does
     * **not** permit argument rewriting; this keeps that, so a hook can stop a call but
     * cannot silently change what it does.
     */
    const pre = this.ctx.waterfall('tools/pre-execute', { name, args }, () => ({ allowed: true as const }))
    if (!pre.allowed) {
      context.log(`hooked ${name}: ${pre.reason ?? 'refused by a hook'}`)
      return { output: '', error: { code: 'HOOKED', message: pre.reason ?? `a hook refused '${name}'` } }
    }

    try {
      const result = await tool.run(args, context)
      /**
       * The hook point after a tool runs, modelled on DSH's `tools/post-execute`: a
       * waterfall over the result, so a listener may replace it — which is how a policy
       * redacts a secret or spills a huge result — or block it.
       */
      return this.ctx.waterfall('tools/post-execute', { name, args, result }, () => result)
    } catch (error) {
      if (error instanceof SandboxDenial) {
        context.log(`denied ${name}: ${error.message}`)
        return { output: '', error: { code: 'SANDBOX', message: error.message } }
      }
      return { output: '', error: { code: 'TOOL_FAILED', message: (error as Error).message } }
    }
  }

  /** Run one command, which shares the gates and the result shape with a tool. */
  async runCommand(name: string, args: readonly string[], context: ToolContext): Promise<ToolResult> {
    const command = this.commands.get(name)
    if (command === undefined) {
      return { output: '', error: { code: 'UNKNOWN_COMMAND', message: `no command named '${name}'` } }
    }
    const decision = this.approvals.check(`command:${name}`)
    if (!decision.allowed) {
      return { output: '', error: { code: 'DENIED', message: decision.reason ?? `the approval policy refused '${name}'` } }
    }
    return command.run(args, context)
  }

  /** The sandbox this registry gates against, so a caller can report its mode. */
  sandboxPolicy() {
    return this.sandbox.policy()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['tools', 'approvals', 'sandbox']`. */
    tools: ToolRegistry
  }
}


declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Waterfall before a tool runs. Return `{ allowed: false, reason }` without calling
     * `next()` to refuse; the refusal is reported as a tool error, so the model is told.
     *
     * @mode waterfall
     */
    'tools/pre-execute'(
      this: ToolRegistry,
      call: { readonly name: string; readonly args: Record<string, unknown> },
      next: () => { readonly allowed: true },
    ): { readonly allowed: boolean; readonly reason?: string }
    /**
     * Waterfall after a tool ran. Call `next()` for the tool's own result and return
     * whatever should stand in its place.
     *
     * @mode waterfall
     */
    'tools/post-execute'(
      this: ToolRegistry,
      call: { readonly name: string; readonly args: Record<string, unknown>; readonly result: ToolResult },
      next: () => ToolResult,
    ): ToolResult
  }
}
