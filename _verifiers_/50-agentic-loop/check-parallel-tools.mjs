// Parallel tool calls, as DSH's agent loop runs them: the parallel-safe calls of one model step run together, up to
// tools.maxParallelToolCalls. The proof needs no timing: a double asks for two read_file calls in one step, on two
// named pipes, and the check writes pipe B before pipe A. Run together, both reads are waiting, so B and then A are
// answered and the turn ends. Run one after the other, the loop waits on A while the check waits for a reader on B,
// and the turn cannot end, so a cap of 1 must stall. Runs against whichever harness HEDDLE_BIN names, or the TypeScript
// build.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

/** An OpenAI-compatible double: the first request gets both read_file calls in one message, the next an answer. */
async function double(paths) {
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      requests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      if (requests === 1) {
        paths.forEach((path, index) =>
          send({ role: 'assistant', tool_calls: [{ index, id: `call-${index}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] }, null),
        )
        send({}, 'tool_calls')
      } else send({ role: 'assistant', content: 'read both' }, 'stop')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}

function profile(home, limit) {
  const dir = join(home, `parallel-profile-${limit ?? 'default'}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
    - id: session
      name: ${repoRoot}/src/plugins/session.ts
      config:
        root: ${join(home, 'sessions')}
    - id: model
      name: ${repoRoot}/src/plugins/model.ts
    - id: context
      name: ${repoRoot}/src/context/service.ts
      inject: [model, session]
      config:
        contextWindow: 200000
    - id: sandbox
      name: ${repoRoot}/src/sandbox/service.ts
      config:
        mode: danger-full-access
        workspaceRoot: ${home}
    - id: approvals
      name: ${repoRoot}/src/approvals/service.ts
      config:
        mode: allow
    - id: tools
      name: ${repoRoot}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [read_file]
${limit === undefined ? '' : `        maxParallelToolCalls: ${limit}\n`}`,
  )
  return dir
}

/** Run one turn reading pipes A and B, writing B then A; resolve with how it ended within `waitMs`. */
async function turnOverPipes(limit, waitMs) {
  const home = isolatedHome(`parallel-tools-${limit ?? 'default'}`)
  const a = join(home, 'pipe-a')
  const b = join(home, 'pipe-b')
  execFileSync('mkfifo', [a, b])
  const model = await double([a, b])
  const config = join(home, 'heddle.json')
  writeFileSync(config, JSON.stringify({ default: 'double', exclude: ['scripted'], endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: model.baseUrl, model: 'double', stream: true }] }))
  const child = spawn(...heddleCommand(['--profile', profile(home, limit), '--sandbox-root', home, '--turn', 'read both pipes']), {
    cwd: home,
    env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code })))
  // B first, then A: opening a pipe to write waits for its reader, which only a parallel step provides for B while A waits.
  // A broken pipe while the check frees a stalled run below is expected, so the writer's failure is caught at once.
  const writer = (async () => {
    for (const [path, text] of [[b, 'from pipe B'], [a, 'from pipe A']]) {
      const handle = await open(path, 'w')
      await handle.write(text)
      await handle.close()
    }
  })().catch(() => {})
  const outcome = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), waitMs))])
  child.kill('SIGKILL')
  // Free a writer still waiting for a reader (a stalled turn, or a harness that exited early): opening a pipe for
  // reading and writing never blocks and satisfies the waiting open. Each pipe is opened once per write still owed.
  for (let round = 0; round < 2; round += 1) {
    for (const path of [a, b]) await open(path, 'r+').then((handle) => handle.close()).catch(() => {})
  }
  await Promise.race([writer, new Promise((resolve) => setTimeout(resolve, 2_000))])
  const sessions = outcome.stalled ? [] : sessionsUnder(join(home, 'sessions'))
  const results = sessions.length === 0
    ? []
    : readTranscript(join(home, 'sessions', sessions[0]))
        .filter((event) => event.type === 'message' && event.message?.role === 'tool')
        .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
  await model.close()
  removeDir(home)
  return { ...outcome, output, results }
}

test('the read_file calls of one step run together, and their results keep the model order', async () => {
  const run = await turnOverPipes(undefined, 20_000)
  assert.equal(run.stalled, undefined, `the turn ended: both reads waited at once\n${run.output.slice(-600)}`)
  assert.equal(run.code, 0, run.output.slice(-600))
  assert.deepEqual(run.results, ['from pipe A', 'from pipe B'], 'answered in the order the model asked, not the order they finished')
})

test('maxParallelToolCalls 1 runs them one after the other, so the same step cannot finish', async () => {
  const run = await turnOverPipes(1, 4_000)
  assert.equal(run.stalled, true, 'serial reads wait on pipe A while pipe B waits for its reader')
})
