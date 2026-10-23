import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The tool processes `check-tools.mjs` writes under `HEDDLE_BIN`, judged directly, with this suite playing the host.
 *
 * Under `HEDDLE_BIN` each `.ts` tool plugin becomes a `.component.yml` and a node process speaking the part-4
 * protocol (`rust/crates/heddle-tools/PROTOCOL.md`). A process that answered differently from its plugin would turn a
 * binary's correct behaviour into a failed check, so each one is driven here — `initialize`, a `tools/call`, the
 * `sandbox/assertWritable` back-channel both admitted and refused, `shutdown` — and compared with what its plugin
 * does. The generator and the tool table are read out of `check-tools.mjs`, so this judges what ships.
 *
 *     node --test _verifiers_/40-pluggable-tools/_tests_/process-tools/unit.test.mjs
 */

const source = readFileSync(new URL('../../check-tools.mjs', import.meta.url), 'utf8')
const generator = source.slice(source.indexOf('const binaryUnderTest'), source.indexOf('const pluginFile'))
const { componentSource, manifestSource, PROCESS_TOOLS } = new Function(`${generator}; return { componentSource, manifestSource, PROCESS_TOOLS }`)()

/** Start one tool process; `onHostRequest(message)` answers its back-channel requests the way a host would. */
function startTool(base, onHostRequest) {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-process-tool-'))
  writeFileSync(join(dir, `${base}.mjs`), componentSource(PROCESS_TOOLS[base]))
  const child = spawn(process.execPath, [`./${base}.mjs`], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] })
  let buffer = ''
  let next = 0
  const waiting = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      if (message.method !== undefined) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...onHostRequest(message) })}\n`)
      else {
        waiting.get(message.id)?.(message)
        waiting.delete(message.id)
      }
    }
  })
  const request = (method, params) =>
    new Promise((resolve) => {
      next += 1
      waiting.set(next, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`)
    })
  const end = async () => {
    const answer = await request('shutdown', null)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'exit' })}\n`)
    child.kill()
    rmSync(dir, { recursive: true, force: true })
    return answer
  }
  return { request, end }
}

const initialize = (workspaceRoot, mode = 'workspace-write') => ({ protocol: 'heddle-component/1', row: 'plugin-1', config: {}, workspaceRoot, mode })
const context = (workspaceRoot, mode = 'workspace-write') => ({ cwd: workspaceRoot, mode, session: 'session-test', workspaceRoot })

test('the manifest names the program and its script, the shape D-031 froze', () => {
  assert.match(manifestSource('shout-tool'), /^program: ".+"\nargs:\n {2}- \.\/shout-tool\.mjs\n$/)
})

test('shout declares its plugin spec, asks the host before writing, and writes the upper-cased text', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heddle-process-tool-ws-'))
  const questions = []
  const tool = startTool('shout-tool', (message) => {
    questions.push(message)
    return { result: { path: message.params.path } }
  })
  try {
    const init = await tool.request('initialize', initialize(workspace))
    assert.deepEqual(init.result.tools, PROCESS_TOOLS['shout-tool'].tools)
    assert.equal(init.result.tools[0].description, 'Write a shout file containing the text, uppercased.')
    const call = await tool.request('tools/call', { name: 'shout', args: { text: 'from the plugin' }, context: context(workspace) })
    assert.deepEqual(call.result, { output: 'wrote shout.txt' })
    assert.equal(questions.length, 1)
    assert.equal(questions[0].method, 'sandbox/assertWritable')
    assert.equal(questions[0].params.path, join(workspace, 'shout.txt'), 'the workspace file, as the plugin writes it')
    assert.equal(questions[0].params.call, 2, 'the question names the tools/call it belongs to')
    assert.equal(readFileSync(join(workspace, 'shout.txt'), 'utf8'), 'FROM THE PLUGIN')
    assert.equal((await tool.end()).result, null, 'shutdown is answered null')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('shout returns a sandbox refusal as its error and writes nothing', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heddle-process-tool-ws-'))
  const tool = startTool('shout-tool', (message) => ({
    error: { code: -32001, message: 'outside the workspace', data: { code: 'SANDBOX', path: message.params.path, mode: 'read-only' } },
  }))
  try {
    await tool.request('initialize', initialize(workspace, 'read-only'))
    const call = await tool.request('tools/call', { name: 'shout', args: { text: 'x' }, context: context(workspace, 'read-only') })
    assert.equal(call.error.code, -32001)
    assert.equal(call.error.data.code, 'SANDBOX', 'the host reports the call as SANDBOX')
    assert.equal(existsSync(join(workspace, 'shout.txt')), false)
    await tool.end()
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('the shadowing process declares read_file with the replacement description and answers as the plugin does', async () => {
  const tool = startTool('shadow-tool', () => ({ error: { code: -32601, message: 'no back-channel expected' } }))
  const init = await tool.request('initialize', initialize(tmpdir()))
  assert.equal(init.result.tools.length, 1)
  assert.equal(init.result.tools[0].name, 'read_file')
  assert.match(init.result.tools[0].description, /wins/)
  const call = await tool.request('tools/call', { name: 'read_file', args: {}, context: context(tmpdir()) })
  assert.deepEqual(call.result, { output: 'the replacement ran' })
  await tool.end()
})

test('the malformed process declares exactly the unnamed spec its plugin registers', async () => {
  const tool = startTool('bad-tool', () => ({}))
  const init = await tool.request('initialize', initialize(tmpdir()))
  assert.deepEqual(init.result.tools, [{ name: '', description: '' }])
  await tool.end()
})

test('an unknown method is answered with method-not-found, not silence', async () => {
  const tool = startTool('shadow-tool', () => ({}))
  await tool.request('initialize', initialize(tmpdir()))
  const answer = await tool.request('hooks/call', {})
  assert.equal(answer.error.code, -32601)
  await tool.end()
})
