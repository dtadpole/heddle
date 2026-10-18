/**
 * Token usage in the shape the harness keeps it.
 *
 * Providers disagree about what a usage frame contains. DSH separates the **three prompt-side billing
 * buckets** — uncached input, cache reads and cache writes — from output, because the composer's token
 * pill prints their total and its `Cache hit` share is the cache-read fraction of that billed input. An
 * adapter's job is therefore to normalise its wire shape into these buckets before anything else reads a
 * token count; this file is that normalisation, kept pure so each provider's rule can be judged without a
 * server.
 *
 * Two rules are deliberate:
 *
 * - **A bucket stays absent until a frame reports it.** An absent cache bucket is not a zero: a provider
 *   that never mentions caching must not make the page print `Cache hit 0%`.
 * - **`inputTokens` is the uncached part**, never the whole prompt. OpenAI's `prompt_tokens` includes the
 *   cached subset, so the cache read is subtracted; Anthropic's `input_tokens` already excludes it.
 */

/** One call's, or one turn's, reported usage. Every field is absent when no frame reported it. */
export interface TokenUsage {
  /** Prompt-side tokens billed without a cache hit. */
  readonly inputTokens?: number
  /** Completion tokens the provider billed. */
  readonly outputTokens?: number
  /** Prompt-side tokens served from the provider's cache. */
  readonly cacheReadTokens?: number
  /** Prompt-side tokens written into the provider's cache. */
  readonly cacheWriteTokens?: number
}

/** A non-negative finite token count, or undefined when the frame did not carry one. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** The cached-token count out of a nested details object, if the provider sent one. */
function cachedIn(details: unknown): number | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  return count((details as { cached_tokens?: unknown }).cached_tokens)
}

/**
 * OpenAI's chat-completions usage.
 *
 * `prompt_tokens` includes the cached subset, so this subtracts it and keeps the remainder as the billed
 * input. A frame without a cache detail reports its whole prompt as uncached.
 */
export function openaiChatUsage(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const frame = usage as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    prompt_tokens_details?: unknown
  }
  const prompt = count(frame.prompt_tokens)
  const cached = cachedIn(frame.prompt_tokens_details)
  const outputTokens = count(frame.completion_tokens)
  return assemble(prompt, cached, undefined, outputTokens)
}

/** OpenAI's responses-API usage: the same subset rule on `input_tokens`. */
export function openaiResponsesUsage(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const frame = usage as {
    input_tokens?: unknown
    output_tokens?: unknown
    input_tokens_details?: unknown
  }
  return assemble(count(frame.input_tokens), cachedIn(frame.input_tokens_details), undefined, count(frame.output_tokens))
}

/**
 * Anthropic's usage.
 *
 * Anthropic already keeps the buckets apart: `input_tokens` is the uncached part, `cache_read_input_tokens`
 * and `cache_creation_input_tokens` are the other two.
 */
export function anthropicUsage(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const frame = usage as {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_read_input_tokens?: unknown
    cache_creation_input_tokens?: unknown
  }
  return disjoint(
    count(frame.input_tokens),
    count(frame.cache_read_input_tokens),
    count(frame.cache_creation_input_tokens),
    count(frame.output_tokens),
  )
}

/**
 * Build a usage value from a prompt total that **includes** its cached subset.
 *
 * Kept private because the subset rule is a provider fact; the exported adapters above name their frames.
 */
function assemble(promptTotal: number | undefined, cachedRead: number | undefined, cacheWrite: number | undefined, outputTokens: number | undefined): TokenUsage | undefined {
  const inputTokens = promptTotal === undefined ? undefined : Math.max(0, promptTotal - (cachedRead ?? 0))
  const usage: TokenUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedRead !== undefined ? { cacheReadTokens: cachedRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  }
  return Object.keys(usage).length === 0 ? undefined : usage
}

/** Build a usage value from buckets a provider already keeps disjoint (Anthropic). */
function disjoint(inputTokens: number | undefined, cacheRead: number | undefined, cacheWrite: number | undefined, outputTokens: number | undefined): TokenUsage | undefined {
  const usage: TokenUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  }
  return Object.keys(usage).length === 0 ? undefined : usage
}

/**
 * Add one frame's usage to a running total, bucket by bucket.
 *
 * A turn is several model rounds, so this is a sum. A bucket stays absent until a frame reports it: a round
 * that knows nothing about caching must not turn another round's cache read into a zero.
 */
export function mergeTokenUsage(previous: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (next === undefined) return previous
  if (previous === undefined) return next
  return {
    ...(previous.inputTokens !== undefined || next.inputTokens !== undefined
      ? { inputTokens: (previous.inputTokens ?? 0) + (next.inputTokens ?? 0) }
      : {}),
    ...(previous.outputTokens !== undefined || next.outputTokens !== undefined
      ? { outputTokens: (previous.outputTokens ?? 0) + (next.outputTokens ?? 0) }
      : {}),
    ...(previous.cacheReadTokens !== undefined || next.cacheReadTokens !== undefined
      ? { cacheReadTokens: (previous.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0) }
      : {}),
    ...(previous.cacheWriteTokens !== undefined || next.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (previous.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0) }
      : {}),
  }
}

/**
 * The billed prompt-side total: the denominator of `Cache hit`.
 *
 * Undefined when no prompt-side bucket was reported at all — the percentage has no denominator, and the page
 * omits the phrase rather than printing a zero.
 */
export function billedInputTokens(usage: TokenUsage | undefined): number | undefined {
  if (usage === undefined) return undefined
  if (
    usage.inputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheWriteTokens === undefined
  ) {
    return undefined
  }
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}
