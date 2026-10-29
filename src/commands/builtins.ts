import { SANDBOX_MODES, isSandboxMode, sandboxModeRank, type SandboxMode } from '../sandbox/service.ts'
import type { SessionHandle } from '../session/store.ts'
import type { CommandDefinition, CommandLog, CommandResult } from './registry.ts'

/**
 * The built-in host commands, with DSH's names, descriptions, argument forms and sentences.
 *
 * Each is a factory over the smallest host it needs, so a command is judged against a double and wired to the real
 * services in one place (`service.ts`). The words a person reads are DSH's, re-read from its source on 2026-10-29;
 * where heddle has no equivalent fact (a ZIP archive, an approval preset) the sentence says what heddle does instead.
 * `/goal` has its own file, `goal.ts`.
 */

/** What a manual compaction reports. */
export interface CompactionOutcome {
  readonly compacted: boolean
  /** How many history items the summary replaced. */
  readonly items?: number
  /** Roughly how many tokens the replaced items held. */
  readonly tokens?: number
  /** The summary's sequence number in the session log. */
  readonly summarySeq?: number
}

/** The compaction `/compact` asks for: summarise the session's older history now. */
export interface CompactionHost {
  compactNow(handle: SessionHandle): Promise<CompactionOutcome>
}

/** `/compact` — compact older history now. It takes no arguments. */
export function compactCommand(host: CompactionHost): CommandDefinition {
  return {
    name: 'compact',
    label: 'Compact',
    section: 'commands',
    description: 'Compact older conversation history',
    handler: async ({ session, args }): Promise<CommandResult> => {
      if (args.length > 0) return { kind: 'error', text: 'Usage: /compact (no arguments)' }
      const outcome = await host.compactNow(session)
      if (!outcome.compacted) return { kind: 'success', text: 'No compactable history yet.' }
      const items = outcome.items !== undefined ? `${outcome.items} history items` : 'older history'
      const tokens = outcome.tokens !== undefined ? ` (~${outcome.tokens} tokens)` : ''
      return {
        kind: 'success',
        text: `Compacted ${items}${tokens}.`,
        ...(outcome.summarySeq !== undefined ? { sourceEventSeq: outcome.summarySeq } : {}),
      }
    },
  }
}

/** The log event `/feedback` appends. */
export const FEEDBACK_EVENT = 'feedback/record'

/** `/feedback <text>` — record feedback about this session in its log. The text is not repeated in `command/run`. */
export function feedbackCommand(log: CommandLog, anonymousUser: () => string): CommandDefinition {
  return {
    name: 'feedback',
    label: 'Feedback',
    section: 'add',
    description: 'Record feedback about this session',
    input: { hint: '<text>' },
    recordInput: false,
    handler: ({ session, args }) => {
      if (args.length === 0) return { kind: 'error', text: 'Feedback text is required. Usage: /feedback <text>' }
      const user = anonymousUser()
      log.append(session, { type: FEEDBACK_EVENT, text: args, anonymousUser: user })
      return { kind: 'success', text: `Feedback recorded for session ${session.id}\nAnonymous user: ${user}.` }
    },
  }
}

/** The session's access mode, read and written as the access chip does. */
export interface PermissionHost {
  current(handle: SessionHandle): SandboxMode
  set(handle: SessionHandle, mode: SandboxMode): { readonly changed: boolean }
}

/**
 * `/permission <preset>` — switch the session's access mode.
 *
 * heddle's presets are its three sandbox modes. Widening to `danger-full-access` is the one change the access chip
 * guards with a risk gate, and a typed line cannot acknowledge one, so the command refuses it and names the chip.
 */
export function permissionCommand(host: PermissionHost): CommandDefinition {
  const available = SANDBOX_MODES.join(', ')
  return {
    name: 'permission',
    label: 'Permission',
    section: 'commands',
    description: 'Switch the permission preset (sandbox mode + approval policy)',
    input: { hint: '<preset>' },
    handler: ({ session, args }) => {
      const current = host.current(session)
      if (args.length === 0) return { kind: 'success', text: `current preset ${current} (available: ${available})` }
      if (!isSandboxMode(args)) return { kind: 'error', text: `unknown preset "${args}" (available: ${available})` }
      if (args === 'danger-full-access' && sandboxModeRank(args) > sandboxModeRank(current)) {
        return {
          kind: 'error',
          text: "widening to 'danger-full-access' needs the risk gate: choose it from the access control in the composer",
        }
      }
      host.set(session, args)
      return { kind: 'success', text: `preset ${args}` }
    },
  }
}

/** `/export` — download this session's log, the same bytes as Download log. It takes no path. */
export function exportCommand(): CommandDefinition {
  return {
    name: 'export',
    label: 'Export',
    section: 'commands',
    description: 'Download this session log',
    handler: ({ session, args }) => {
      if (args.length > 0) return { kind: 'error', text: 'The Web /export command does not accept a path.' }
      return {
        kind: 'success',
        text: 'Session log download requested.',
        action: { kind: 'download', href: `/api/sessions/${encodeURIComponent(session.id)}/log` },
      }
    },
  }
}
