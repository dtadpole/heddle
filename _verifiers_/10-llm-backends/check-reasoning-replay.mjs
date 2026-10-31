// developer-ten-3 (P1): a DeepSeek thinking-mode continuation replays each assistant message's reasoning_content.
// Runs against whichever harness HEDDLE_BIN names (the TypeScript build by default).
//
// DeepSeek's thinking API refuses a continuation whose replayed assistant message lacks `reasoning_content` ("The
// `reasoning_content` in the thinking mode must be passed back to the API"). A tool round, a steer and a subagent's
// notice all continue a turn that way, so on the live DeepSeek route a steered turn died with that 400. DSH's rule
// (pi-ai's openai-completions compat `requiresReasoningContentOnAssistantMessages`): for a base URL containing
// `deepseek.com`, while reasoning is on, every replayed assistant message carries its thinking, or "" when it has none.
//
// The double below enforces DeepSeek's validation on a loopback route whose path names `deepseek.com` (the rule reads
// the whole base URL, as DSH's does). A second double on an ordinary path must receive no reasoning_content at all.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, removeDir, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

const DEEPSEEK_REFUSAL = 'The `reasoning_content` in the thinking mode must be passed back to the API'

/**
 * A Chat Completions double. The first request is answered with reasoning and a `list_dir` call; every later one with
 * a short answer. With `enforce`, a request replaying an assistant message without `reasoning_content` is refused
 * with DeepSeek's 400, as the live route refuses it.
 */
async function double({ enforce }) {
  const bodies = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404)
        response.end()
        return
      }
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      bodies.push(body)
      const missing = (body.messages ?? []).some((message) => message.role === 'assistant' && typeof message.reasoning_content !== 'string')
      if (enforce && missing) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: DEEPSEEK_REFUSAL, type: 'invalid_request_error' } }))
        return
      }
      const frames =
        bodies.length === 1
          ? [
              { choices: [{ index: 0, delta: { reasoning_content: 'look at the folder first' }, finish_reason: null }] },
              {
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] },
                    finish_reason: null,
                  },
                ],
              },
              { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            ]
          : [
              { choices: [{ index: 0, delta: { reasoning_content: 'now answer' }, finish_reason: null }] },
              { choices: [{ index: 0, delta: { content: 'the folder holds a.txt' }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, bodies, close: () => server.close() }
}

async function supportsTurns() {
  const help = await runCli(['--help'])
  return /--endpoint/.test(help.stdout) && /--turn/.test(help.stdout)
}

/** One `--turn` on an endpoint at `path` of a double; the double's record and the run. */
async function turnOn(label, path, enforce) {
  const home = isolatedHome(`reasoning-replay-${label}`)
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'a.txt'), 'one\n')
  const provider = await double({ enforce })
  const config = join(home, 'heddle.json')
  writeFileSync(
    config,
    // The shape the shared httpConfig writes: a default, a streaming endpoint, no key (a double needs none).
    `${JSON.stringify({ default: 'thinking', endpoints: [{ name: 'thinking', kind: 'openai-chat', baseUrl: `http://127.0.0.1:${provider.port}${path}`, model: 'thinking-model', stream: true }] }, null, 2)}\n`,
  )
  try {
    const run = await runCli(['--endpoint', 'thinking', '--sandbox-root', work, '--session-root', join(home, 'sessions'), '--turn', 'What is in this folder?', '--json'], {
      // From the repository root, as every part-10 check runs the harness (it finds its profile there).
      env: { HOME: home, HEDDLE_CONFIG: config },
    })
    return { run, bodies: provider.bodies }
  } finally {
    provider.close()
    removeDir(home)
  }
}

test('a tool round on a DeepSeek thinking route replays the assistant reasoning, so the continuation is accepted', async (context) => {
  if (!skipUnless(context, await supportsTurns(), '`--endpoint` and `--turn`')) return
  const { run, bodies } = await turnOn('deepseek', '/deepseek.com/v1', true)
  assert.equal(bodies.length, 2, `the turn made its tool round and continued (requests: ${bodies.length}, exit ${run.code})\n${run.stdout}\n${run.stderr}`)
  assert.equal(run.code, 0, `the turn ended normally, not with DeepSeek's 400\n${run.stdout}\n${run.stderr}`)
  const replayed = (bodies[1].messages ?? []).filter((message) => message.role === 'assistant')
  assert.ok(replayed.length >= 1, 'the continuation replays the assistant step')
  assert.equal(replayed[0].reasoning_content, 'look at the folder first', 'with the reasoning it streamed')
  assert.ok(replayed[0].tool_calls?.length === 1, 'and its tool call')
})

test('any other chat route receives no reasoning_content, so no gateway sees a new field', async (context) => {
  if (!skipUnless(context, await supportsTurns(), '`--endpoint` and `--turn`')) return
  const { run, bodies } = await turnOn('other', '/v1', false)
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
  assert.equal(bodies.length, 2)
  for (const body of bodies) {
    assert.ok((body.messages ?? []).every((message) => !('reasoning_content' in message)), JSON.stringify(body.messages))
  }
})
