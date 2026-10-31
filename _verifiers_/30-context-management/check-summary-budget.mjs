import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, readTranscript, removeDir, repoRoot, runCli, sessionsUnder, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier — a reasoning model's summary has room to answer, so compaction succeeds on it (#15).
 *
 * **The claim it decides:** past the trigger, a session on a model that thinks before it answers is compacted: the
 * summarising call leaves the model room for its reasoning and its answer, and the log records the summary and the
 * closed transaction rather than a refusal.
 *
 * Measured live on both builds before the fix (draft developer-four-4): the summarising call carried a fixed
 * `max_tokens` of 1024, the DeepSeek reasoning model spent all of it thinking, the answer text came back empty, and
 * every turn past the trigger logged `compaction/failed` "the summariser returned nothing", paid about 7 s, and sent
 * the request uncompacted. DSH budgets the summary at 65536 (`dsh-compaction-basic`: `maxTokens` from
 * `headroomTokens`). The double below is that model's shape: it streams 2000 tokens of reasoning before any answer,
 * so a request whose `max_tokens` is smaller ends at `length` with reasoning and no text.
 */

const CAPABILITY = 'compaction through an OpenAI-compatible endpoint'
const REASONING_TOKENS = 2000
/** The summariser's directive, recognised in either form: DSH's since #77, the older request before it. */
const isInstruction = (text) => text.includes('acting as a compaction engine') || text.includes('Summarise the conversation above')

/** A chat double that reasons for REASONING_TOKENS before answering, and records every request. */
async function reasoningDouble() {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no model list' }))
        return
      }
      const parsed = JSON.parse(body || '{}')
      const last = (parsed.messages ?? []).at(-1)
      const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
      const summary = isInstruction(lastText)
      requests.push({ summary, maxTokens: parsed.max_tokens })
      const frame = (delta, finish = null, usage) =>
        response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame({ role: 'assistant', reasoning_content: 'think '.repeat(50) })
      const room = typeof parsed.max_tokens === 'number' ? parsed.max_tokens : Number.POSITIVE_INFINITY
      if (room <= REASONING_TOKENS) {
        // The budget ran out inside the reasoning: no answer text at all, which is what the live model did.
        frame({}, 'length', { prompt_tokens: 100, completion_tokens: room })
      } else {
        frame({ content: summary ? 'the briefing: the user wrote about rivers' : 'x'.repeat(300) })
        frame({}, 'stop', { prompt_tokens: 100, completion_tokens: REASONING_TOKENS + 50 })
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((done) => server.close(done)) }
}

/** A profile whose context plugin compacts early, routed to the double. */
function profile(home, baseUrl) {
  const dir = fixtureDir('summary-budget-profile')
  const prefix = relative(dir, repoRoot).split('\\').join('/')
  writeJson(join(home, 'heddle.json'), {
    default: 'thinking',
    endpoints: [{ name: 'thinking', kind: 'openai-chat', baseUrl, model: 'thinking', stream: true }],
  })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
    - id: console
      name: ${prefix}/src/plugins/console-exporter.ts
    - id: session
      name: ${prefix}/src/plugins/session.ts
      config:
        root: ${join(home, 'sessions')}
    - id: model
      name: ${prefix}/src/plugins/model.ts
    - id: context
      name: ${prefix}/src/context/service.ts
      inject: [model, session]
      config:
        contextWindow: 900
        thresholdTokens: 700
        retainTokens: 100
        instructions: false
    - id: workspace
      name: ${prefix}/src/workspace/service.ts
      inject: [session]
    - id: sandbox
      name: ${prefix}/src/sandbox/service.ts
      config:
        mode: workspace-write
        workspaceRoot: ${home}
    - id: approvals
      name: ${prefix}/src/approvals/service.ts
      config:
        mode: allow
    - id: tools
      name: ${prefix}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [read_file]
`,
  )
  return dir
}

async function supportsContext() {
  const help = await runCli(['--help'])
  return /^\s{2}context\b/m.test(help.stdout) && /--turn/.test(help.stdout)
}

test('past the trigger, a reasoning model’s summary has room to answer, and the session is compacted', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  const double = await reasoningDouble()
  const home = fixtureDir('summary-budget-home')
  const env = { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') }
  try {
    const dir = profile(home, double.url)
    const first = await runCli(['--profile', dir, '--endpoint', 'thinking', '--turn', `first ${'y'.repeat(300)}`], { env })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const session = sessionsUnder(join(home, 'sessions'))[0]
    assert.ok(session, 'a session was recorded')

    const second = await runCli(
      ['--profile', dir, '--endpoint', 'thinking', '--resume', session, '--turn', `second ${'z'.repeat(4000)}`],
      { env },
    )
    assert.equal(second.code, 0, `the second turn ran\n${second.stdout}${second.stderr}`)

    const summaries = double.requests.filter((request) => request.summary)
    assert.ok(summaries.length >= 1, `the session passed the trigger and asked for a summary\n${JSON.stringify(double.requests)}`)
    const events = readTranscript(join(home, 'sessions', session))
    const failed = events.filter((event) => event.type === 'compaction/failed')
    assert.deepEqual(
      failed.map((event) => event.reason),
      [],
      `no compaction was refused; the summary call's max_tokens: ${JSON.stringify(summaries.map((request) => request.maxTokens ?? 'none'))}`,
    )
    assert.ok(events.some((event) => event.type === 'compaction/summary'), 'the summary was recorded')
    assert.ok(events.some((event) => event.type === 'compaction/end'), 'and the transaction closed')
  } finally {
    await double.close()
    removeDir(home)
  }
})
