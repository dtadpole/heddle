// Parallel tool calls, as DSH's agent loop runs them: the parallel-safe calls of one model step run together, up to
// tools.maxParallelToolCalls, and their results are answered in the order the model asked.
//
// What each test proves, by name:
// - Scheduler concurrency, by a bounded handshake: a fixture tool `meet`, declared parallel-safe (DSH's
//   isConcurrencySafe), marks that its call started and then waits for the other call's mark, with a 3 s timeout as
//   the failure guard. Two `meet` calls in one step both find each other only if the loop ran them together; at
//   maxParallelToolCalls 1 the first waits out the timeout alone and the second then finds the first's mark.
// - Result order against completion order: once met, the first call also waits (same guard) for the second to
//   finish, so the second call always completes first; the results must still be answered first call first.
//   The fixture is a TypeScript plugin on the TypeScript build and a process on a binary
//   (rust/crates/heddle-tools/PROTOCOL.md, `concurrencySafe`).
// - read_file batching: two read_file calls of one step, on a regular file and on a missing one, are both answered,
//   in the model's order. A regular-file read does not block, so this does not prove overlap; read_file keeps DSH's
//   regular-file contract (dsh-tool-fs resolveRegularReadTarget), which is why the overlap proof no longer reads
//   named pipes.
// Runs against whichever harness HEDDLE_BIN names, or the TypeScript build.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

const binaryUnderTest = typeof process.env.HEDDLE_BIN === 'string' && process.env.HEDDLE_BIN.length > 0

/** The handshake's failure guard: how long a `meet` call waits for its partner's mark (or finish) before giving up. */
const MEET_BOUND_MS = 3_000

const MEET_SPEC = {
  name: 'meet',
  description: 'Mark this call as started, then wait for the other named call to start.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' }, other: { type: 'string' }, dir: { type: 'string' }, after: { type: 'boolean' } },
    required: ['name', 'other', 'dir'],
  },
}

/**
 * The call itself, shared by both vehicles: mark the start, wait (guarded) for the partner's start mark; a call with
 * `after` set then also waits (guarded) for that partner's finish mark, so it completes second. Every call marks its
 * finish as it returns.
 */
const MEET_RUN = `async (args) => {
  const { existsSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const mark = (name, kind) => join(args.dir, name + '.' + kind)
  const wait = async (path) => {
    const deadline = Date.now() + ${MEET_BOUND_MS}
    while (Date.now() < deadline) {
      if (existsSync(path)) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }
  writeFileSync(mark(args.name, 'started'), '')
  let output = 'alone'
  if (await wait(mark(args.other, 'started'))) {
    output = 'met ' + args.other
    if (args.after === true) output += (await wait(mark(args.other, 'finished'))) ? ', after ' + args.other + ' finished' : ', before ' + args.other + ' finished'
  }
  writeFileSync(mark(args.name, 'finished'), '')
  return { output }
}`

/** The fixture as a TypeScript plugin, registered parallel-safe. */
const MEET_PLUGIN = `export const name = 'meet-tool'
export const inject = ['tools']
const run = ${MEET_RUN}
export default function meet(ctx) {
  ctx.tools.register({ spec: ${JSON.stringify(MEET_SPEC)}, concurrencySafe: true, run })
}
`

/** The fixture as a process speaking the outside-component protocol, declaring `concurrencySafe`. */
const MEET_PROCESS = `import { createInterface } from 'node:readline'
const run = ${MEET_RUN}
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
createInterface({ input: process.stdin }).on('line', async (line) => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.method === 'initialize') return write({ id: message.id, result: { tools: [{ ...${JSON.stringify(MEET_SPEC)}, concurrencySafe: true }] } })
  if (message.method === 'shutdown') return write({ id: message.id, result: null })
  if (message.method === 'exit') return process.exit(0)
  if (message.method === 'tools/call') return write({ id: message.id, result: await run(message.params.args ?? {}) })
  if (message.id !== undefined) write({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
})
`

