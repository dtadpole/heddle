import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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
 * A turn stopped during its automatic compaction ends there (#154).
 *
 * Live on TS: the summary ran on after the Stop and landed, then the turn called the model and answered in full; the
 * turn was only marked stopped at the end. DSH runs its pre-step compaction with the turn's signal and stops at the
 * loop's own check before the model request.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-turn-compaction-stop-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** A chat double that answers every call and counts them. */
async function chatDouble() {
  let calls = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      calls += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'answered' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('a Stop while the turn’s automatic summary runs ends the turn stopped, with no model request', async () => {
  const double = await chatDouble()
  try {
    const ctx = new Context()
    const sessions = new SessionService(ctx, { root: join(scratch, 'sessions') })
    const session = sessions.start({ cwd: scratch })
    const sandbox = new SandboxService(ctx, { workspaceRoot: scratch, backend: 'none' })
    new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
    let summaryAsked: (() => void) | undefined
    const asked = new Promise<void>((resolve) => {
      summaryAsked = resolve
    })
    let summarySignal: AbortSignal | undefined
    new ContextService(ctx, sessions.store, { instructions: false, contextWindow: 3000 }, {
      complete: (request) =>
        new Promise<string>((_resolve, reject) => {
          summarySignal = request.signal
          summaryAsked?.()
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    })
    new ModelService(ctx, [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'm', stream: true } as never])

    // History over the trigger, so the next turn compacts before its request.
    sessions.store.message(session, { role: 'user', content: [{ type: 'text', text: 'u'.repeat(6000) }] })
    sessions.store.message(session, { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(6000) }] })

    const controller = new AbortController()
    const turn = runTurn(ctx, { session, endpoint: 'double', prompt: 'the next question', maxRounds: 2, signal: controller.signal }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    await asked
    assert.ok(summarySignal !== undefined, 'the summary call carries a signal')
    controller.abort()
    const settled = await turn

    assert.equal(double.calls(), 0, 'no model request followed the stop')
    const events = sessions.store.read(session)
    const types = events.map((event) => event.type)
    assert.ok(!types.includes('model/request'), `no model/request was recorded\n${types.join(' ')}`)
    assert.ok(!types.includes('compaction/end'), `the compaction landed nothing\n${types.join(' ')}`)
    const failed = events.find((event) => event.type === 'compaction/failed') as { stopped?: unknown } | undefined
    assert.equal(failed?.stopped, true, 'the span is closed as stopped')
    const completed = events.filter((event) => event.type === 'assistant/completed') as { ended?: string[] }[]
    assert.equal(completed.length, 1, `the turn is ended once\n${types.join(' ')}`)
    assert.deepEqual(completed[0]?.ended, ['stopped by the caller'])
    assert.equal((completed[0] as { rounds?: number }).rounds, 0, 'and it made no round: no model call was sent')
    assert.ok('result' in settled || 'error' in settled)
  } finally {
    await double.close()
  }
})
