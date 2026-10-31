import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../src/agent/loop.ts'
import { delegateSubagent } from '../src/agent/subagent.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { presetRoster, presetToolSpecs, resolvePreset, STANDARD_PRESET } from '../src/config/presets.ts'
import { ContextService } from '../src/context/service.ts'
import { ModelService } from '../src/llm/service.ts'
import PresetService from '../src/plugins/presets.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import type { SessionEvent } from '../src/session/store.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * Agent presets (inventory A96): DSH's preset registry and persona, as heddle's `presets` row.
 *
 * The claim the inventory judges is "a new session with a non-default preset gets its tool set". The tests drive real
 * turns through `runTurn` with a scripted model and read what each request offered from its `model/request` record.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-presets-'))
const previousHome = process.env.HEDDLE_HOME
process.env.HEDDLE_HOME = join(scratch, 'home')
after(() => {
  if (previousHome === undefined) delete process.env.HEDDLE_HOME
  else process.env.HEDDLE_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
})

const ROW = {
  default: 'standard',
  presets: [
    { id: 'standard', name: 'Standard' },
    { id: 'reader', name: 'Reader', tools: ['read_tool'], persona: 'You are a careful reviewer who never edits.' },
  ],
}

/** One wired harness: two tools, a scripted model, and the `presets` row (unless `presets` is false). */
function harness(label: string, steps: unknown[], presets: object | false = ROW) {
  const ctx = new Context()
  const work = join(scratch, `${label}-work`)
  mkdirSync(work, { recursive: true })
  const sessions = new SessionService(ctx, { root: join(scratch, `${label}-sessions`) })
  const sandbox = new SandboxService(ctx, { workspaceRoot: work, backend: 'none' })
  const approvals = new ApprovalService(ctx, { mode: 'allow' })
  const tools = new ToolRegistry(ctx, approvals, sandbox, sessions)
  const ran: string[] = []
  for (const name of ['read_tool', 'write_tool']) {
    tools.register({
      spec: { name, description: `stands for ${name}`, parameters: { type: 'object', properties: {} } },
      run: async () => {
        ran.push(name)
        return { output: `${name} ran` }
      },
    })
  }
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const script = join(scratch, `${label}-script.json`)
  writeFileSync(script, JSON.stringify({ steps }))
  new ModelService(ctx, [{ name: 'scripted', kind: 'scripted', baseUrl: script }])
  /** Through the row's schema, as the loader hands the row its config: a raw object would skip Schemastery's defaults. */
  if (presets !== false) new PresetService(ctx, PresetService.Config(presets))
  return { ctx, sessions, work, ran }
}

const offered = (events: readonly SessionEvent[]): string[][] =>
  events.filter((event) => event.type === 'model/request').map((event) => event.tools as string[])

const systemText = (events: readonly SessionEvent[]): string | undefined => {
  const node = events.find((event) => event.type === 'context/note' && (event.message as { role: string }).role === 'system')
  return (node?.message as { content: { text: string }[] } | undefined)?.content[0]?.text
}

test('the roster: an implicit standard preset, duplicates and an undeclared default refused, order kept', () => {
  assert.deepEqual(presetRoster(), { default: 'standard', presets: [STANDARD_PRESET] })
  assert.throws(() => presetRoster({ presets: [{ id: 'a' }, { id: 'a' }] }), /the preset 'a' is declared twice/)
  assert.throws(() => presetRoster({ default: 'gone', presets: [{ id: 'a' }] }), /the default preset 'gone' is not declared; declared: a/)
  assert.equal(presetRoster({ presets: [{ id: 'only' }] }).default, 'only', 'a single preset is the default')
  const ordered = presetRoster({ default: 'b', presets: [{ id: 'a', order: 2 }, { id: 'b', order: 1 }, { id: 'c', order: 2 }] })
  assert.deepEqual(ordered.presets.map((preset) => preset.id), ['b', 'a', 'c'])
  assert.deepEqual(resolvePreset(ordered, 'zzz'), { missing: 'zzz', declared: ['b', 'a', 'c'] })
  assert.deepEqual(presetToolSpecs({ id: 'x', tools: ['b'] }, [{ name: 'a' }, { name: 'b' }]), [{ name: 'b' }])
})

