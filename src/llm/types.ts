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

/** One part of a message's content. */
export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }

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
