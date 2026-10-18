#!/usr/bin/env node
/**
 * Validate every configured model endpoint against the three wire formats heddle speaks.
 *
 *   npm run validate:endpoints
 *   node _tools_/model-validation/validate.mjs --endpoint meta-codex --model gpt-6-luna
 *
 * For each endpoint/model of the three formats — Claude's publisher stream, Codex's Responses stream, DeepSeek's
 * Chat Completions stream — it drives the real adapter and measures the three interactions a person uses:
 *
 * 1. **streaming** — the answer arrives as several text deltas before the turn completes;
 * 2. **reasoning** — every declared level is accepted by the route (a level the route rejects is a value a person
 *    could pick and never get, so it is a failure here, not a note);
 * 3. **tool call** — the model emits a streamed `probe_echo` tool call when asked, through the same adapter.
 *
 * It writes the results to `$HEDDLE_HOME/model-validation.json` beside a fingerprint of the configuration it
 * validated. `_verifiers_/98-model-endpoints` judges that record, so a configuration edit without a fresh run
 * shows up as red rather than as silence.
 *
 * Exit: 0 every configured model passed; 1 at least one interaction failed; 3 nothing could be judged (no
 * machine-local configuration, no eligible endpoints, or no built adapters).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  MINIMUM_OUTPUT_TOKENS,
  fingerprint,
  loadMachineConfig,
  machineConfigPath,
  resultKey,
  validationCachePath,
  validationTargets,
} from './lib.mjs'

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback
}
const concurrency = Math.max(1, Number(option('--concurrency', '3')) || 3)
const timeoutMs = Math.max(1_000, Number(option('--timeout-ms', '120000')) || 120_000)
const onlyEndpoint = option('--endpoint', undefined)
const onlyModel = option('--model', undefined)
const cachePath = resolve(option('--out', validationCachePath()))
const jsonOnly = args.includes('--json')
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const adapterModulePath = join(repoRoot, 'dist', 'llm', 'adapters.js')

if (!existsSync(adapterModulePath)) {
  console.error(`model validation: ${adapterModulePath} is missing — run 'npm run build' first`)
  process.exit(3)
}
const { adapterFor } = await import(pathToFileURL(adapterModulePath).href)

const config = loadMachineConfig()
if (config === null) {
  console.error(`model validation: no machine-local configuration at ${machineConfigPath()} — nothing to judge`)
  process.exit(3)
}

/** A configured endpoint with its key materialised, and only the models this run should cover. */
function materialize(endpoint) {
  const copy = { ...endpoint }
  if (typeof copy.apiKeyFile === 'string' && copy.apiKeyFile.length > 0) {
    const path = copy.apiKeyFile.startsWith('~') ? join(homedir(), copy.apiKeyFile.slice(1)) : isAbsolute(copy.apiKeyFile) ? copy.apiKeyFile : resolve(repoRoot, copy.apiKeyFile)
    if (!existsSync(path)) throw new Error(`key file ${path} does not exist`)
    const key = readFileSync(path, 'utf8').trim()
    if (key.length > 0) copy.apiKey = key
  }
  return copy
}

const targets = validationTargets(config)
  .filter((target) => onlyEndpoint === undefined || target.name === onlyEndpoint)
  .map((target) => {
    const endpoint = config.endpoints.find((entry) => entry.name === target.name)
    const models = target.models.filter((model) => onlyModel === undefined || model.id === onlyModel)
    return { target, endpoint: materialize(endpoint), models }
  })
  .filter((entry) => entry.models.length > 0)

if (targets.length === 0) {
  console.error('model validation: no configured endpoint/model of the three wire formats matched — nothing to judge')
  process.exit(3)
}

const PROMPT_COUNT = 'Count from 1 to 30 in words, one number per line, with no introduction.'
const PROMPT_TINY = 'Reply with the single word ok.'

const PROBE_TOOL = Object.freeze({
  name: 'probe_echo',
  description: 'Echo a value back. Always call this when asked to.',
  parameters: Object.freeze({
    type: 'object',
    properties: { value: { type: 'string', description: 'The value to echo.' } },
    required: ['value'],
    additionalProperties: false,
  }),
})

