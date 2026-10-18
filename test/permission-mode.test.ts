import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import {
  SANDBOX_MODES,
  SandboxService,
  canonical,
  isSandboxMode,
  permissionTransition,
} from '../src/sandbox/service.ts'
import { MODE_EVENT, effectiveMode, inheritRecordedMode, recordedMode } from '../src/session/mode.ts'
import { SessionStore, type SessionHandle } from '../src/session/store.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'
import { delegateSubagent } from '../src/agent/subagent.ts'

/**
 * The session-scoped access mode: the rule that decides a change, the log event that records it, and
 * the gate every tool call passes through.
 *
 * The mode was a value the sandbox fixed when it was constructed, so these tests are about the three
 * facts that make it a mechanism instead: a change is decided by one rule (and an escalation needs an
 * explicit confirmation), the decision is an append-only event that survives a new process and belongs
 * to one session, and every tool call resolves the session's mode at the one registry gate — a tool
 * argument can never widen it.
 *
 * A unit test here judges the rules in isolation; the enforcement a person can see is judged in
 * `_verifiers_/75-permission-sandbox/` (through the HTTP API and a real turn) and the control in
 * `_verifiers_/80-web-ui/check-access.mjs` (in a browser).
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-permission-mode-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let fixtures = 0
/** One sandbox, one session store, one registry and one session — the four things a tool call needs. */
function fixture(options: { readonly mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; readonly root?: string } = {}) {
  fixtures += 1
  const root = options.root ?? join(scratch, `sessions-${fixtures}`)
  const workspace = join(scratch, `workspace-${fixtures}`)
  mkdirSync(workspace, { recursive: true })
  const sandbox = new SandboxService(new Context(), { mode: options.mode ?? 'workspace-write', workspaceRoot: workspace })
  const sessions = new SessionService(new Context(), { root })
  const approvals = new ApprovalService(new Context(), { mode: 'allow' })
  const registry = new ToolRegistry(new Context(), approvals, sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  /** Every mode a tool was actually given, so "the gate resolved it" is asserted rather than assumed. */
  const seen: string[] = []
  registry.register({
    spec: { name: 'probe_mode', description: 'records the mode the gate resolved', parameters: { type: 'object' } },
    run: async (_args, context) => {
      seen.push(context.mode)
      return { output: context.mode }
    },
  })
  return { sandbox, sessions, registry, handle, workspace, seen }
}

test('the three modes are a closed vocabulary, and a per-call mode outranks the one the sandbox was built with', () => {
  assert.deepEqual([...SANDBOX_MODES], ['read-only', 'workspace-write', 'danger-full-access'], 'the vocabulary is DSH’s three words, narrowest first')
  assert.equal(isSandboxMode('read-only'), true)
  assert.equal(isSandboxMode('root'), false, 'a word outside the vocabulary is not a mode')

  const { sandbox, workspace } = fixture()
  const inside = join(workspace, 'inside.txt')
  const outside = join(scratch, 'outside.txt')

  /** The deployment mode is the default, so the old call sites keep working. */
  assert.equal(sandbox.assertWritable(inside), canonical(inside), 'workspace-write permits a write inside the workspace')
  assert.throws(() => sandbox.assertWritable(outside), /outside the sandbox root/, 'and refuses one outside it')

  /** The per-call argument is what makes a session's mode real; it is the same comparison, not a second one. */
  assert.throws(() => sandbox.assertWritable(inside, 'read-only'), /read-only/, 'read-only refuses even the inside write')
  assert.throws(() => sandbox.assertReadable(outside, 'read-only'), /cannot be read/, 'and a read outside the workspace')
  assert.equal(sandbox.assertWritable(outside, 'danger-full-access'), canonical(outside), 'full access permits the write the others refused')
})

test('the change rule: no-op changes append nothing, any narrowing is free, an escalation to full access needs the owner’s confirmation', () => {
  assert.deepEqual(
    permissionTransition('read-only', 'workspace-write', undefined),
    { ok: true, changed: true, mode: 'workspace-write' },
    'widening to workspace-write is the owner’s menu click, not a second prompt',
  )
  assert.deepEqual(
    permissionTransition('workspace-write', 'workspace-write', undefined),
    { ok: true, changed: false, mode: 'workspace-write' },
    'choosing the mode already in effect changes nothing',
  )
  assert.deepEqual(
    permissionTransition('danger-full-access', 'read-only', undefined),
    { ok: true, changed: true, mode: 'read-only' },
    'a narrowing never needs a confirmation',
  )

  const unconfirmed = permissionTransition('workspace-write', 'danger-full-access', undefined)
  assert.equal(unconfirmed.ok, false, 'an escalation to full access without the confirmation is refused')
  assert.match(unconfirmed.reason ?? '', /confirm/i, 'and the refusal says what is missing')
  assert.deepEqual(
    permissionTransition('read-only', 'danger-full-access', 'full-access'),
    { ok: true, changed: true, mode: 'danger-full-access' },
    'with the explicit confirmation the escalation is allowed',
  )

  const invalid = permissionTransition('read-only', 'root', 'full-access')
  assert.equal(invalid.ok, false, 'a mode outside the vocabulary is refused whatever the confirmation says')
})

test('a session’s mode is its last recorded event, defaulting to the deployment mode', () => {
  const { sessions, handle } = fixture()
  assert.equal(sessions.recordedMode(handle), undefined, 'a fresh session has recorded no choice')
  assert.equal(sessions.effectiveMode(handle, 'workspace-write'), 'workspace-write', 'so the deployment mode answers')

  const first = sessions.setMode(handle, 'read-only', 'workspace-write')
  assert.equal(first.changed, true, 'the first change is recorded')
  assert.equal(sessions.recordedMode(handle), 'read-only')
  assert.equal(sessions.effectiveMode(handle, 'workspace-write'), 'read-only', 'and outranks the deployment mode')

  const again = sessions.setMode(handle, 'read-only', 'workspace-write')
  assert.equal(again.changed, false, 'choosing the mode already in effect appends nothing')
  const records = sessions.events(handle).filter((event) => event.type === MODE_EVENT)
  assert.equal(records.length, 1, 'one change is one event')

  sessions.setMode(handle, 'danger-full-access', 'workspace-write')
  assert.equal(sessions.effectiveMode(handle, 'workspace-write'), 'danger-full-access', 'the last event wins')
  assert.throws(() => effectiveMode([{ seq: 0, at: '', type: MODE_EVENT, mode: 'root' }], 'workspace-write'), /root/, 'a forged mode outside the vocabulary is not silently ignored')
})

test('a mode belongs to one session and survives a fresh process', () => {
  const root = join(scratch, 'persisted-sessions')
  const workspace = join(scratch, 'persisted-workspace')
  mkdirSync(workspace, { recursive: true })
  const first = new SessionService(new Context(), { root })
  const one = first.start({ cwd: workspace })
  const two = first.start({ cwd: workspace })
  first.setMode(one, 'read-only', 'workspace-write')

  /** A new process is modelled by a new service over the same root: nothing is carried in memory. */
  const reopened = new SessionService(new Context(), { root })
  const oneAgain = reopened.store.open(one.id)
  const twoAgain = reopened.store.open(two.id)
  assert.ok(oneAgain !== null && twoAgain !== null, 'both sessions are still there')
  assert.equal(reopened.effectiveMode(oneAgain, 'workspace-write'), 'read-only', 'the changed session came back read-only')
  assert.equal(reopened.recordedMode(twoAgain), undefined, 'its neighbour never saw the change')
  assert.equal(reopened.effectiveMode(twoAgain, 'workspace-write'), 'workspace-write', 'so the deployment mode still answers for it')
})

test('every tool call is gated by the session’s mode, and a tool argument cannot widen it', async () => {
  const { sessions, registry, handle, workspace, seen } = fixture()
  sessions.setMode(handle, 'read-only', 'workspace-write')

  /**
   * The probe is a tool whose only job is to report the mode it was run under. A `write_file` call is
   * gated where its effect lands; this one is gated where every call is resolved, which is the fact
   * that makes "every tool call" true rather than "every filesystem call".
   */
  const gated = await registry.call(
    'probe_mode',
    { mode: 'danger-full-access', sandbox_permissions: 'danger-full-access', justification: 'pretend' },
    { cwd: workspace, session: handle, log: () => {} },
  )
  assert.equal(gated.output, 'read-only', 'the registry resolved the session’s mode, not the argument named in the call')
  assert.deepEqual(seen, ['read-only'], 'no widening argument reached the tool')
  assert.equal(sessions.effectiveMode(handle, 'workspace-write'), 'read-only', 'and the call did not change the session')

  const withoutSession = await registry.call('probe_mode', {}, { cwd: workspace, log: () => {} })
  assert.equal(withoutSession.output, 'workspace-write', 'a call with no session runs under the deployment mode')
})

test('a read-only session refuses the write and the shell; workspace-write permits the same write', async () => {
  const { sessions, registry, handle, workspace } = fixture()
  const context = { cwd: workspace, session: handle, log: () => {} }

  sessions.setMode(handle, 'read-only', 'workspace-write')
  const refusedWrite = await registry.call('write_file', { path: 'inside.txt', content: 'inside' }, context)
  assert.equal(refusedWrite.error?.code, 'SANDBOX', 'the write is refused with the sandbox’s code')
  assert.match(refusedWrite.error?.message ?? '', /read-only/, 'and the sentence names the mode')
  assert.equal(existsSync(join(workspace, 'inside.txt')), false, 'and nothing landed on disk')

  const refusedShell = await registry.call('bash', { command: 'echo hi' }, context)
  assert.equal(refusedShell.error?.code, 'SANDBOX', 'read-only refuses the shell too')
  assert.match(refusedShell.error?.message ?? '', /shell/, 'because a shell is not confined by this sandbox')

  sessions.setMode(handle, 'workspace-write', 'workspace-write')
  const allowedWrite = await registry.call('write_file', { path: 'inside.txt', content: 'inside' }, context)
  assert.equal(allowedWrite.error, undefined, 'workspace-write permits the same write')
  assert.equal(existsSync(join(workspace, 'inside.txt')), true, 'and it landed')
  const allowedShell = await registry.call('bash', { command: 'echo hi' }, context)
  assert.equal(allowedShell.error, undefined, 'and permits the shell')
  assert.match(allowedShell.output, /hi/, 'which ran')
})

test('a delegated child inherits the parent’s mode, so read-only cannot be widened by spawning a child', async () => {
  /**
   * A child session is created with no `permission/mode` event, so without inheritance it would run under the
   * **deployment default** — a `read-only` parent could delegate a write and the mode would hold only for the
   * parent's own calls. Both spawn paths call `inheritRecordedMode` immediately after the child exists; this
   * judges the rule and the subagent path end to end with a fake child run.
   */
  const root = join(scratch, 'inheritance-sessions')
  const store = new SessionStore(root)
  const parent = store.create({ cwd: scratch })
  store.append(parent, { type: MODE_EVENT, mode: 'read-only' })
  const deps = {
    store,
    run: async (child: SessionHandle) => {
      store.append(child, { type: 'assistant/completed', text: 'child answer' })
    },
  }
  const delegated = await delegateSubagent(deps, parent, 'a scoped task', { maxDepth: 2, maxActive: 1 })
  const child = store.open(delegated.childSession)
  assert.ok(child !== null, 'the child session exists')
  assert.equal(recordedMode(store.read(child)), 'read-only', 'the child inherited the parent’s narrowing')
  assert.equal(effectiveMode(store.read(child), 'workspace-write'), 'read-only', 'so the deployment default cannot widen it')

  /** A parent that never recorded a mode inherits nothing, because its own effective mode IS the deployment default. */
  const plain = store.create({ cwd: scratch })
  const second = await delegateSubagent(deps, plain, 'another task', { maxDepth: 2, maxActive: 1 })
  const other = store.open(second.childSession)
  assert.ok(other !== null, 'the second child exists')
  assert.equal(recordedMode(store.read(other)), undefined, 'nothing to inherit, so no event is appended')

  /** The helper is idempotent for the caller's purposes: a second call appends a second identical event. */
  const direct = store.create({ cwd: scratch })
  assert.equal(inheritRecordedMode(store, parent, direct), 'read-only', 'the helper answers with the inherited mode')
  assert.equal(recordedMode(store.read(direct)), 'read-only')
})
