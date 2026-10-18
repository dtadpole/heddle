/**
 * The model's context window, from the provider's own model list.
 *
 * A context window is a property of the model, and both wire shapes this project speaks publish a list of
 * models that carries it: an OpenAI-compatible list says `data[].context_window`, and the Responses list says
 * `models[].context_window`. Reading it there is the honest alternative to a hardcoded table — the number is
 * the provider's, not a guess — and it is what lets the composer's context gauge print a real percentage for a
 * provider nobody configured a window for.
 *
 * Three rules are deliberate:
 *
 * - **Configuration wins.** This is only consulted when the endpoint declares no window; a declared value is
 *   the operator's statement and is never overridden from the network.
 * - **A missing or failed answer is `undefined`.** The caller prints a blank rather than a denominator the
 *   provider never gave.
 * - **One read per endpoint and model.** The page asks for the endpoint list on every load, so the answer is
 *   cached as a promise: concurrent callers share one request, and a later load reuses it.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

/** The fields of an endpoint this resolver reads. A subset of the configured endpoint, so a caller passes one. */
export interface ModelInfoEndpoint {
  readonly name: string
  readonly kind: string
  readonly baseUrl: string
  readonly model?: string
  readonly apiKey?: string
  readonly apiKeyFile?: string
  readonly headers?: Record<string, string>
}

/** How long a model-list read may take before the gauge simply stays blank. */
const DEFAULT_TIMEOUT_MS = 1500

const cache = new Map<string, Promise<number | undefined>>()

/** Forget cached answers. The unit tests need it; nothing in production calls it. */
export function resetModelInfoCache(): void {
  cache.clear()
}

/**
 * Ask the provider what the endpoint's model window is.
 *
 * Undefined for a wire with no model-list route (Anthropic passes its window through configuration), for an
 * endpoint with no model named, and for every failure — the callers' blank is the truthful answer.
 */
export function contextWindowFromModelList(
  endpoint: ModelInfoEndpoint,
  options: { readonly timeoutMs?: number } = {},
): Promise<number | undefined> {
  if (endpoint.kind !== 'openai-chat' && endpoint.kind !== 'openai-responses') return Promise.resolve(undefined)
  if (endpoint.model === undefined || endpoint.model.length === 0) return Promise.resolve(undefined)
  const key = `${endpoint.name}\u0000${endpoint.baseUrl}\u0000${endpoint.model}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const pending = readWindow(endpoint, options.timeoutMs ?? DEFAULT_TIMEOUT_MS).catch(() => undefined)
  cache.set(key, pending)
  return pending
}

/** One authenticated GET of the model list, read for the endpoint's own model. */
async function readWindow(endpoint: ModelInfoEndpoint, timeoutMs: number): Promise<number | undefined> {
  const model = endpoint.model
  if (model === undefined) return undefined
  const headers: Record<string, string> = { accept: 'application/json', ...(endpoint.headers ?? {}) }
  const key = endpoint.apiKey ?? readKeyFile(endpoint.apiKeyFile)
  if (key !== undefined) headers.authorization = `Bearer ${key}`
  const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/models`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) return undefined
  const body: unknown = await response.json()
  return windowOf(body, endpoint.kind, model)
}

/** The provider's list rows for the wire shape, then the row for this model, then its window field. */
function windowOf(body: unknown, kind: string, model: string): number | undefined {
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  if (!isRecord(body)) return undefined
  const rows = kind === 'openai-chat' ? body.data : body.models
  if (!Array.isArray(rows)) return undefined
  const idKey = kind === 'openai-chat' ? 'id' : 'slug'
  for (const row of rows) {
    if (!isRecord(row)) continue
    if (row[idKey] !== model) continue
    const reported = row.context_window
    if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) return Math.round(reported)
    return undefined
  }
  return undefined
}

/** Read a key file the way the endpoint configuration does, but let a missing file mean "no key". */
function readKeyFile(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  try {
    const expanded = path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path
    return readFileSync(expanded, 'utf8').trim()
  } catch {
    return undefined
  }
}
