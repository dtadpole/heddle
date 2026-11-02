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
  type TitleLevels,
} from '../src/session/title.ts'
import SessionPlugin from '../src/plugins/session.ts'
import { sessionRequestSelection } from '../src/server/web.ts'
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
/** A service over a fresh store, with a fake model whose answers the test decides, and the routes' levels if given. */
function fixture(answer: (request: GenerateRequest) => Promise<TitleAnswer> | TitleAnswer, options: { readonly levels?: TitleLevels } = {}) {
  counter += 1
  const sessions = new SessionService(new Context(), { root: join(scratch, `sessions-${counter}`) })
  const requests: GenerateRequest[] = []
  sessions.store.titles.attach(
    async (request) => {
      requests.push(request)
      return answer(request)
    },
    options.levels !== undefined ? { levels: options.levels } : {},
  )
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
    },
    'on the route the turn used; no levels are known here, so no effort, and no session id for a session policy to rewrite (#215)',
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

/** A route's levels, least first, as the catalogue declares them (Claude Opus 5.5's ladder, default xhigh). */
const LEVELS = [
  { id: 'low', name: 'Low', value: 'low' },
  { id: 'medium', name: 'Medium', value: 'medium' },
  { id: 'high', name: 'High', value: 'high' },
  { id: 'xhigh', name: 'XHigh', value: 'xhigh' },
  { id: 'max', name: 'Max', value: 'max' },
]

/** The selection a session's record holds: the part a title call must leave as it found it. */
const selectionOf = (sessions: SessionService, id: string) => {
  const meta = sessions.list().find((entry) => entry.id === id)
  return { endpoint: meta?.endpoint, model: meta?.model, reasoningEffort: meta?.reasoningEffort }
}

test("#215: the title call asks for the route's least supported effort, not the session's, and names no session", async () => {
  /**
   * DSH's first-prompt provider titles at `model.reasoning?.efforts[0]?.id` (dsh-session-title-first-prompt-llm
   * lib/index.js:41-42), laid over the call's controls (dsh-session-title-llm lib/index.js:184-190): a route's first
   * declared level, and nothing for a route that declares none. Heddle sent no effort and the session's id, so the
   * server's selection rule and the default fill (#157) ran the title at the session's max or xhigh.
   */
  const { sessions, requests } = fixture(() => stop('Quarterly revenue comparison'), {
    levels: (endpoint, model) => (endpoint === 'gateway' && model === 'opus' ? { default: 'xhigh', levels: LEVELS } : undefined),
  })
  const atMax = sessions.start({ cwd: scratch })
  sessions.setModel(atMax.id, { endpoint: 'gateway', model: 'opus', reasoningEffort: 'max' })
  const before = selectionOf(sessions, atMax.id)
  sessions.user(atMax, PROMPT)
  sessions.store.modelRequest(atMax, { endpoint: 'gateway', model: 'opus', reasoningEffort: 'max', messages: 1, tools: [] })
  await sessions.store.titles.settle()
  assert.equal(requests.length, 1, 'the turn’s request started the title call')
  assert.equal(requests[0]!.reasoningEffort, 'low', 'a session at max: the title asks for the route’s least level')
  assert.equal(requests[0]!.sessionId, undefined, 'and carries no session id, so no session policy rewrites it')
  assert.deepEqual(selectionOf(sessions, atMax.id), before, 'the session keeps its endpoint, model and max')
  assert.equal(before.reasoningEffort, 'max')

  const atDefault = sessions.start({ cwd: scratch })
  sessions.setModel(atDefault.id, { endpoint: 'gateway', model: 'opus' })
  sessions.user(atDefault, PROMPT)
  sessions.store.modelRequest(atDefault, { endpoint: 'gateway', model: 'opus', reasoningEffort: 'xhigh', reasoningEffortDefault: true, messages: 1, tools: [] })
  await sessions.store.titles.settle()
  assert.equal(requests[1]!.reasoningEffort, 'low', 'a session at the model’s default xhigh: the least level too')
  assert.equal(selectionOf(sessions, atDefault.id).reasoningEffort, undefined, 'and the session still names no level')

  const plain = sessions.start({ cwd: scratch })
  sessions.setModel(plain.id, { endpoint: 'gateway', model: 'plain' })
  sessions.user(plain, PROMPT)
  sessions.store.modelRequest(plain, { endpoint: 'gateway', model: 'plain', messages: 1, tools: [] })
  await sessions.store.titles.settle()
  assert.equal(requests.length, 3)
  assert.equal('reasoningEffort' in requests[2]!, false, 'a route that declares no levels: no effort is asked for')
  assert.equal(requests[2]!.sessionId, undefined)
})

