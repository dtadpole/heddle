/**
 * The pure half of the model-endpoint validation: what is configured, which API type it speaks, and how a
 * recorded validation is judged. No network, no clock — so the runner, the verifier and the unit suite all
 * agree by importing this one file.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The three wire formats heddle speaks, named for the provider family a person recognises.
 *
 * A machine's endpoint list may name five backends (Meta's Claude and Codex gateways, plugboard's two routes,
 * DeepSeek's own API), but the interactions under test are three: Anthropic's publisher stream, OpenAI's
 * Responses stream, and OpenAI's Chat Completions stream. The validation is organised by **format**, because
 * that is what decides which request shape, which reasoning field and which tool-call event a check must
 * exercise.
 */
export const API_TYPES = Object.freeze({
  'anthropic-vertex': 'claude',
  'openai-responses': 'codex',
  'openai-chat': 'deepseek',
})

/**
 * The smallest output a Responses route accepts.
 *
 * Measured 2026-10-18: the Codex route answers `400 Invalid 'max_output_tokens': integer below minimum value.
 * Expected a value >= 16` for the tiny reasoning calls. The reasoning check must be cheap, not invalid, so the
 * floor lives here where the unit suite can pin it rather than inside one call site.
 */
export const MINIMUM_OUTPUT_TOKENS = 16

/** The family name of an endpoint kind, or `null` for an offline or unknown kind this validation skips. */
export function apiTypeFor(kind) {
  return API_TYPES[kind] ?? null
}

/** The models an endpoint offers, as ids, honouring the single-`model` shorthand. */
export function modelEntries(endpoint) {
  const listed = Array.isArray(endpoint.models) && endpoint.models.length > 0 ? endpoint.models : []
  const models = listed.length > 0 ? listed : endpoint.model !== undefined ? [{ id: endpoint.model }] : []
  return models
    .map((model) => (typeof model === 'string' ? { id: model } : model))
    .filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id.length > 0)
}

/** The reasoning ladder a model declares, endpoint-level block included, as plain `{ id, name, value }`. */
export function levelsFor(endpoint, model) {
  const block = model.reasoning ?? endpoint.reasoning
  const levels = Array.isArray(block?.levels) ? block.levels : []
  return levels
    .filter((level) => level !== null && typeof level === 'object' && typeof level.id === 'string' && level.id.length > 0)
    .map((level) => ({ id: level.id, name: typeof level.name === 'string' ? level.name : level.id, value: level.value ?? null }))
}

/**
 * Every endpoint and model this validation is responsible for, in configuration order.
 *
 * Offline fixtures (`scripted`) and unknown kinds are deliberately absent: a validation that spends a network
 * call to prove the deterministic fixture streams would be spending for nothing.
 */
export function validationTargets(config) {
  const excluded = new Set(Array.isArray(config?.exclude) ? config.exclude : [])
  const endpoints = Array.isArray(config?.endpoints) ? config.endpoints : []
  return endpoints
    .filter((endpoint) => endpoint !== null && typeof endpoint === 'object')
    .filter((endpoint) => typeof endpoint.name === 'string' && !excluded.has(endpoint.name) && apiTypeFor(endpoint.kind) !== null)
    .map((endpoint) => ({
      name: endpoint.name,
      kind: endpoint.kind,
      apiType: apiTypeFor(endpoint.kind),
      baseUrl: endpoint.baseUrl,
      models: modelEntries(endpoint).map((model) => ({ id: model.id, levels: levelsFor(endpoint, model) })),
    }))
}

/**
 * The configuration's identity, as far as this validation is concerned.
 *
 * It covers the endpoint name, kind and address and the model ids and reasoning values — **not** credentials,
 * so the fingerprint can be written beside results without leaking a key. A new endpoint, a new model, a new
 * declared level or a changed address all change the hash, which is what makes a stale record visibly stale
 * instead of silently passing for a configuration it never saw.
 */
