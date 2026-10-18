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

test('a failed discovery is retried on the next image turn rather than cached as text only', async () => {
  resetModelInfoCache()
  const dir = mkdtempSync(join(tmpdir(), 'heddle-discovery-'))
  const path = join(dir, 'shot.png')
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const provider = await flakyProvider({ data: [{ id: 'm', input_modalities: ['text', 'image'] }] }, 1)
  const ctx = new Context()
  try {
    const service = new ModelService(ctx, [{ name: 'flaky', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'm' }])
    /** The first read fails, so the first turn falls back to the text placeholder. */
    await service.generate({ endpoint: 'flaky', messages: imageMessage(path) })
    assert.match(provider.completions[0] ?? '', /accepts text only/, 'the failed read degrades the first turn to text')
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
