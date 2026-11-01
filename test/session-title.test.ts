import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../src/agent/loop.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { ContextService } from '../src/context/service.ts'
import type { GenerateRequest } from '../src/llm/types.ts'
import { ModelService } from '../src/llm/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService, titleFrom } from '../src/session/service.ts'
import {
  normalizeSessionTitle,
  SESSION_TITLE_LIMITS,
  SESSION_TITLE_PURPOSE,
  sessionTitleInput,
  sessionTitleSystemPrompt,
  titleFromAnswer,
  titleFromOutput,
  type TitleAnswer,
} from '../src/session/title.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A session's automatic title, judged against DSH's (`dsh-session-title` with `dsh-session-title-first-prompt-llm`,
 * R-developer-eight-12): the first prompt's fallback name is replaced by a title the session's own endpoint generates,
 * a rename pins the name, and a failed call leaves the fallback.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-session-title-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const PROMPT = 'Please summarise the quarterly revenue figures for the northern region and compare them with last year, thanks.'

let counter = 0
/** A service over a fresh store, with a fake model whose answers the test decides. */
function fixture(answer: (request: GenerateRequest) => Promise<TitleAnswer> | TitleAnswer) {
  counter += 1
  const sessions = new SessionService(new Context(), { root: join(scratch, `sessions-${counter}`) })
  const requests: GenerateRequest[] = []
  sessions.store.titles.attach(async (request) => {
    requests.push(request)
    return answer(request)
  })
  const titleOf = (id: string) => sessions.list().find((meta) => meta.id === id)?.title
  /** What the loop writes before its model call: the request record whose route the title call takes. */
  const request = (handle: ReturnType<SessionService['start']>, endpoint = 'scripted', model?: string) =>
    sessions.store.modelRequest(handle, { endpoint, ...(model !== undefined ? { model } : {}), messages: 1, tools: [] })
  return { sessions, requests, titleOf, request }
}

const stop = (text: string): TitleAnswer => ({ text, finishReason: 'stop', toolCalls: [] })

test("the title is cleaned the way DSH cleans one: the first line, no wrapping emphasis, no controls, 80 bytes", () => {
  assert.equal(titleFromOutput('\n\n  Quarterly revenue review  \nbecause you asked'), 'Quarterly revenue review', 'the first non-empty line, trimmed')
  assert.equal(titleFromOutput('**Quarterly revenue**'), 'Quarterly revenue', 'emphasis wrapping the whole line goes')
  assert.equal(titleFromOutput('***x***'), 'x')
  assert.equal(titleFromOutput('**a*'), '**a*', 'a marker inside the inner text keeps the line as it is')
  assert.equal(titleFromOutput('a **bold** word'), 'a **bold** word', 'emphasis inside a longer line stays')
  assert.equal(normalizeSessionTitle('\u001b[31mRed\u001b[0m \u202etitle\u0007  here ', 80), 'Red title here', 'terminal and directional controls are removed, spaces collapsed')
  assert.equal(normalizeSessionTitle('\u001b]0;window title\u0007Shown', 80), 'Shown', 'an OSC sequence goes whole')
  assert.equal(normalizeSessionTitle('é'.repeat(50), 80), 'é'.repeat(40), 'the cut is in UTF-8 bytes and never splits a character')
  assert.equal(normalizeSessionTitle(`${'a'.repeat(79)} b`, 80), 'a'.repeat(79), 'and a space left at the cut is trimmed')

  assert.equal(titleFromAnswer(stop('  **Quarterly revenue comparison**\nmore words')), 'Quarterly revenue comparison')
  assert.throws(() => titleFromAnswer({ text: 'x', finishReason: 'length', toolCalls: [] }), /title output ended with length/, 'a cut-off answer is not a title')
  assert.throws(() => titleFromAnswer({ text: '', finishReason: 'tool_calls', toolCalls: [{}] }), /text only/, 'nor is a tool call')
  assert.throws(() => titleFromAnswer(stop('  \n\u200b ')), /produced no text/, 'nor is nothing visible')
})

