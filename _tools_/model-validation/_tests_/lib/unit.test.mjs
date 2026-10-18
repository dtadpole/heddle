import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  API_TYPES,
  MINIMUM_OUTPUT_TOKENS,
  apiTypeFor,
  fingerprint,
  judge,
  levelsFor,
  loadMachineConfig,
  loadValidationCache,
  machineConfigPath,
  modelEntries,
  resultKey,
  validationCachePath,
  validationTargets,
} from '../../lib.mjs'

/**
 * The pure half of the model validation: the three formats, what the machine configured, the fingerprint that
 * makes a stale record visible, and the judgement the verifier applies. No network call is made here.
 */

const configured = {
  default: 'chat',
  exclude: ['fixture'],
  endpoints: [
    {
      name: 'chat',
      kind: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'chat-small',
      models: [
        { id: 'chat-small', reasoning: { default: 'high', levels: [{ id: 'low', name: 'Low', value: 'low' }, { id: 'high', name: 'High', value: 'high' }] } },
        { id: 'chat-large' },
      ],
    },
    { name: 'codex', kind: 'openai-responses', baseUrl: 'http://127.0.0.1:2/v1', model: 'gpt', models: [{ id: 'gpt', reasoning: { levels: [{ id: 'none', name: 'None', value: null }] } }] },
    { name: 'claude', kind: 'anthropic-vertex', baseUrl: 'http://127.0.0.1:3/v1', project: 'p', region: 'global', model: 'claude', models: [{ id: 'claude' }] },
    { name: 'fixture', kind: 'scripted', baseUrl: '~/.heddle/scripted.json' },
  ],
}

const passingResult = (endpoint, apiType, model, levels) => ({
  endpoint,
  apiType,
  model,
  streaming: { ok: true, textDeltas: 4, chars: 20, done: 1, spanMs: 50 },
  reasoning: {
    ok: true,
    levels: levels.map((level) => ({ id: level.id, value: level.value, ok: true, ...(level.value === null ? { note: 'no wire value' } : {}) })),
    visible: { deltas: 4, chars: 120, sample: ['thinking'] },
  },
  tools: { ok: true, toolCalls: [{ name: 'probe_echo', arguments: '{"value":"hello"}' }] },
})

function cacheFor(config) {
  const targets = validationTargets(config)
  const results = {}
  for (const target of targets) {
    for (const model of target.models) results[resultKey(target.name, model.id)] = passingResult(target.name, target.apiType, model.id, model.levels)
  }
  return { version: 1, configFingerprint: fingerprint(config), results }
}

test('the three wire formats are named for the provider families', () => {
  assert.deepEqual(API_TYPES, { 'anthropic-vertex': 'claude', 'openai-responses': 'codex', 'openai-chat': 'deepseek' })
  assert.equal(apiTypeFor('anthropic-vertex'), 'claude')
  assert.equal(apiTypeFor('openai-responses'), 'codex')
  assert.equal(apiTypeFor('openai-chat'), 'deepseek')
  assert.equal(apiTypeFor('scripted'), null, 'the offline fixture is not one of them')
  assert.equal(apiTypeFor('unknown'), null)
})

test('targets cover the three formats and skip excluded or offline endpoints, with every model', () => {
  const targets = validationTargets(configured)
  assert.deepEqual(targets.map((target) => target.name), ['chat', 'codex', 'claude'], 'excluded fixture and order preserved')
  assert.deepEqual(targets[0].models.map((model) => model.id), ['chat-small', 'chat-large'], 'every listed model, not only the default')
  assert.deepEqual(targets[1].models[0].levels.map((level) => level.value), [null], 'a level that sends nothing is kept')
})

test('the single-model shorthand is a model list of one', () => {
  assert.deepEqual(modelEntries({ model: 'only' }).map((model) => model.id), ['only'])
  assert.deepEqual(modelEntries({ models: [{ id: 'a' }, 'b'] }).map((model) => model.id), ['a', 'b'], 'strings and objects both count')
  assert.deepEqual(modelEntries({}), [])
})

test('a reasoning ladder comes from the model first and the endpoint second', () => {
  const endpoint = { reasoning: { levels: [{ id: 'endpoint-level', value: 'high' }] } }
  assert.deepEqual(levelsFor(endpoint, { reasoning: { levels: [{ id: 'model-level', name: 'Model', value: 'low' }] } }), [
    { id: 'model-level', name: 'Model', value: 'low' },
  ])
  assert.deepEqual(levelsFor(endpoint, {}), [{ id: 'endpoint-level', name: 'endpoint-level', value: 'high' }])
  assert.deepEqual(levelsFor({}, {}), [])
})

