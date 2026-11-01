import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, readTranscript, removeDir, repoRoot, runCli, sessionsUnder, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier — the summariser is asked DSH's structured checkpoint directive (#77).
 *
 * **The claim it decides:** when a session compacts, the auxiliary summary call ends with DSH's directive
 * (dsh-compaction-basic `COMPACTION_INSTRUCTION`): the compaction-engine role, the fixed Markdown sections, and the
 * rule to output only the checkpoint. The compaction lands.
 *
 * Measured before (developer-four, live DeepSeek endpoint, both builds, after #15): heddle asked a four-sentence
 * "Summarise the conversation above ... a briefing to yourself". When the replayed span ended with a pending user
 * request ("write part 6"), the model answered that request instead. Summaries became essays ("# The History of
 * Canals, Part 6 ..."), and on Rust the code word from the older span was lost. DSH's cut is the same tool-pairing
 * balance; its directive is what keeps the call a checkpoint.
 */

const CAPABILITY = 'compaction through an OpenAI-compatible endpoint'
const isInstruction = (text) => text.includes('acting as a compaction engine') || text.includes('Summarise the conversation above')

/** A chat double that answers at once and records the last message of every request. */
async function recordingDouble() {
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
      const lastText = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((part) => part.text ?? '').join('')
      const summary = isInstruction(lastText)
      requests.push({ summary, lastText, role: last?.role })
      const frame = (delta, finish = null, usage) =>
        response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame({ role: 'assistant', content: summary ? '## Primary Request and Intent\n- the user wrote about rivers' : 'x'.repeat(300) })
      frame({}, 'stop', { prompt_tokens: 100, completion_tokens: 50 })
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((done) => server.close(done)) }
}

/** A profile whose context plugin compacts early, routed to the double. */
function profile(home, baseUrl) {
  const dir = fixtureDir('compaction-directive-profile')
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

test('a compacting session asks the summariser DSH’s structured checkpoint directive, and the compaction lands', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  const double = await recordingDouble()
  const home = fixtureDir('compaction-directive-home')
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

    const summary = double.requests.find((request) => request.summary)
    assert.ok(summary, `the session passed the trigger and asked for a summary\n${JSON.stringify(double.requests.map((r) => r.lastText.slice(0, 60)))}`)
    assert.equal(summary.role, 'user', 'the directive is the call’s final user message')
    for (const part of ['You are now acting as a compaction engine', 'Condense the conversation ABOVE', '## Primary Request and Intent', '## Current Work', '## Next Step', 'Output only the checkpoint text']) {
      assert.ok(summary.lastText.includes(part), `the directive holds ${JSON.stringify(part)}\n${summary.lastText.slice(0, 300)}`)
    }
    const events = readTranscript(join(home, 'sessions', session))
    assert.ok(events.some((event) => event.type === 'compaction/summary'), 'the summary was recorded')
    assert.ok(events.some((event) => event.type === 'compaction/end'), 'and the transaction closed')
  } finally {
    await double.close()
    removeDir(home)
  }
})
