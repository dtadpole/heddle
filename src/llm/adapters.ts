import { anthropicUsage, openaiChatUsage, openaiResponsesUsage, type TokenUsage } from './usage.ts'
import {
  ModelError,
  baseUrlFor,
  canonicalFinishReason,
  reasoningLevelFor,
  reasoningLevelsFor,
  type Adapter,
  type Chunk,
  type ContentPart,
  type EndpointConfig,
  type GenerateRequest,
  type ImagePart,
} from './types.ts'

/**
 * The two wire shapes this project speaks, plus the scripted one the checks use.
 *
 * Both HTTP adapters are thin on purpose. What varies between providers is the
 * request body, where a text delta lives in the event, and how the stream ends;
 * everything else — adding a tool call, counting tokens, one `done` chunk — is
 * the same and lives here once.
 */

/** One event parsed out of a `text/event-stream` body. */
interface SseEvent {
  readonly event?: string
  readonly data: string
}

/**
 * Resolve the reasoning level a request names into the wire value its model declares.
 *
 * Three rules live here once rather than in each adapter:
 *
 * - the level is looked up on the model that will actually answer (`request.model`, else the endpoint's own);
 * - an id the catalogue does not declare is a **loud** `ModelError`, because silently dropping it would display a
 *   control the provider never received — the one thing the task forbids;
 * - a level whose value is `null` is real but sends nothing, which is how a `Default` row says "the provider's own
 *   default" without inventing a parameter.
 *
 * The returned `value` is the provider's own vocabulary (`low`, `high`, a budget number) and is sent verbatim by
 * the adapter whose kind knows where its route expects it.
 */
function reasoningValue(
  endpoint: EndpointConfig,
  request: GenerateRequest,
): { readonly value: string | number | null } | undefined {
  const id = request.reasoningEffort
  if (id === undefined || id.length === 0) return undefined
  const model = request.model ?? endpoint.model
  const level = reasoningLevelFor(endpoint, model, id)
  if (level === undefined) {
    const declared = reasoningLevelsFor(endpoint, model)?.levels.map((entry) => entry.id).join(', ') ?? '(none)'
    throw new ModelError(
      `'${endpoint.name}' does not offer reasoning effort '${id}' for model '${model ?? '(none)'}'; declared: ${declared}`,
      { endpoint: endpoint.name, code: 'UNSUPPORTED_REASONING_EFFORT' },
    )
  }
  return { value: level.value }
}

/**
 * Parse an SSE body into events.
 *
 * Written against measured behaviour rather than the specification in one
 * place: the Codex route answers `200` with **no content type at all**, and
 * terminates with a `response.completed` event rather than `[DONE]`. So the
 * parse is driven by `data:` lines and never by a header.
 */
export async function* readSse(body: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    for (;;) {
      const split = buffer.indexOf('\n\n')
      if (split === -1) break
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      const event = parseBlock(block)
      if (event) yield event
    }
  }
  const last = parseBlock(buffer)
  if (last) yield last
}

function parseBlock(block: string): SseEvent | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return null
  return event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') }
}

import { titleCaseHeaders, wire, type WireResponse } from './http.ts'

/** What a call site passes to {@link post}; the transport is in `./http.ts`. */
interface HttpOptions {
  readonly url: string
  readonly body: unknown
  readonly headers?: Record<string, string>
  readonly apiKey?: string
  readonly stream: boolean
  readonly timeoutMs?: number
  readonly proxy?: string
  readonly endpoint: string
  readonly signal?: AbortSignal
}

/**
 * POST a request and hand back either parsed JSON or a streamed body.
 *
 * A non-2xx answer becomes a `ModelError` carrying the status and a short excerpt
 * of the body, because the failure that matters in practice is a gateway refusing
 * the call — `401` for a missing router credential, `403` for the Cloudflare gate,
 * `503` when the backend credential does not resolve — and each of those is
 * diagnosed from the status and the body, not from a stack trace.
 */
