import Schema from '@deepseek-ai/schemastery'

import { builtinTools } from '../tools/builtin.ts'
import { ToolRegistry } from '../tools/service.ts'

export const name = 'tools'

/**
 * The tools plugin, as a service class.
 *
 * It is a class rather than a function with an exported `inject` array because
 * the loader's own `inject` row is the mechanism that actually gates a plugin:
 * measured, a function that read `ctx.approvals` failed at load with "cannot get
 * property approvals without inject" while the loader reported no pending entry,
 * so the documented array was silently ignored. A service declares its
 * dependency where Cordis reads it.
 */
export default class ToolsPlugin extends ToolRegistry {
  /** What the configuration named, kept so a caller can ask what never arrived. */
  private readonly allow: readonly string[]

  /** Configured tool names that nothing registered. Empty when the configuration is satisfied. */
  override missing(): readonly string[] {
    return this.allow.filter((tool) => !this.has(tool))
  }

  /** The allow list this row carried, so a caller can apply it once the tree has loaded. */
  override allowList(): readonly string[] {
    return this.allow
  }

  static readonly Config = Schema.object({
    /** Tools to enable, by name. Empty means every registered tool. */
    allow: Schema.array(Schema.string()).default([]),
    /** Register the harness's own four tools. */
    includeBuiltins: Schema.boolean().default(true),
    /** Wall time a `bash` call may take before it is killed. */
    bashTimeoutMs: Schema.number().default(30_000),
  })

  static readonly inject = ['approvals', 'sandbox', 'session']

  constructor(ctx: import('@deepseek-ai/cordis').Context, config: { allow?: readonly string[]; includeBuiltins?: boolean; bashTimeoutMs?: number } = {}) {
    super(ctx, ctx.approvals, ctx.sandbox, ctx.session)
    /** Tools the configuration named and nothing registered, reported once the tree is loaded. */
    const cfgProblems: string[] = []

    const definitions = config.includeBuiltins === false ? [] : [...builtinTools(ctx.sandbox, { ...(config.bashTimeoutMs !== undefined ? { bashTimeoutMs: config.bashTimeoutMs } : {}) })]
    const allow = config.allow ?? []
    /**
     * The built-ins are registered whether or not the allow list names them, and the list is enforced
     * as a **configuration check** afterwards rather than as a filter here.
     *
     * Measured, on a plugin that registers a name a built-in uses: filtering by `allow` dropped the
     * plugin's own tool, because a plugin's name is not in the profile's list of built-ins — so a
     * project could not replace a built-in with its own version of the same name, which is the most
     * ordinary reason to register one. The list still decides whether a run is *valid*: a name nothing
     * registered fails the run, and `missing()` is what reports it.
     */
    for (const definition of definitions) this.register(definition)

    /**
     * The allow list is checked **by the caller, once the tree has loaded**, not here.
     *
     * Measured: checking it in the constructor failed on a tool another plugin registers, because
     * row order is not load order. Checking it on `heddle/ready` was worse — `boot` emits that
     * event before it returns, so a listener could not be attached in time and the check silently
     * never ran. The honest mechanism is a question the caller asks: `missing` names what the
     * configuration asked for and nothing provided.
     */
    this.allow = allow

    /**
     * The registry's own summary is deferred by one turn of the loop.
     *
     * Measured: printed from the constructor it said "tools: 3 registered" while a plugin loaded
     * later registered a fourth, so the line a person reads first was wrong. A tree whose plugins
     * register tools cannot know its own size until they have all started.
     */
    queueMicrotask(() => {
      ctx.logger.info(
        'tools: %d registered, %d command(s) — %s',
        this.names().length,
        this.describeCommands().length,
        this.names().join(', '),
      )
    })
  }
}