test('a session under a non-default preset is offered only its tools and written from its persona', async () => {
  const { ctx, sessions, work } = harness('reader', [{ text: 'read only' }])
  const session = sessions.start({ cwd: work, preset: 'reader' })
  await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'look around' })
  const events = sessions.store.read(session)
  assert.deepEqual(offered(events), [['read_tool']], 'the request offered the preset’s tools only')
  assert.equal(systemText(events), 'You are a careful reviewer who never edits.', 'the system prompt is the preset’s persona')
})

test('a default session is offered every tool, and records the default so a later default does not move it', async () => {
  const first = harness('default', [{ text: 'all' }])
  const session = first.sessions.start({ cwd: first.work })
  await runTurn(first.ctx, { session, endpoint: 'scripted', prompt: 'hello' })
  assert.deepEqual(offered(first.sessions.store.read(session)), [['read_tool', 'write_tool']])
  assert.equal(first.sessions.list().find((meta) => meta.id === session.id)?.preset, 'standard', 'the default was recorded')

  /** The same store under a profile whose default is now `reader`: the recorded session keeps `standard`. */
  const second = harness('default', [{ text: 'still all' }], { ...ROW, default: 'reader' })
  await runTurn(second.ctx, { session, endpoint: 'scripted', prompt: 'again' })
  const requests = offered(second.sessions.store.read(session))
  assert.deepEqual(requests.at(-1), ['read_tool', 'write_tool'], 'an older session keeps the preset it recorded')
})

test('a tool an agent/pre-step listener adds outside the preset is still not offered', async () => {
  const { ctx, sessions, work } = harness('hooked', [{ text: 'read only' }])
  const writeSpec = ctx.tools.describe().find((spec) => spec.name === 'write_tool')
  assert.ok(writeSpec !== undefined)
  ctx.on('agent/pre-step', (_step, next) => {
    const answered = next()
    return { ...answered, tools: [...answered.tools, writeSpec] }
  })
  const session = sessions.start({ cwd: work, preset: 'reader' })
  await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'look around' })
  assert.deepEqual(offered(sessions.store.read(session)), [['read_tool']], 'the preset is applied after the hook')
})

test('a call to a tool outside the preset gets the unknown-tool answer and does not run', async () => {
  const { ctx, sessions, work, ran } = harness('outside', [{ toolCall: { name: 'write_tool', arguments: {} } }, { text: 'done' }])
  const session = sessions.start({ cwd: work, preset: 'reader' })
  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'write something', maxRounds: 3 })
  assert.deepEqual(ran, [], 'the tool never ran')
  assert.equal(result.toolCalls[0]?.result.error?.code, 'UNKNOWN_TOOL')
  assert.match(result.toolCalls[0]?.result.error?.message ?? '', /no tool named 'write_tool'; known: read_tool/)
})

test('a recorded preset that is no longer declared refuses the turn before anything is written', async () => {
  const { ctx, sessions, work } = harness('missing', [{ text: 'never' }])
  const session = sessions.start({ cwd: work, preset: 'retired' })
  const before = sessions.store.count(session)
  await assert.rejects(
    runTurn(ctx, { session, endpoint: 'scripted', prompt: 'hello' }),
    /the session's preset 'retired' is not declared in this profile; declared: standard, reader/,
  )
  assert.equal(sessions.store.count(session), before, 'the refused turn wrote nothing')
})

test('a profile without the presets row runs every session as before', async () => {
  const { ctx, sessions, work } = harness('none', [{ text: 'plain' }], false)
  const session = sessions.start({ cwd: work })
  await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'hello' })
  assert.deepEqual(offered(sessions.store.read(session)), [['read_tool', 'write_tool']])
  assert.equal(sessions.list().find((meta) => meta.id === session.id)?.preset, undefined, 'and records no preset')
})

test('a delegated child runs under its parent’s preset', async () => {
  const { sessions, work } = harness('child', [])
  const parent = sessions.start({ cwd: work, preset: 'reader' })
  const result = await delegateSubagent(
    {
      store: sessions.store,
      run: async (child) => {
        sessions.store.assistantChunk(child, { type: 'text-delta', text: 'child answer' })
        sessions.store.assistantChunk(child, { type: 'done', finishReason: 'stop' })
      },
    },
    parent,
    'look at it',
    { maxDepth: 2, maxActive: 2 },
  )
  assert.equal(sessions.list().find((meta) => meta.id === result.childSession)?.preset, 'reader')
})