export function post(options: HttpOptions): Promise<WireResponse> {
  return wire({
    url: options.url,
    body: options.body,
    stream: options.stream,
    endpoint: options.endpoint,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
}

/**
 * The endpoint's forwarding hop, when it has one.
 *
 * `proxy` is a fact about **where an endpoint is reachable from**, not about a wire shape, so every adapter
 * passes it. Measured 2026-10-18: only the Anthropic publisher adapter did, so an `openai-responses` endpoint
 * behind an enterprise forwarding agent sent its request **direct** to a gateway address that is routable only
 * from the agent's side, and timed out on a call the agent answers in under a second. The field was documented
 * on `EndpointConfig` the whole time; the two OpenAI-shaped adapters simply never read it.
 */
function hop(endpoint: Adapter['endpoint']): { readonly proxy?: string } {
  return endpoint.proxy !== undefined ? { proxy: endpoint.proxy } : {}
}

/** A tool call assembled from the fragments a streaming provider sends. */
export interface PartialToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * OpenAI's Chat Completions shape.
 *
 * Chosen for the DeepSeek route, which speaks it natively and terminates with
 * `[DONE]`. Reasoning arrives as a `reasoning_content` delta, which is why the
 * chunk vocabulary has a `reasoning-delta` rather than flattening it into text.
 */
export function openAiChatAdapter(
  endpoint: Adapter['endpoint'],
  request: GenerateRequest,
  signal?: AbortSignal,
): AsyncIterable<Chunk> {
  const effort = reasoningValue(endpoint, request)
  const body = {
    model: request.model ?? endpoint.model,
    messages: request.messages.map(toChatMessage),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
    ...(request.maxOutputTokens ?? endpoint.maxOutputTokens ?? undefined) !== undefined
      ? { max_tokens: request.maxOutputTokens ?? endpoint.maxOutputTokens }
      : {},
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    /** Chat Completions names the level `reasoning_effort`; verified against a live DeepSeek route on 2026-10-17. */
    ...(effort !== undefined && effort.value !== null ? { reasoning_effort: effort.value } : {}),
  }

  const streaming = endpoint.stream ?? request.stream ?? false

  return (async function* chat() {
    const result = await post({
      url: `${baseUrlFor(endpoint, request.model)}/chat/completions`,
      body: { ...body, stream: streaming },
      ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
      ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
      ...(endpoint.timeoutMs !== undefined ? { timeoutMs: endpoint.timeoutMs } : {}),
      ...hop(endpoint),
      stream: streaming,
      endpoint: endpoint.name,
      ...(signal !== undefined ? { signal } : {}),
    })

    if ('json' in result) {
      yield* finishFromChatMessage(result.json)
      return
    }

    const calls = new Map<number, PartialToolCall>()
    for await (const event of readSse(result.stream)) {
      if (event.data === '[DONE]') break
      let parsed: {
        choices?: {
          delta?: {
            content?: string | null
            reasoning_content?: string | null
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
          }
          finish_reason?: string | null
        }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      try {
        parsed = JSON.parse(event.data)
      } catch {
        continue
      }
      const choice = parsed.choices?.[0]
      const delta = choice?.delta
      if (delta?.reasoning_content) yield { type: 'reasoning-delta', text: delta.reasoning_content }
      if (delta?.content) yield { type: 'text-delta', text: delta.content }
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0
        const call = calls.get(index) ?? { id: '', name: '', arguments: '' }
        if (fragment.id) call.id = fragment.id
        if (fragment.function?.name) call.name = fragment.function.name
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments
        calls.set(index, call)
      }
      if (choice?.finish_reason) {
        for (const call of calls.values()) {
          yield { type: 'tool-call', id: call.id || `call-${call.name}`, name: call.name, arguments: call.arguments }
        }
        yield {
          type: 'done',
          finishReason: canonicalFinishReason(choice.finish_reason, calls.size),
          ...(openaiChatUsage(parsed.usage) !== undefined ? { usage: openaiChatUsage(parsed.usage) } : {}),
        }
        return
      }
    }
    yield { type: 'done', finishReason: 'stop' }
  })()
}

/**
 * One message's content in the Responses shape.
 *
 * Text becomes `input_text`; an image becomes `input_image` carrying a data URL. That is the only
 * image form a Responses route accepts without the Files API, and it is what the recording double in
 * the browser contract asserts.
 */
export function toResponsesContent(
  parts: readonly ContentPart[],
  role: 'user' | 'assistant' | 'developer' = 'user',
): Record<string, unknown>[] {
  /**
   * The part's type depends on **who is speaking**, which is why the role is a parameter.
   *
   * Measured 2026-10-18 against a live Responses route: an assistant message whose text part was
   * `input_text` was refused with `Invalid value: 'input_text'. Supported values are: 'output_text' and
   * 'refusal'.` The shape names input and output apart, so a message replayed from a session is not the same
   * part as a message being sent. Every turn after the first carries an assistant message, which is why this
   * failed on a conversation rather than on a one-shot probe.
   */
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  return parts.flatMap((part): Record<string, unknown>[] => {
    if (part.type === 'text') return [{ type: textType, text: part.text }]
    if (part.type === 'image' && part.data !== undefined) {
      return [{ type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}` }]
    }
    return []
  })
}

/**
 * The Responses shape's `input` list, from a conversation.
 *
 * Three things this shape does that a message list does not carry, each measured against a live route on
 * 2026-10-18 rather than read off a specification:
 *
 * - **A tool call is an item, not a content part.** `{type: 'function_call', call_id, name, arguments}` sits in
 *   the list beside the messages. An adapter that dropped it ran a tool loop that could never continue.
 * - **A tool result is an item too.** `{type: 'function_call_output', call_id, output}` replaces the `tool`
 *   role, which this shape does not have.
 * - **An assistant message with nothing to say is not sent.** A turn whose whole reply was a tool call has no
 *   text, and an assistant item with empty content is refused; its `function_call` items carry the turn on
 *   their own, which the route accepts.
 */
export function toResponsesInput(messages: GenerateRequest['messages']): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: message.content
          .filter((part) => part.type === 'text')
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('\n'),
      })
      continue
    }
    const role = message.role === 'system' ? 'developer' : message.role
    const content = toResponsesContent(message.content, role)
    if (content.length > 0) items.push({ role, content })
    for (const part of message.content) {
      if (part.type !== 'tool-call') continue
      items.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: part.arguments })
    }
  }
  return items
}

/**
 * One message's content in the Anthropic shape.
 *
 * Text is a `text` block; an image is a `base64` source block, which is how a publisher route carries
 * image input without a file reference.
 */
export function toAnthropicContent(parts: readonly ContentPart[]): Record<string, unknown>[] {
  return parts.flatMap((part): Record<string, unknown>[] => {
    if (part.type === 'text') return [{ type: 'text', text: part.text }]
    if (part.type === 'image' && part.data !== undefined) {
      return [{ type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } }]
    }
    return []
  })
}

/**
 * One message in the Chat Completions shape.
 *
 * Text-only messages keep the string `content` the wire has always taken; a message carrying images
 * switches to the typed-parts form, which is the only shape that can carry an `image_url`. Exported so
 * the mapping can be asserted without a network call.
 */
export function toChatMessage(message: GenerateRequest['messages'][number]): Record<string, unknown> {
  const text = message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    /** Separate text blocks are separate blocks on the wire; a newline is this form's way to keep them apart. */
    .join('\n')
  const calls = message.content.filter((part) => part.type === 'tool-call')
  const images = message.content.filter(
    (part): part is ImagePart => part.type === 'image' && part.data !== undefined,
  )
  return {
    role: message.role,
    content:
      images.length > 0
        ? [
            ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
            ...images.map((part) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${part.mimeType};base64,${part.data}` },
            })),
          ]
        : text.length > 0
          ? text
          : null,
    ...(calls.length > 0
      ? {
          tool_calls: calls.map((part) => ({
            id: part.type === 'tool-call' ? part.id : '',
            type: 'function',
            function: { name: part.type === 'tool-call' ? part.name : '', arguments: part.type === 'tool-call' ? part.arguments : '' },
          })),
        }
      : {}),
    ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
  }
}

