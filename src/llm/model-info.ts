/**
 * What the provider's own model list says about the endpoint's model.
 *
 * Two facts heddle would otherwise have to guess are published there by the wire shapes it speaks: the
 * model's **context window** (`data[].context_window` on an OpenAI-compatible list, `models[].context_window`
 * on a Responses list) and the **input modalities** it accepts (`input_modalities`, spelled a few ways).
 * Reading them is the honest alternative to a hardcoded table — the number and the modality are the
 * provider's declaration, not a guess — and it is what lets the composer print a real percentage for a
 * provider nobody configured a window for, and lets an attached image reach a model that accepts one
 * without the person having to declare the same fact by hand.
 *
 * Three rules are deliberate:
 *
 * - **Configuration wins.** These readers are only consulted when the endpoint declares no window and no
 *   modalities; a declared value is the operator's statement and is never overridden from the network.
 * - **A missing or failed answer is `undefined`.** The caller prints a blank, or falls back to text-only,
 *   rather than acting on a denominator the provider never gave.
 * - **One read per endpoint and model.** The page asks for the endpoint list on every load and the first
 *   image-bearing request asks for modalities, so the body is cached as a promise: concurrent callers share
 *   one request and a later turn reuses it.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { wire } from './http.ts'

/** The fields of an endpoint these resolvers read. A subset of the configured endpoint, so a caller passes one. */
export interface ModelInfoEndpoint {
  readonly name: string
  readonly kind: string
  readonly baseUrl: string
  readonly model?: string
  /**
   * The model to ask about, when it is not the endpoint's default.
   *
   * A gateway can place each deployment on **its own host** and give it its own window, so a read taken from the
   * endpoint's address and answered about `endpoint.model` describes the wrong model from the wrong place. Measured
   * 2026-10-18 against a two-host double: asking about a model that lived on the second host returned `undefined`
   * from this resolver, which a caller reads as "text only", so an image on that model was silently degraded.
   */
  readonly askAbout?: string
  readonly apiKey?: string
  readonly apiKeyFile?: string
  readonly headers?: Record<string, string>
  /** The forwarding hop, when this endpoint is reachable only through one. */
  readonly proxy?: string
  /** The models the endpoint offers, so a model's own address can be found. */
  readonly models?: readonly (string | { readonly id: string; readonly baseUrl?: string })[]
}

/** What a model accepts: the two modalities the harness can deliver. */
export type InputModality = 'text' | 'image'

/** How long a model-list read may take before the answer simply stays `undefined`. */
const DEFAULT_TIMEOUT_MS = 1500

/** What a read may be told: how long to wait, and which model to ask about when it is not the default. */
export interface ModelInfoOptions {
  readonly timeoutMs?: number
  /**
   * The model the caller is actually going to use.
   *
   * Stated per call rather than taken from the endpoint because the endpoint only ever names its **default**, and
   * a gateway can put each deployment on its own host with its own capabilities.
   */
  readonly askAbout?: string
}

/** The provider's model-list body, by endpoint and model, so the window and the modalities share one read. */
const lists = new Map<string, Promise<unknown | undefined>>()

/** Forget cached answers. The unit tests need it; nothing in production calls it. */
export function resetModelInfoCache(): void {
  lists.clear()
}

/** Whether this wire has a model-list route at all. Anthropic passes its facts through configuration. */
function listedKind(kind: string): boolean {
  return kind === 'openai-chat' || kind === 'openai-responses'
}

/** The model this read is about: the one asked about, else the endpoint's default. */
function askedAbout(endpoint: ModelInfoEndpoint): string | undefined {
  const model = endpoint.askAbout ?? endpoint.model
  return model === undefined || model.length === 0 ? undefined : model
}

/** The address that serves that model, which is the model's own host when it declares one. */
function addressOf(endpoint: ModelInfoEndpoint): string {
  const model = askedAbout(endpoint)
  const entry =
    model === undefined
      ? undefined
      : endpoint.models?.find((candidate) => (typeof candidate === 'string' ? candidate : candidate.id) === model)
  const declared = typeof entry === 'object' ? entry.baseUrl : undefined
  return declared ?? endpoint.baseUrl
}

/** One cache key: the route and the model its answers describe, by the address that serves it. */
function cacheKey(endpoint: ModelInfoEndpoint): string | undefined {
  if (!listedKind(endpoint.kind)) return undefined
  const model = askedAbout(endpoint)
  if (model === undefined) return undefined
  return `${endpoint.name}\u0000${addressOf(endpoint)}\u0000${model}`
}

