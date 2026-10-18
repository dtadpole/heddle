import type { TokenUsage } from './usage.ts'

/**
 * The model service's vocabulary.
 *
 * The shape is modelled on how DSH separates the two halves of a model call: a
 * provider-neutral **service** that owns a registry of adapters and exposes one
 * streaming call, and an **adapter** that a provider plugin supplies. See
 * `@deepseek-ai/dsh-llm`, whose `LlmRuntime` plus `LlmAdapter` split this file
 * mirrors in miniature — the parts kept are the parts a harness needs, and the
 * parts dropped are the remote protocol and the tool-call policy.
 *
 * Two decisions are deliberately narrow:
 *
 * - **Tool calls are content, not a typed channel.** A `tool-call` content part
 *   carries a name and parsed arguments; the loop decides what to do with it.
 *   This is enough for the whole wire format and keeps the adapter shallow.
 * - **Every call is a stream.** A non-streaming transport still produces chunks,
 *   one per field, so a consumer has exactly one shape to read and streaming is a
 *   transport detail rather than a second code path.
 */

/** The raster formats an attached image may have, matching what the providers accept. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/**
 * One uploaded image, referenced by the durable path the harness stored it at.
 *
 * The path is the reference this project's substrate already has — the agent reads it with its file
 * tools, and the sandbox admits it. The request projection either fills `data` (a route that accepts
 * image input) or replaces the whole part with DSH's text-only placeholder; the session log keeps the
 * reference, so a 50 MiB image never enters the JSONL.
 */
export interface ImagePart {
  readonly type: 'image'
  readonly name: string
  readonly mimeType: ImageMediaType
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  /** Base64 bytes, present only on the adapter-facing copy the request projection builds. */
  readonly data?: string
}

/**
 * One uploaded non-image file, referenced by its durable path.
 *
 * Files are never sent to a provider natively: DSH's rule, and this project follows it by projecting the
 * part to a deterministic handle naming the saved read-only copy.
 */
export interface FilePart {
  readonly type: 'file'
  readonly name: string
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/** One part of a message's content. */
export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }
  | ImagePart
  | FilePart

/** One message in a request. */
export interface Message {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: readonly ContentPart[]
  /** Present on a `tool` message: which call this is the answer to. */
  readonly toolCallId?: string
}

/** One tool the model may ask for, in the provider's shape. */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  /** JSON Schema for the arguments. */
  readonly parameters: Record<string, unknown>
}

/** What to ask one endpoint for. */
export interface GenerateRequest {
  /** The endpoint's name, as the configuration declares it. */
  readonly endpoint: string
  /** The model id to use; falls back to the endpoint's configured default. */
  readonly model?: string
  readonly messages: readonly Message[]
  readonly tools?: readonly ToolSpec[]
  /** Upper bound on generated tokens, which is also what keeps a probe cheap. */
  readonly maxOutputTokens?: number
  readonly temperature?: number
  /**
   * The reasoning level to ask for, as an **id** the endpoint's model declares.
   *
   * It is the id rather than the provider's wire value because the wire value belongs to the adapter:
   * `reasoning_effort` for a Chat Completions route, `reasoning.effort` for a Responses one, and
   * adaptive thinking plus `output_config.effort` for an Anthropic publisher route. The adapter resolves
   * the id through `reasoningLevelFor` and sends **that model's declared value**, so a level the catalogue
   * does not hold can never be displayed and silently not sent.
   */
  readonly reasoningEffort?: string
  /** Ask the transport to stream; adapters that must stream ignore `false`. */
  readonly stream?: boolean
  /** Opaque identity carried through the waterfall for logging and retries. */
  readonly sessionId?: string
  /**
   * Which round of a turn this request is.
   *
   * A transport ignores it. The scripted adapter uses it to hand out one step per round, so a
   * script is a sequence rather than a list it replays forever.
   */
  readonly round?: number
  /**
   * What the call is for, when it is not a turn.
   *
   * DSH tags its summarising call `purpose: 'compaction'`, and the tag earns its keep here: a
   * scripted endpoint can hand a summary step to the summary call and a turn step to the turn,
   * which is what makes compaction checkable without a second provider.
   */
  readonly purpose?: string
}

/** One piece of a streamed answer. */
export type Chunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }
  | {
      readonly type: 'done'
      readonly finishReason: string
      readonly usage?: TokenUsage
    }

/**
 * One model type an endpoint offers.
 *
 * The owner's shape (2026-10-17): an endpoint is configured once in the user's own
 * `~/.heddle/heddle.json`, and the **model types it offers** are listed under it. `name` is what a person
 * reads (a provider's `DeepSeek-V4.1-Flash` rather than its id `deepseek-flash`), and `reasoning` is present
 * only when that exact model publishes levels — which is what makes the selector show an effort control for
 * the models that have one and no control for the models that do not.
 */