/** The non-streaming half of the chat shape, reduced to the same chunks. */
function* finishFromChatMessage(json: unknown): Generator<Chunk> {
  const answer = json as {
    choices?: { message?: { content?: string; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const choice = answer.choices?.[0]
  if (choice?.message?.reasoning_content) yield { type: 'reasoning-delta', text: choice.message.reasoning_content }
  if (choice?.message?.content) yield { type: 'text-delta', text: choice.message.content }
  for (const call of choice?.message?.tool_calls ?? []) {
    yield { type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments }
  }
  yield {
    type: 'done',
    finishReason: canonicalFinishReason(choice?.finish_reason, choice?.message?.tool_calls?.length ?? 0),
    ...(openaiChatUsage(answer.usage) !== undefined ? { usage: openaiChatUsage(answer.usage) } : {}),
  }
}

/**
 * OpenAI's Responses shape, which is the only one the Codex route offers.
 *
 * Two measured contracts are enforced here rather than left to the caller:
 * `input` must be a **list**, and `stream` must be **true** — a `false` is
 * rejected with `400 Stream must be set to true`. The stream ends on a
 * `response.completed` event and there is no `[DONE]` sentinel, so the loop
 * watches for that name.
 */
export function openAiResponsesAdapter(
  endpoint: Adapter['endpoint'],
  request: GenerateRequest,
  signal?: AbortSignal,
): AsyncIterable<Chunk> {
  const effort = reasoningValue(endpoint, request)
  const body = {
    model: request.model ?? endpoint.model,
    input: toResponsesInput(request.messages),
    store: false,
    stream: true,
    /** The Responses shape nests the level under `reasoning.effort`; the route's own error names the values. */
    ...(effort !== undefined && effort.value !== null ? { reasoning: { effort: effort.value } } : {}),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }
      : {}),
    ...(request.maxOutputTokens ?? endpoint.maxOutputTokens ?? undefined) !== undefined
      ? { max_output_tokens: request.maxOutputTokens ?? endpoint.maxOutputTokens }
      : {},
  }

  return (async function* responses() {
    const result = await post({
      url: `${baseUrlFor(endpoint, request.model)}/responses`,
      body,
      ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
      ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
      ...(endpoint.timeoutMs !== undefined ? { timeoutMs: endpoint.timeoutMs } : {}),
      ...hop(endpoint),
      stream: true,
      endpoint: endpoint.name,
      ...(signal !== undefined ? { signal } : {}),
    })
    if ('json' in result) {
      throw new ModelError(`'${endpoint.name}' answered the Responses route without a stream`, {
        endpoint: endpoint.name,
        code: 'BAD_BODY',
      })
    }

    const calls = new Map<string, PartialToolCall>()
    let usage: TokenUsage | undefined
    let finishReason = 'stop'

    for await (const event of readSse(result.stream)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(event.data)
      } catch {
        continue
      }
      const type = String(parsed.type ?? event.event ?? '')
      if (type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
        yield { type: 'text-delta', text: parsed.delta }
      } else if (type === 'response.reasoning_summary_text.delta' && typeof parsed.delta === 'string') {
        yield { type: 'reasoning-delta', text: parsed.delta }
      } else if (type === 'response.output_item.added') {
        const item = parsed.item as { type?: string; id?: string; name?: string; call_id?: string } | undefined
        if (item?.type === 'function_call') {
          /**
           * Keyed by the item's own `id`, not by its `call_id`, because those are **two different strings**
           * and the argument deltas name the first. Measured 2026-10-18 against a live route: the item arrived
           * as `id: fc_023f…, call_id: call_8xeHF…`, every `response.function_call_arguments.delta` carried
           * `item_id: fc_023f…`, and keying the map by `call_id` made each delta miss its entry — so the tool
           * call was emitted with the right id, an empty name and empty arguments, and the route refused the
           * next request with `Invalid 'input[4].name': empty string`.
           */
          const key = String(item.id ?? item.call_id ?? 'call')
          calls.set(key, {
            id: item.call_id ?? item.id ?? 'call',
            name: item.name ?? '',
            arguments: '',
          })
        }
      } else if (type === 'response.function_call_arguments.delta') {
        const key = String(parsed.item_id ?? parsed.call_id ?? 'call')
        const call = calls.get(key) ?? { id: key, name: '', arguments: '' }
        call.arguments += String(parsed.delta ?? '')
        calls.set(key, call)
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        const response = parsed.response as
          | {
              usage?: { input_tokens?: number; output_tokens?: number }
              status?: string
              incomplete_details?: { reason?: string } | null
              output?: { type?: string; call_id?: string; name?: string; arguments?: string }[]
            }
          | undefined
        if (response?.usage) usage = openaiResponsesUsage(response.usage)
        /**
         * The completed response restates every function call in full, so it is the authority for anything the
         * event stream left incomplete. A name that arrived only here is still a name; preferring the deltas
         * would turn a restated call into an empty one.
         */
        for (const item of response?.output ?? []) {
          if (item.type !== 'function_call') continue
          const id = String(item.call_id ?? '')
          const known = [...calls.values()].find((call) => call.id === id)
          if (known === undefined && id !== '') {
            calls.set(id, { id, name: item.name ?? '', arguments: item.arguments ?? '' })
          } else if (known !== undefined && known.name === '' && item.name !== undefined) {
            known.name = item.name
            if (known.arguments === '') known.arguments = item.arguments ?? ''
          }
        }
        for (const call of calls.values()) {
          yield { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }
        }
        finishReason = responsesFinishReason(type, response?.incomplete_details?.reason, calls.size)
        yield { type: 'done', finishReason, ...(usage ? { usage } : {}) }
        return
      } else if (type === 'response.failed' || type === 'error') {
        throw new ModelError(`'${endpoint.name}' reported a failed response — ${JSON.stringify(parsed).slice(0, 300)}`, {
          endpoint: endpoint.name,
          code: 'REMOTE',
        })
      }
    }
    for (const call of calls.values()) {
      yield { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }
    }
    /**
     * The stream closed without a terminal event. That is not a normal stop: the route always ends on one of
     * `response.completed`, `response.incomplete` or `response.failed`, so a stream that ends on none of them was
     * cut, and saying `stop` would present a truncated answer as a finished one.
     */
    finishReason = 'stream_ended'
    yield { type: 'done', finishReason, ...(usage ? { usage } : {}) }
  })()
}

