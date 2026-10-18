import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

import { contextWindowFromModelList, inputModalitiesFromModelList, inputModalitiesOfRow, resetModelInfoCache } from '../src/llm/model-info.ts'
import { withDiscoveredModalities } from '../src/llm/service.ts'

/**
 * A context window is a property of the model, and providers that list their models already say what it is.
 *
 * This resolver is what turns "the endpoint declares no window" from "the dock hides the context gauge" into
 * "the dock asks the provider". The rules under test are the honest ones: the provider's own field, matched to
 * the endpoint's model, and nothing when the answer is missing or the request fails — a guess would be worse
 * than a blank because the dock prints it as a percentage of the context used.
 */
async function modelListServer(body: unknown, status = 200) {
  const hits = { count: 0 }
  const server = createServer((request, response) => {
    hits.count += 1
    if (!request.url?.endsWith('/models')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return {
    hits,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('an openai-chat model list reports the window under data[].context_window', async () => {
  resetModelInfoCache()
  const server = await modelListServer({
    object: 'list',
    data: [
      { id: 'other-model', context_window: 1 },
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1048576 },
    ],
  })
  try {
    const window = await contextWindowFromModelList({ name: 'd', kind: 'openai-chat', baseUrl: server.baseUrl, model: 'deepseek-flash' })
    assert.equal(window, 1048576, 'the model\'s own reported window is returned')
  } finally {
    await server.close()
  }
})

test('an openai-responses model list reports the window under models[].context_window', async () => {
  resetModelInfoCache()
  const server = await modelListServer({
    models: [
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', context_window: 500000 },
    ],
  })
  try {
    const window = await contextWindowFromModelList({ name: 'x', kind: 'openai-responses', baseUrl: server.baseUrl, model: 'gpt-6.1-sol' })
    assert.equal(window, 500000)
  } finally {
    await server.close()
  }
})

test('a model the provider does not list, or a request that fails, yields no window', async () => {
  resetModelInfoCache()
  const listed = await modelListServer({ data: [{ id: 'something-else', context_window: 999 }] })
  try {
    assert.equal(
      await contextWindowFromModelList({ name: 'd', kind: 'openai-chat', baseUrl: listed.baseUrl, model: 'missing-model' }),
      undefined,
      'no matching model means no invented denominator',
    )
  } finally {
    await listed.close()
  }
  resetModelInfoCache()
  const broken = await modelListServer({ error: 'nope' }, 500)
  try {
    assert.equal(
      await contextWindowFromModelList({ name: 'd', kind: 'openai-chat', baseUrl: broken.baseUrl, model: 'deepseek-flash' }),
      undefined,
      'a failed request leaves the gauge blank rather than guessing',
    )
  } finally {
    await broken.close()
  }
})

test('the answer is cached per endpoint and model, so a page load does not re-ask every time', async () => {
  resetModelInfoCache()
  const server = await modelListServer({ data: [{ id: 'm', context_window: 4096 }] })
  try {
    const endpoint = { name: 'd', kind: 'openai-chat', baseUrl: server.baseUrl, model: 'm' }
    assert.equal(await contextWindowFromModelList(endpoint), 4096)
    assert.equal(await contextWindowFromModelList(endpoint), 4096)
    assert.equal(server.hits.count, 1, 'the model list was read once')
  } finally {
    await server.close()
  }
})

test('a kind with no model-list route is left to the configuration', async () => {
  resetModelInfoCache()
  const answer = await contextWindowFromModelList({ name: 'a', kind: 'anthropic-vertex', baseUrl: 'http://127.0.0.1:1', model: 'claude' })
  assert.equal(answer, undefined, 'no request is made for a wire that has no list route')
})

test('a chat model list reports its input modalities, and the read is cached', async () => {
  resetModelInfoCache()
  const server = await modelListServer({
    object: 'list',
    data: [{ id: 'vision', input_modalities: ['text', 'image'], context_window: 1000 }],
  })
  try {
    const endpoint = { name: 'probe-chat', kind: 'openai-chat' as const, baseUrl: server.baseUrl, model: 'vision' }
    assert.deepEqual(await inputModalitiesFromModelList(endpoint), ['text', 'image'])
    assert.deepEqual(await inputModalitiesFromModelList(endpoint), ['text', 'image'], 'the cached answer is reused')
    assert.equal(server.hits.count, 1, 'one model-list read for both answers')
  } finally {
    await server.close()
  }
})

test('a responses model list reports modalities under models[].slug', async () => {
  resetModelInfoCache()
  const server = await modelListServer({ models: [{ slug: 'text-only', input_modalities: ['text'] }] })
  try {
    const endpoint = { name: 'probe-responses', kind: 'openai-responses' as const, baseUrl: server.baseUrl, model: 'text-only' }
    assert.deepEqual(await inputModalitiesFromModelList(endpoint), ['text'])
  } finally {
    await server.close()
  }
})

test('the modality parser accepts the field spellings providers use, and refuses guesses', () => {
  assert.deepEqual(inputModalitiesOfRow({ input_modalities: ['text', 'image'] }), ['text', 'image'])
  assert.deepEqual(inputModalitiesOfRow({ inputModalities: ['image'] }), ['image'])
  assert.deepEqual(inputModalitiesOfRow({ architecture: { input_modalities: ['text', 'image'] } }), ['text', 'image'])
  assert.deepEqual(inputModalitiesOfRow({ modalities: ['text'] }), ['text'])
  assert.deepEqual(inputModalitiesOfRow({ modalities: { input: ['text', 'image'] } }), ['text', 'image'])
  assert.equal(inputModalitiesOfRow({ modalities: ['audio'] }), undefined, 'an unknown modality is not text or image')
  assert.equal(inputModalitiesOfRow({}), undefined, 'a row that says nothing yields nothing')
  assert.equal(inputModalitiesOfRow('not a row'), undefined)
})

test('a failing model list yields no modalities rather than failing the caller', async () => {
  resetModelInfoCache()
  const server = await modelListServer({ data: [] }, 500)
  try {
    const endpoint = { name: 'probe-failure', kind: 'openai-chat' as const, baseUrl: server.baseUrl, model: 'm' }
    assert.equal(await inputModalitiesFromModelList(endpoint), undefined)
  } finally {
    await server.close()
  }
})

test('a declared configuration wins over what the provider publishes', async () => {
  const declared = { name: 'declared', kind: 'openai-chat' as const, baseUrl: 'http://127.0.0.1:1', model: 'm', inputModalities: ['text'] as const }
  assert.equal(withDiscoveredModalities(declared, ['text', 'image']), declared, 'the declared endpoint is returned unchanged')
  const discovered = { name: 'undeclared', kind: 'openai-chat' as const, baseUrl: 'http://127.0.0.1:1', model: 'm' }
  assert.deepEqual(withDiscoveredModalities(discovered, ['text', 'image']).inputModalities, ['text', 'image'], 'discovery fills a blank declaration')
  assert.equal(withDiscoveredModalities(discovered, undefined), discovered, 'no answer leaves the endpoint as it was')
})