export interface ModelOption {
  /** The model id sent on the wire. */
  readonly id: string
  /** The name a person reads; the id when absent, so a catalogue entry cannot render blank. */
  readonly name?: string
  /**
   * The reasoning levels this model offers.
   *
   * On the model rather than only on the endpoint because a route can serve a thinking model beside a
   * non-thinking one. An endpoint-level block is the default for its models (see `ReasoningLevels`).
   */
  readonly reasoning?: ReasoningLevels
}

/**
 * One reasoning level: an id, a name, and the value the provider's wire expects.
 *
 * `value: null` is a level that is real and displayed but sends no parameter — the provider's own default,
 * which is what a `Default` row means in DSH's effort pane. A non-null value is sent verbatim in the parameter
 * the endpoint's kind uses, so what the page displays is what the provider receives; the value never reaches
 * the page's payload because only the adapter needs it.
 */
export interface ReasoningLevel {
  readonly id: string
  readonly name: string
  readonly value: string | number | null
}

/** The levels a model offers, and the one it uses when nobody chose. */
export interface ReasoningLevels {
  /** The level used when a session has recorded none. Absent means the provider's default. */
  readonly default?: string
  readonly levels: readonly ReasoningLevel[]
}

/** What an adapter is told about its endpoint. */
export interface EndpointConfig {
  /** Stable name a request addresses this endpoint by. */
  readonly name: string
  /** Which wire shape this endpoint speaks. */
  readonly kind: 'openai-chat' | 'openai-responses' | 'anthropic-vertex' | 'scripted'
  /** Scheme, host and path prefix, without a trailing slash. */
  readonly baseUrl: string
  /** The endpoint's default model id. */
  readonly model?: string
  /**
   * The model types this endpoint offers, as the user configured them.
   *
   * Optional so every endpoint written before the two-tier selector existed keeps working: an endpoint with
   * only `model` offers that single model (`offeredModels` normalises both shapes), and one with neither
   * offers nothing rather than inventing a name. The endpoint's `model` stays the default when this list is
   * present and nobody chose.
   */
  readonly models?: readonly (ModelOption | string)[]
  /**
   * Reasoning levels that apply to every model of this endpoint which does not declare its own.
   *
   * The convenient half of the configuration: a route that serves several models with the same effort ladder
   * declares it once here. A model's own `reasoning` **replaces** this rather than merging, because a merged
   * ladder would offer a level the model never declared.
   */
  readonly reasoning?: ReasoningLevels
  /** The cloud project a publisher route is addressed under. Required by `anthropic-vertex`. */
  readonly project?: string
  /** The region of that project's endpoint, for example `global`. Required by `anthropic-vertex`. */
  readonly region?: string
  /** Sent as a bearer token when present. Never logged; must not be committed. */
  readonly apiKey?: string
  /**
   * A path to read the token from, resolved instead of `apiKey`.
   *
   * This exists because a key is often already a file with a tight mode — the
   * owner's keys live under `~/.keys/` — and reading that path keeps the value out
   * of any file the harness itself would write or commit.
   */
  readonly apiKeyFile?: string
  /** Extra headers, for a gateway that gates on its own header. */
  readonly headers?: Record<string, string>
  /** Force streaming on or off for this endpoint regardless of the request. */
  readonly stream?: boolean
  /** Default cap on generated tokens for this endpoint. */
  readonly maxOutputTokens?: number
  /**
   * The model's context window, in tokens, when this endpoint knows it.
   *
   * It belongs to the route rather than to the harness: the same gateway can serve models with
   * different windows, and a budget resolved from a number somebody typed into the harness is a
   * budget that is wrong the moment the model changes. Absent means the harness falls back to its
   * own configured window, and the budget reports where the number came from.
   */
  readonly contextWindow?: number
  /** What this endpoint can do, for a caller choosing between them. */
  readonly capabilities?: readonly string[]
  /**
   * What input the endpoint's model accepts.
   *
   * Declared rather than guessed: an image attached to a turn is sent as image content only when this
   * list names `image`, and otherwise becomes DSH's deterministic text placeholder. Absent means text
   * only, which is the safe reading of every configuration written before images existed.
   */
  readonly inputModalities?: readonly ('text' | 'image')[]
  /**
   * An HTTP forwarding proxy for this endpoint, as a URL.
   *
   * This exists for the shape an enterprise deployment usually has: the gateway is not reachable directly, and
   * a small agent on loopback forwards for it — adding the identity the gateway checks on the way through. The
   * request is sent to the proxy in a proxy's own form (an absolute request line), so the endpoint's `baseUrl`
   * stays the gateway's real address and only this one field knows the hop.
   */
  readonly proxy?: string
  /** Milliseconds before a request is abandoned. */
  readonly timeoutMs?: number
}

/**
 * The model types an endpoint offers, normalised from both configuration shapes.
 *
 * A string entry is an id with no display name, so `models: ['a', 'b']` and
 * `models: [{ id: 'a' }, { id: 'b' }]` mean the same thing. An endpoint with no `models` offers its single
 * `model`; one with neither offers nothing. The order is the user's declaration order, because that is the
 * order the menu shows and a re-ordering nobody asked for is how a selector becomes hard to find things in.
 */