/**
 * The loop's finish reason for a Responses stream's terminal event.
 *
 * The loop speaks Chat Completions' words — `stop` for a finished answer, `tool_calls` for a round that asks for
 * tools, anything else an abnormal end it reports. The Responses shape uses its own: a status of `completed`, or a
 * separate `response.incomplete` event carrying `incomplete_details.reason`. Passing the status through made every
 * healthy answer read as stopped — measured 2026-10-18, a plain `ok` from a Meta Codex route was logged with
 * `ended: ['round 1: completed']` — and ignoring the incomplete event made a reasoning model that spent its whole
 * budget thinking return an empty answer reported as a normal stop.
 */
export function responsesFinishReason(terminal: string, incompleteReason: string | undefined, toolCalls: number): string {
  /**
   * An incomplete response is cut, and its own `reason` is the useful word — `max_output_tokens` or
   * `content_filter`. Every other terminal event goes through the shared translation, because `completed` is the
   * loop's `stop` and a round that asked for tools ended in `tool_calls`.
   */
  if (terminal === 'response.incomplete') return canonicalFinishReason(incompleteReason ?? 'incomplete', 0)
  return canonicalFinishReason('completed', toolCalls)
}

/** The body version an Anthropic publisher route requires; it is not a header on this shape. */
export const ANTHROPIC_VERTEX_VERSION = 'vertex-2023-10-16'

