import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import type { EndpointConfig, ModelOption, ReasoningLevels } from './llm/types.ts'
import { offeredModels, reasoningLevelsFor } from './llm/types.ts'

/**
 * Endpoint definitions and how they are resolved.
 *
 * The ladder is the answer to "how does a harness talk to a paid gateway without
 * committing anything": the repository carries the **shape**, the machine carries
 * the **values**. Resolution runs in this order, each step overriding the one
 * before:
 *
 * 1. the plugin's own config, which usually comes from a layer file;
 * 2. the local file — `$HEDDLE_CONFIG`, `$HEDDLE_HOME/heddle.json`, `~/.heddle/heddle.json`;
 * 3. the environment — `HEDDLE_<ENDPOINT>_BASE_URL`, `_MODEL`, `_API_KEY`.
 *
 * A secret is only ever read from a path or a variable. `apiKeyFile` exists
 * because the owner's keys already live as files with tight modes
 * (`~/.keys/deepseek.api.key`), and reading that path is safer than copying the
 * value into a JSON file that sits beside it.
 */

/**
 * The repository's own defaults.
 *
 * The one endpoint here is **offline**: `scripted` reads a local JSON file. Nothing here points at a paid service or
 * carries a credential, which is what makes the file safe to commit and what lets a fresh clone run its checks with no
 * setup.
 *
 * **`localhost` was removed on 2026-10-17** at the owner's instruction. It was a loopback endpoint pointing at port
 * 8790 — the plugboard signing helper, which exists only on a machine that runs one — so it was a default with a
 * machine's assumption inside it, and on a provider list it read as a real destination when it was a duplicate of the
 * `plugboard-d` endpoint beside it. The local file names every endpoint this machine actually has.
 */
export function defaultEndpoints(): readonly EndpointConfig[] {
  return [
    {
      name: 'scripted',
      kind: 'scripted',
      baseUrl: 'scripted.json',
      model: 'scripted',
      capabilities: ['offline', 'tools'],
    },
  ]
}

/** Where the owner's configuration lives, in precedence order. */
export function configPaths(home = homedir()): readonly string[] {
  if (process.env.HEDDLE_CONFIG) return [process.env.HEDDLE_CONFIG]
  const dir = process.env.HEDDLE_HOME ?? `${home}/.heddle`
  return [`${dir}/heddle.json`, `${home}/.heddle/heddle.json`]
}

/**
 * Environment overrides for one endpoint.
 *
 * Named by the endpoint rather than by the provider, because one provider can be
 * reached through several endpoints — a direct one and a gateway one — and each
 * needs its own values.
 */
export function environmentOverride(name: string, env: NodeJS.ProcessEnv = process.env): Partial<EndpointConfig> {
  const prefix = `HEDDLE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`
  const override: Record<string, unknown> = {}
  if (env[`${prefix}BASE_URL`]) override.baseUrl = env[`${prefix}BASE_URL`]
  if (env[`${prefix}MODEL`]) override.model = env[`${prefix}MODEL`]
  if (env[`${prefix}API_KEY`]) override.apiKey = env[`${prefix}API_KEY`]
  if (env[`${prefix}API_KEY_FILE`]) override.apiKeyFile = env[`${prefix}API_KEY_FILE`]
  if (env[`${prefix}KIND`]) override.kind = env[`${prefix}KIND`]
  return override as Partial<EndpointConfig>
}

/**
 * Merge one endpoint's layers.
 *
 * Exported and pure so the ladder can be reasoned about without a process: the
 * order is the rule, and a rule that is only observable by booting is a rule
 * nobody checks.
 */
export function mergeEndpoint(
  base: EndpointConfig,
  ...layers: readonly Partial<EndpointConfig>[]
): EndpointConfig {
  return Object.assign({}, base, ...layers) as EndpointConfig
}

