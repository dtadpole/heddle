import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
 * The `model/request` waterfall runs once per model call, and the record names what the call sent (issue #14).
 *
 * A listener on that waterfall may rewrite the request however it likes or have effects, so it is not assumed to be
 * idempotent: this one numbers each call it sees. The loop resolves the request once, records it, and streams that very
 * request without re-entering the waterfall; what reaches the adapter (`model/stream`) is what the record says.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-model-request-once-'))
const previousHome = process.env.HEDDLE_HOME
process.env.HEDDLE_HOME = join(scratch, 'home')
after(() => {
  if (previousHome === undefined) delete process.env.HEDDLE_HOME
  else process.env.HEDDLE_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
})

test('a non-idempotent model/request listener runs once per call, and the record is what was sent', async () => {
  const ctx = new Context()
  const work = join(scratch, 'work')
  mkdirSync(work, { recursive: true })
  const sessions = new SessionService(ctx, { root: join(scratch, 'sessions') })
  const sandbox = new SandboxService(ctx, { workspaceRoot: work, backend: 'none' })
  const tools = new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  tools.register({
    spec: { name: 'noop', description: 'does nothing', parameters: { type: 'object', properties: {} } },
    run: async () => ({ output: 'ok' }),
  })
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const script = join(scratch, 'script.json')
  writeFileSync(script, JSON.stringify({ steps: [{ toolCall: { name: 'noop', arguments: {} } }, { text: 'done' }] }))
  new ModelService(ctx, [{ name: 'scripted', kind: 'scripted', baseUrl: script }])

  let calls = 0
  ctx.on('model/request', (_request, next) => {
    calls += 1
    return { ...next(), model: `rewritten-${calls}` }
  })
  const sent: (string | undefined)[] = []
  ctx.on('model/stream', (request, next) => {
    sent.push(request.model)
    return next()
  })

  const session = sessions.start({ cwd: work })
  await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'call the tool, then answer', maxRounds: 3 })
  const recorded = sessions.store
    .read(session)
    .filter((event) => event.type === 'model/request')
    .map((event) => event.model)
  assert.equal(calls, 2, 'the waterfall ran once for each of the two model calls')
  assert.deepEqual(sent, ['rewritten-1', 'rewritten-2'], 'each call sent the request the waterfall answered once')
  assert.deepEqual(recorded, sent, 'and each record names what its call sent')
})
