import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withDefaultEffort } from '../src/llm/service.ts'
import type { EndpointConfig, GenerateRequest } from '../src/llm/types.ts'

/**
 * #157: a request that names no reasoning effort runs at its model's declared default, as DSH's dsh-llm
 * `resolveCallWithInfo` resolves `requested ?? reasoning.defaultEffort`, and is marked as a default
 * (`adapterDefaults: { reasoningEffort: true }` in DSH). A model with levels but no default sends nothing.
 */

const levels = [{ id: 'low', name: 'Low', value: 'low' }, { id: 'high', name: 'High', value: 'high' }, { id: 'xhigh', name: 'XHigh', value: 'xhigh' }]
const endpoint = {
  name: 'claude',
  kind: 'anthropic-messages',
  baseUrl: 'http://127.0.0.1:9/v1',
  model: 'opus',
  models: [
    { id: 'opus', reasoning: { default: 'xhigh', levels } },
    { id: 'sonnet', reasoning: { levels } },
  ],
} as unknown as EndpointConfig
const ask = (extra: Partial<GenerateRequest> = {}): GenerateRequest => ({ endpoint: 'claude', messages: [], ...extra })

test('a request with no effort takes the model default and is marked as one', () => {
  assert.deepEqual(withDefaultEffort(endpoint, ask()), { ...ask(), reasoningEffort: 'xhigh', reasoningEffortDefault: true })
  assert.deepEqual(withDefaultEffort(endpoint, ask({ model: 'opus', reasoningEffort: '' })), { ...ask({ model: 'opus' }), reasoningEffort: 'xhigh', reasoningEffortDefault: true }, 'an empty level is none')
})

test('a named effort is the request\'s own, and a model without a default sends nothing', () => {
  assert.deepEqual(withDefaultEffort(endpoint, ask({ reasoningEffort: 'low' })), ask({ reasoningEffort: 'low' }), 'a person\'s or a policy\'s level wins')
  assert.deepEqual(withDefaultEffort(endpoint, ask({ model: 'sonnet' })), ask({ model: 'sonnet' }), 'no default: the provider\'s own, so nothing is invented')
  assert.deepEqual(withDefaultEffort(undefined, ask()), ask(), 'an unknown endpoint is left to the call to refuse')
  assert.deepEqual(withDefaultEffort(endpoint, ask({ model: '' })), { ...ask({ model: '' }), reasoningEffort: 'xhigh', reasoningEffortDefault: true }, 'an empty model is the endpoint\'s own, as in Rust')
})