export function offeredModels(endpoint: EndpointConfig): readonly ModelOption[] {
  const declared = endpoint.models
  if (declared !== undefined) {
    return declared
      .map((entry) => (typeof entry === 'string' ? { id: entry } : entry))
      .filter((entry) => typeof entry.id === 'string' && entry.id.trim().length > 0)
  }
  return endpoint.model !== undefined && endpoint.model.length > 0 ? [{ id: endpoint.model }] : []
}

/** The catalogue entry a model id names, or `undefined` when the endpoint does not offer it. */
export function modelOptionOf(endpoint: EndpointConfig, modelId: string | undefined): ModelOption | undefined {
  if (modelId === undefined) return undefined
  return offeredModels(endpoint).find((model) => model.id === modelId)
}

/**
 * The levels a model offers: its own block, else the endpoint's, else none.
 *
 * `modelId` absent means "the model a call would use", which is the endpoint's default — a request that
 * names no model still has an effort ladder to show, and reading it from the endpoint is what makes that so.
 */
export function reasoningLevelsFor(endpoint: EndpointConfig, modelId?: string): ReasoningLevels | undefined {
  const model = modelOptionOf(endpoint, modelId ?? endpoint.model)
  return model?.reasoning ?? endpoint.reasoning
}

/** One declared level of one model, by id. */
export function reasoningLevelFor(
  endpoint: EndpointConfig,
  modelId: string | undefined,
  effortId: string,
): ReasoningLevel | undefined {
  return reasoningLevelsFor(endpoint, modelId)?.levels.find((level) => level.id === effortId)
}

/** A provider backend: one wire shape, one endpoint. */
export interface Adapter {
  readonly endpoint: EndpointConfig
  /** One call, streamed. Errors are thrown as `ModelError`. */
  stream(request: GenerateRequest, signal?: AbortSignal): AsyncIterable<Chunk>
}

/**
 * The code a provider's refusal is normalized to when the request did not fit the window.
 *
 * It is the one HTTP failure the harness recovers from, so it is a named constant rather than a
 * string compared at a call site: the loop offers it on `agent/request-error` and compaction
 * answers with a reduction and a retry, and every other failure is left to throw.
 */
export const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'

/** A failure with the endpoint and status attached, so a caller can diagnose it. */
export class ModelError extends Error {  readonly endpoint: string
  readonly status?: number
  readonly code: string

  constructor(message: string, options: { endpoint: string; code: string; status?: number; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ModelError'
    this.endpoint = options.endpoint
    this.code = options.code
    if (options.status !== undefined) this.status = options.status
  }
}

/** Plain text of a message, for a transcript, a log line or a prompt echo. */
export function textOf(parts: readonly ContentPart[]): string {
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

/**
 * A plain-text rendering of content blocks, for a summary a person reads.
 *
 * Attachment parts have no text of their own, so they contribute a bracketed name rather than
 * disappearing: a surface message that silently omitted an image would read as if it were never there.
 */
export function describeContent(parts: readonly ContentPart[]): string {
  return parts
    .map((part) => {
      if (part.type === 'tool-call') return `→ ${part.name} ${part.arguments}`
      if (part.type === 'text' || part.type === 'reasoning') return part.text
      if (part.type === 'image') return `[image ${part.name}]`
      return `[file ${part.name}]`
    })
    .join('')
}

/** A one-message user request, which is what a turn and a probe both are. */
export function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One event was appended to a session, after it reached the disk.
     *
     * The seam a live view listens on. Emitted rather than returned so a consumer can
     * be a plugin, owned by its fiber and released with it, instead of a callback the
     * writer has to hold.
     *
     * @param payload - the session id and the event as it was written.
     * @mode emit
     */
    'session/event'(payload: { readonly session: string; readonly event: { readonly seq: number; readonly at: string; readonly type: string; readonly [key: string]: unknown } }): void
  }
}

/**
 * The messages a provider may actually be sent.
 *
 * A reasoning part is **not replayed**: its thinking block belongs to the provider that issued it (see
 * the Anthropic adapter's note), so an assistant turn whose only parts are reasoning has nothing to say
 * on the wire. Measured against a real OpenAI-compatible gateway: resuming a session that held such a
 * turn produced `{role: 'assistant', content: null}` and the gateway refused the whole request with
 * "Invalid assistant message: content or tool_calls must be set". The turn is therefore dropped at the
 * provider boundary rather than mapped to an empty message — a rule about what a model can be sent, not
 * about what a session records, so the log and the views keep the turn.
 */
export function requestMessages(messages: readonly Message[]): readonly Message[] {
  return messages.filter(
    (message) =>
      message.role !== 'assistant' ||
      message.content.some((part) => part.type === 'text' || part.type === 'tool-call'),
  )
}
