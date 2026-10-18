import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import { adapterFor } from './adapters.ts'
import { projectAttachments } from './attachments.ts'
import { ModelError, requestMessages, textOf, type Adapter, type Chunk, type EndpointConfig, type GenerateRequest, type Message } from './types.ts'

export * from './types.ts'
export { ModelError } from './types.ts'
export { adapterFor } from './adapters.ts'

/**
 * The model service: a registry of endpoints plus one streaming call.
 *
 * Modelled on `@deepseek-ai/dsh-llm`'s split between a runtime that owns the
 * call and adapters that own the wire. What is kept: the service is the only
 * thing a consumer injects, every call is a stream, and a call is intercepted by
 * a waterfall so a listener can log, retry or replay it without the caller
 * knowing. What is dropped: the remote protocol, the retry policy and the
 * provider catalog, none of which a first harness needs.
 *
 * The waterfall matters because it is the seam DSH puts its own policy on. Here
 * it is what lets a **turn be recorded without the caller cooperating**: a
 * listener sees the request and can tee the chunks.
 */
export class ModelService extends Service {
  static readonly provide = 'model'

  private readonly endpoints = new Map<string, Adapter>()
  /** The endpoint the configuration nominated, if any. */
  private nominated: string | undefined

  constructor(ctx: Context, endpoints: readonly EndpointConfig[] = []) {
    super(ctx, 'model')
    for (const endpoint of endpoints) this.register(endpoint)
  }

  /** Add an endpoint, replacing one of the same name. */
  register(endpoint: EndpointConfig): void {
    this.endpoints.set(endpoint.name, adapterFor(endpoint))
  }

  /** Every endpoint, in declaration order. Surfaced so a caller can configure. */
  list(): readonly EndpointConfig[] {
    return [...this.endpoints.values()].map((adapter) => adapter.endpoint)
  }

  /** The endpoints' names, which is what a `--endpoint` flag accepts. */
  names(): readonly string[] {
    return [...this.endpoints.keys()]
  }

  /** One endpoint's configuration, or `undefined` when it is not registered. */
  endpoint(name: string): EndpointConfig | undefined {
    return this.endpoints.get(name)?.endpoint
  }

  /**
   * The endpoint the configuration nominates, when it names one that exists.
   *
   * A caller that does not name an endpoint asks the service rather than taking the first, because a
   * `default` in a person's configuration is how they say "this one, unless I say otherwise" —
   * measured, the CLI took the first endpoint and ignored it, so a configured default only applied to
   * a caller that already knew to use it.
   */
  defaultEndpoint(nominated?: string): string | undefined {
    const candidate = nominated ?? this.nominated
    if (candidate !== undefined && this.endpoints.has(candidate)) return candidate
    return this.endpoints.keys().next().value
  }

  /** Record which endpoint the configuration nominates as the default. */
  nominateDefault(name: string): void {
    if (this.endpoints.has(name)) this.nominated = name
  }

  /**
   * Call one endpoint and stream the answer.
   *
   * The waterfall is dispatched on the **runtime context** rather than on the
   * service, so a listener registered in a plugin's own fiber is released with
   * that plugin — the Cordis rule that every effect is owned by the fiber that
   * made it.
   */
  stream(request: GenerateRequest, signal?: AbortSignal): AsyncIterable<Chunk> {
    const adapter = this.endpoints.get(request.endpoint)
    if (adapter === undefined) {
      throw new ModelError(
        `no endpoint named '${request.endpoint}'; configured: ${this.names().join(', ') || '(none)'}`,
        { endpoint: request.endpoint, code: 'NO_ENDPOINT' },
      )
    }
    /**
     * The request hook, modelled on DSH's `agent/request`.
     *
     * A waterfall over the request itself, before the adapter is reached, so a listener
     * can rewrite which model answers or what is asked — the seam a model-selection
     * policy attaches to. `model/stream` below is the chunk-level seam for logging,
     * retrying or replaying a call.
     */
    const effective = this.ctx.waterfall('model/request', request, () => request)
    const resolved = this.endpoints.get(effective.endpoint)
    if (resolved === undefined) {
      throw new ModelError(
        `no endpoint named '${effective.endpoint}'; configured: ${this.names().join(', ') || '(none)'}`,
        { endpoint: effective.endpoint, code: 'NO_ENDPOINT' },
      )
    }
    /**
     * The provider boundary drops assistant turns that carry only reasoning, because reasoning is not
     * replayed and a provider rejects an assistant message with neither content nor tool calls.
     * Applied after the request hook, so a policy listener sees the request as it was recorded.
     */
    /**
     * The attachment projection sits between the recorded request and the adapter: files become
     * handles, images become bytes only on a route that declared image input, and every other route
     * sees deterministically-labelled text. It is applied after the `model/request` waterfall, so a
     * listener that rewrites the request still sees the content as the session recorded it.
     */
    const sendable = {
      ...effective,
      messages: requestMessages(projectAttachments(effective.messages, resolved.endpoint)),
    }
    const next = () => resolved.stream(sendable, signal)
    return this.ctx.waterfall('model/stream', sendable, next)
  }

