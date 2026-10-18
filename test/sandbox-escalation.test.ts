import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { EscalationRefusal, approveEscalation, validateEscalationArgs } from '../src/sandbox/escalation.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * The escalation ladder: one call may be retried once at a strictly wider mode, and a person approves it first.
 *
 * The rules worth pinning are the ones that make the grant narrow: repeating the effective mode is not an
 * escalation, a narrower target is invalid, the approval happens **before** anything executes, a grant applies to
 * that one call, and the session's own mode never moves because of it.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-escalation-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** An approval channel whose answers are scripted, so the ladder is judged without a UI. */
function approver(outcomes: readonly ('allowed-once' | 'rejected' | 'cancelled' | 'unavailable')[]) {
  const asked: { readonly tool: string; readonly reason: string; readonly displayReason: string; readonly session?: string }[] = []
  let index = 0
  return {
    asked,
    request: async (options: { readonly tool: string; readonly reason: string; readonly displayReason: string; readonly session?: string }) => {
      asked.push(options)
      const outcome = outcomes[index] ?? 'unavailable'
      index += 1
      return outcome
    },
  }
}

test('the ladder: repeat is free, wider asks, narrower and unknown are refused', async () => {
  const free = approver([])
  assert.equal(await approveEscalation({ tool: 'bash', requestedMode: 'workspace-write', effectiveMode: 'workspace-write', justification: 'same', subject: 'command' }, free), 'workspace-write', 'repeating the effective mode needs no approval')
  assert.equal(free.asked.length, 0, 'and asks nothing')

  const granted = approver(['allowed-once'])
  assert.equal(await approveEscalation({ tool: 'bash', requestedMode: 'danger-full-access', effectiveMode: 'workspace-write', justification: 'the file is outside', subject: 'command', session: 's-1' }, granted), 'danger-full-access', 'a wider mode is granted for this call')
  assert.equal(granted.asked.length, 1, 'after one question')
  assert.match(granted.asked[0]?.displayReason ?? '', /the file is outside/, 'which carries the justification verbatim')
  assert.match(granted.asked[0]?.displayReason ?? '', /danger-full-access/, 'and the mode being requested')
  assert.equal(granted.asked[0]?.session, 's-1', 'and the session it belongs to')

  await assert.rejects(
    approveEscalation({ tool: 'bash', requestedMode: 'read-only', effectiveMode: 'workspace-write', justification: 'x', subject: 'command' }, approver([])),
    (error: unknown) => error instanceof EscalationRefusal && error.code === 'NOT_WIDER',
    'a narrower target is not an escalation',
  )
  await assert.rejects(
    approveEscalation({ tool: 'bash', requestedMode: 'root', effectiveMode: 'read-only', justification: 'x', subject: 'command' }, approver([])),
    (error: unknown) => error instanceof EscalationRefusal && error.code === 'MALFORMED',
    'a word outside the vocabulary is refused',
  )
})

test('the three refusal outcomes all leave the call where it was', async () => {
  for (const [outcome, code, sentence] of [
    ['rejected', 'REJECTED', /rejected/],
    ['cancelled', 'CANCELLED', /cancelled/],
    ['unavailable', 'UNAVAILABLE', /no one can approve/],
  ] as const) {
    await assert.rejects(
      approveEscalation({ tool: 'bash', requestedMode: 'workspace-write', effectiveMode: 'read-only', justification: 'x', subject: 'command' }, approver([outcome])),
      (error: unknown) => error instanceof EscalationRefusal && error.code === code && sentence.test(error.message),
      `${outcome} refuses the escalation with its own sentence`,
    )
  }
})

test('the argument pairing a schema cannot express is validated', () => {
  assert.throws(() => validateEscalationArgs('workspace-write', undefined), /requires a justification/)
  assert.throws(() => validateEscalationArgs(undefined, 'because'), /only valid together/)
  assert.throws(() => validateEscalationArgs('workspace-write', '   '), /non-empty sentence/)
  assert.doesNotThrow(() => validateEscalationArgs('workspace-write', 'the file is outside the workspace'))
})