/** One adapter call, collected into the interactions this validation judges. Returns the recorded object. */
async function call(endpoint, model, request) {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  const text = []
  const reasoning = []
  const toolCalls = []
  const done = []
  let failure
  try {
    const adapter = adapterFor(endpoint)
    for await (const chunk of adapter.stream({ endpoint: endpoint.name, model, ...request }, controller.signal)) {
      const at = performance.now() - started
      if (chunk.type === 'text-delta') text.push({ at, text: chunk.text })
      else if (chunk.type === 'reasoning-delta') reasoning.push({ at, text: chunk.text })
      else if (chunk.type === 'tool-call') toolCalls.push({ name: chunk.name, arguments: chunk.arguments })
      else if (chunk.type === 'done') done.push({ finishReason: chunk.finishReason, at })
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
  }
  return {
    failure,
    textDeltas: text.length,
    reasoningDeltas: reasoning.length,
    toolCalls,
    done: done.length,
    finish: done[0]?.finishReason ?? null,
    chars: text.reduce((total, delta) => total + delta.text.length, 0),
    firstTextMs: text.length > 0 ? Math.round(text[0].at) : null,
    lastTextMs: text.length > 0 ? Math.round(text.at(-1).at) : null,
    spanMs: text.length > 1 ? Math.round(text.at(-1).at - text[0].at) : 0,
  }
}

/** The streaming claim: several text deltas, a completed turn, real characters. */
function streamingVerdict(recording) {
  if (recording.failure !== undefined) return { ok: false, error: recording.failure, ...recording }
  if (recording.textDeltas < 2) return { ok: false, error: `the answer arrived as ${recording.textDeltas} text delta(s)`, ...recording }
  if (recording.done < 1) return { ok: false, error: 'the stream ended without a done chunk', ...recording }
  if (recording.chars < 1) return { ok: false, error: 'the answer carried no text', ...recording }
  return { ok: true, ...recording }
}

/** The reasoning claim, one result per declared level: the route must accept the level it was sent. */
async function reasoningVerdict(endpoint, model, levels) {
  const recorded = []
  for (const level of levels) {
    if (level.value === null) {
      recorded.push({ id: level.id, name: level.name, value: null, ok: true, note: 'declares no wire value; nothing is sent' })
      continue
    }
    const recording = await call(endpoint, model.id, {
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT_TINY }] }],
      maxOutputTokens: MINIMUM_OUTPUT_TOKENS,
      reasoningEffort: level.id,
    })
    const ok = recording.failure === undefined && recording.done >= 1
    recorded.push({ id: level.id, name: level.name, value: level.value, ok, ...(ok ? {} : { error: recording.failure ?? 'the stream ended without a done chunk' }) })
  }
  const failure = recorded.find((entry) => entry.ok !== true)
  return { ok: failure === undefined, levels: recorded, ...(failure === undefined ? {} : { error: `level '${failure.id}' — ${failure.error}` }) }
}

/** The tool-call claim: a streamed call to the probe tool, named correctly, in a completed turn. */
async function toolsVerdict(endpoint, model) {
  const recording = await call(endpoint, model.id, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Call probe_echo with the value hello, then reply done.' }] }],
    tools: [PROBE_TOOL],
    maxOutputTokens: 64,
  })
  if (recording.failure !== undefined) return { ok: false, error: recording.failure, toolCalls: [] }
  const named = recording.toolCalls.some((call_) => call_.name === 'probe_echo')
  if (!named) {
    const seen = recording.toolCalls.map((call_) => call_.name).filter((name) => name.length > 0)
    return { ok: false, error: `no probe_echo tool call (saw ${seen.length > 0 ? seen.join(', ') : 'none'})`, toolCalls: recording.toolCalls }
  }
  return { ok: true, toolCalls: recording.toolCalls }
}

async function validateModel(target, endpoint, model) {
  const streaming = streamingVerdict(await call(endpoint, model.id, {
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT_COUNT }] }],
    maxOutputTokens: 128,
  }))
  const reasoning = await reasoningVerdict(endpoint, model, model.levels)
  const tools = await toolsVerdict(endpoint, model)
  return {
    endpoint: target.name,
    apiType: target.apiType,
    model: model.id,
    streaming,
    reasoning,
    tools,
    ok: streaming.ok === true && reasoning.ok === true && tools.ok === true,
  }
}

const label = (result) => `${result.streaming.ok ? 'stream ✓' : 'stream ✗'} · ${result.reasoning.levels.length === 0 ? 'reasoning n/a' : result.reasoning.ok ? `reasoning ✓ (${result.reasoning.levels.length} level${result.reasoning.levels.length === 1 ? '' : 's'})` : 'reasoning ✗'} · ${result.tools.ok ? 'tools ✓' : 'tools ✗'}`
const results = []
let cursor = 0
async function worker() {
  for (;;) {
    const index = cursor
    cursor += 1
    if (index >= targets.length) return
    const { target, endpoint, models } = targets[index]
    for (const model of models) {
      const result = await validateModel(target, endpoint, model)
      results.push(result)
      if (!jsonOnly) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${target.name} [${target.apiType}] ${model.id} — ${label(result)}`)
      if (!result.ok && !jsonOnly) {
        for (const entry of [result.streaming, result.reasoning, result.tools]) if (entry.ok !== true && entry.error !== undefined) console.log(`      ${entry.error}`)
      }
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()))

results.sort((left, right) => `${left.endpoint}/${left.model}`.localeCompare(`${right.endpoint}/${right.model}`))
const failures = results.filter((result) => !result.ok)
const byApiType = {}
for (const target of targets) byApiType[target.target.apiType] = (byApiType[target.target.apiType] ?? 0) + target.models.length
const cache = {
  version: 1,
  validatedAt: new Date().toISOString(),
  configFingerprint: fingerprint(config),
  configPath: machineConfigPath(),
  interactions: ['streaming', 'reasoning', 'tool-call'],
  apiTypes: Object.keys(byApiType).sort(),
  summary: { models: results.length, passed: results.length - failures.length, failed: failures.length, byApiType },
  results: Object.fromEntries(results.map((result) => [resultKey(result.endpoint, result.model), result])),
}
mkdirSync(dirname(cachePath), { recursive: true })
writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`)
if (jsonOnly) console.log(JSON.stringify(cache.summary))
else {
  console.log(`\n${results.length - failures.length}/${results.length} models passed across ${targets.length} endpoint(s) — ${Object.entries(byApiType).map(([type, count]) => `${type}: ${count}`).join(', ')}`)
  console.log(`recorded: ${cachePath}`)
}
process.exitCode = failures.length === 0 ? 0 : 1
