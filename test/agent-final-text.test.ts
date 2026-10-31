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
 * A turn's answer is its last non-empty round, DSH's rule for what a run hands back (`dsh-subagent`
 * finalAssistantOutput). Live-testing issue #9: the loop added every round's text, so "I'll read both files." and the
 * answer arrived fused in the API's answer, the CLI's printed answer and a child's closing message. Real turns through
 * `runTurn` with a scripted model; the log still keeps each round's own message.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-final-text-'))
const previousHome = process.env.HEDDLE_HOME
process.env.HEDDLE_HOME = join(scratch, 'home')
after(() => {
  if (previousHome === undefined) delete process.env.HEDDLE_HOME
  else process.env.HEDDLE_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
})

async function turn(label: string, steps: unknown[]) {
  const ctx = new Context()
  const work = join(scratch, `${label}-work`)
  mkdirSync(work, { recursive: true })
  const sessions = new SessionService(ctx, { root: join(scratch, `${label}-sessions`) })
  const session = sessions.start({ cwd: work })
  const sandbox = new SandboxService(ctx, { workspaceRoot: work, backend: 'none' })
  const tools = new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  tools.register({
    spec: { name: 'note_tool', description: 'Returns a note', parameters: { type: 'object', properties: {} } },
    run: async () => ({ output: 'hello' }),
  })
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const script = join(scratch, `${label}-script.json`)
  writeFileSync(script, JSON.stringify({ steps }))
  new ModelService(ctx, [{ name: 'scripted', kind: 'scripted', baseUrl: script }])
  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'read the note', maxRounds: 4 })
  const events = sessions.store.read(session)
  return { result, events }
}

const call = { name: 'note_tool', arguments: {} }

test("the answer is the last round's text, and the log keeps the remark before the tool call as its own message", async () => {
  const { result, events } = await turn('fused', [{ text: "I'll read the note.", toolCall: call }, { text: 'It says hello.' }])
  assert.equal(result.text, 'It says hello.')
  const completed = events.filter((event) => event.type === 'assistant/completed')
  assert.deepEqual(completed.map((event) => (event as { text?: string }).text), ['It says hello.'])
  // Each round's text stays in the log as its own streamed chunks, which is what the page draws.
  const streamed = events
    .filter((event) => event.type === 'assistant/chunk' && (event as unknown as { chunk: { type: string } }).chunk.type === 'text-delta')
    .map((event) => (event as unknown as { chunk: { text: string } }).chunk.text)
  assert.deepEqual(streamed, ["I'll read the note.", 'It says hello.'], 'both rounds are still in the log')
})

test('a last round with no text leaves the last round that had some as the answer', async () => {
  const { result } = await turn('empty-last', [{ text: 'Reading it now.', toolCall: call }, { text: '' }])
  assert.equal(result.text, 'Reading it now.')
})

test('a one-round answer is unchanged', async () => {
  const { result } = await turn('one-round', [{ text: 'Just this.' }])
  assert.equal(result.text, 'Just this.')
})