test('the approval service answers from policy with no answerer, and from a person with one', async () => {
  const noOne = new ApprovalService(new Context(), { mode: 'ask', unanswered: 'deny', answerTimeoutMs: 50 })
  assert.equal(await noOne.request({ tool: 'bash', reason: 'x' }), 'unavailable', 'a headless run gets the unanswered answer at once')

  const serviceCtx = new Context()
  const service = new ApprovalService(serviceCtx, { mode: 'allow', answerTimeoutMs: 5_000 })
  const answered: string[] = []
  const dispose = service.attachAnswerer()
  serviceCtx.on('approval/request', (request) => {
    answered.push(request.id)
    service.answer(request.id, 'allowed-once')
  })
  assert.equal(await service.request({ tool: 'bash', reason: 'needs a wider mode', session: 's-1' }), 'allowed-once', 'an attached surface can grant it')
  assert.equal(answered.length, 1, 'one question, one answer')
  assert.equal(service.pendingRequests().length, 0, 'and nothing is left pending')
  dispose()
  assert.equal(await service.request({ tool: 'bash', reason: 'again' }), 'unavailable', 'detaching restores the headless answer')

  const timeout = new ApprovalService(new Context(), { mode: 'allow', answerTimeoutMs: 20 })
  timeout.attachAnswerer()
  assert.equal(await timeout.request({ tool: 'bash', reason: 'nobody answers' }), 'cancelled', 'an ignored question is withdrawn as cancelled')
})

test('the tool registry gates an escalation before the call runs, and the session mode never moves', async () => {
  const root = join(scratch, 'registry-workspace')
  mkdirSync(root, { recursive: true })
  const sandbox = new SandboxService(new Context(), { mode: 'workspace-write', workspaceRoot: root })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'registry-sessions') })
  const approvalsCtx = new Context()
  const approvals = new ApprovalService(approvalsCtx, { mode: 'allow', answerTimeoutMs: 5_000 })
  approvals.attachAnswerer()
  const registry = new ToolRegistry(new Context(), approvals, sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: root })
  sessions.setMode(handle, 'read-only', 'workspace-write')

  /** An answerer whose answer the test chooses; one listener, so each question is settled exactly once. */
  let nextAnswer: 'allowed-once' | 'rejected' = 'allowed-once'
  approvalsCtx.on('approval/request', (request) => approvals.answer(request.id, nextAnswer))
  const granted = await registry.call(
    'write_file',
    { path: 'escalated.txt', content: 'x', sandbox_permissions: 'workspace-write', justification: 'the session started read-only' },
    { cwd: root, session: handle, log: () => {} },
  )
  assert.equal(granted.error, undefined, `the escalation lets the one write through (${granted.error?.message ?? ''})`)
  assert.equal(sessions.effectiveMode(handle, 'workspace-write'), 'read-only', 'and the session is still read-only afterwards')

  /** A rejected escalation refuses the call and touches nothing. */
  nextAnswer = 'rejected'
  const refused = await registry.call(
    'write_file',
    { path: 'rejected.txt', content: 'x', sandbox_permissions: 'workspace-write', justification: 'try again' },
    { cwd: root, session: handle, log: () => {} },
  )
  assert.equal(refused.error?.code, 'ESCALATION_REFUSED', 'the rejected ask is the call’s result')
  assert.match(refused.error?.message ?? '', /rejected/, 'and the sentence says so')
  assert.equal(sessions.effectiveMode(handle, 'workspace-write'), 'read-only', 'with the mode untouched')

  /** The fields are advertised only where a backend can enforce a wider mode. */
  const specs = builtinTools(sandbox).map((tool) => tool.spec)
  const writeSpec = specs.find((spec) => spec.name === 'write_file')
  const properties = writeSpec?.parameters.properties as Record<string, unknown> | undefined
  if (process.platform === 'darwin') {
    assert.ok(properties?.sandbox_permissions !== undefined, 'a confining host advertises the escalation fields')
    assert.ok(properties?.justification !== undefined, 'both of them')
  }
  const unconfined = new SandboxService(new Context(), { mode: 'workspace-write', workspaceRoot: root, backend: 'none' })
  const unconfinedSpec = builtinTools(unconfined).find((tool) => tool.spec.name === 'write_file')?.spec
  assert.equal((unconfinedSpec?.parameters.properties as Record<string, unknown>)?.sandbox_permissions, undefined, 'a host that cannot confine advertises no escalation')
})
