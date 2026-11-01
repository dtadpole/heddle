import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ContextService } from '../src/context/service.ts'
import { SessionStore } from '../src/session/store.ts'

/**
 * The summarising call's output cap (#15).
 *
 * A fixed 1024 left the DeepSeek reasoning model no room to answer: its thinking spent the budget, the summary came
 * back empty, and compaction was refused on every turn past the trigger. The call now names no cap of its own unless
 * the profile does, so the endpoint's cap applies (its `maxOutputTokens`, else the provider's or the adapter's
 * default). DSH budgets 65536, which a route that caps its output lower would refuse.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-summary-cap-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let fixtures = 0

/** Compact one session over the trigger and answer with the one summarising call it made. */
async function summaryCall(config: { readonly summarizeMaxTokens?: number }) {
  fixtures += 1
  const store = new SessionStore(join(scratch, `sessions-${fixtures}`))
  const calls: { readonly maxOutputTokens?: number; readonly purpose?: string }[] = []
  const context = new ContextService(new Context(), store, { instructions: false, contextWindow: 900, ...config }, {
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
  const report = await context.prepare(session, { cwd: workspace, endpoint: 'local' })
  assert.ok(report.compacted, 'the session compacted')
  assert.equal(calls.length, 1, 'with one summarising call')
  return calls[0] ?? {}
}

test('the summarising call names no output cap of its own, so the endpoint’s applies', async () => {
  const call = await summaryCall({})
  assert.equal(call.purpose, 'compaction')
  assert.equal('maxOutputTokens' in call, false, 'no cap: a reasoning model keeps room to answer')
})

test('a configured summarizeMaxTokens still reaches the call', async () => {
  assert.equal((await summaryCall({ summarizeMaxTokens: 16000 })).maxOutputTokens, 16000)
})