/**
 * What a call with no cap gets.
 *
 * The route **requires** `max_tokens`, so a request that names none cannot simply omit it — the provider would
 * refuse the whole call over a field the caller did not know it had to send. The cap is conservative on
 * purpose: it bounds a runaway answer, and an endpoint that wants a different one says so in its configuration.
 */
export const DEFAULT_MAX_TOKENS = 4096

/** A tool call's arguments as the provider expects them: parsed JSON, not a string. */
function parseToolInput(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

/**
 * The request body and URL for the Anthropic publisher route.
 *
 * Pure and exported so the translation can be judged without a socket. Four rules differ from the OpenAI
 * shapes and each one is a provider refusal if it is wrong:
 *
 * - the **system prompt** is a top-level field, not a message;
 * - a recorded **tool call** becomes a `tool_use` block with parsed input, and its result becomes a
 *   `tool_result` block on a **user** turn, naming the call;
 * - adjacent same-role turns are merged, because Anthropic's turns must alternate and a tool result follows an
 *   assistant turn directly;
 * - **reasoning is dropped**: a thinking block carries a signature the provider issues when it generates it,
 *   and one sent back without that signature is refused.
 */
export function anthropicCall(
  endpoint: Adapter['endpoint'],
  request: GenerateRequest,
): { readonly url: string; readonly body: Record<string, unknown>; readonly headers: Record<string, string> } {
  if (endpoint.project === undefined || endpoint.project.length === 0) {
    throw new ModelError(`'${endpoint.name}' has no project, and the publisher route is addressed under one`, {
      endpoint: endpoint.name,
      code: 'NO_PROJECT',
    })
  }
  if (endpoint.region === undefined || endpoint.region.length === 0) {
    throw new ModelError(`'${endpoint.name}' has no region, and the publisher route is addressed in one`, {
      endpoint: endpoint.name,
      code: 'NO_REGION',
    })
  }
  const model = request.model ?? endpoint.model
  if (model === undefined || model.length === 0) {
    throw new ModelError(`'${endpoint.name}' names no model`, { endpoint: endpoint.name, code: 'NO_MODEL' })
  }
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.filter((part) => part.type === 'text').map((part) => (part.type === 'text' ? part.text : '')).join(''))
    .filter((text) => text.length > 0)
    .join('\n\n')
  const maxTokens = request.maxOutputTokens ?? endpoint.maxOutputTokens ?? DEFAULT_MAX_TOKENS
  const effort = reasoningValue(endpoint, request)

  const body: Record<string, unknown> = {
    anthropic_version: ANTHROPIC_VERTEX_VERSION,
    messages: toAnthropicMessages(request.messages),
    max_tokens: maxTokens,
    stream: true,
    ...(system.length > 0 ? { system } : {}),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    /**
     * The publisher route for the models configured here refuses `thinking.type: enabled` with
     * "use thinking.type.adaptive and output_config.effort to control thinking behavior" — measured
     * 2026-10-17 against the Meta Vertex route — so the effort is sent the way that route names it.
     */
    ...(effort !== undefined && effort.value !== null
      ? { thinking: { type: 'adaptive' }, output_config: { effort: effort.value } }
      : {}),
  }

  return {
    url: `${baseUrlFor(endpoint, request.model)}/projects/${endpoint.project}/locations/${endpoint.region}/publishers/anthropic/models/${model}:streamRawPredict`,
    body,
    headers: titleCaseHeaders(endpoint.headers ?? {}),
  }
}