test('the fingerprint changes when a new endpoint, model, level or address is configured', () => {
  const base = fingerprint(configured)
  assert.equal(base, fingerprint(structuredClone(configured)), 'the same configuration fingerprints the same')
  const addedModel = structuredClone(configured)
  addedModel.endpoints[0].models.push({ id: 'chat-new' })
  assert.notEqual(fingerprint(addedModel), base, 'a new model type re-triggers validation')
  const addedLevel = structuredClone(configured)
  addedLevel.endpoints[1].models[0].reasoning.levels.push({ id: 'high', value: 'high' })
  assert.notEqual(fingerprint(addedLevel), base, 'a new level re-triggers validation')
  const movedAddress = structuredClone(configured)
  movedAddress.endpoints[2].baseUrl = 'http://127.0.0.1:4/v1'
  assert.notEqual(fingerprint(movedAddress), base, 'a changed address re-triggers validation')
  const credentialOnly = structuredClone(configured)
  credentialOnly.endpoints[0].apiKey = 'a-secret-that-is-not-in-the-fingerprint'
  assert.equal(fingerprint(credentialOnly), base, 'a credential is not part of the identity written beside results')
})

test('a fresh passing record judges true; a missing, stale or failing record does not', () => {
  const fresh = judge(cacheFor(configured), configured)
  assert.equal(fresh.ok, true, fresh.failures.join('; '))
  assert.deepEqual(fresh.failures, [])

  assert.equal(judge(null, configured).ok, false, 'no record is not a pass')
  assert.match(judge(null, configured).failures.join(' '), /no model validation/)

  const stale = cacheFor(configured)
  stale.configFingerprint = 'a-different-configuration'
  const staleVerdict = judge(stale, configured)
  assert.equal(staleVerdict.ok, false)
  assert.equal(staleVerdict.stale, true)

  const missing = cacheFor(configured)
  delete missing.results[resultKey('chat', 'chat-large')]
  assert.match(judge(missing, configured).failures.join(' '), /chat\/chat-large: no validation entry/)

  const failingStream = cacheFor(configured)
  failingStream.results[resultKey('codex', 'gpt')].streaming = { ok: false, error: 'the answer arrived as 1 text delta(s)' }
  assert.match(judge(failingStream, configured).failures.join(' '), /codex\/gpt: streaming — the answer arrived as 1 text delta/)

  const failingLevel = cacheFor(configured)
  failingLevel.results[resultKey('chat', 'chat-small')].reasoning.levels[0].ok = false
  assert.match(judge(failingLevel, configured).failures.join(' '), /reasoning level 'low'/)

  const failingTools = cacheFor(configured)
  failingTools.results[resultKey('claude', 'claude')].tools = { ok: false, error: 'no probe_echo tool call' }
  assert.match(judge(failingTools, configured).failures.join(' '), /claude\/claude: tool call — no probe_echo/)

  /**
   * The Claude family's reasoning must be **visible**: measured 2026-10-18, a route asked for adaptive thinking
   * without a summarized display streamed one empty thinking delta, so the page had nothing to show. A record for
   * a Claude endpoint that reports no thinking text is therefore a failure, while the other families may
   * legitimately not disclose theirs.
   */
  const invisibleClaude = cacheFor(configured)
  invisibleClaude.results[resultKey('claude', 'claude')].reasoning.visible = { deltas: 1, chars: 0 }
  assert.match(judge(invisibleClaude, configured).failures.join(' '), /claude\/claude: reasoning is not visible/)
  const invisibleDeepSeek = cacheFor(configured)
  invisibleDeepSeek.results[resultKey('chat', 'chat-small')].reasoning.visible = { deltas: 0, chars: 0 }
  assert.equal(judge(invisibleDeepSeek, configured).ok, true, 'a non-Claude family is not required to disclose its reasoning text')
})

test('the tiny reasoning call respects the smallest output a Responses route accepts', () => {
  /**
   * Measured 2026-10-18: a Codex route answers 400 for `max_output_tokens` below 16, and the first version of the
   * validator asked for 8 — every Codex reasoning check failed on the validator's own request, not the route's
   * behaviour. The floor is pinned here so a later "make it cheaper" edit cannot reintroduce it silently.
   */
  assert.ok(MINIMUM_OUTPUT_TOKENS >= 16, `the reasoning check asks for at least 16 output tokens (${MINIMUM_OUTPUT_TOKENS})`)
})

test('the machine paths follow HEDDLE_HOME and HEDDLE_CONFIG', () => {
  assert.equal(machineConfigPath({ HEDDLE_HOME: '/tmp/home' }), '/tmp/home/heddle.json')
  assert.equal(machineConfigPath({ HEDDLE_CONFIG: '/tmp/somewhere.json', HEDDLE_HOME: '/tmp/home' }), '/tmp/somewhere.json')
  assert.equal(validationCachePath({ HEDDLE_HOME: '/tmp/home' }), '/tmp/home/model-validation.json')
  assert.equal(loadMachineConfig({ HEDDLE_CONFIG: '/definitely/not/a/config.json' }), null)
  assert.equal(loadValidationCache({ HEDDLE_HOME: '/definitely/not/a/home' }), null)
})
