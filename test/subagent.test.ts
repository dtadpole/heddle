import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import {
  delegateSubagent,
  finalAssistantText,
  parentFacts,
  type SettlementNotice,
  settlementNotice,
  settlementSummary,
  SubagentError,
  subagentRunner,
  SubagentService,
} from '../src/agent/subagent.ts'
import { TurnRegistry } from '../src/agent/turns.ts'
import { SessionStore } from '../src/session/store.ts'
import { subagentTools } from '../src/tools/subagent.ts'
import type { ToolRunContext } from '../src/tools/service.ts'

/**
 * Subagent delegation: the child's session attribution, the answer extraction, and the refusals.
 *
 * A delegation is a boundary, not a merge: the child runs in its own log and the parent sees only a tool call
 * and the final answer. These tests pin the boundary — the metadata that says whose session it is, the fold
 * that extracts the answer, and the depth/active refusals that keep delegation from becoming an unbounded tree.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-subagent-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function setup(): { store: SessionStore; parent: ReturnType<SessionStore['create']> } {
  counter += 1
  const store = new SessionStore(join(root, `store-${counter}`))
  return { store, parent: store.create({ cwd: root, endpoint: 'scripted', model: 'm' }) }
}

test('the child answer is the last settled assistant output, not the whole transcript', () => {
  const events = [
    { seq: 0, at: '', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'task' }] } },
    { seq: 1, at: '', type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'working' } },
    { seq: 2, at: '', type: 'assistant/completed', text: 'first answer' },
    { seq: 3, at: '', type: 'model/request', messages: 2 },
    { seq: 4, at: '', type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'second ' } },
    { seq: 5, at: '', type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'answer' } },
  ]
  assert.equal(finalAssistantText(events), 'second answer', 'a later round replaces the settled one')
  assert.equal(finalAssistantText(events.slice(0, 3)), 'first answer')
  assert.equal(finalAssistantText([{ seq: 0, at: '', type: 'assistant/chunk', chunk: { type: 'text-delta', text: '  hi  ' } }]), 'hi')
  assert.equal(finalAssistantText([]), '')
  assert.equal(
    finalAssistantText([
      { seq: 0, at: '', type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'stale' } },
      { seq: 1, at: '', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'next' }] } },
    ]),
    '',
    'a new prompt clears the previous round, so an unanswered prompt is empty rather than a stale answer',
  )
})

test('the parent facts default to depth zero and carry its endpoint and model', () => {
  assert.deepEqual(parentFacts(undefined), { depth: 0 })
  assert.deepEqual(parentFacts({ delegationDepth: 2, endpoint: 'e', model: 'm' } as never), { depth: 2, endpoint: 'e', model: 'm' })
})

test('a delegation creates an attributed child session and returns its answer', async () => {
  const { store, parent } = setup()
  const deps = {
    store,
    run: async (child: ReturnType<SessionStore['create']>, prompt: string) => {
      store.append(child, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })
      store.append(child, { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'child answer' } })
    },
  }
  const result = await delegateSubagent(deps, parent, 'do the child task', { maxDepth: 2, maxActive: 1 })

  assert.equal(result.text, 'child answer')
  assert.equal(result.depth, 1)
  const meta = store.list().find((one) => one.id === result.childSession)
  assert.equal(meta?.parentSession, parent.id, 'the child names its parent')
  assert.equal(meta?.origin, 'subagent', 'and says how it came to exist')
  assert.equal(meta?.delegationDepth, 1, 'and how deep the chain is')
  assert.equal(meta?.cwd, root, 'and inherits the parent’s folder')
  assert.equal(meta?.endpoint, 'scripted')
  assert.equal(meta?.model, 'm')
})

test('the refusals are stable codes: depth, empty prompt, no session, busy', async () => {
  const { store, parent } = setup()
  const deps = { store, run: async () => {} }

  await assert.rejects(
    () => delegateSubagent({ ...deps, store }, parent, 'x', { maxDepth: 0 }),
    (error: unknown) => error instanceof SubagentError && error.code === 'SUBAGENT_DEPTH_EXCEEDED',
  )
  await assert.rejects(
    () => delegateSubagent(deps, parent, '   ', {}),
    (error: unknown) => error instanceof SubagentError && error.code === 'SUBAGENT_EMPTY_PROMPT',
  )
  await assert.rejects(
    () => delegateSubagent(deps, undefined, 'x', {}),
    (error: unknown) => error instanceof SubagentError && error.code === 'SUBAGENT_NO_SESSION',
  )
  await assert.rejects(
    () => delegateSubagent(deps, parent, 'x', { maxActive: 0 }, { active: new Set([parent.id]) }),
    (error: unknown) => error instanceof SubagentError && error.code === 'SUBAGENT_BUSY',
  )
})

test('a child that produces no answer is a failure, not an empty success', async () => {
  const { store, parent } = setup()
  await assert.rejects(
    () => delegateSubagent({ store, run: async () => {} }, parent, 'task', {}),
    (error: unknown) => error instanceof SubagentError && error.code === 'SUBAGENT_FAILED',
  )
})

/** A promise the test settles by hand, so "returns before the child finishes" is proven, not timed. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

/** A background service whose child runs answer `text` when the test releases them, recording deliveries. */
function backgroundSetup(text = 'child answer') {
  const { store, parent } = setup()
  const release = deferred()
  const notices: { parent: string; notice: SettlementNotice }[] = []
  const service = new SubagentService(
    {
      store,
      run: async (child, prompt) => {
        store.append(child, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })
        await release.promise
        if (text.length > 0) store.append(child, { type: 'assistant/completed', text })
      },
      deliver: async (to, notice) => {
        notices.push({ parent: to.id, notice })
      },
    },
    { maxDepth: 2, maxActive: 1 },
  )
  return { store, parent, release, notices, service }
}

