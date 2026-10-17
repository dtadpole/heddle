import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { runTurn } from '../agent/loop.ts'
import type { TurnRegistry } from '../agent/turns.ts'
import { TEAM_POLICY, TEAM_POLICY_NOTE_ORIGIN } from '../team/policy.ts'
import { TeamService } from '../team/service.ts'
import { TeamError } from '../team/state.ts'
import { teamTools } from '../team/tool.ts'

/** The Agent Teams plugin: one durable service and the nine model-facing tools. */
export const name = 'team'

/**
 * The services a team needs. The live-turn registry is deliberately not injected: a profile that leaves the
 * `turns` row out still runs teams, with status limited to durable phases and interruption unavailable.
 */
export const inject = ['session', 'model', 'tools', 'context', 'sandbox']

export interface Config {
  readonly maxMembers?: number
  readonly maxTasks?: number
  readonly maxPendingMessagesPerMember?: number
  readonly maxMessageBytes?: number
}

export const Config = Schema.object({
  maxMembers: Schema.number().default(8),
  maxTasks: Schema.number().default(256),
  maxPendingMessagesPerMember: Schema.number().default(64),
  maxMessageBytes: Schema.number().default(65_536),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    team: TeamService
  }
  interface Events {
    'team/changed'(lead: string): void
  }
}

/**
 * Make the collaboration policy durable for a team member.
 *
 * DSH injects the policy into every member's system prompt. Heddle writes it as a `context/note` with its own
 * origin, once per session: it is then part of the surface for every later turn, survives a restart with the
 * team, and is distinguishable from the project's instructions and from the person's own words.
 */
function ensurePolicy(ctx: Context, ids: readonly string[]): void {
  const store = ctx.session.store
  for (const id of ids) {
    const handle = store.open(id)
    if (handle === null) continue
    if (store.read(handle).some((event) => event.type === 'context/note' && event.origin === TEAM_POLICY_NOTE_ORIGIN)) continue
    store.append(handle, {
      type: 'context/note',
      message: { role: 'system', content: [{ type: 'text', text: TEAM_POLICY }] },
      origin: TEAM_POLICY_NOTE_ORIGIN,
    })
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const store = ctx.session.store
  const service = new TeamService({
    store,
    /**
     * The registry is read through the context on every call rather than captured: rows load in any order, and
     * a profile may leave `turns` out entirely.
     */
    turns: {
      /**
       * `ctx.get` is the store read **without** the inject requirement: the `turns` row is optional, and the
       * guarded property access (`ctx.turns`) throws in a fiber that did not declare it, which turned every
       * status check into `TEAM_FAILED: cannot get property "turns" without inject`.
       */
      isRunning: (id) => (ctx.get('turns') as TurnRegistry | undefined)?.isRunning(id) ?? false,
      abort: (id) => (ctx.get('turns') as TurnRegistry | undefined)?.abort(id) ?? false,
    },
    limits: {
      maxMembers: config.maxMembers,
      maxTasks: config.maxTasks,
      maxPendingMessagesPerMember: config.maxPendingMessagesPerMember,
      maxMessageBytes: config.maxMessageBytes,
    },
    notify: (lead) => {
      ensurePolicy(ctx, [lead])
      ctx.emit('team/changed', lead)
    },
    warn: (message) => ctx.logger.warn('team: %s', message),
    run: async (child, prompt, source, signal) => {
      const meta = store.list().find((one) => one.id === child.id)
      const endpoint = meta?.endpoint ?? ctx.model.defaultEndpoint()
      if (endpoint === undefined) throw new TeamError('no endpoint is configured for a teammate turn', 'TEAM_UNAVAILABLE')
      await runTurn(ctx, {
        session: child,
        endpoint,
        prompt,
        /** A teammate's automatic turn, distinguishable from the Lead's by a backend that cares. */
        purpose: 'team',
        ...(source !== undefined ? { source } : {}),
        ...(meta?.model !== undefined ? { model: meta.model } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
    },
  })

  /** Cordis requires a service name to be declared before it can be assigned. */
  ctx.provide('team')
  ctx.set('team', service)
  for (const tool of teamTools(service, { onSpawn: (lead, member) => ensurePolicy(ctx, [lead, member]) })) {
    ctx.tools.register(tool)
  }

  /**
   * Reconcile teams a previous process left behind. Called by the server at boot rather than here, for the same
   * reason the goal driver is: a one-shot command must not start turns for sessions it is not working on.
   */
  ctx.on('heddle/ready', () => {
    ctx.logger.info('team: durable team service ready')
  })
}
