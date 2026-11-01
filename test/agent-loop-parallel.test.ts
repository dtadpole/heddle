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
import { builtinTools } from '../src/tools/builtin.ts'
import { subagentTools } from '../src/tools/subagent.ts'
import { ToolRegistry, type ToolDefinition } from '../src/tools/service.ts'

/**
 * Parallel tool calls, as DSH's agent loop runs a step's calls: parallel-safe calls share a pool of
 * `maxParallelToolCalls`, any other call runs alone as a barrier, and the results commit in model order.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-loop-parallel-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

type Call = { readonly name: string; readonly args: Record<string, unknown> }

/** An OpenAI-compatible double: the first reply asks for every call in one assistant message, the second answers. */
async function provider(calls: readonly Call[]) {
  let requests = 0
  const server = createServer((request, response: ServerResponse) => {
    request.resume()
    request.on('end', () => {
      requests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: unknown, finish: string | null) =>
        response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      if (requests === 1) {
        calls.forEach((call, index) =>
          send({ role: 'assistant', tool_calls: [{ index, id: `call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, null),
        )
        send({}, 'tool_calls')
      } else send({ role: 'assistant', content: 'done' }, 'stop')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

/** A tool that sleeps `ms` and stamps when it ran; parallel-safe or not as asked. */
function sleepy(name: string, concurrencySafe: boolean, stamps: { tag: string; start: number; end: number }[]): ToolDefinition {
  return {
    ...(concurrencySafe ? { concurrencySafe: true } : {}),
    spec: { name, description: 'sleeps and stamps', parameters: { type: 'object', properties: { tag: { type: 'string' }, ms: { type: 'number' } } } },
    run: async (args) => {
      const start = Date.now()
      await new Promise((resolve) => setTimeout(resolve, Number(args.ms)))
      stamps.push({ tag: String(args.tag), start, end: Date.now() })
      return { output: `ran ${String(args.tag)}` }
    },
  }
}

let counter = 0
async function step(calls: readonly Call[], maxParallelToolCalls?: number) {
  const double = await provider(calls)
  const ctx = new Context()
  const sessions = new SessionService(ctx, { root: join(scratch, `sessions-${++counter}`) })
  const session = sessions.start({ cwd: scratch })
  const sandbox = new SandboxService(ctx, { workspaceRoot: scratch, backend: 'none' })
  const tools = new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  if (maxParallelToolCalls !== undefined) tools.maxParallelToolCalls = maxParallelToolCalls
  const stamps: { tag: string; start: number; end: number }[] = []
  tools.register(sleepy('sleepy_read', true, stamps))
  tools.register(sleepy('sleepy_write', false, stamps))
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  new ModelService(ctx, [{ name: 'double', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'm' } as never])
  try {
    const result = await runTurn(ctx, { session, endpoint: 'double', prompt: 'go', maxRounds: 3 })
    const toolMessages = sessions.store
      .deriveMessages(session)
      .filter((message) => message.role === 'tool')
      .map((message) => message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''))
    const at = (tag: string) => stamps.find((stamp) => stamp.tag === tag)!
    return { result, toolMessages, at }
  } finally {
    await double.close()
  }
}

test('two parallel-safe calls of one step run together, and their results commit in model order', async () => {
  const { result, toolMessages, at } = await step([
    { name: 'sleepy_read', args: { tag: 'slow', ms: 300 } },
    { name: 'sleepy_read', args: { tag: 'quick', ms: 40 } },
  ])
  assert.equal(result.text, 'done')
  assert.ok(at('quick').start < at('slow').end, 'the second started before the first ended')
  assert.ok(at('quick').end < at('slow').end, 'and finished first')
  assert.deepEqual(toolMessages, ['ran slow', 'ran quick'], 'yet each is answered in its place')
  assert.deepEqual(result.toolCalls.map((call) => JSON.parse(call.arguments).tag), ['slow', 'quick'])
})

test('maxParallelToolCalls 1 runs the same calls one after the other', async () => {
  const { at } = await step(
    [
      { name: 'sleepy_read', args: { tag: 'first', ms: 120 } },
      { name: 'sleepy_read', args: { tag: 'second', ms: 40 } },
    ],
    1,
  )
  assert.ok(at('second').start >= at('first').end, 'serial')
})

test('an exclusive call is a barrier between parallel groups', async () => {
  const { toolMessages, at } = await step([
    { name: 'sleepy_read', args: { tag: 'before', ms: 120 } },
    { name: 'sleepy_write', args: { tag: 'write', ms: 60 } },
    { name: 'sleepy_read', args: { tag: 'after', ms: 40 } },
  ])
  assert.ok(at('write').start >= at('before').end, 'the write waited for the read before it')
  assert.ok(at('after').start >= at('write').end, 'and the read after it waited for the write')
  assert.deepEqual(toolMessages, ['ran before', 'ran write', 'ran after'])
})

test('a tool without the flag is exclusive, and the read-only built-ins and delegate declare it', () => {
  const ctx = new Context()
  const sandbox = new SandboxService(ctx, { workspaceRoot: scratch, backend: 'none' })
  const sessions = new SessionService(ctx, { root: join(scratch, 'sessions-flags') })
  const tools = new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) tools.register(tool)
  assert.deepEqual(
    ['read_file', 'list_dir', 'write_file', 'bash', 'unknown'].map((name) => tools.isConcurrencySafe(name)),
    [true, true, false, false, false],
  )
  assert.equal(tools.maxParallelToolCalls, 10, "DSH's default")
  const delegate = subagentTools({} as never).find((tool) => tool.spec.name === 'delegate')
  assert.equal(delegate?.concurrencySafe, true, 'two delegates of one step start together')
})