test("the request is DSH's first-prompt request: its system prompt, the one message framed as JSON, its caps and purpose", async () => {
  const { sessions, requests, titleOf, request } = fixture(() => stop('Quarterly revenue comparison'))
  const handle = sessions.start({ cwd: scratch })
  sessions.user(handle, PROMPT)
  assert.equal(titleOf(handle.id), titleFrom(PROMPT), 'the first prompt names the session at once — the fallback')
  assert.equal(requests.length, 0, 'and no call starts before the turn asks its own model')

  request(handle, 'scripted', 'the-model')
  await sessions.store.titles.settle()
  assert.equal(requests.length, 1, 'the turn’s request starts exactly one title call')
  const asked = requests[0]!
  const firstSeq = sessions.events(handle).find((event) => event.type === 'message')!.seq
  assert.deepEqual(
    asked,
    {
      endpoint: 'scripted',
      model: 'the-model',
      messages: [
        { role: 'system', content: [{ type: 'text', text: sessionTitleSystemPrompt() }] },
        { role: 'user', content: [{ type: 'text', text: `Generate the session title from this JSON array of human messages:\n${JSON.stringify([{ seq: firstSeq, text: PROMPT }])}` }] },
      ],
      maxOutputTokens: 4096,
      purpose: SESSION_TITLE_PURPOSE,
      sessionId: handle.id,
    },
    'on the route the turn used, with the session’s id so the session’s own selection applies',
  )
  assert.match(sessionTitleSystemPrompt(), /^Create a concise title for an AI coding-assistant session from the supplied human messages\.\n/)
  assert.match(sessionTitleSystemPrompt(), /Aim for about 5 words in non-CJK languages or 10 CJK characters\./)
  assert.equal(titleOf(handle.id), 'Quarterly revenue comparison', 'and the generated title replaces the fallback')

  sessions.user(handle, 'a second prompt does not retitle')
  request(handle)
  await sessions.store.titles.settle()
  assert.equal(requests.length, 1, 'the first prompt is the only one that earns a call')
  assert.equal(titleOf(handle.id), 'Quarterly revenue comparison')
})

test('a rename while the title is being generated pins the name, even when it confirms the automatic one unchanged', async () => {
  let release: (answer: TitleAnswer) => void = () => {}
  const { sessions, titleOf, request } = fixture(() => new Promise<TitleAnswer>((resolve) => { release = resolve }))
  const handle = sessions.start({ cwd: scratch })
  sessions.user(handle, PROMPT)
  request(handle)
  const automatic = titleOf(handle.id)!
  sessions.rename(handle.id, automatic)
  release(stop('Quarterly revenue comparison'))
  await sessions.store.titles.settle()
  assert.equal(titleOf(handle.id), automatic, 'the confirmed name stands; the late answer lands nowhere')

  const other = sessions.start({ cwd: scratch })
  sessions.user(other, PROMPT)
  sessions.rename(other.id, 'named by a person')
  request(other)
  await sessions.store.titles.settle()
  assert.equal(titleOf(other.id), 'named by a person', 'a rename before the request means no call at all')
})

test('a session named before its first prompt, a forked child and a goal round get no generated title', async () => {
  const { sessions, requests, titleOf, request } = fixture(() => stop('Generated'))
  const named = sessions.start({ cwd: scratch, title: 'given at creation' })
  sessions.user(named, PROMPT)
  request(named)
  const goal = sessions.start({ cwd: scratch })
  sessions.user(goal, 'round 1 of the goal', { kind: 'goal', goalId: 'g', revision: 1, round: 1 })
  request(goal)
  const child = sessions.store.create({ cwd: scratch, parentSession: named.id })
  sessions.user(child, PROMPT)
  request(child)
  await sessions.store.titles.settle()
  assert.equal(requests.length, 0, 'nothing was asked')
  assert.equal(titleOf(named.id), 'given at creation')
  assert.equal(titleOf(child.id), titleFrom(PROMPT), 'the child keeps its plain first-message name')
})