/**
 * Read an `apiKeyFile`, or fail naming the setting.
 *
 * The value never reaches a message: the path is what a reader needs to fix, and
 * echoing any part of a key into a log is the failure this avoids.
 */
export function readKeyFile(path: string): string {
  const expanded = path.startsWith('~') ? `${homedir()}${path.slice(1)}` : path
  let raw: string
  try {
    raw = readFileSync(expanded, 'utf8')
  } catch (error) {
    throw new Error(`could not read the key file '${path}': ${(error as Error).message}`)
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new Error(`the key file '${path}' is empty`)
  return trimmed
}

/** Resolve `apiKeyFile` into `apiKey`, leaving both out when neither is set. */
export function materializeKey(endpoint: EndpointConfig): EndpointConfig {
  if (endpoint.apiKey || !endpoint.apiKeyFile) return endpoint
  return { ...endpoint, apiKey: readKeyFile(endpoint.apiKeyFile) }
}

/**
 * Build the endpoint list a run uses.
 *
 * A configured endpoint **replaces** a default of the same name; the defaults are
 * not extra rows a machine cannot get rid of. An endpoint named only by the local
 * file is added, which is how a machine declares something this project never
 * heard of.
 */
export function resolveEndpoints(
  configured: readonly Partial<EndpointConfig>[] = [],
  local: readonly Partial<EndpointConfig>[] = [],
  env: NodeJS.ProcessEnv = process.env,
): readonly EndpointConfig[] {
  const byName = new Map<string, EndpointConfig>()
  for (const endpoint of defaultEndpoints()) byName.set(endpoint.name, endpoint)

  const apply = (partial: Partial<EndpointConfig>) => {
    if (!partial.name) throw new Error('every endpoint needs a name')
    const base = byName.get(partial.name)
    if (base === undefined) {
      // A brand-new endpoint must be complete enough to use.
      if (!partial.kind) throw new Error(`endpoint '${partial.name}' needs a kind`)
      if (!partial.baseUrl) throw new Error(`endpoint '${partial.name}' needs a baseUrl`)
      byName.set(partial.name, partial as EndpointConfig)
      return
    }
    byName.set(partial.name, mergeEndpoint(base, partial, environmentOverride(partial.name, env)))
  }

  for (const endpoint of configured) apply(endpoint)
  for (const endpoint of local) apply(endpoint)
  for (const endpoint of byName.values()) {
    if (endpoint.apiKeyFile !== undefined) byName.set(endpoint.name, materializeKey(endpoint))
  }
  return [...byName.values()]
}

/**
 * The endpoint list as the Web UI's switcher reads it, plus the name it should show as current.
 *
 * One list, one shape: this is `describeEndpoint` mapped over the service's own endpoints, so the answer
 * to "what is safe to say about an endpoint" stays in one function rather than being re-derived for the
 * page. The `default` is validated against the list, because a name that is not there is not a selection
 * the page can mark — `null` is the honest answer, and the page falls back to whatever a session recorded.
 */
export function describeEndpoints(
  endpoints: readonly EndpointConfig[],
  nominated?: string,
): { readonly endpoints: readonly Record<string, unknown>[]; readonly default: string | null } {
  const present = nominated !== undefined && endpoints.some((endpoint) => endpoint.name === nominated)
  return {
    endpoints: endpoints.map(describeEndpoint),
    default: present && nominated !== undefined ? nominated : null,
  }
}

/** A credential-free summary of an endpoint, safe to log or print. */
export function describeEndpoint(endpoint: EndpointConfig): Record<string, unknown> {
  return {
    name: endpoint.name,
    kind: endpoint.kind,
    baseUrl: endpoint.baseUrl,
    ...(endpoint.model !== undefined ? { model: endpoint.model } : {}),
    /**
     * The two-tier catalogue: every model type this endpoint offers, with the name a person reads and the
     * effort levels it declares. The levels travel **by id and name only** — the wire value is the adapter's
     * business and never needs to reach a page, and a payload that cannot carry it cannot leak it.
     *
     * `models` is always present, even as an empty list, because the page's model pane draws its groups from
     * this field: an endpoint with no model must read as "offers nothing", not as "this endpoint is old".
     */
    models: offeredModels(endpoint).map((model) => describeModel(endpoint, model)),
    ...(endpoint.reasoning !== undefined ? { reasoning: describeReasoning(endpoint.reasoning) } : {}),
    ...(endpoint.project !== undefined ? { project: endpoint.project } : {}),
    ...(endpoint.region !== undefined ? { region: endpoint.region } : {}),
    ...(endpoint.proxy !== undefined ? { proxy: endpoint.proxy } : {}),
    ...(endpoint.capabilities !== undefined ? { capabilities: endpoint.capabilities } : {}),
    ...(endpoint.contextWindow !== undefined
      ? { contextWindow: endpoint.contextWindow, contextWindowSource: 'config' }
      : {}),
    // Presence, never the value.
    ...(endpoint.apiKey !== undefined ? { credential: 'set' } : {}),
    ...(endpoint.apiKeyFile !== undefined ? { credentialFile: endpoint.apiKeyFile } : {}),
    ...(endpoint.headers !== undefined ? { headers: Object.keys(endpoint.headers) } : {}),
  }
}

/** One model type as a page reads it: id, display name, and effort ids/names. */
function describeModel(endpoint: EndpointConfig, model: ModelOption): Record<string, unknown> {
  /**
   * A model without a block of its own inherits the endpoint's, because that is the ladder a request for it
   * would be checked against — a page that showed no effort control there would hide a level the route accepts.
   */
  const reasoning = model.reasoning ?? endpoint.reasoning
  return {
    id: model.id,
    name: model.name ?? model.id,
    ...(reasoning !== undefined ? { reasoning: describeReasoning(reasoning) } : {}),
  }
}

/** The effort ladder a page may show, without the provider's wire values. */
function describeReasoning(reasoning: ReasoningLevels): Record<string, unknown> {
  return {
    ...(reasoning.default !== undefined ? { default: reasoning.default } : {}),
    levels: reasoning.levels.map((level) => ({ id: level.id, name: level.name })),
  }
}

/**
 * Why a selection a page asked for is not one this endpoint offers, or `null` when it is.
 *
 * The route is the one place a name from a browser reaches the store, so it is checked here rather than
 * trusted: an unvalidated model or effort would be recorded and then sent to the provider on every following
 * turn, failing each of them with a name nobody chose. The message names what was asked and what is declared,
 * because the page shows the server's own sentence where the person made the choice.
 *
 * `model` absent means the endpoint's default model, which is what the menu selects when a session has never
 * named one; `effort` absent means "whatever the model uses by default" and is always acceptable.
 */
export function selectionProblem(endpoint: EndpointConfig, model?: string, effort?: string): string | null {
  const offered = offeredModels(endpoint)
  const chosen = model !== undefined && model.length > 0 ? model : endpoint.model
  if (model !== undefined && model.length > 0 && !offered.some((entry) => entry.id === model)) {
    const names = offered.map((entry) => entry.id)
    return `no model named '${model}' on endpoint '${endpoint.name}'; configured: ${names.length > 0 ? names.join(', ') : '(none)'}`
  }
  if (effort === undefined || effort.length === 0) return null
  const levels = reasoningLevelsFor(endpoint, chosen)
  if (levels === undefined) {
    return `model '${chosen ?? '(none)'}' on endpoint '${endpoint.name}' declares no reasoning effort levels`
  }
  if (!levels.levels.some((level) => level.id === effort)) {
    return `no reasoning effort named '${effort}' for model '${chosen ?? '(none)'}' on endpoint '${endpoint.name}'; declared: ${levels.levels.map((level) => level.id).join(', ')}`
  }
  return null
}
