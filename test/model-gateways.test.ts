import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EndpointConfig } from '../src/llm/types.ts'
import { baseUrlFor, contextWindowFor, offeredModels } from '../src/llm/types.ts'

/**
 * One endpoint, several gateways.
 *
 * A provider's routing table can put each deployment behind **its own host** — measured 2026-10-18 against a
 * Meta-internal Codex gateway, where `azure-codex-gpt-6-1-sol` answered `gpt-6.1-sol-ptu`, returned `404` for
 * every other deployment name, and the un-suffixed `azure-codex` front door answered `421` because it routes by
 * `Host`. Declaring such a provider as five endpoints is a routing detail leaking into the list a person picks
 * from, so a model may carry its own `baseUrl`.
 *
 * The window travels with the model for the same reason: that routing table serves a 272k deployment beside a
 * 1M one, and one number on the endpoint would price every model against the wrong size.
 */

const multiHost: EndpointConfig = {
  name: 'meta-codex',
  kind: 'openai-responses',
  baseUrl: 'http://azure-codex-gpt-6-1-sol.ai-gateway.example/openai/v1',
  model: 'gpt-6.1-sol-ptu',
  contextWindow: 272_000,
  models: [
    { id: 'gpt-6.1-sol-ptu', name: 'Meta GPT-6.1 Sol' },
    {
      id: 'gpt-5.6-sol-ptu',
      name: 'Meta GPT-5.6 Sol',
      baseUrl: 'http://azure-codex-gpt-5-6-sol-ptu.ai-gateway.example/openai/v1',
      contextWindow: 1_000_000,
    },
  ],
}

test('a model without its own gateway is served from the endpoint', () => {
  assert.equal(baseUrlFor(multiHost, 'gpt-6.1-sol-ptu'), multiHost.baseUrl)
  assert.equal(baseUrlFor(multiHost), multiHost.baseUrl)
})

test('a model that declares a gateway is served from it, not from the endpoint', () => {
  assert.equal(baseUrlFor(multiHost, 'gpt-5.6-sol-ptu'), 'http://azure-codex-gpt-5-6-sol-ptu.ai-gateway.example/openai/v1')
})

test('a model the endpoint does not offer falls back to the endpoint rather than throwing', () => {
  // The selection is validated where a name enters — see `selectionProblem` — so this is the defensive path,
  // and it has to stay usable rather than turning an unknown id into an exception deep inside an adapter.
  assert.equal(baseUrlFor(multiHost, 'not-offered'), multiHost.baseUrl)
})

test("a model's window wins over the endpoint's, and the endpoint's is the fallback", () => {
  assert.equal(contextWindowFor(multiHost, 'gpt-6.1-sol-ptu'), 272_000)
  assert.equal(contextWindowFor(multiHost, 'gpt-5.6-sol-ptu'), 1_000_000)
  // No model named means the model a call would use — the endpoint's default.
  assert.equal(contextWindowFor(multiHost), 272_000)
  assert.equal(contextWindowFor({ ...multiHost, contextWindow: undefined }, 'gpt-6.1-sol-ptu'), undefined)
})

test('the offered list keeps every model of a multi-gateway endpoint, in declaration order', () => {
  assert.deepEqual(offeredModels(multiHost).map((model) => model.id), ['gpt-6.1-sol-ptu', 'gpt-5.6-sol-ptu'])
})
