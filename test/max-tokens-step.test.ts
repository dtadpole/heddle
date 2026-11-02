import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { MAX_TOKENS_NOT_RUN, MAX_TOKENS_NOTICE, runTurn } from '../src/agent/loop.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { ContextService } from '../src/context/service.ts'
import { ModelService } from '../src/llm/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A step the provider cut at its output limit ends the turn and runs none of its calls (#208), as DSH's
 * `dsh-agent-loop` `step()` returns `max-tokens` before `executeToolCalls`. Real turns through `runTurn` with a scripted
 * model.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-max-tokens-'))
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
  let ran = 0
  tools.register({
    spec: { name: 'note_tool', description: 'Returns a note', parameters: { type: 'object', properties: {} } },
    run: async () => {
      ran += 1
      return { output: 'TOOLRAN-208' }
    },
  })
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const script = join(scratch, `${label}-script.json`)
  writeFileSync(script, JSON.stringify({ steps }))
  new ModelService(ctx, [{ name: 'scripted', kind: 'scripted', baseUrl: script }])
  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'write the file', maxRounds: 10 })
  return { result, events: sessions.store.read(session), ran: () => ran }
}

const call = { name: 'note_tool', arguments: {} }
const completedOf = (events: readonly { type: string }[]) => events.filter((event) => event.type === 'assistant/completed') as unknown as { finishReason: string; ended?: string[]; rounds: number }[]
const toolMessages = (events: readonly { type: string }[]) =>
  events
    .filter((event) => event.type === 'message' && (event as unknown as { message: { role: string } }).message.role === 'tool')
    .map((event) => (event as unknown as { message: { toolCallId: string; content: { text: string }[] } }).message)

test('a complete call in a step cut at the output limit is not run, and the turn ends there as max-tokens (#208)', async () => {
  const { result, events, ran } = await turn('complete', [
    { text: 'Writing it now.', toolCall: call, finishReason: 'max_output_tokens' },
    { text: 'a second round that must not happen' },
  ])
  assert.equal(ran(), 0, 'the call never runs')
  assert.equal(result.rounds, 1, 'and there is no second round')
  assert.equal(result.finishReason, 'max_output_tokens')
  const answers = toolMessages(events)
  assert.equal(answers.length, 1, 'the call is still answered in the log, so the request pairing holds')
  assert.equal(answers[0]?.toolCallId, 'call-note_tool')
  assert.match(answers[0]?.content[0]?.text ?? '', /^error \(MAX_TOKENS\): /)
  assert.ok((answers[0]?.content[0]?.text ?? '').includes(MAX_TOKENS_NOT_RUN))
  const [completed] = completedOf(events)
  assert.equal(completed?.finishReason, 'max_output_tokens', 'the record says max-tokens, so a goal disarms')
  assert.deepEqual(completed?.ended, [MAX_TOKENS_NOTICE], "DSH's notice, once")
  assert.ok(events.some((event) => event.type === 'turn/completed'))
})

test('a cut call with arguments the model never finished is not run either, and is not retried round after round (#208)', async () => {
  const { result, events, ran } = await turn('truncated', [
    { toolCall: { name: 'note_tool', arguments: '{"command":"echo TRUNC' }, finishReason: 'max_output_tokens' },
    { toolCall: { name: 'note_tool', arguments: '{"command":"echo TRUNC' }, finishReason: 'max_output_tokens' },
    { text: 'gave up' },
  ])
  assert.equal(ran(), 0)
  assert.equal(result.rounds, 1, 'one cut, one round: the model is not asked again')
  assert.equal(toolMessages(events).length, 1)
  assert.deepEqual(completedOf(events)[0]?.ended, [MAX_TOKENS_NOTICE])
})

test('a cut answer with no calls keeps its text and ends with the same notice (#208)', async () => {
  const { result, events } = await turn('text', [{ text: 'Here is part one of the answer, and the', finishReason: 'max_output_tokens' }])
  assert.equal(result.text, 'Here is part one of the answer, and the', 'the partial text is kept')
  assert.equal(result.finishReason, 'max_output_tokens')
  assert.deepEqual(completedOf(events)[0]?.ended, [MAX_TOKENS_NOTICE])
})

test('a healthy tool step still runs its call and the turn goes on', async () => {
  const { result, ran } = await turn('healthy', [{ text: 'Reading.', toolCall: call }, { text: 'It says TOOLRAN-208.' }])
  assert.equal(ran(), 1)
  assert.equal(result.rounds, 2)
  assert.equal(result.finishReason, 'stop')
})
