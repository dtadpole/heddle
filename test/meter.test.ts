import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BLOCK_OVERHEAD, CHARS_PER_TOKEN, ROLE_OVERHEAD, TokenMeter, estimateMessage, estimatePart, estimateTools } from '../src/context/meter.ts'
import { BudgetError, resolveBudget } from '../src/context/budget.ts'
import type { ContentPart, Message, ToolSpec } from '../src/llm/types.ts'

/** One user message carrying a single text block, which is what most cases need. */
function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** The one tool schema the pricing cases share, whose serialisation is 76 characters. */
const TOOL: ToolSpec = { name: 'read', description: 'Read a file', parameters: { type: 'object' } }

test('a tool call is priced with two ceilings, not one over the concatenation', () => {
  const part = { type: 'tool-call' as const, id: 'call-1', name: 'ab', arguments: 'cd' }
  assert.equal(estimatePart(part), 1 + 1 + BLOCK_OVERHEAD)
  // The four concatenated characters round to one token, so the naive price is
  // a token cheaper — this is the difference the two ceilings exist to keep.
  assert.notEqual(estimatePart(part), Math.ceil('abcd'.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD)
})

test('a block type the union does not have yet is priced by its JSON structure', () => {
  // The union is merge-extensible, so the arm has to exist even though no current
  // variant reaches it; a cast is the only way to exercise it from here.
  const part = { type: 'image', source: 'x' } as unknown as ContentPart
  assert.equal(estimatePart(part), BLOCK_OVERHEAD + Math.ceil(JSON.stringify(part).length / CHARS_PER_TOKEN))
})

test('an empty system message prices zero while an empty user message prices its role', () => {
  assert.equal(estimateMessage({ role: 'system', content: [] }), 0)
  assert.equal(estimateMessage({ role: 'user', content: [] }), ROLE_OVERHEAD)
})

test('a system message pays no per-block overhead, and a user message does', () => {
  const text = 'a'.repeat(40)
  assert.equal(estimateMessage({ role: 'system', content: [{ type: 'text', text }] }), 10 + ROLE_OVERHEAD)
  assert.equal(estimateMessage(userMessage(text)), 10 + BLOCK_OVERHEAD + ROLE_OVERHEAD)
})

test('tools price zero when absent or empty, and the schema otherwise', () => {
  assert.equal(estimateTools(undefined), 0)
  assert.equal(estimateTools([]), 0)
  assert.equal(JSON.stringify([TOOL]).length, 76)
  assert.equal(estimateTools([TOOL]), 19 + BLOCK_OVERHEAD)
})

test('usage below the estimate is ignored while usage at or above it is adopted', () => {
  const meter = new TokenMeter()
  const message = userMessage('hello world')
  // Three tokens of text, one block of framing, one role of framing.
  const estimated = estimateMessage(message)
  assert.equal(estimated, 3 + BLOCK_OVERHEAD + ROLE_OVERHEAD)

  const below = meter.measure({ nodes: [{ seq: 1, message }], usage: { inputTokens: 3, outputTokens: 4, generation: 1 }, generation: 1 })
  assert.equal(below.baseline.kind, 'estimated')
  assert.equal(below.baseline.tokens, estimated)
  assert.equal(below.totalTokens, estimated)

  const equal = meter.measure({ nodes: [{ seq: 1, message }], usage: { inputTokens: 5, outputTokens: 6, generation: 1 }, generation: 1 })
  assert.equal(equal.baseline.kind, 'usage')
  assert.equal(equal.totalTokens, estimated)

  const above = meter.measure({ nodes: [{ seq: 1, message }], usage: { inputTokens: 100, outputTokens: 50, generation: 1 }, generation: 1 })
  assert.equal(above.baseline.kind, 'usage')
  assert.equal(above.totalTokens, 150)
})

test('usage from a different surface generation is ignored', () => {
  const message = userMessage('hello world')
  const measurement = new TokenMeter().measure({
    nodes: [{ seq: 1, message }],
    usage: { inputTokens: 100, outputTokens: 50, generation: 1 },
    generation: 2,
  })
  assert.equal(measurement.baseline.kind, 'estimated')
  assert.equal(measurement.totalTokens, estimateMessage(message))
})

test('measure splits the surface into system, message and tool prices', () => {
  const system = { role: 'system' as const, content: [{ type: 'text' as const, text: 'you are a harness' }] }
  const message = userMessage('hello world')
  const measurement = new TokenMeter().measure({
    nodes: [
      { seq: 1, message: system },
      { seq: 2, message },
    ],
    tools: [TOOL],
    generation: 0,
  })

  assert.deepEqual(measurement.nodes.map((node) => node.seq), [1, 2])
  // No route pricing exists yet, so the used price and the heuristic agree.
  assert.deepEqual(measurement.nodes.map((node) => node.tokens), measurement.nodes.map((node) => node.heuristicTokens))
  assert.equal(measurement.systemTokens, estimateMessage(system))
  assert.equal(measurement.messageTokens, estimateMessage(message))
  assert.equal(measurement.toolsTokens, estimateTools([TOOL]))
  assert.equal(measurement.baseline.kind, 'estimated')
  assert.equal(measurement.totalTokens, measurement.systemTokens + measurement.messageTokens + measurement.toolsTokens)
})

test('a session with no nodes, no tools and no usage reports nothing to measure', () => {
  const measurement = new TokenMeter().measure({ nodes: [], generation: 0 })
  assert.equal(measurement.baseline.kind, 'none')
  assert.equal(measurement.baseline.tokens, 0)
  assert.equal(measurement.totalTokens, 0)
  assert.deepEqual(measurement.nodes, [])
  assert.equal(measurement.systemTokens + measurement.messageTokens + measurement.toolsTokens, 0)
})

test('tools alone are enough to make the baseline an estimate', () => {
  const measurement = new TokenMeter().measure({ nodes: [], tools: [TOOL], generation: 3 })
  assert.equal(measurement.baseline.kind, 'estimated')
  assert.equal(measurement.baseline.tokens, measurement.toolsTokens)
  assert.equal(measurement.totalTokens, measurement.toolsTokens)
})

test('the endpoint window beats the configured window and is the reported source', () => {
  assert.deepEqual(resolveBudget({ endpoint: 'local', endpointWindow: 1000, configWindow: 500 }), {
    contextWindow: 1000,
    thresholdTokens: 800,
    retainTokens: 160,
    source: 'endpoint',
  })
  assert.deepEqual(resolveBudget({ endpoint: 'local', configWindow: 500 }), {
    contextWindow: 500,
    thresholdTokens: 400,
    retainTokens: 80,
    source: 'config',
  })
})

test('a per-endpoint policy overrides the configured policy field by field', () => {
  const budget = resolveBudget({
    endpoint: 'a',
    endpointWindow: 1000,
    configPolicy: { thresholdRatio: 0.9, retainRatio: 0.05 },
    policies: [{ endpoint: 'a', thresholdRatio: 0.5 }],
  })
  // The ratio it names is overridden; the one it leaves alone survives.
  assert.equal(budget.thresholdTokens, 500)
  assert.equal(budget.retainTokens, 50)

  const other = resolveBudget({
    endpoint: 'a',
    endpointWindow: 1000,
    configPolicy: { thresholdRatio: 0.9 },
    policies: [{ endpoint: 'b', thresholdRatio: 0.5 }],
  })
  assert.equal(other.thresholdTokens, 900)
})

test('the first matching per-endpoint policy wins', () => {
  const budget = resolveBudget({
    endpoint: 'a',
    endpointWindow: 1000,
    policies: [
      { endpoint: 'a', thresholdRatio: 0.5 },
      { endpoint: 'a', thresholdRatio: 0.25, retainRatio: 0.1 },
    ],
  })
  assert.equal(budget.thresholdTokens, 500)
  assert.equal(budget.retainTokens, 160)
})

test('absolute numbers in the policy beat the ratios', () => {
  const budget = resolveBudget({ endpointWindow: 1000, configPolicy: { thresholdTokens: 640, retainTokens: 96, thresholdRatio: 0.1, retainRatio: 0.01 } })
  assert.equal(budget.thresholdTokens, 640)
  assert.equal(budget.retainTokens, 96)
})

test('a window that comes from nowhere is refused with NO_CAPACITY, naming the endpoint', () => {
  assert.throws(
    () => resolveBudget({ endpoint: 'local' }),
    (error: unknown) => {
      assert.ok(error instanceof BudgetError)
      assert.equal(error.code, 'NO_CAPACITY')
      assert.match(error.message, /local/)
      return true
    },
  )
  assert.throws(
    () => resolveBudget({}),
    (error: unknown) => {
      assert.ok(error instanceof BudgetError)
      assert.equal(error.code, 'NO_CAPACITY')
      return true
    },
  )
})

test('a retained tail at or above the trigger is refused', () => {
  assert.throws(
    () => resolveBudget({ endpointWindow: 100, configPolicy: { thresholdRatio: 0.1, retainRatio: 0.2 } }),
    (error: unknown) => {
      assert.ok(error instanceof BudgetError)
      assert.equal(error.code, 'RETAIN_NOT_BELOW_THRESHOLD')
      // Named by what was written (#212): the two ratios, not token counts the reader never set.
      assert.equal(
        error.message,
        'retainRatio (0.2) must be less than the resolved thresholdRatio (0.1): the retained tail would be at least the trigger, so compaction could never make progress',
      )
      return true
    },
  )
  assert.throws(
    () => resolveBudget({ endpointWindow: 100, configPolicy: { thresholdRatio: 0.2, retainRatio: 0.2 } }),
    (error: unknown) => error instanceof BudgetError && error.code === 'RETAIN_NOT_BELOW_THRESHOLD',
  )
  // A side in tokens against a ratio of the endpoint's own window, and a policy's own field under its index.
  assert.throws(
    () => resolveBudget({ endpoint: 'small', endpointWindow: 1000, configPolicy: { retainTokens: 900 } }),
    (error: unknown) =>
      error instanceof BudgetError &&
      error.message.startsWith("retainTokens (900) must be less than the threshold tokens (800 = thresholdRatio 0.8 of endpoint 'small' window 1000):"),
  )
  assert.throws(
    () => resolveBudget({ endpoint: 'small', configWindow: 1000, policies: [{ endpoint: 'other' }, { endpoint: 'small', thresholdTokens: 100 }] }),
    (error: unknown) =>
      error instanceof BudgetError &&
      error.message.startsWith('policies[1].retainRatio (0.16) of contextWindow 1000 is 160 tokens, which must be less than thresholdTokens (100):'),
  )
})
