import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ModelService } from '../src/llm/service.ts'
import { resetModelInfoCache } from '../src/llm/model-info.ts'

/**
 * Capability discovery is the difference between an image reaching the model and DSH's placeholder.
 *
 * The rules under test are the ones a provider outage makes load-bearing: a **failed** model-list read must not
 * become a permanent "text only" verdict for the process — the next image-bearing request asks again — while a
 * successful answer is cached once, so a conversation does not re-ask on every turn.
 */

/** A provider that answers /models (failing the first `failures` times) and records every completion body. */
async function flakyProvider(modelList: unknown, failures: number) {
  const completions: string[] = []
  let modelHits = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://x')
      if (url.pathname.endsWith('/models')) {
        modelHits += 1
        if (modelHits <= failures) {
          response.writeHead(503, { 'content-type': 'application/json' })
          response.end('{}')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(modelList))
        return
      }
      completions.push(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    completions,
    modelHits: () => modelHits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** One image part pointing at a real temporary file, which is what the projection materialises. */
function imageMessage(path: string) {
  return [{
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: 'look' },
      { type: 'image' as const, name: 'shot.png', mimeType: 'image/png' as const, path, bytes: 4, sha256: 'ab'.repeat(32) },
    ],
  }]
}

test('a failed discovery holds the image back truthfully, says so in a notice, and is retried on the next image turn (#178)', async () => {
  resetModelInfoCache()
  const dir = mkdtempSync(join(tmpdir(), 'heddle-discovery-'))
  const path = join(dir, 'shot.png')
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const provider = await flakyProvider({ data: [{ id: 'm', input_modalities: ['text', 'image'] }] }, 1)
  const ctx = new Context()
  try {
    const service = new ModelService(ctx, [{ name: 'flaky', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'm' }])
    /** The first read fails: the image is held back, and the model is told why rather than a false "text only". */
    const chunks: { type: string; text?: string }[] = []
    for await (const chunk of service.stream({ endpoint: 'flaky', messages: imageMessage(path) })) chunks.push(chunk)
    assert.match(provider.completions[0] ?? '', /\[image not sent: this model's image support could not be read from the provider; attachment sha256:abababab\]/)
    assert.doesNotMatch(provider.completions[0] ?? '', /accepts text only|"type":"image_url"/)
    assert.equal(chunks[0]?.type, 'notice', 'and the person is told, before the answer')
    assert.match(chunks[0]?.text ?? '', /image not sent/)
    /** The second turn asks again, gets the answer, and sends the image. */
    await service.generate({ endpoint: 'flaky', messages: imageMessage(path) })
    assert.match(provider.completions[1] ?? '', /"type":"image_url"/, 'the retried read delivers image content')
    /** The successful answer is cached: a third turn asks the provider no further questions. */
    const hits = provider.modelHits()
    await service.generate({ endpoint: 'flaky', messages: imageMessage(path) })
    assert.equal(provider.modelHits(), hits, 'a successful discovery is reused')
  } finally {
    await ctx.fiber.dispose()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a model that declares its own input is believed without a list read: one endpoint, an image model beside a text one (#178)', async () => {
  resetModelInfoCache()
  const dir = mkdtempSync(join(tmpdir(), 'heddle-discovery-'))
  const path = join(dir, 'shot.png')
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  /** A provider whose list never answers: before #178 every image on this endpoint became the text-only placeholder. */
  const provider = await flakyProvider({ data: [] }, Number.POSITIVE_INFINITY)
  const ctx = new Context()
  try {
    const service = new ModelService(ctx, [{
      name: 'mixed',
      kind: 'openai-chat',
      baseUrl: provider.baseUrl,
      model: 'vis',
      models: [{ id: 'vis', inputModalities: ['text', 'image'] }, { id: 'txt', inputModalities: ['text'] }],
    }])
    await service.generate({ endpoint: 'mixed', model: 'vis', messages: imageMessage(path) })
    assert.match(provider.completions[0] ?? '', /"type":"image_url"/, 'the image model gets the image')
    await service.generate({ endpoint: 'mixed', model: 'txt', messages: imageMessage(path) })
    assert.match(provider.completions[1] ?? '', /accepts text only/, 'the text model gets the placeholder, as declared')
    assert.equal(provider.modelHits(), 0, 'and neither asked the provider')
  } finally {
    await ctx.fiber.dispose()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a list that answers text only gets DSH\'s placeholder, and no notice (#178)', async () => {
  resetModelInfoCache()
  const dir = mkdtempSync(join(tmpdir(), 'heddle-discovery-'))
  const path = join(dir, 'shot.png')
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const provider = await flakyProvider({ data: [{ id: 'm', input_modalities: ['text'] }] }, 0)
  const ctx = new Context()
  try {
    const service = new ModelService(ctx, [{ name: 'plain', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'm' }])
    const chunks: { type: string }[] = []
    for await (const chunk of service.stream({ endpoint: 'plain', messages: imageMessage(path) })) chunks.push(chunk)
    assert.match(provider.completions[0] ?? '', /accepts text only/)
    assert.ok(!chunks.some((chunk) => chunk.type === 'notice'), 'a known text-only model is no surprise to report')
  } finally {
    await ctx.fiber.dispose()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