/** An OpenAI-compatible double: the first request gets every call in one message, the next an answer. */
async function double(calls) {
  let requests = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      /** A new session's title request is not one of the turn's rounds this double answers in order (#68). */
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      requests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      if (requests === 1) {
        calls.forEach(({ name, args }, index) =>
          send({ role: 'assistant', tool_calls: [{ index, id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null),
        )
        send({}, 'tool_calls')
      } else send({ role: 'assistant', content: 'all answered' }, 'stop')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}

function profile(home, limit) {
  const dir = join(home, `parallel-profile-${limit ?? 'default'}`)
  mkdirSync(dir, { recursive: true })
  if (binaryUnderTest) {
    writeFileSync(join(dir, 'meet-tool.component.yml'), `program: ${JSON.stringify(process.execPath)}\nargs:\n  - ./meet-tool.mjs\n`)
    writeFileSync(join(dir, 'meet-tool.mjs'), MEET_PROCESS)
  } else writeFileSync(join(dir, 'meet-tool.ts'), MEET_PLUGIN)
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
    - id: meet-tool
      name: ./${binaryUnderTest ? 'meet-tool.component.yml' : 'meet-tool.ts'}
      inject: [tools]
    - id: tools
      name: ${repoRoot}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [read_file, meet]
${limit === undefined ? '' : `        maxParallelToolCalls: ${limit}\n`}`,
  )
  return dir
}

/** Run one `--turn` whose first step asks for `calls(home)`; answer the tool results in log order. */
async function turn(label, limit, calls) {
  const home = isolatedHome(`parallel-tools-${label}`)
  const model = await double(calls(home))
  const config = join(home, 'heddle.json')
  writeFileSync(config, JSON.stringify({ default: 'double', exclude: ['scripted'], endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: model.baseUrl, model: 'double', stream: true }] }))
  const child = spawn(...heddleCommand(['--profile', profile(home, limit), '--sandbox-root', home, '--turn', 'run the calls']), {
    cwd: home,
    env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout') }, 60_000)
    child.on('exit', (exit) => { clearTimeout(timer); resolve(exit) })
  })
  const sessions = sessionsUnder(join(home, 'sessions'))
  const results = sessions.length === 0
    ? []
    : readTranscript(join(home, 'sessions', sessions[0]))
        .filter((event) => event.type === 'message' && event.message?.role === 'tool')
        .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
  await model.close()
  removeDir(home)
  return { code, output, results }
}

const meetCalls = (home) => {
  const dir = join(home, 'marks')
  mkdirSync(dir, { recursive: true })
  return [
    { name: 'meet', args: { name: 'a', other: 'b', dir, after: true } },
    { name: 'meet', args: { name: 'b', other: 'a', dir } },
  ]
}

test('the parallel-safe calls of one step run together, and the first is answered first though it finished last', async () => {
  const run = await turn('together', undefined, meetCalls)
  assert.equal(run.code, 0, run.output.slice(-600))
  assert.deepEqual(
    run.results,
    ['met b, after b finished', 'met a'],
    `each call found the other started (they ran together), and the second finished first yet is answered second\n${run.output.slice(-600)}`,
  )
})

test('maxParallelToolCalls 1 runs them one after the other', async () => {
  const run = await turn('serial', 1, meetCalls)
  assert.equal(run.code, 0, run.output.slice(-600))
  assert.deepEqual(run.results, ['alone', 'met a'], `the first waited out its bound alone, the second found it: one at a time\n${run.output.slice(-600)}`)
})

test('the read_file calls of one step are all answered, in the order the model asked', async () => {
  const run = await turn('reads', undefined, (home) => {
    writeFileSync(join(home, 'present.txt'), 'present content')
    return [
      { name: 'read_file', args: { path: join(home, 'present.txt') } },
      { name: 'read_file', args: { path: join(home, 'missing.txt') } },
    ]
  })
  // `--turn` exits 1 when a call was refused or failed (any denial but UNKNOWN_TOOL, src/cli.ts and the binary alike),
  // and the missing file's read is one. The turn itself completed: the model's final answer was printed.
  assert.equal(run.code, 1, run.output.slice(-600))
  assert.match(run.output, /all answered/, 'the turn completed after both answers')
  assert.equal(run.results.length, 2, `both calls were answered\n${run.output.slice(-600)}`)
  assert.equal(run.results[0], 'present content', 'the first answer is the first call’s')
  assert.match(run.results[1], /^error \(/, 'and the second is the missing file’s refusal')
})
