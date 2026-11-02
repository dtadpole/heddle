import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ContextService } from '../src/context/service.ts'
import type { ToolSpec } from '../src/llm/types.ts'
import { SessionStore } from '../src/session/store.ts'

/**
 * The summarising call offers the turn's tools (#209), so it is a prefix of the turn's own request and the provider's
 * cache is reused. DSH's `summarizeWithLlm` sends the header's tool schemas; the `model/request` waterfall then gives
 * the summary the same system sections it gives the turn.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-compaction-prefix-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let fixtures = 0

async function summaryCall(tools?: readonly ToolSpec[]) {
  fixtures += 1
  const store = new SessionStore(join(scratch, `sessions-${fixtures}`))
  const calls: { readonly tools?: readonly ToolSpec[] }[] = []
  const context = new ContextService(new Context(), store, { instructions: false, contextWindow: 900 }, {
    complete: async (request) => {
      calls.push({ ...request })
      return 'the briefing'
    },
  })
  const workspace = join(scratch, `workspace-${fixtures}`)
  const session = store.create({ cwd: workspace })
  store.message(session, { role: 'user', content: [{ type: 'text', text: 'u'.repeat(1500) }] })
  store.message(session, { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(1500) }] })
  store.message(session, { role: 'user', content: [{ type: 'text', text: 'q'.repeat(1500) }] })
  const report = await context.prepare(session, { cwd: workspace, endpoint: 'local', ...(tools !== undefined ? { tools } : {}) })
  assert.ok(report.compacted, 'the session compacted')
  assert.equal(calls.length, 1, 'with one summarising call')
  return calls[0] ?? {}
}

test("the summarising call offers the turn's tools, in their order (#209)", async () => {
  const tools: ToolSpec[] = [
    { name: 'read_file', description: 'Reads a file', parameters: { type: 'object' } },
    { name: 'bash', description: 'Runs a command', parameters: { type: 'object' } },
  ]
  assert.deepEqual((await summaryCall(tools)).tools, tools)
})

test('a compaction asked without tools offers none', async () => {
  assert.equal('tools' in (await summaryCall()), false)
})