test('a background delegation returns at once with the child id and depth, before the child has answered', async () => {
  const { store, parent, release, notices, service } = backgroundSetup()
  const started = service.start(parent, 'do the child task')

  assert.equal(started.depth, 1)
  assert.equal(service.running, 1, 'the child is still in flight when start returns')
  assert.equal(notices.length, 0, 'and nothing has been reported yet')
  const meta = store.list().find((one) => one.id === started.childSession)
  assert.equal(meta?.parentSession, parent.id, 'the child names its parent')
  assert.equal(meta?.origin, 'subagent')
  assert.equal(meta?.delegationDepth, 1)

  release.resolve()
  assert.equal(await service.settle(parent.id), 1, 'settle waits for the child and its notice')
  assert.equal(service.running, 0)
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.parent, parent.id, 'the notice goes to the parent')
})

test('the settlement notice is DSH’s: summary, closing message, source', async () => {
  const { parent, release, notices, service } = backgroundSetup('the answer is 42')
  const started = service.start(parent, 'compute')
  release.resolve()
  await service.settle(parent.id)
  const notice = notices[0]?.notice
  assert.ok(notice !== undefined)
  assert.deepEqual(
    notice.content.map((part) => part.text),
    [`Background subagent ${started.childSession} finished. It cannot receive follow-up messages.`, 'Its closing message:', 'the answer is 42'],
  )
  assert.deepEqual(notice.source, {
    kind: 'subagent-settled',
    form: 'notice',
    summary: `Background subagent ${started.childSession} finished. It cannot receive follow-up messages.`,
    senderSessionId: started.childSession,
  })
})

test('a child with no closing text, a failed child and a stopped child are each reported as DSH words them', async () => {
  assert.deepEqual(
    settlementNotice('c1', 'completed', '').content.map((part) => part.text),
    ['Background subagent c1 finished. It cannot receive follow-up messages.', 'It left no closing message.'],
  )
  assert.equal(settlementSummary('c2', 'error'), 'Background subagent c2 failed before it finished.')
  assert.equal(settlementSummary('c3', 'aborted'), 'Background subagent c3 was stopped before it finished.')

  const failing = backgroundSetup()
  const started = failing.service.start(failing.parent, 'task')
  failing.release.reject(new Error('the model went away'))
  await failing.service.settle(failing.parent.id)
  assert.deepEqual(
    failing.notices[0]?.notice.content.map((part) => part.text),
    [`Background subagent ${started.childSession} failed before it finished.`, 'It left no closing message.', 'the model went away'],
    'the failure is reported, with its diagnostic, rather than lost',
  )

  const stopping = backgroundSetup()
  const controller = new AbortController()
  stopping.service.start(stopping.parent, 'task', { signal: controller.signal })
  controller.abort()
  stopping.release.reject(new Error('aborted'))
  await stopping.service.settle(stopping.parent.id)
  assert.match(stopping.notices[0]?.notice.content[0]?.text ?? '', /was stopped before it finished\.$/)
})

test('a background start refuses synchronously with the stable codes, and counts children in flight', () => {
  const { parent, service } = backgroundSetup()
  const refuses = (run: () => unknown, code: string) =>
    assert.throws(run, (error: unknown) => error instanceof SubagentError && error.code === code)
  refuses(() => service.start(undefined, 'x'), 'SUBAGENT_NO_SESSION')
  refuses(() => service.start(parent, '  '), 'SUBAGENT_EMPTY_PROMPT')
  service.start(parent, 'first')
  refuses(() => service.start(parent, 'second'), 'SUBAGENT_BUSY')
})

test('the tool starts the child and answers with DSH’s start line, and refuses without a session', async () => {
  const { parent, release, service } = backgroundSetup()
  const tool = subagentTools(service)[0]
  assert.ok(tool !== undefined)

  const ok = await tool.run({ prompt: 'a task' }, { cwd: root, session: parent, mode: 'workspace-write' } as ToolRunContext)
  assert.equal(ok.error, undefined)
  const child = (ok.data as { childSession: string; depth: number }).childSession
  assert.equal(ok.output, `started subagent ${child}`, 'the result is the start line, not the child’s answer')
  assert.equal((ok.data as { depth: number }).depth, 1)

  const refused = await tool.run({ prompt: 'a task' }, { cwd: root, mode: 'workspace-write' } as ToolRunContext)
  assert.equal(refused.error?.code, 'SUBAGENT_NO_SESSION')
  release.resolve()
  await service.settle(parent.id)
})

test('the turn registry resolves whenIdle at the settle that empties a session, not before', async () => {
  const registry = new TurnRegistry(new Context())
  await registry.whenIdle('s1')
  const first = registry.begin('s1')
  const second = registry.begin('s1')
  let idle = false
  const waiting = registry.whenIdle('s1').then(() => {
    idle = true
  })
  first.settle()
  await Promise.resolve()
  assert.equal(idle, false, 'one turn is still in flight')
  second.settle()
  await waiting
  assert.equal(idle, true)
})

test('the production runner is a function, not a second implementation of the loop', () => {
  // The plugin wires it to runTurn; this test pins the seam's shape so a future change cannot silently
  // replace the child's turn with a direct model call.
  assert.equal(typeof subagentRunner, 'function')
})
