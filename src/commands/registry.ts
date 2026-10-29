import { randomBytes } from 'node:crypto'

import type { SessionEvent, SessionHandle } from '../session/store.ts'

/**
 * The host's slash commands: a registry, the line parser and the one way a command runs.
 *
 * Modelled on DSH's `dsh-commands` (`CommandRuntime`), re-read from its source on 2026-10-29. Four rules are DSH's and
 * each is the place a command layer goes quietly wrong:
 *
 * - **A command line is parsed once, here.** `/name` must open the line and end at whitespace or the end
 *   ({@link COMMAND_LINE}); the name is lower-case (`/^[a-z][a-z0-9_-]*$/`). Everything after the name — the separating
 *   whitespace included — is the command's raw input.
 * - **An unknown name is not a failure.** {@link CommandRegistry.execute} answers `undefined` and records nothing, so a
 *   caller sends the line on as an ordinary prompt. That is how DSH passes `/skillname` to the model, and why a typo
 *   like `/compcat` reaches the model rather than vanishing.
 * - **A run is two log-only events.** `command/run` is appended before the handler runs and `command/done` after it,
 *   both outside the model's surface: a command is something the person did to the session, not something said to
 *   the model. A handler that throws is a `command/done` of kind `error`, never a half-written run.
 * - **The handler's words are the result.** It answers `{kind: 'success', text?}` or `{kind: 'error', text}`; the page
 *   shows them in the command's row rather than echoing them into the composer.
 */

/** A command name: lower-case, starting with a letter. */
export const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/

/** A command line: `/name` opening the line, ending at whitespace or the end of the line. */
export const COMMAND_LINE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/

/** The log event a run starts with, appended before the handler. */
export const COMMAND_RUN_EVENT = 'command/run'

/** The log event a run ends with. */
export const COMMAND_DONE_EVENT = 'command/done'

/** What a command takes after its name, when it takes anything. */
export interface CommandInput {
  /** The argument shape a person reads in the menu, for example `<text>` or `[off|message]`. */
  readonly hint: string
  /** Whether attachments may travel with the line. */
  readonly attachments?: boolean
}

/** Where the page's menu lists a command when nothing has been typed: DSH's two sections. */
export type CommandSection = 'add' | 'commands'

/** Something the page does after a successful run, because only the page can do it. */
export type CommandAction = { readonly kind: 'download'; readonly href: string }

/** A handler's answer. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number; readonly action?: CommandAction }
  | { readonly kind: 'error'; readonly text: string }

/** What a handler is given for one run. */
export interface CommandContext {
  readonly session: SessionHandle
  readonly commandId: string
  /** Everything after the name, the separating whitespace included. */
  readonly rawInput: string
  /** The raw input with surrounding whitespace removed: what most commands read. */
  readonly args: string
}

/** One command, as a plugin registers it. */
export interface CommandDefinition {
  readonly name: string
  readonly description: string
  /** The name a person reads in the menu; the name with an upper-case first letter when absent. */
  readonly label?: string
  readonly section?: CommandSection
  readonly input?: CommandInput
  /** `false` keeps the raw input out of the log (DSH's `/feedback`). Defaults to `true`. */
  readonly recordInput?: boolean
  readonly handler: (context: CommandContext) => CommandResult | Promise<CommandResult>
}

/** A command as the page lists it: everything but the handler. */
export interface CommandDescriptor {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly section: CommandSection
  readonly input?: CommandInput
}

/** One finished run. */
export interface CommandExecution {
  readonly commandId: string
  readonly name: string
  readonly result: CommandResult
  /** The `command/done` event's sequence number in the session log. */
  readonly seq: number
}

/** The part of the session store a run writes to. */
export interface CommandLog {
  append(handle: SessionHandle, event: { readonly type: string; readonly [field: string]: unknown }): SessionEvent
}

/** A parsed command line, or `undefined` when the line is not one. */
export function parseCommandLine(line: string): { readonly name: string; readonly rawInput: string } | undefined {
  const match = COMMAND_LINE.exec(line)
  if (match === null || match[1] === undefined) return undefined
  return { name: match[1], rawInput: line.slice(match[0].length) }
}

/** The label a command shows when it declares none: `compact` reads `Compact`. */
export function defaultLabel(name: string): string {
  return name.length === 0 ? name : `${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
}

/**
 * The registry of host commands.
 *
 * Names are unique: registering a name twice is refused, because two handlers for one line would make which one
 * runs an accident of load order. {@link register} returns the disposer, so a plugin's commands leave with it.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>()
  private readonly prefix = `cmd-${randomBytes(4).toString('hex')}`
  private count = 0

  /** Add one command; refused when the name is malformed, the description empty, or the name taken. */
  register(definition: CommandDefinition): () => void {
    if (!COMMAND_NAME.test(definition.name)) {
      throw new Error(`command name '${definition.name}' must be lower-case and start with a letter (${String(COMMAND_NAME)})`)
    }
    if (definition.description.trim().length === 0) throw new Error(`command '${definition.name}' needs a description`)
    if (this.commands.has(definition.name)) throw new Error(`a command named '${definition.name}' is already registered`)
    this.commands.set(definition.name, definition)
    return () => {
      if (this.commands.get(definition.name) === definition) this.commands.delete(definition.name)
    }
  }

  /** Whether a name is registered. */
  has(name: string): boolean {
    return this.commands.has(name)
  }

  /** Every command, sorted by name: what `GET /api/commands` answers. */
  list(): readonly CommandDescriptor[] {
    return [...this.commands.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((definition) => ({
        name: definition.name,
        label: definition.label ?? defaultLabel(definition.name),
        description: definition.description,
        section: definition.section ?? (definition.input !== undefined ? 'add' : 'commands'),
        ...(definition.input !== undefined ? { input: definition.input } : {}),
      }))
  }

  /**
   * Run a line in a session, or answer `undefined` when it is not a registered command.
   *
   * `undefined` writes nothing: the line was never a command, and the caller sends it on as a prompt.
   */
  async execute(log: CommandLog, session: SessionHandle, line: string): Promise<CommandExecution | undefined> {
    const parsed = parseCommandLine(line)
    if (parsed === undefined) return undefined
    const definition = this.commands.get(parsed.name)
    if (definition === undefined) return undefined

    this.count += 1
    const commandId = `${this.prefix}-${this.count}`
    const args = parsed.rawInput.trim()
    log.append(session, {
      type: COMMAND_RUN_EVENT,
      commandId,
      name: definition.name,
      ...(definition.recordInput !== false && args.length > 0 ? { args } : {}),
      source: { kind: 'user' },
    })

    let result: CommandResult
    try {
      result = await definition.handler({ session, commandId, rawInput: parsed.rawInput, args })
    } catch (error) {
      result = { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
    const done = log.append(session, {
      type: COMMAND_DONE_EVENT,
      commandId,
      kind: result.kind,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(result.kind === 'success' && result.sourceEventSeq !== undefined ? { sourceEventSeq: result.sourceEventSeq } : {}),
    })
    return { commandId, name: definition.name, result, seq: done.seq }
  }
}
