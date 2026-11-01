import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'
import { argumentViolations, invalidArguments, openRoot, type ParameterSchema } from '../src/tools/validate.ts'

/**
 * Tool-argument validation, DSH's (R-developer-five-6, coordinator ruling (a)): a call is checked against the
 * tool's declared parameters before it runs, a violation is `INVALID_ARGS` in DSH's words, and the root is open —
 * an unknown top-level key passes and the schema the model is shown says nothing to the contrary.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-validate-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const bash: ParameterSchema = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    description: { type: 'string' },
    timeoutMs: { type: 'integer' },
    sandbox_permissions: { type: 'string', enum: ['use_default', 'require_escalated'] },
    opts: { type: 'object', additionalProperties: false, properties: { a: { type: 'array', items: { type: 'number' } } } },
  },
  required: ['command', 'description'],
}

test('a missing required property is refused in DSH’s words', () => {
  assert.equal(invalidArguments(argumentViolations(bash, { command: 'ls' })), 'invalid arguments: missing required property "description"')
})

test('an unknown top-level key passes, because the root is open as in DSH', () => {
  assert.deepEqual(argumentViolations(bash, { command: 'ls', description: 'd', run_in_background: true }), [])
})

test('wrong types and a bad enum are named by path, in declaration order', () => {
  assert.deepEqual(argumentViolations(bash, { command: 1, description: 'd', timeoutMs: 1.5, sandbox_permissions: 'x' }), [
    '"command" must be a string',
    '"timeoutMs" must be an integer',
    '"sandbox_permissions" must be one of ["use_default","require_escalated"]',
  ])
})

test('a nested closed node refuses its undeclared keys after its items, with item paths', () => {
  assert.deepEqual(argumentViolations(bash, { command: 'ls', description: 'd', opts: { a: [1, 'two'], b: 1 } }), [
    '"opts.a[1]" must be a number',
    '"opts.b" is not a declared property (additionalProperties: false)',
  ])
})

test('arguments that are not an object are named as the arguments; oneOf needs exactly one branch', () => {
  assert.deepEqual(argumentViolations(bash, 'nope'), ['"arguments" must be an object'])
  const either: ParameterSchema = { oneOf: [{ type: 'string' }, { type: 'number' }] }
  assert.deepEqual(argumentViolations(either, 'x', 'v'), [])
  assert.deepEqual(argumentViolations(either, true, 'v'), ['"v" must match exactly one oneOf branch (matched 0)'])
})

test('openRoot drops only the root’s additionalProperties', () => {
  const closed = { type: 'object', properties: { o: { type: 'object', additionalProperties: false } }, additionalProperties: false }
  assert.deepEqual(openRoot(closed), { type: 'object', properties: { o: { type: 'object', additionalProperties: false } } })
  assert.equal(closed.additionalProperties, false, 'the declared schema itself is untouched')
})

function registry(): { registry: ToolRegistry; root: string; context: { cwd: string; log: () => void } } {
  const root = join(scratch, `workspace-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  const sandbox = new SandboxService(new Context(), { mode: 'workspace-write', workspaceRoot: root })
  const sessions = new SessionService(new Context(), { root: join(root, '.sessions') })
  const approvals = new ApprovalService(new Context(), { mode: 'allow', answerTimeoutMs: 1_000 })
  const tools = new ToolRegistry(new Context(), approvals, sandbox, sessions)
  for (const tool of builtinTools(sandbox)) tools.register(tool)
  return { registry: tools, root, context: { cwd: root, log: () => {} } }
}

test('the registry refuses a call that breaks its schema before the tool runs', async () => {
  const { registry: tools, root, context } = registry()
  const wrong = await tools.call('write_file', { path: 7, content: 'x' }, context)
  assert.equal(wrong.error?.code, 'INVALID_ARGS')
  assert.equal(wrong.error?.message, 'invalid arguments: "path" must be a string')
  assert.equal(existsSync(join(root, '7')), false, 'the tool never ran')

  const missing = await tools.call('bash', {}, context)
  assert.equal(missing.error?.code, 'INVALID_ARGS')
  assert.equal(missing.error?.message, 'invalid arguments: missing required property "command"')

  const unparsed = await tools.call('read_file', { __unparsed: '{"path":' }, context)
  assert.equal(unparsed.error?.message, 'invalid arguments: "arguments" must be an object', 'malformed JSON is not an object')
})

test('an unknown top-level argument reaches the tool, which ignores it', async () => {
  const { registry: tools, root, context } = registry()
  const written = await tools.call('write_file', { path: 'a.txt', content: 'x', run_in_background: true }, context)
  assert.equal(written.error, undefined, written.error?.message)
  assert.equal(existsSync(join(root, 'a.txt')), true)
})

test('the model is shown open roots, while each tool keeps its own spec', () => {
  const { registry: tools } = registry()
  for (const spec of tools.describe()) {
    assert.equal(Object.hasOwn(spec.parameters, 'additionalProperties'), false, `${spec.name} is shown with an open root`)
  }
})
