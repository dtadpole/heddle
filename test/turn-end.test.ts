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
 * Every turn ends in the log, a failed or stopped one included (#16, #29).
 *
 * Measured before on both builds: a turn whose model call failed threw out of the loop before its
 * `assistant/completed` and `turn/completed`, so the log kept only the prompt, and a reload or a second tab saw a
 * message with no answer and no failure. On TS a stop that cut the stream did the same. DSH's loop appends `turn/end`
 * with its reason in a `finally`.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-turn-end-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function harness(baseUrl: string) {
  const ctx = new Context()
  const sessions = new SessionService(ctx, { root: join(scratch, `sessions-${++counter}`) })
  const session = sessions.start({ cwd: scratch })
  const sandbox = new SandboxService(ctx, { workspaceRoot: scratch, backend: 'none' })
  new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  new ModelService(ctx, [{ name: 'double', kind: 'openai-chat', baseUrl, model: 'm' } as never])
  const ends = () => {
    const events = sessions.store.read(session)
    return {
      completed: events.filter((event) => event.type === 'assistant/completed'),
      closed: events.filter((event) => event.type === 'turn/completed'),
      last: events.at(-1)?.type,
    }
  }
  return { ctx, session, ends }
}

test('a turn whose model call fails is ended in the log with its error, and the caller still gets the error', async () => {
  // Port 9 (discard) refuses connections on loopback, as the live report's dead endpoint did.
  const { ctx, session, ends } = harness('http://127.0.0.1:9/v1')
  await assert.rejects(runTurn(ctx, { session, endpoint: 'double', prompt: 'Say hi', maxRounds: 1 }), /could not be sent/)
  const { completed, closed, last } = ends()
  assert.equal(completed.length, 1, 'one completion record')
  assert.match(String((completed[0]?.ended as string[] | undefined)?.[0]), /^failed: .*could not be sent/)
  assert.equal(closed.length, 1, 'and the turn is closed')
  assert.equal(last, 'turn/completed', 'as the log’s last event')
})

test('a turn stopped mid-stream is ended in the log as stopped', async () => {
  const server = createServer((request, response: ServerResponse) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'counting ' }, finish_reason: null }] })}\n\n`)
      // The stream never finishes on its own; the stop ends it.
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { ctx, session, ends } = harness(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
  const controller = new AbortController()
  try {
    const turn = runTurn(ctx, { session, endpoint: 'double', prompt: 'count', maxRounds: 1, signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort('stopped by the caller')
    await turn.catch(() => undefined)
    const { completed, closed, last } = ends()
    assert.equal(completed.length, 1, 'one completion record')
    assert.deepEqual(completed[0]?.ended, ['stopped by the caller'])
    assert.equal(completed[0]?.text, 'counting ', 'with the text that streamed before the stop')
    assert.equal(closed.length, 1, 'and the turn is closed')
    assert.equal(last, 'turn/completed')
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
})

test('a turn that fails after a round keeps that round’s progress in its record', async () => {
  let requests = 0
  const server = createServer((request, response: ServerResponse) => {
    request.resume()
    request.on('end', () => {
      requests += 1
      if (requests > 1) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'the provider broke' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: unknown, finish: string | null) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      send({ role: 'assistant', content: 'looking ' }, null)
      send({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'nope', arguments: '{}' } }] }, null)
      send({}, 'tool_calls')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { ctx, session, ends } = harness(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
  try {
    await assert.rejects(runTurn(ctx, { session, endpoint: 'double', prompt: 'go', maxRounds: 3 }))
    const { completed, closed } = ends()
    assert.equal(completed.length, 1, 'one completion record')
    assert.equal(completed[0]?.text, 'looking ', 'with the answer of the round that finished')
    assert.equal(completed[0]?.rounds, 2)
    assert.equal(completed[0]?.denials, 1, 'and the unknown tool’s refusal')
    assert.match(String((completed[0]?.ended as string[] | undefined)?.[0]), /^failed: /)
    assert.equal(closed.length, 1)
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
})

test('a stream that breaks after some text keeps that text in the record', async () => {
  const server = createServer((request, response: ServerResponse) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'partial ' }, finish_reason: null }] })}\n\n`)
      // The connection breaks mid-answer.
      setTimeout(() => response.destroy(), 100)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { ctx, session, ends } = harness(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
  try {
    await assert.rejects(runTurn(ctx, { session, endpoint: 'double', prompt: 'go', maxRounds: 1 }), 'the broken stream fails the turn')
    const { completed, closed } = ends()
    assert.equal(completed.length, 1, 'one completion record')
    assert.equal(completed[0]?.text, 'partial ', 'with the text that streamed before the break')
    assert.equal(completed[0]?.finishReason, 'error')
    assert.match(String((completed[0]?.ended as string[] | undefined)?.[0]), /^failed: /, 'naming the failure')
    assert.equal(closed.length, 1)
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
})

test('a second round cut after some text records that text as the answer, as the last non-empty round', async () => {
  let requests = 0
  const server = createServer((request, response: ServerResponse) => {
    request.resume()
    request.on('end', () => {
      requests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: unknown, finish: string | null) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      if (requests === 1) {
        send({ role: 'assistant', content: 'looking ' }, null)
        send({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'nope', arguments: '{}' } }] }, null)
        send({}, 'tool_calls')
        response.end('data: [DONE]\n\n')
        return
      }
      send({ role: 'assistant', content: 'the answer is' }, null)
      setTimeout(() => response.destroy(), 100)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { ctx, session, ends } = harness(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
  try {
    await assert.rejects(runTurn(ctx, { session, endpoint: 'double', prompt: 'go', maxRounds: 3 }))
    const { completed } = ends()
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.text, 'the answer is', 'the cut round replaces the first round’s remark')
    assert.equal(completed[0]?.rounds, 2)
    assert.equal(completed[0]?.finishReason, 'error')
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
})