  /**
   * One call, collected.
   *
   * A convenience for the two callers that do not want to think about deltas —
   * a probe and a plain turn — and deliberately not a second implementation:
   * it reads the same stream and folds it.
   */
  async generate(
    request: GenerateRequest,
    signal?: AbortSignal,
  ): Promise<{ text: string; reasoning: string; toolCalls: { id: string; name: string; arguments: string }[]; finishReason: string }> {
    let text = ''
    let reasoning = ''
    const toolCalls: { id: string; name: string; arguments: string }[] = []
    let finishReason = 'unknown'
    for await (const chunk of this.stream(request, signal)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk.type === 'tool-call') toolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments })
      else finishReason = chunk.finishReason
    }
    return { text, reasoning, toolCalls, finishReason }
  }

  /**
   * The cheapest call that proves an endpoint answers.
   *
   * One turn, one token, no tools. This is the command the owner runs before
   * trusting a backend, and the reason it is a first-class method rather than a
   * script: a probe that is awkward to run does not get run.
   */
  async probe(
    endpoint: string,
    options: { readonly prompt?: string; readonly maxOutputTokens?: number; readonly model?: string } = {},
  ): Promise<{ endpoint: string; model?: string; text: string; finishReason: string; milliseconds: number }> {
    const started = Date.now()
    const configured = this.endpoint(endpoint)
    if (configured === undefined) {
      throw new ModelError(`no endpoint named '${endpoint}'; configured: ${this.names().join(', ') || '(none)'}`, {
        endpoint,
        code: 'NO_ENDPOINT',
      })
    }
    const request: GenerateRequest = {
      endpoint,
      messages: [{ role: 'user', content: [{ type: 'text', text: options.prompt ?? 'Reply with the single word: ready' }] }],
      maxOutputTokens: options.maxOutputTokens ?? 16,
      ...(options.model !== undefined ? { model: options.model } : {}),
    }
    const result = await this.generate(request)
    return {
      endpoint,
      ...(request.model ?? configured.model ? { model: request.model ?? configured.model } : {}),
      text: result.text,
      finishReason: result.finishReason,
      milliseconds: Date.now() - started,
    }
  }
}

/** The last assistant text in a message list, for a transcript reader. */
export function lastAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant') return textOf(message.content)
  }
  return ''
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['model']`. */
    model: ModelService
  }
  interface Events {
    /**
     * Waterfall around every model call, mirroring `llm/stream` in DSH.
     *
     * A listener may call `next()` to reach the resolved adapter, or yield its
     * own chunks to short-circuit. This is where a recorder, a retry or a replay
     * attaches without the caller knowing.
     *
     * @mode waterfall
     */
    'model/stream'(this: ModelService, request: GenerateRequest, next: () => AsyncIterable<Chunk>): AsyncIterable<Chunk>
    /**
     * Waterfall over a request before an adapter is chosen. Return a replaced request
     * without calling `next()` to override it — how a model-selection policy works.
     *
     * @mode waterfall
     */
    'model/request'(this: ModelService, request: GenerateRequest, next: () => GenerateRequest): GenerateRequest
  }
}