/** The message list as Anthropic reads it, with a system prompt left to the top-level field. */
function toAnthropicMessages(messages: GenerateRequest['messages']): Record<string, unknown>[] {
  const turns: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = []
  const push = (role: 'user' | 'assistant', content: Record<string, unknown>[]): void => {
    if (content.length === 0) return
    const last = turns[turns.length - 1]
    if (last !== undefined && last.role === role) last.content.push(...content)
    else turns.push({ role, content })
  }

  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'assistant') {
      push(
        'assistant',
        message.content.flatMap((part): Record<string, unknown>[] => {
          if (part.type === 'text') return [{ type: 'text', text: part.text }]
          if (part.type === 'tool-call') {
            return [{ type: 'tool_use', id: part.id, name: part.name, input: parseToolInput(part.arguments) }]
          }
          // A reasoning part is deliberately not sent: see this function's caller for why.
          return []
        }),
      )
      continue
    }
    if (message.role === 'tool') {
      const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      push('user', [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: text }])
      continue
    }
    push('user', toAnthropicContent(message.content))
  }
  return turns
}

/**
 * Fold Anthropic's event stream into the harness vocabulary.
 *
 * The shape is the one Anthropic documents and the one a cloud publisher route relays unchanged: text arrives
 * as `text_delta`, thinking as `thinking_delta`, a tool call as a `content_block_start` naming it followed by
 * `input_json_delta` fragments, the stop reason and output count as `message_delta`, and the end as
 * `message_stop`. Split out from the transport so the fold is judged by feeding it literals.
 */
