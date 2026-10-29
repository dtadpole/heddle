import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { describeEndpoints } from '../src/endpoints.ts'
import { ModelService } from '../src/llm/service.ts'
import type { EndpointConfig } from '../src/llm/types.ts'

/**
 * The model and effort a new session starts with (DSH parity A104, DSH's `dsh-agent-default-model`): the model row's
 * defaultModel and defaultEffort, checked against the default endpoint when a session starts, never failing it.
 */

const levels = { default: 'low', levels: [{ id: 'low', name: 'Low', value: 'low' }, { id: 'high', name: 'High', value: 'high' }] }
const gateway: EndpointConfig = {
  name: 'gateway',
  kind: 'scripted',
  baseUrl: 'unused.json',
  model: 'flash',
  models: [{ id: 'flash', name: 'Flash', reasoning: levels }, { id: 'pro', name: 'Pro', reasoning: levels }, { id: 'plain', name: 'Plain' }],
} as EndpointConfig

function service(defaults: { model?: string; effort?: string }) {
  const ctx = new Context()
  const warnings: string[] = []
  ;(ctx as unknown as { logger: unknown }).logger = { warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')), info: () => {}, debug: () => {} }
  const models = new ModelService(ctx, [gateway])
  models.setDefaults(defaults)
  return { models, warnings }
}

test('a configured default model and effort are what a new session starts with', () => {
  const { models, warnings } = service({ model: 'pro', effort: 'high' })
  assert.deepEqual(models.defaultSelection(), { endpoint: 'gateway', model: 'pro', reasoningEffort: 'high' })
  assert.deepEqual(warnings, [])
  assert.deepEqual(service({}).models.defaultSelection(), { endpoint: 'gateway' }, 'nothing configured is the endpoint’s own')
})

test('a stale default falls back to the endpoint’s own model and level, warned once, never failing', () => {
  const stale = service({ model: 'retired', effort: 'high' })
  assert.deepEqual(stale.models.defaultSelection(), { endpoint: 'gateway', reasoningEffort: 'high' }, 'the model falls back; high is a level of flash too')
  stale.models.defaultSelection()
  assert.equal(stale.warnings.length, 1, `one warning for one stale value\n${stale.warnings.join('\n')}`)
  assert.match(stale.warnings[0]!, /no model named 'retired'/)

  const levelless = service({ model: 'plain', effort: 'high' })
  assert.deepEqual(levelless.models.defaultSelection(), { endpoint: 'gateway', model: 'plain' }, 'an effort the model does not declare is dropped')
  assert.match(levelless.warnings[0]!, /declares no reasoning effort levels/)
})

test('the page listing names the default selection beside the default endpoint', () => {
  const { models } = service({ model: 'pro', effort: 'high' })
  const view = describeEndpoints([gateway], 'gateway', models.defaultSelection())
  assert.equal(view.default, 'gateway')
  assert.equal(view.defaultModel, 'pro')
  assert.equal(view.defaultEffort, 'high')
  const absent = describeEndpoints([gateway], 'elsewhere', models.defaultSelection())
  assert.equal('defaultModel' in absent, false, 'no default endpoint in the list, no default selection')
})
