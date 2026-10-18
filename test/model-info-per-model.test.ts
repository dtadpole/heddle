import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { describeEndpoint } from '../src/endpoints.ts'
import { contextWindowFromModelList, inputModalitiesFromModelList, resetModelInfoCache } from '../src/llm/model-info.ts'
import type { EndpointConfig } from '../src/llm/types.ts'

/**
 * Where a **model** lives, as opposed to where its endpoint does.
 *
 * A gateway can put each deployment on its own host, with its own window and its own capabilities. Three readers
 * resolved those facts from the endpoint instead, and each read the wrong answer without failing:
 *
 * - the model-list read (input modalities, and the window when the configuration declares none) asked the
 *   endpoint's address about the endpoint's **default** model, so a question about any other model came back
 *   `undefined`, which a caller reads as "text only" — measured 2026-10-18 as an image on a second-host model
 *   being silently replaced by a text placeholder;
 * - the same read used `fetch`, which cannot go through a forwarding agent, so on a gateway that requires the hop
 *   it could only ever fail, and a failed read is indistinguishable from "the provider publishes no list";
 * - the catalogue the page reads dropped the model's own `contextWindow` and showed the endpoint's for every
 *   model, so a 1M deployment was measured against 272k.
 *
 * The two-server double below is the instrument: model `b` exists only on the second host.
 */

const listing = (slug: string, modalities: string[]): string => JSON.stringify({ models: [{ slug, input_modalities: modalities }] })

async function twoHosts(): Promise<{
  readonly a: string
  readonly b: string
  readonly asked: string[]
  close(): Promise<void>
}> {
  const asked: string[] = []
  const one = createServer((request, response) => {
    asked.push(`a:${request.url ?? ''}`)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(listing('a', ['text']))
  })
  const two = createServer((request, response) => {
    asked.push(`b:${request.url ?? ''}`)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(listing('b', ['text', 'image']))
  })
  await new Promise<void>((resolve) => one.listen(0, '127.0.0.1', () => resolve()))
  await new Promise<void>((resolve) => two.listen(0, '127.0.0.1', () => resolve()))
  const portOf = (server: typeof one): number => {
    const address = server.address()
    return typeof address === 'object' && address !== null ? address.port : 0
  }
  return {
    a: `http://127.0.0.1:${portOf(one)}/v1`,
    b: `http://127.0.0.1:${portOf(two)}/v1`,
    asked,
    close: async () => {
      await new Promise<void>((resolve) => one.close(() => resolve()))
      await new Promise<void>((resolve) => two.close(() => resolve()))
    },
  }
}

const multi = (a: string, b: string): EndpointConfig => ({
  name: 'multi',
  kind: 'openai-responses',
  baseUrl: a,
  model: 'a',
  models: [
    { id: 'a', baseUrl: a, contextWindow: 272_000 },
    { id: 'b', baseUrl: b, contextWindow: 1_000_000 },
  ],
})

test('a model is asked about at its own address, not at the endpoint default one', async () => {
  const hosts = await twoHosts()
  try {
    resetModelInfoCache()
    assert.deepEqual(
      await inputModalitiesFromModelList(multi(hosts.a, hosts.b), { askAbout: 'b' }),
      ['text', 'image'],
      'model b is described by the host that serves it',
    )
    assert.ok(
      hosts.asked.some((entry) => entry.startsWith('b:')),
      `the second host was the one asked (saw ${hosts.asked.join(', ')})`,
    )
  } finally {
    await hosts.close()
  }
})

test('asking about the endpoint default still goes to the endpoint address', async () => {
  const hosts = await twoHosts()
  try {
    resetModelInfoCache()
    assert.deepEqual(await inputModalitiesFromModelList(multi(hosts.a, hosts.b), { askAbout: 'a' }), ['text'])
    assert.deepEqual(hosts.asked, ['a:/v1/models'])
  } finally {
    await hosts.close()
  }
})

test('two models of one endpoint are not served each other\'s answer from a cache', async () => {
  const hosts = await twoHosts()
  try {
    resetModelInfoCache()
    const endpoint = multi(hosts.a, hosts.b)
    assert.deepEqual(await inputModalitiesFromModelList(endpoint, { askAbout: 'a' }), ['text'])
    assert.deepEqual(await inputModalitiesFromModelList(endpoint, { askAbout: 'b' }), ['text', 'image'], 'the second question is not answered by the first')
  } finally {
    await hosts.close()
  }
})

test('a model-list read is written to the provider, and a provider that refuses answers undefined', async () => {
  /**
   * The read now travels through the shared client so an endpoint behind a forwarding agent can be read at all.
   * What is asserted here is the part a double can see and a failure mode the caller depends on: a refusal is
   * `undefined` rather than a throw, because a provider outage must degrade an image to a placeholder rather than
   * fail the turn.
   */
  const refusing = createServer((request, response) => {
    request.resume()
    response.writeHead(403, { 'content-type': 'application/json' })
    response.end('{"error":"no"}')
  })
  await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', () => resolve()))
  const address = refusing.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    resetModelInfoCache()
    const endpoint: EndpointConfig = { name: 'refuser', kind: 'openai-chat', baseUrl: `http://127.0.0.1:${port}`, model: 'm' }
    assert.equal(await contextWindowFromModelList(endpoint), undefined)
    assert.equal(await inputModalitiesFromModelList(endpoint), undefined)
  } finally {
    await new Promise<void>((resolve) => refusing.close(() => resolve()))
  }
})

test('the catalogue carries each model\'s own window, not the endpoint\'s for all of them', () => {
  const described = describeEndpoint({
    name: 'multi',
    kind: 'openai-responses',
    baseUrl: 'http://127.0.0.1:1',
    model: 'a',
    contextWindow: 272_000,
    models: [{ id: 'a' }, { id: 'b', contextWindow: 1_000_000 }],
  })
  assert.deepEqual(
    (described.models as { id: string; contextWindow?: number }[]).map((model) => [model.id, model.contextWindow]),
    [
      ['a', 272_000],
      ['b', 1_000_000],
    ],
    'a model that declares no window of its own still inherits the endpoint\'s',
  )
})