export async function* anthropicChunks(
  events: AsyncIterable<{ readonly event?: string; readonly data: string }>,
  endpointName: string,
): AsyncIterable<Chunk> {
  const calls = new Map<number, PartialToolCall>()
  let finishReason = 'stop'
  let usage: { inputTokens?: number; outputTokens?: number } | undefined

  for await (const event of events) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>
    } catch {
      continue
    }
    const type = String(parsed.type ?? event.event ?? '')
    if (type === 'message_start') {
      const message = parsed.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined
      if (message?.usage !== undefined) {
        usage = {
          ...(message.usage.input_tokens !== undefined ? { inputTokens: message.usage.input_tokens } : {}),
          ...(message.usage.output_tokens !== undefined ? { outputTokens: message.usage.output_tokens } : {}),
        }
      }
    } else if (type === 'content_block_start') {
      const block = parsed.content_block as { type?: string; id?: string; name?: string } | undefined
      const index = typeof parsed.index === 'number' ? parsed.index : 0
      if (block?.type === 'tool_use') {
        calls.set(index, { id: block.id ?? `call-${index}`, name: block.name ?? '', arguments: '' })
      }
    } else if (type === 'content_block_delta') {
      const delta = parsed.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined
      const index = typeof parsed.index === 'number' ? parsed.index : 0
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        yield { type: 'text-delta', text: delta.text }
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        yield { type: 'reasoning-delta', text: delta.thinking }
      } else if (delta?.type === 'input_json_delta') {
        const call = calls.get(index) ?? { id: `call-${index}`, name: '', arguments: '' }
        call.arguments += String(delta.partial_json ?? '')
        calls.set(index, call)
      }
    } else if (type === 'message_delta') {
      const delta = parsed.delta as { stop_reason?: string } | undefined
      /**
       * Anthropic's words, translated. Its healthy end is `end_turn`, which the loop does not know, so passing it
       * through put a stop notice on every ordinary Claude answer.
       */
      if (typeof delta?.stop_reason === 'string') finishReason = canonicalFinishReason(delta.stop_reason, calls.size)
      const reported = parsed.usage as { output_tokens?: number } | undefined
      if (reported?.output_tokens !== undefined) usage = { ...(usage ?? {}), outputTokens: reported.output_tokens }
    } else if (type === 'message_stop') {
      for (const call of calls.values()) yield { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }
      yield { type: 'done', finishReason, ...(usage !== undefined ? { usage } : {}) }
      return
    } else if (type === 'error') {
      const failure = parsed.error as { type?: string; message?: string } | undefined
      throw new ModelError(
        `'${endpointName}' reported ${failure?.type ?? 'an error'} — ${failure?.message ?? JSON.stringify(parsed).slice(0, 200)}`,
        { endpoint: endpointName, code: 'REMOTE' },
      )
    }
  }
  for (const call of calls.values()) yield { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }
  yield { type: 'done', finishReason, ...(usage !== undefined ? { usage } : {}) }
}

/**
 * Anthropic's Messages shape on a cloud publisher route.
 *
 * A third wire shape beside Chat Completions and Responses, and the reason it is worth having: it is the
 * **standard** way to reach Anthropic's models on a hosted cloud, so an enterprise deployment that forwards to
 * that publisher is reached by configuration alone — the gateway's address, the project and region, and the
 * hop an agent on loopback provides. Nothing about a particular deployment is in this file.
 */
export function anthropicVertexAdapter(
  endpoint: Adapter['endpoint'],
  request: GenerateRequest,
  signal?: AbortSignal,
): AsyncIterable<Chunk> {
  return (async function* anthropic() {
    const call = anthropicCall(endpoint, request)
    const result = await post({
      url: call.url,
      body: call.body,
      headers: call.headers,
      ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
      ...(endpoint.timeoutMs !== undefined ? { timeoutMs: endpoint.timeoutMs } : {}),
      ...hop(endpoint),
      stream: true,
      endpoint: endpoint.name,
      ...(signal !== undefined ? { signal } : {}),
    })
    if ('json' in result) {
      throw new ModelError(`'${endpoint.name}' answered the publisher route without a stream`, {
        endpoint: endpoint.name,
        code: 'BAD_BODY',
      })
    }
    yield* anthropicChunks(readSse(result.stream), endpoint.name)
  })()
}

/**
 * A deterministic backend for the checks, and the reason they spend nothing.
 *
 * The endpoint's `baseUrl` names a JSON file holding the script: an array of
 * steps, each either text or a tool call. It reads no clock and calls nothing, so
 * a check that runs against it is reproducible and offline by construction.
 */
