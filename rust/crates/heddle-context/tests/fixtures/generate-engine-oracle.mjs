// Record what the TypeScript build's store and context engine write, as the oracle for
// `tests/engine-agreement.rs`.
//
//   node rust/crates/heddle-context/tests/fixtures/generate-engine-oracle.mjs \
//     > rust/crates/heddle-context/tests/fixtures/engine-oracle.json
//
// Node 24 runs `src/` directly (type stripping), and the store, the pruner and the compaction engine
// import only Node built-ins, so this needs no `dist/` and no `node_modules`. Each scenario records the
// events the TypeScript build appended (without `at`, which is a clock), the surface, and the messages a
// request would carry, so the Rust build can replay the same inputs and be compared field for field.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionStore } from '../../../../../src/session/store.ts'
import { CompactionEngine } from '../../../../../src/context/compaction.ts'
import { TokenMeter } from '../../../../../src/context/meter.ts'
import { resolveBudget } from '../../../../../src/context/budget.ts'
import { ToolResultPruner } from '../../../../../src/context/prune.ts'

const scratch = mkdtempSync(join(tmpdir(), 'heddle-engine-oracle-'))
const meter = new TokenMeter()

function fresh() {
  const store = new SessionStore(join(scratch, `sessions-${Math.random().toString(36).slice(2)}`))
  const handle = store.create({ cwd: scratch })
  return { store, handle }
}

function measure(store, handle) {
  const state = store.surface(handle)
  const nodes = state.nodes
    .map((seq) => ({ seq, message: store.deriveNode(handle, seq) }))
    .filter((node) => node.message !== null)
  return meter.measure({ nodes, generation: state.contentGeneration })
}

/** The log without the clock, and with `cwd` (a temporary path) left out of `session/created`. */
function record(store, handle, extra = {}) {
  const events = store.read(handle).map((event) => {
    const { at, ...rest } = event
    if (rest.type === 'session/created') delete rest.cwd
    return rest
  })
  return {
    events,
    surface: [...store.surface(handle).nodes],
    contentGeneration: store.surface(handle).contentGeneration,
    replaceGeneration: store.surface(handle).replaceGeneration,
    messages: store.deriveMessages(handle),
    ...extra,
  }
}

const text = (role, body) => ({ role, content: [{ type: 'text', text: body }] })
const scenarios = {}

// 1. The verifier's in-process scenario: a cut aimed at the tool result backs off before the call, and a
//    20,000-character summary is refused with the surface unchanged.
{
  const { store, handle } = fresh()
  store.message(handle, text('system', 'be brief'))
  store.message(handle, text('user', 'do the thing'))
  store.assistantChunk(handle, { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' })
  store.assistantChunk(handle, { type: 'done', finishReason: 'tool_calls' })
  store.message(handle, { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'the result' }] })
  store.message(handle, text('user', 'and again'))
  store.message(handle, text('assistant', 'done'))
  const measurement = measure(store, handle)
  const budget = resolveBudget({ configWindow: 10_000 })
  const nodes = store.surface(handle).nodes
  const priced = new Map(measurement.nodes.map((node) => [node.seq, node.tokens]))
  const aimed = [nodes[2], nodes[3], nodes[4], nodes[5]].reduce((sum, seq) => sum + (priced.get(seq) ?? 0), 0)
  const engine = new CompactionEngine(store)
  const plan = engine.plan(handle, budget, measurement, { retainTokens: aimed })
  const outcome = await engine.compact(handle, plan, {
    budget,
    measurement,
    summarize: async () => 'z'.repeat(20_000),
    measure: () => measurement,
  })
  scenarios.refusedAimedCut = record(store, handle, { retainTokens: aimed, measurement, plan, outcome })
}

// 2. A landed compaction: the span becomes one checkpoint note and the transaction is logged.
{
  const { store, handle } = fresh()
  store.message(handle, text('system', 'be brief'))
  store.message(handle, text('user', 'u'.repeat(600)))
  store.message(handle, text('assistant', 'a'.repeat(600)))
  const measurement = measure(store, handle)
  const budget = resolveBudget({ configWindow: 10_000 })
  const engine = new CompactionEngine(store)
  const plan = engine.plan(handle, budget, measurement, { retainTokens: 0 })
  const outcome = await engine.compact(handle, plan, {
    budget,
    measurement,
    summarize: async () => '  the briefing \n',
    measure: () => measure(store, handle),
  })
  scenarios.landed = record(store, handle, { measurement, plan, outcome })
}

// 3. A second compaction over a span whose seqs are out of order.
{
  const { store, handle } = fresh()
  store.message(handle, text('system', 'be brief'))
  store.message(handle, text('user', 'u'.repeat(600)))
  store.message(handle, text('user', 'v'.repeat(600)))
  const budget = resolveBudget({ configWindow: 10_000 })
  const engine = new CompactionEngine(store)
  const summarize = async () => 'brief'
  const first = measure(store, handle)
  await engine.compact(handle, engine.plan(handle, budget, first, { retainTokens: 0 }), {
    budget, measurement: first, summarize, measure: () => measure(store, handle),
  })
  store.message(handle, text('user', 'after'))
  const second = measure(store, handle)
  const plan = engine.plan(handle, budget, second, { retainTokens: 0 })
  const outcome = await engine.compact(handle, plan, {
    budget, measurement: second, summarize, measure: () => measure(store, handle),
  })
  scenarios.repeated = record(store, handle, { plan, outcome })
}

// 4. Pruning that clears the pressure: no summary is asked for.
{
  const { store, handle } = fresh()
  store.message(handle, text('system', 'be brief'))
  store.message(handle, text('user', 'do the thing'))
  store.message(handle, { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'x'.repeat(30_000) }] })
  const measurement = measure(store, handle)
  const budget = resolveBudget({ configWindow: 3000 })
  let asked = 0
  const outcome = await new CompactionEngine(store, new ToolResultPruner()).compactIfNeeded(handle, {
    budget,
    measurement,
    summarize: async () => { asked += 1; return 'brief' },
    measure: () => measure(store, handle),
  })
  scenarios.pruneClears = record(store, handle, { outcome, asked })
}

rmSync(scratch, { recursive: true, force: true })
process.stdout.write(`${JSON.stringify({ generatedBy: 'src/context/ and src/session/store.ts under Node', scenarios }, null, 2)}\n`)
