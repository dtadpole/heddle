import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The hook processes `check.mjs` writes under `HEDDLE_BIN`, judged directly.
 *
 * Under `HEDDLE_BIN` each `.ts` hook plugin becomes a `.component.yml` and a node process speaking the part-4
 * protocol. A process that answered differently from its plugin would turn a binary's correct behaviour into a
 * failed check, so each one is driven here over the protocol and its every answer compared with what the
 * plugin decides. The generator and the hook table are read out of `check.mjs` itself, so this tests what ships.
 */
const text = readFileSync(new URL('../../check.mjs', import.meta.url), 'utf8')
const grab = (start) => {
  const at = text.indexOf(start)
  assert.ok(at >= 0, `check.mjs defines ${start}`)
  const end = text.indexOf('\n}\n', at)
  return text.slice(at, end + 2)
}
const { componentSource, manifestSource, PROCESS_HOOKS } = new Function(
  `${grab('function manifestSource(base)')}\n${grab('function componentSource(')}\n${grab('const PROCESS_HOOKS = {')}\nreturn { componentSource, manifestSource, PROCESS_HOOKS }`,
)()

const scratch = []
function talk(source) {
  const dir = mkdtempSync(join(tmpdir(), 'hook-proc-'))
  scratch.push(dir)
  writeFileSync(join(dir, 'hook.mjs'), source)
  const child = spawn(process.execPath, ['./hook.mjs'], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] })
  let buffer = ''
  const waiting = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const message = JSON.parse(line)
      assert.equal(message.jsonrpc, '2.0', `every line is JSON-RPC 2.0: ${line}`)
      waiting.get(message.id)?.(message)
    }
  })
  let id = 0
  const request = (method, params) =>
    new Promise((resolve) => {
      id += 1
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const close = () =>
    new Promise((resolve) => {
      child.on('exit', (code) => resolve(code))
      request('shutdown', null).then(() => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'exit' })}\n`))
    })
  return { request, close }
}

const call = (point, payload) => ({ point, mode: 'waterfall', payload })
const cases = {
  retarget: [[call('model/request', { endpoint: 'double', model: 'double', messages: [] }), { result: { kind: 'replace', value: { endpoint: 'scripted', model: 'double', messages: [] } } }]],
  refuse: [
    [call('tools/pre-execute', { name: 'write_file', args: { path: 'x' } }), { result: { kind: 'replace', value: { allowed: false, reason: 'this hook refuses writes' } } }],
    [call('tools/pre-execute', { name: 'read_file', args: { path: 'x' } }), { result: { kind: 'next' } }],
  ],
  post: [[call('tools/post-execute', { name: 'read_file', args: {}, result: { output: 'the real contents' } }), { result: { kind: 'merge', value: { output: 'redacted by the hook', data: { replacedBy: 'post-hook' } } } }]],
  stop: [[call('agent/pre-step', { messages: [] }), { result: { kind: 'refuse', reason: 'refused by hook: this hook refuses to send the request' } }]],
  broken: [
    [call('tools/pre-execute', { name: 'write_file', args: {} }), { error: { code: -32000, message: 'this hook is broken' } }],
    [call('model/request', {}), { error: { code: -32000, message: 'this hook is broken too' } }],
  ],
}


test('a manifest names the node running the check and the process beside it', () => {
  assert.match(manifestSource('retarget'), /^program: ".+"\nargs:\n  - \.\/retarget\.mjs\n$/)
})

for (const [name, hook] of Object.entries(PROCESS_HOOKS)) {
  test(`the ${name} process declares its listeners and answers as its plugin decides`, async () => {
    const process_ = talk(componentSource(hook))
    const init = await process_.request('initialize', { protocol: 'heddle-component/1', row: 'hook-1', config: null, workspaceRoot: '/w', mode: 'workspace-write' })
    assert.deepEqual(init.result, { tools: [], listeners: hook.listeners }, 'initialize declares its listeners')
    for (const [params, expected] of cases[name]) {
      const reply = await process_.request('hooks/call', params)
      const { jsonrpc: _j, id: _i, ...rest } = reply
      assert.deepEqual(rest, expected, `${params.point} ${JSON.stringify(params.payload)}`)
    }
    const unknown = await process_.request('sandbox/whatever', {})
    assert.equal(unknown.error?.code, -32601, 'an unknown method is -32601')
    assert.equal(await process_.close(), 0, 'shutdown then exit ends the process')
  })
}

test.after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})