export function scriptedAdapter(
  endpoint: Adapter['endpoint'],
  request: GenerateRequest,
  signal?: AbortSignal,
): AsyncIterable<Chunk> {
  return (async function* scripted() {
    const { readFileSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    // `~` is expanded here because a script path is written in a config file the
    // same way every other local path is, and a literal `~` directory does not
    // exist. Measured: this is what "the script could not be read at
    // ~/.heddle/scripted.json" meant the first time it ran.
    const scriptPath = endpoint.baseUrl.startsWith('~')
      ? `${homedir()}${endpoint.baseUrl.slice(1)}`
      : endpoint.baseUrl
    let script: { steps?: unknown[] } = {}
    try {
      script = JSON.parse(readFileSync(scriptPath, 'utf8')) as { steps?: unknown[] }
    } catch (error) {
      throw new ModelError(`the script for '${endpoint.name}' could not be read at ${scriptPath}`, {
        endpoint: endpoint.name,
        code: 'SCRIPT',
        cause: error,
      })
    }
    if (signal?.aborted) throw new ModelError('aborted', { endpoint: endpoint.name, code: 'ABORTED' })

    /**
     * Steps are handed out by round, one call each.
     *
     * The first version replayed the whole list on every call, so a script whose first step
     * was a tool call that got refused refused it again on the next round — an endless loop
     * that only the round limit stopped, and one that made a one-step script unusable. A round
     * index makes the script a sequence rather than a repeat.
     */
    const roundIndex = typeof (request as { round?: unknown }).round === 'number' ? (request as { round: number }).round : 0
    /**
     * Steps are also separable by **purpose**.
     *
     * A summarising call and a turn reach the same endpoint, so a script that could not tell them
     * apart could not describe a compaction at all: the summary step and the turn's step would be
     * the same step. A step's `purpose` defaults to `'turn'`, so every script written before this
     * existed keeps its meaning.
     */
    const purpose = (request as { purpose?: unknown }).purpose
    const wanted = typeof purpose === 'string' ? purpose : 'turn'
    const steps = (script.steps ?? []).filter((entry) => {
      const declared = (entry ?? {}) as { purpose?: unknown }
      return (typeof declared.purpose === 'string' ? declared.purpose : 'turn') === wanted
    })
    const step = steps[roundIndex]
    const value = (step ?? {}) as {
      text?: string
      reasoning?: string
      toolCall?: { name: string; arguments: unknown }
      finishReason?: string
      /** A step that fails the call rather than answering, so a check can exercise recovery. */
      error?: { code?: string; status?: number; message?: string }
    }
    if (value.error !== undefined) {
      throw new ModelError(value.error.message ?? `the script for '${endpoint.name}' failed at round ${roundIndex}`, {
        endpoint: endpoint.name,
        code: value.error.code ?? 'SCRIPT',
        ...(value.error.status !== undefined ? { status: value.error.status } : {}),
      })
    }
    {
      if (value.reasoning) yield { type: 'reasoning-delta', text: value.reasoning }
      if (value.text) yield { type: 'text-delta', text: value.text }
      if (value.toolCall) {
        yield {
          type: 'tool-call',
          id: `call-${value.toolCall.name}`,
          name: value.toolCall.name,
          arguments: JSON.stringify(value.toolCall.arguments ?? {}),
        }
      }
    }
    yield { type: 'done', finishReason: value.finishReason ?? (value.toolCall ? 'tool_calls' : 'stop') }
  })()
}

/** The adapter for one endpoint's declared kind. */
export function adapterFor(endpoint: Adapter['endpoint']): Adapter {
  switch (endpoint.kind) {
    case 'openai-chat':
      return { endpoint, stream: (request, signal) => openAiChatAdapter(endpoint, request, signal) }
    case 'openai-responses':
      return { endpoint, stream: (request, signal) => openAiResponsesAdapter(endpoint, request, signal) }
    case 'anthropic-vertex':
      return { endpoint, stream: (request, signal) => anthropicVertexAdapter(endpoint, request, signal) }
    case 'scripted':
      return { endpoint, stream: (request, signal) => scriptedAdapter(endpoint, request, signal) }
    default: {
      const kind: never = endpoint.kind
      throw new ModelError(`unknown endpoint kind '${String(kind)}'`, {
        endpoint: endpoint.name,
        code: 'UNKNOWN_KIND',
      })
    }
  }
}
