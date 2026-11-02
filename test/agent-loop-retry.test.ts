import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../src/agent/loop.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { ContextService } from '../src/context/service.ts'
import { ModelService } from '../src/llm/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * Provider retry in the agent loop, as DSH's dsh-llm-retry executes an endpoint's retryPolicy: a transient failure
 * before any answer is retried over the same history, durably (`llm/retry` before the wait, `llm/retry-started` after),
 * within the policy's budget, honouring the provider's Retry-After; a permanent failure, a spent budget and a failure
 * after a partial answer end the turn as before; only the answer that succeeded reaches the derived messages.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-loop-retry-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

type Reply =
  | { readonly status: number; readonly headers?: Record<string, string>; readonly body?: string }
  | { readonly text: string }
  | { readonly partial: string }

/** An OpenAI-compatible double answering each chat request with the next reply in the queue. */
async function provider(replies: readonly Reply[]) {
  const queue = [...replies]
  let requests = 0
  const server = createServer((request, response: ServerResponse) => {
    request.resume()
    request.on('end', () => {
      requests += 1
      const reply = queue.shift() ?? { status: 500, body: 'the queue is empty' }
      if ('status' in reply) {
        response.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) })
        response.end(reply.body ?? '{"error":{"message":"failed"}}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = (content: string, finish: string | null) =>
        `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content }, finish_reason: finish }] })}\n\n`
      if ('partial' in reply) {
        response.write(delta(reply.partial, null))
        setTimeout(() => response.destroy(), 20)
        return
      }
      response.write(delta(reply.text, 'stop'))
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

let counter = 0
async function turn(replies: readonly Reply[], retryPolicy?: unknown) {
  const double = await provider(replies)
  const ctx = new Context()
  const sessions = new SessionService(ctx, { root: join(scratch, `sessions-${++counter}`) })
  const session = sessions.start({ cwd: scratch })
  const sandbox = new SandboxService(ctx, { workspaceRoot: scratch, backend: 'none' })
  new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  new ModelService(ctx, [
    { name: 'flaky', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'm', ...(retryPolicy !== undefined ? { retryPolicy } : {}) } as never,
  ])
  const outcome = await runTurn(ctx, { session, endpoint: 'flaky', prompt: 'hello', maxRounds: 2 }).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error: error as Error & { code?: string } }),
  )
  const events = sessions.store.read(session)
  const answers = sessions.store
    .deriveMessages(session)
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''))
  await double.close()
  return { ...outcome, events, answers, requests: double.requests() }
}

const fast = { mode: 'normal', backoff: { initialDelayMs: 10, maxDelayMs: 50, jitterRatio: 0 } }

test('a rate limit and a server error are retried durably and the turn answers', async () => {
  const run = await turn(
    [{ status: 429, headers: { 'retry-after': '0.02' } }, { status: 503 }, { text: 'answered on the third try' }],
    fast,
  )
  assert.equal(run.error, undefined, run.error?.message)
  assert.equal(run.result?.text, 'answered on the third try')
  assert.equal(run.requests, 3)
  const retries = run.events.filter((event) => event.type === 'llm/retry')
  assert.deepEqual(
    retries.map((event) => [event.retry, (event.failure as { code: string }).code, event.delayMs]),
    [
      [1, 'RATE_LIMIT', 20],
      [2, 'SERVER', 20],
    ],
    'the provider’s Retry-After is waited first, then the local backoff (10 × 2)',
  )
  assert.equal(retries[0]?.retryId, retries[1]?.retryId, 'one retry id for the step')
  assert.equal(retries[0]?.provider, 'flaky')
  assert.equal(retries[0]?.maxRetries, 5)
  const started = run.events.filter((event) => event.type === 'llm/retry-started').map((event) => event.retry)
  assert.deepEqual(started, [1, 2], 'each retry is announced after its wait')
  const order = run.events.map((event) => event.type).filter((type) => type.startsWith('llm/retry'))
  assert.deepEqual(order, ['llm/retry', 'llm/retry-started', 'llm/retry', 'llm/retry-started'])
  assert.deepEqual(run.answers, ['answered on the third try'], 'only the answer that succeeded reaches the model')
})

test('a spent budget ends the turn with the last failure', async () => {
  const run = await turn([{ status: 503 }, { status: 503 }, { text: 'too late' }], { ...fast, maxRetries: 1 })
  assert.ok(run.error, 'the turn fails')
  assert.equal(run.error?.code, 'HTTP')
  assert.equal(run.requests, 2, 'the first request and one retry')
  assert.equal(run.events.filter((event) => event.type === 'llm/retry').length, 1)
})

test('a permanent failure is not retried', async () => {
  const run = await turn([{ status: 401 }, { text: 'never asked' }], fast)
  assert.ok(run.error)
  assert.equal(run.requests, 1)
  assert.equal(run.events.filter((event) => event.type === 'llm/retry').length, 0)
})

test('a Retry-After past the cap ends a normal policy', async () => {
  const run = await turn([{ status: 429, headers: { 'retry-after': '120' } }, { text: 'never asked' }], fast)
  assert.ok(run.error)
  assert.equal(run.requests, 1)
})

test('a failure after part of the answer arrived is not retried', async () => {
  const run = await turn([{ partial: 'half an ans' }, { text: 'never asked' }], fast)
  assert.ok(run.error, 'the turn fails as before')
  assert.equal(run.requests, 1, 'no retry after output reached the session')
  assert.equal(run.events.filter((event) => event.type === 'llm/retry').length, 0)
})

test('an endpoint without a policy retries with DSH defaults', async () => {
  const run = await turn([{ status: 500 }, { text: 'answered after the default wait' }])
  assert.equal(run.result?.text, 'answered after the default wait')
  const retry = run.events.find((event) => event.type === 'llm/retry')
  assert.equal(retry?.mode, 'normal')
  assert.equal(retry?.maxRetries, 5)
  assert.ok(typeof retry?.delayMs === 'number' && retry.delayMs >= 450 && retry.delayMs <= 550, `the first default delay is 500 ± 10%: ${retry?.delayMs}`)
})