test('#215: through the model service, the title leaves at the least level while the turn runs at the session’s', async () => {
  /**
   * The whole path the server takes: the session plugin's own wiring reads the route's levels from the model service,
   * a selection policy keyed on the session id stands for the server's running-turn rule (src/server/web.ts, the
   * model/request listener over sessionRequestSelection), the model service's default fill runs, and each request is
   * read as the adapter receives it (model/stream).
   */
  const script = join(scratch, 'script-effort.json')
  writeFileSync(script, JSON.stringify({ steps: [{ purpose: SESSION_TITLE_PURPOSE, text: 'Northern revenue comparison' }, { text: 'a scripted answer' }] }))
  const ctx = new Context()
  const sessions = new SessionPlugin(ctx, { root: join(scratch, 'sessions-effort') })
  const sandbox = new SandboxService(ctx, { workspaceRoot: scratch, backend: 'none' })
  new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  new ModelService(ctx, [
    {
      name: 'scripted',
      kind: 'scripted',
      baseUrl: script,
      model: 'opus',
      models: [{ id: 'opus', reasoning: { default: 'xhigh', levels: LEVELS } }, { id: 'plain' }],
    } as never,
  ])
  ctx.on('model/request', (request, next) => {
    const resolved = next()
    if (resolved.sessionId === undefined) return resolved
    return { ...resolved, ...sessionRequestSelection(sessions.list().find((meta) => meta.id === resolved.sessionId)) }
  })
  const sent: GenerateRequest[] = []
  ctx.on('model/stream', (request, next) => {
    sent.push(request)
    return next()
  })
  const titleRequest = () => sent.find((request) => request.purpose === SESSION_TITLE_PURPOSE)
  const turnRequest = () => sent.find((request) => request.purpose !== SESSION_TITLE_PURPOSE)

  const handle = sessions.start({ cwd: scratch })
  sessions.setModel(handle.id, { endpoint: 'scripted', model: 'opus', reasoningEffort: 'max' })
  const result = await runTurn(ctx, { session: handle, endpoint: 'scripted', model: 'opus', reasoningEffort: 'max', prompt: PROMPT, maxRounds: 2 })
  await sessions.store.titles.settle()
  assert.equal(result.text, 'a scripted answer')
  assert.equal(turnRequest()?.reasoningEffort, 'max', 'the turn runs at the session’s max')
  assert.equal(titleRequest()?.reasoningEffort, 'low', `the title asks for the least level\nsent: ${JSON.stringify(titleRequest())}`)
  assert.equal(titleRequest()?.reasoningEffortDefault, undefined, 'a level the title named, not the model default filled in')
  assert.equal(titleRequest()?.model, 'opus', 'on the turn’s own route')
  assert.equal(selectionOf(sessions, handle.id).reasoningEffort, 'max', 'the session still runs at max')
  assert.equal(sessions.list().find((meta) => meta.id === handle.id)?.title, 'Northern revenue comparison', 'and the title landed')

  sent.length = 0
  const atDefault = sessions.start({ cwd: scratch })
  await runTurn(ctx, { session: atDefault, endpoint: 'scripted', model: 'opus', prompt: PROMPT, maxRounds: 2 })
  await sessions.store.titles.settle()
  assert.equal(turnRequest()?.reasoningEffort, 'xhigh', 'a session that names no level runs its turn at the model default')
  assert.equal(titleRequest()?.reasoningEffort, 'low', 'its title, at the least level')

  sent.length = 0
  const plain = sessions.start({ cwd: scratch })
  await runTurn(ctx, { session: plain, endpoint: 'scripted', model: 'plain', prompt: PROMPT, maxRounds: 2 })
  await sessions.store.titles.settle()
  assert.ok(titleRequest(), 'the plain route was asked for a title')
  assert.equal(titleRequest()?.reasoningEffort, undefined, 'a route without levels: the title sends no effort')
})