test('a failed, cut-off, empty or oversized title leaves the fallback name', async () => {
  const answers: (() => TitleAnswer)[] = [
    () => { throw new Error('provider down') },
    () => ({ text: 'Half a tit', finishReason: 'length', toolCalls: [] }),
    () => stop('   '),
  ]
  for (const answer of answers) {
    const { sessions, requests, titleOf, request } = fixture(answer)
    const handle = sessions.start({ cwd: scratch })
    sessions.user(handle, PROMPT)
    request(handle)
    await sessions.store.titles.settle()
    assert.equal(requests.length, 1)
    assert.equal(titleOf(handle.id), titleFrom(PROMPT), 'the fallback stays')
  }
  const { sessions, requests, titleOf, request } = fixture(() => stop('never asked'))
  const handle = sessions.start({ cwd: scratch })
  const long = 'word '.repeat(900)
  sessions.user(handle, long)
  request(handle)
  await sessions.store.titles.settle()
  assert.ok(Buffer.byteLength(sessionTitleInput({ seq: 1, text: long })) > SESSION_TITLE_LIMITS.maxInputBytes)
  assert.equal(requests.length, 0, 'an input over maxInputBytes is not sent')
  assert.equal(titleOf(handle.id), titleFrom(long))
})

test('a store with no model attached keeps the plain first-message name, and a detach abandons a running call', async () => {
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions-plain') })
  const handle = sessions.start({ cwd: scratch })
  sessions.user(handle, PROMPT)
  sessions.store.modelRequest(handle, { endpoint: 'scripted', messages: 1, tools: [] })
  assert.equal(sessions.store.titles.attached, false)
  assert.equal(sessions.list()[0]?.title, titleFrom(PROMPT))

  let signalSeen: AbortSignal | undefined
  const detach = sessions.store.titles.attach((_request, signal) => {
    signalSeen = signal
    return new Promise<TitleAnswer>(() => {})
  })
  const next = sessions.start({ cwd: scratch })
  sessions.user(next, PROMPT)
  sessions.store.modelRequest(next, { endpoint: 'scripted', messages: 1, tools: [] })
  detach()
  assert.equal(signalSeen?.aborted, true, 'disposal aborts the call')
})

test("a scripted turn's first prompt is titled by the scripted endpoint's session-title step", async () => {
  const script = join(scratch, 'script.json')
  writeFileSync(script, JSON.stringify({ steps: [{ purpose: SESSION_TITLE_PURPOSE, text: 'Northern revenue comparison' }, { text: 'a scripted answer' }] }))
  const ctx = new Context()
  const sessions = new SessionService(ctx, { root: join(scratch, 'sessions-scripted') })
  const sandbox = new SandboxService(ctx, { workspaceRoot: scratch, backend: 'none' })
  new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const models = new ModelService(ctx, [{ name: 'scripted', kind: 'scripted', baseUrl: script, model: 'scripted' } as never])
  sessions.store.titles.attach((request, signal) => models.generate(request, signal))
  const handle = sessions.start({ cwd: scratch })
  const result = await runTurn(ctx, { session: handle, endpoint: 'scripted', prompt: PROMPT, maxRounds: 2 })
  await sessions.store.titles.settle()
  assert.equal(result.text, 'a scripted answer', 'the turn took the turn step, not the title step')
  const meta = JSON.parse(readFileSync(handle.meta, 'utf8')) as { title?: string }
  assert.equal(meta.title, 'Northern revenue comparison', 'and the session is titled by the title step, not by the cut prompt')
  assert.ok(!sessions.events(handle).some((event) => JSON.stringify(event).includes('Northern revenue comparison')), 'the title is meta, not a log event')
})