/** The model list, read once per endpoint and model and shared by both readers below. */
function modelList(endpoint: ModelInfoEndpoint, options: ModelInfoOptions): Promise<unknown | undefined> {
  const about: ModelInfoEndpoint = options.askAbout === undefined ? endpoint : { ...endpoint, askAbout: options.askAbout }
  const key = cacheKey(about)
  if (key === undefined) return Promise.resolve(undefined)
  const cached = lists.get(key)
  if (cached !== undefined) return cached
  const pending = readModelList(about, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    .catch(() => undefined)
    .then((body) => {
      /**
       * Only an answer is cached. A failed read is not a fact about the model, and keeping it would turn one
       * outage into a process that can never read this endpoint's list again — the next caller asks again.
       */
      if (body === undefined) lists.delete(key)
      return body
    })
  lists.set(key, pending)
  return pending
}

/**
 * One authenticated GET of the provider's model list.
 *
 * Sent through the shared client rather than `fetch`, because an endpoint reachable only through a forwarding
 * agent is the case this whole file exists for and `fetch` has no way to say so. Measured 2026-10-18: a plain
 * `fetch` to a gateway that requires the hop could only ever fail, and a failed read here is indistinguishable
 * from "the provider publishes no list".
 */
async function readModelList(endpoint: ModelInfoEndpoint, timeoutMs: number): Promise<unknown | undefined> {
  const headers: Record<string, string> = { accept: 'application/json', ...(endpoint.headers ?? {}) }
  const key = endpoint.apiKey ?? readKeyFile(endpoint.apiKeyFile)
  try {
    const response = await wire({
      url: `${addressOf(endpoint).replace(/\/+$/, '')}/models`,
      method: 'GET',
      headers,
      timeoutMs,
      endpoint: endpoint.name,
      ...(key !== undefined ? { apiKey: key } : {}),
      ...(endpoint.proxy !== undefined ? { proxy: endpoint.proxy } : {}),
    })
    return 'json' in response ? response.json : undefined
  } catch {
    return undefined
  }
}

/** The is-a-record guard both parsers share. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The provider's list rows for the wire shape. */
function rowsOf(body: unknown, kind: string): readonly unknown[] | undefined {
  if (!isRecord(body)) return undefined
  const rows = kind === 'openai-chat' ? body.data : body.models
  return Array.isArray(rows) ? rows : undefined
}

/** The row for one model; the wire shapes name the model differently (`id` or `slug`). */
function rowOf(body: unknown, kind: string, model: string): Record<string, unknown> | undefined {
  const rows = rowsOf(body, kind)
  if (rows === undefined) return undefined
  const idKeys = kind === 'openai-chat' ? ['id'] : ['slug', 'id']
  for (const row of rows) {
    if (!isRecord(row)) continue
    if (idKeys.some((key) => row[key] === model)) return row
  }
  return undefined
}

/**
 * Ask the provider what the endpoint's model window is.
 *
 * Undefined for a wire with no model-list route, for an endpoint with no model named, and for every failure —
 * the caller's blank is the truthful answer.
 */
export function contextWindowFromModelList(
  endpoint: ModelInfoEndpoint,
  options: ModelInfoOptions = {},
): Promise<number | undefined> {
  return modelList(endpoint, options).then((body) => {
    const model = options.askAbout ?? askedAbout(endpoint)
    if (body === undefined || model === undefined) return undefined
    const reported = rowOf(body, endpoint.kind, model)?.context_window
    return typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? Math.round(reported) : undefined
  })
}

/**
 * Ask the provider which inputs the endpoint's model accepts.
 *
 * Undefined when the wire publishes no list, the model is not in it, or the row says nothing about modalities —
 * which callers read as text only, the safe direction: an image is never sent to a model that did not say it
 * accepts one.
 */
export function inputModalitiesFromModelList(
  endpoint: ModelInfoEndpoint,
  options: ModelInfoOptions = {},
): Promise<readonly InputModality[] | undefined> {
  return modelList(endpoint, options).then((body) => {
    const model = options.askAbout ?? askedAbout(endpoint)
    if (body === undefined || model === undefined) return undefined
    return inputModalitiesOfRow(rowOf(body, endpoint.kind, model))
  })
}

/**
 * Read one model row's input modalities wherever the provider put them.
 *
 * The spellings met in the wild: `input_modalities: ["text","image"]`, `inputModalities`, a `modalities`
 * array, a `modalities` object with its own `input` list, and OpenRouter's nested
 * `architecture.input_modalities`. A value that names only modalities this harness cannot deliver is `undefined`
 * rather than an empty list, so "said nothing" and "said nothing usable" read the same to the caller.
 */
export function inputModalitiesOfRow(row: unknown): readonly InputModality[] | undefined {
  if (!isRecord(row)) return undefined
  for (const value of [row.input_modalities, row.inputModalities]) {
    const parsed = modalityList(value)
    if (parsed !== undefined) return parsed
  }
  if (isRecord(row.architecture)) {
    const parsed = modalityList(row.architecture.input_modalities)
    if (parsed !== undefined) return parsed
  }
  return modalityList(row.modalities)
}

/** A modality list, from an array or from the `input` of an object, keeping only what can be delivered. */
function modalityList(value: unknown): readonly InputModality[] | undefined {
  const source = Array.isArray(value) ? value : isRecord(value) ? value.input : undefined
  if (!Array.isArray(source)) return undefined
  const modalities = source
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.toLowerCase())
    .filter((entry): entry is InputModality => entry === 'text' || entry === 'image')
  return modalities.length > 0 ? [...new Set(modalities)] : undefined
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