export function fingerprint(config) {
  const shape = validationTargets(config).map((target) => ({
    name: target.name,
    kind: target.kind,
    baseUrl: target.baseUrl,
    models: target.models.map((model) => ({
      id: model.id,
      levels: model.levels.map((level) => ({ id: level.id, value: level.value })),
    })),
  }))
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex')
}

/** Where the machine's own configuration lives, following the same precedence the harness documents. */
export function machineConfigPath(environment = process.env) {
  return environment.HEDDLE_CONFIG !== undefined && environment.HEDDLE_CONFIG.length > 0
    ? environment.HEDDLE_CONFIG
    : join(environment.HEDDLE_HOME ?? join(homedir(), '.heddle'), 'heddle.json')
}

/** Read the machine-local configuration, or `null` when this machine has none. */
export function loadMachineConfig(environment = process.env) {
  const path = machineConfigPath(environment)
  if (!existsSync(path)) return null
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'))
    return config !== null && typeof config === 'object' ? config : null
  } catch {
    return null
  }
}

/** Where a completed validation is recorded, beside the configuration it validated. */
export function validationCachePath(environment = process.env) {
  const home = environment.HEDDLE_HOME ?? join(homedir(), '.heddle')
  return join(home, 'model-validation.json')
}

/** Read a recorded validation, or `null` when none was written yet. */
export function loadValidationCache(environment = process.env) {
  const path = validationCachePath(environment)
  if (!existsSync(path)) return null
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8'))
    return cache !== null && typeof cache === 'object' ? cache : null
  } catch {
    return null
  }
}

/** The cache's result key for one endpoint/model pair. */
export function resultKey(endpointName, modelId) {
  return `${endpointName}\u0000${modelId}`
}

/**
 * Judge a recorded validation against the configuration in front of it.
 *
 * A record passes when it exists, was made for this exact configuration (fingerprint), and every configured
 * endpoint/model carries a passing streaming, reasoning and tool-call result. Every failure is named with the
 * endpoint, the model and the interaction, because the reader's next act is to run the validator for that pair.
 */
export function judge(cache, config) {
  const targets = validationTargets(config)
  if (cache === null || cache === undefined) {
    return { ok: false, failures: ['no model validation has been recorded on this machine'], stale: true }
  }
  const expected = fingerprint(config)
  if (cache.configFingerprint !== expected) {
    return {
      ok: false,
      failures: ['the model configuration changed since the last validation (fingerprint mismatch)'],
      stale: true,
    }
  }
  const failures = []
  const results = cache.results ?? {}
  for (const target of targets) {
    for (const model of target.models) {
      const result = results[resultKey(target.name, model.id)]
      if (result === undefined) {
        failures.push(`${target.name}/${model.id}: no validation entry`)
        continue
      }
      if (result.apiType !== target.apiType) {
        failures.push(`${target.name}/${model.id}: validated as '${result.apiType}' but configured as '${target.apiType}'`)
      }
      if (result.streaming?.ok !== true) {
        failures.push(`${target.name}/${model.id}: streaming — ${result.streaming?.error ?? 'not passing'}`)
      }
      const recorded = Array.isArray(result.reasoning?.levels) ? result.reasoning.levels : []
      for (const level of model.levels) {
        const seen = recorded.find((entry) => entry.id === level.id)
        if (seen === undefined) failures.push(`${target.name}/${model.id}: reasoning level '${level.id}' has no validation entry`)
        else if (seen.ok !== true) failures.push(`${target.name}/${model.id}: reasoning level '${level.id}' — ${seen.error ?? 'not passing'}`)
      }
      if (target.apiType === 'claude' && !(Number(result.reasoning?.visible?.chars ?? 0) > 0)) {
        failures.push(`${target.name}/${model.id}: reasoning is not visible — ${result.reasoning?.visible?.error ?? 'the recorded run streamed no thinking text'}`)
      }
      if (result.tools?.ok !== true) {
        failures.push(`${target.name}/${model.id}: tool call — ${result.tools?.error ?? 'not passing'}`)
      }
    }
  }
  return { ok: failures.length === 0, failures, stale: false }
}
