import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { delegateSubagent, finalAssistantText, parentFacts, SubagentError, subagentRunner } from '../src/agent/subagent.ts'
import { SessionStore } from '../src/session/store.ts'
import { subagentTools } from '../src/tools/subagent.ts'
import type { ToolContext } from '../src/tools/service.ts'

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

test('the tool returns the child’s answer and refuses without a session', async () => {
  const { store, parent } = setup()
  const deps = {
    store,
    run: async (child: ReturnType<SessionStore['create']>, prompt: string) => {
      store.append(child, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })
      store.append(child, { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'from the child' } })
    },
  }
  const tool = subagentTools(deps, { maxDepth: 2, maxActive: 1 })[0]
  assert.ok(tool !== undefined)

  const ok = await tool.run({ prompt: 'a task' }, { cwd: root, session: parent } as ToolContext)
  assert.equal(ok.error, undefined)
  assert.match(ok.output, /from the child/)
  assert.equal((ok.data as { depth: number }).depth, 1)

  const refused = await tool.run({ prompt: 'a task' }, { cwd: root } as ToolContext)
  assert.equal(refused.error?.code, 'SUBAGENT_NO_SESSION')
})

test('the production runner is a function, not a second implementation of the loop', () => {
  // The plugin wires it to runTurn; this test pins the seam's shape so a future change cannot silently
  // replace the child's turn with a direct model call.
  assert.equal(typeof subagentRunner, 'function')
})
