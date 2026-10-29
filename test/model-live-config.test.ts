import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import model from '../src/plugins/model.ts'
import { ModelService } from '../src/llm/service.ts'

/**
 * Configuration applies to the next request without a restart, as DSH's provider settings do, and a request already
 * streaming finishes on the configuration it started with. The machine's file (`HEDDLE_CONFIG`) is the configuration
 * here, edited while the service runs.
 */

/** An OpenAI-compatible double answering `text`, after `delayMs` when given. */
async function double(text: string, delayMs = 0) {
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if ((request.url ?? '').endsWith('/models')) {
        response.writeHead(404).end()
        return
      }
      requests += 1
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, delayMs)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

const ask = (service: ModelService, endpoint: string) =>
  service.generate({ endpoint, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }).then((answer) => answer.text)

/** Run `body` with `HEDDLE_CONFIG` naming a scratch machine file, restoring the environment afterwards. */
async function withMachineFile(body: (file: string, write: (value: unknown) => void) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-live-config-'))
  const file = join(dir, 'heddle.json')
  const saved = { config: process.env.HEDDLE_CONFIG, home: process.env.HEDDLE_HOME }
  process.env.HEDDLE_CONFIG = file
  process.env.HEDDLE_HOME = join(dir, 'home')
  let generation = 0
  // Each write pads the file differently so its size always changes: a stamp is path, modification time and size.
  const write = (value: unknown) => writeFileSync(file, JSON.stringify(value) + ' '.repeat(++generation))
  try {
    await body(file, write)
  } finally {
    if (saved.config === undefined) delete process.env.HEDDLE_CONFIG
    else process.env.HEDDLE_CONFIG = saved.config
    if (saved.home === undefined) delete process.env.HEDDLE_HOME
    else process.env.HEDDLE_HOME = saved.home
    rmSync(dir, { recursive: true, force: true })
  }
}

test('reconfigure swaps endpoints for the next call while a call already streaming keeps its own', async () => {
  const slow = await double('from the old route', 400)
  const fresh = await double('from the new route')
  const ctx = new Context()
  try {
    const service = new ModelService(ctx, [{ name: 'a', kind: 'openai-chat', baseUrl: slow.baseUrl, model: 'm' }])
    const inFlight = ask(service, 'a')
    await new Promise((resolve) => setTimeout(resolve, 100))
    service.reconfigure([{ name: 'a', kind: 'openai-chat', baseUrl: fresh.baseUrl, model: 'm' }], 'a')
    assert.equal(await inFlight, 'from the old route', 'the call that had started finishes where it started')
    assert.equal(await ask(service, 'a'), 'from the new route', 'the next call reads the new configuration')
    assert.equal(service.defaultEndpoint(), 'a')
  } finally {
    await ctx.fiber.dispose()
    await slow.close()
    await fresh.close()
  }
})

test('an edit to the machine file applies on the next read and call, without a restart', async () => {
  const one = await double('answered by one')
  const two = await double('answered by two')
  await withMachineFile(async (_file, write) => {
    const endpoint = (name: string, baseUrl: string) => ({ name, kind: 'openai-chat', baseUrl, model: 'm' })
    write({ default: 'one', exclude: ['scripted'], endpoints: [endpoint('one', one.baseUrl), endpoint('two', two.baseUrl)] })
    const ctx = new Context()
    try {
      model(ctx, {})
      const service = (ctx as unknown as { model: ModelService }).model
      assert.equal(service.defaultEndpoint(), 'one')
      assert.equal(await ask(service, service.defaultEndpoint() ?? ''), 'answered by one')

      write({
        default: 'two',
        exclude: ['scripted'],
        endpoints: [endpoint('one', one.baseUrl), endpoint('two', two.baseUrl), endpoint('three', one.baseUrl)],
      })
      assert.equal(service.defaultEndpoint(), 'two', 'the new default is the default now')
      assert.deepEqual([...service.names()].sort(), ['one', 'three', 'two'], 'the added endpoint is offered at once')
      assert.equal(await ask(service, service.defaultEndpoint() ?? ''), 'answered by two', 'and a new request goes to it')

      write('{ not json')
      assert.equal(service.defaultEndpoint(), 'two', 'an edit that cannot be read keeps the previous configuration')
      write({ default: 'one', exclude: ['scripted'], endpoints: [endpoint('one', one.baseUrl)] })
      assert.deepEqual([...service.names()], ['one'], 'and the next good edit applies')
    } finally {
      await ctx.fiber.dispose()
    }
  })
  await one.close()
  await two.close()
})

test('readLocalConfig false never reads the machine file, at start or later', async () => {
  const one = await double('answered by one')
  await withMachineFile(async (_file, write) => {
    write({ default: 'one', endpoints: [{ name: 'one', kind: 'openai-chat', baseUrl: one.baseUrl, model: 'm' }] })
    const ctx = new Context()
    try {
      model(ctx, { readLocalConfig: false })
      const service = (ctx as unknown as { model: ModelService }).model
      const before = [...service.names()]
      write({ default: 'one', endpoints: [{ name: 'other', kind: 'openai-chat', baseUrl: one.baseUrl, model: 'm' }] })
      assert.deepEqual([...service.names()], before)
      assert.ok(!service.names().includes('other'))
    } finally {
      await ctx.fiber.dispose()
    }
  })
  await one.close()
})
