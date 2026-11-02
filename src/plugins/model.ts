import { statSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { describeEndpoint, resolveEndpoints } from '../endpoints.ts'
import { localConfigCandidates, readLocalConfig } from '../local-config.ts'
import { ModelService } from '../llm/service.ts'
import type { EndpointConfig } from '../llm/types.ts'

export const name = 'model'

/**
 * One endpoint's configuration.
 *
 * Only `name` is required, because an endpoint restating a default may carry just
 * the field it changes. Validation runs before the body, so a typo in a layer
 * fails the load and names the field rather than surfacing later as `undefined`
 * inside a URL.
 */
const endpointSchema = Schema.object({
  name: Schema.string().required(),
  kind: Schema.union([
    Schema.const('openai-chat' as const),
    Schema.const('openai-responses' as const),
    Schema.const('anthropic-vertex' as const),
    Schema.const('anthropic-messages' as const),
    Schema.const('scripted' as const),
  ]),
  baseUrl: Schema.string(),
  model: Schema.string(),
  /** The cloud project and region a publisher route is addressed under. */
  project: Schema.string(),
  region: Schema.string(),
  apiKey: Schema.string(),
  apiKeyFile: Schema.string(),
  headers: Schema.dict(Schema.string()),
  /** An HTTP forwarding proxy for this endpoint, as a URL. */
  proxy: Schema.string(),
  stream: Schema.boolean(),
  maxOutputTokens: Schema.number(),
  /** The model's context window, when this route knows it; the budget resolves from it first. */
  contextWindow: Schema.number(),
  capabilities: Schema.array(Schema.string()),
  timeoutMs: Schema.number(),
})

export const Config = Schema.object({
  /**
   * Endpoints this layer declares or restates.
   *
   * Empty in the repository's own layers on purpose: the values belong to the
   * machine, and `~/.heddle/heddle.json` exists for them.
   */
  endpoints: Schema.array(endpointSchema).default([]),
  /** The endpoint a caller means when it does not name one. */
  default: Schema.string(),
  /**
   * The model and reasoning effort a new session starts with when it names none (DSH's default model selection).
   * Checked when a session starts, not when written: a value the default endpoint no longer offers falls back to the
   * endpoint's own model and level with a warning, so a stale default never fails a session.
   */
  defaultModel: Schema.string(),
  defaultEffort: Schema.string(),
  /** Read the local file even when the layer named endpoints; off only in tests. */
  readLocalConfig: Schema.boolean().default(true),
})

export interface Config {
  readonly endpoints?: readonly Partial<EndpointConfig>[]
  readonly default?: string
  readonly defaultModel?: string
  readonly defaultEffort?: string
  readonly readLocalConfig?: boolean
}

/**
 * The model plugin: one service, and no knowledge of any wire shape.
 *
 * Which backends exist is configuration, each wire shape is an adapter's
 * business, and a machine's URLs and credentials live outside the checkout.
 * That separation is the point of the plugin being this small.
 */
export default function model(ctx: Context, config: Config = {}): void {
  /** The row's composition: the layers' endpoints, then the machine's file, its exclusions, and the default. */
  const compose = () => {
    const local = config.readLocalConfig === false ? null : readLocalConfig()
    const localEndpoints = (local?.config.endpoints ?? []) as readonly Partial<EndpointConfig>[]
    const excluded = Array.isArray(local?.config.exclude) ? local.config.exclude : []
    const endpoints = resolveEndpoints(config.endpoints ?? [], localEndpoints, process.env, excluded)
    const nominated = config.default ?? local?.config.default
    return { local, endpoints, nominated: typeof nominated === 'string' ? nominated : undefined }
  }
  const { local, endpoints, nominated } = compose()

  const service = new ModelService(ctx, endpoints)
  // The configuration's nominated default is recorded on the service, so a caller that does not name an
  // endpoint gets the one a person chose rather than the first one in the list.
  if (nominated !== undefined && service.endpoint(nominated) !== undefined) service.nominateDefault(nominated)
  service.setDefaults({
    ...(config.defaultModel !== undefined ? { model: config.defaultModel } : {}),
    ...(config.defaultEffort !== undefined ? { effort: config.defaultEffort } : {}),
  })
  /**
   * The machine's file applies to the next request without a restart, as DSH's provider settings do: before every
   * read and every call the service asks whether any candidate file changed (its path, modification time and size),
   * and recomposes when one did. A call already streaming keeps its endpoint. An edit that cannot be read (a
   * trailing comma, a patch naming nothing) keeps the previous endpoints and says why, rather than failing turns.
   */
  if (config.readLocalConfig !== false) {
    const candidates = localConfigCandidates()
    let stamp = stampOf(candidates)
    service.setRefresh(() => {
      const now = stampOf(candidates)
      if (now === stamp) return undefined
      stamp = now
      try {
        const next = compose()
        ctx.logger.info('model: the machine configuration changed; %d endpoint(s) — %s', next.endpoints.length, next.endpoints.map((entry) => entry.name).join(', '))
        return { endpoints: next.endpoints, ...(next.nominated !== undefined ? { nominated: next.nominated } : {}) }
      } catch (error) {
        ctx.logger.warn('model: the machine configuration changed but could not be read (%s); the previous endpoints stay', (error as Error).message)
        return undefined
      }
    })
  }
  ctx.set('model', service)

  ctx.logger.info(
    'model: %d endpoint(s) — %s',
    endpoints.length,
    endpoints
      .map(describeEndpoint)
      .map((entry) => `${String(entry.name)}(${String(entry.kind)}${entry.credential ? ',credential' : ''})`)
      .join(', '),
  )
  ctx.logger.debug('model: local configuration %s', local === null ? 'absent, using defaults' : `read from ${local.path}`)
  const fallback = config.default ?? local?.config.default
  if (typeof fallback === 'string') ctx.logger.debug('model: default endpoint is %s', fallback)
}

/** What identifies the candidate files' current contents without reading them: path, modification time and size. */
function stampOf(candidates: readonly string[]): string {
  return candidates
    .map((path) => {
      try {
        const stat = statSync(path)
        return `${path}:${stat.mtimeMs}:${stat.size}`
      } catch {
        return `${path}:absent`
      }
    })
    .join('\n')
}
