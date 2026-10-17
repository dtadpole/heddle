import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { SessionStore, type SessionHandle } from '../src/session/store.ts'
import { TeamService, type TeamDeps } from '../src/team/service.ts'
import { teamTools, TEAM_TOOL_NAMES } from '../src/team/tool.ts'
import type { ToolContext, ToolDefinition } from '../src/tools/service.ts'

/**
 * The nine model-facing team tools: argument translation, the service's refusals surfacing as stable codes, the
 * status/wait answers, and the policy hook. A real service over a fake store and a fake `run`, so the tools are
 * judged through the same service a Lead's turn would use.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-team-tools-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
interface Harness {
  readonly store: SessionStore
  readonly lead: SessionHandle
  readonly service: TeamService
  readonly tools: Map<string, ToolDefinition>
  readonly running: Set<string>
  readonly aborted: string[]
  readonly spawnHooks: string[]
}

function harness(): Harness {
  counter += 1
  const store = new SessionStore(join(root, `store-${counter}`))
  const lead = store.create({ cwd: root, endpoint: 'scripted', model: 'm' })
  const running = new Set<string>()
  const aborted: string[] = []
  const spawnHooks: string[] = []
  const deps: TeamDeps = {
    store,
    turns: { isRunning: (id) => running.has(id), abort: (id) => (aborted.push(id), running.delete(id)) },
    run: async (child, prompt, source) => {
      store.message(child, { role: 'user', content: [{ type: 'text', text: prompt }], ...(source !== undefined ? { source } : {}) })
      store.append(child, { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'ok' } })
    },
  }
  const service = new TeamService(deps)
  const tools = new Map(teamTools(service, { onSpawn: (leadId, memberId) => spawnHooks.push(`${leadId}:${memberId}`) }).map((tool) => [tool.spec.name, tool]))
  return { store, lead, service, tools, running, aborted, spawnHooks }
}

const call = async (h: Harness, name: string, args: Record<string, unknown> = {}, context?: Partial<ToolContext>) => {
  const tool = h.tools.get(name)
  assert.ok(tool !== undefined, `tool ${name} is registered`)
  return tool.run(args, { cwd: root, session: h.lead, ...context } as ToolContext)
}

const json = (result: { output: string }) => JSON.parse(result.output)

test('the nine tools are exactly DSH’s set, and each refuses without a session', async () => {
  const h = harness()
  assert.deepEqual([...h.tools.keys()], [...TEAM_TOOL_NAMES])
  for (const name of TEAM_TOOL_NAMES) {
    const result = await call(h, name, {}, { session: undefined })
    assert.equal(result.error?.code, 'TEAM_NO_SESSION', `${name} needs a session`)
  }
})

test('spawn_teammate creates the member, reports it, and runs the policy hook', async () => {
  const h = harness()
  const result = await call(h, 'spawn_teammate', { name: 'alpha', description: 'the helper', prompt: 'start' })
  assert.equal(result.error, undefined)
  const view = json(result) as { id: string; name: string; role: string }
  assert.equal(view.name, 'alpha')
  assert.equal(view.role, 'teammate')
  assert.deepEqual(h.spawnHooks, [`${h.lead.id}:${view.id}`], 'the profile made the policy durable for the child')
})

test('Lead-only tools refuse from a teammate, and the refusal is a code the model can read', async () => {
  const h = harness()
  const spawned = await call(h, 'spawn_teammate', { name: 'alpha', description: 'x', prompt: 'go' })
  const memberId = (json(spawned) as { id: string }).id
  const member = h.store.open(memberId) as SessionHandle

  const spawn = await call(h, 'spawn_teammate', { name: 'beta', description: 'x', prompt: 'go' }, { session: member })
  assert.equal(spawn.error?.code, 'TEAM_LEAD_REQUIRED')
  const interrupt = await call(h, 'interrupt_agent', { target: 'lead' }, { session: member })
  assert.equal(interrupt.error?.code, 'TEAM_LEAD_REQUIRED')
})

test('send_message reports accepted or queued, and self-messages are refused', async () => {
  const h = harness()
  await call(h, 'spawn_teammate', { name: 'alpha', description: 'x', prompt: 'go' })
  const sent = await call(h, 'send_message', { target: 'alpha', message: 'hello' })
  assert.equal(sent.error, undefined)
  assert.equal((json(sent) as { status: string }).status, 'accepted')
  const self = await call(h, 'send_message', { target: 'lead', message: 'hello' })
  assert.equal(self.error?.code, 'TEAM_SELF_MESSAGE')
})

test('list_agents reports the Lead and teammates with live status', async () => {
  const h = harness()
  const spawned = await call(h, 'spawn_teammate', { name: 'alpha', description: 'x', prompt: 'go' })
  const memberId = (json(spawned) as { id: string }).id
  h.running.add(memberId)
  const list = json(await call(h, 'list_agents')) as { name: string; role: string; status: string }[]
  assert.deepEqual(list.map((member) => [member.name, member.role, member.status]), [
    ['lead', 'lead', 'inactive'],
    ['alpha', 'teammate', 'running'],
  ])
})

test('wait_agent answers noProgress, changed and timedOut as text the model can act on', async () => {
  const h = harness()
  await call(h, 'spawn_teammate', { name: 'alpha', description: 'x', prompt: 'go' })
  const idle = await call(h, 'wait_agent', { timeout_ms: 10 })
  assert.match(idle.output, /noProgress/)

  // A member that is provisioning makes progress possible; a task write is the change that wakes the wait.
  h.store.create({ id: 'session-provisioning', parentSession: h.lead.id, origin: 'subagent', delegationDepth: 1, teamId: h.lead.id, cwd: root })
  h.store.append(h.lead, { type: 'team/member', version: 2, teamId: h.lead.id, member: { id: 'session-provisioning', name: 'beta', description: 'x', context: 'fresh', phase: 'provisioning' } })
  const changed = call(h, 'wait_agent', { timeout_ms: 2_000 })
  setTimeout(() => void call(h, 'team_task_create', { subject: 'wake up' }), 10)
  assert.match((await changed).output, /changed/)

  const timed = await call(h, 'wait_agent', { timeout_ms: 10 })
  assert.match(timed.output, /timedOut/)
})

test('interrupt_agent stops the target through the live-turn registry', async () => {
  const h = harness()
  const spawned = await call(h, 'spawn_teammate', { name: 'alpha', description: 'x', prompt: 'go' })
  const memberId = (json(spawned) as { id: string }).id
  h.running.add(memberId)
  const result = await call(h, 'interrupt_agent', { target: 'alpha' })
  assert.equal(result.error, undefined)
  assert.equal((json(result) as { previousStatus: string }).previousStatus, 'running')
  assert.deepEqual(h.aborted, [memberId])
  const unknown = await call(h, 'interrupt_agent', { target: 'nobody' })
  assert.equal(unknown.error?.code, 'TEAM_MEMBER_INVALID')
})

test('the task tools create, read, list and compare-and-set a task', async () => {
  const h = harness()
  const created = json(await call(h, 'team_task_create', { subject: 'write it', write_scopes: ['src/team'] })) as { id: string; revision: number; status: string }
  assert.equal(created.id, 'task-1')
  assert.equal(created.status, 'pending')

  const got = json(await call(h, 'team_task_get', { task_id: 'task-1' })) as { id: string }
  assert.equal(got.id, 'task-1')
  assert.equal((await call(h, 'team_task_get', { task_id: 'task-404' })).error?.code, 'TEAM_TASK_MISSING')

  const claimed = json(await call(h, 'team_task_update', { task_id: 'task-1', revision: 1, action: 'claim' })) as { status: string; ownerName: string }
  assert.equal(claimed.status, 'in_progress')
  assert.equal(claimed.ownerName, 'lead')
  assert.equal((await call(h, 'team_task_update', { task_id: 'task-1', revision: 1, action: 'complete' })).error?.code, 'TEAM_TASK_STALE')

  const completed = json(await call(h, 'team_task_update', { task_id: 'task-1', revision: 2, action: 'complete' })) as { status: string }
  assert.equal(completed.status, 'completed')
  const listed = json(await call(h, 'team_task_list', { status: 'completed' })) as { id: string }[]
  assert.deepEqual(listed.map((task) => task.id), ['task-1'])
})

test('reassign names an owner through the tool and refuses an unknown member', async () => {
  const h = harness()
  const spawned = await call(h, 'spawn_teammate', { name: 'alpha', description: 'x', prompt: 'go' })
  const memberId = (json(spawned) as { id: string }).id
  await call(h, 'team_task_create', { subject: 'hand over' })
  const reassigned = json(await call(h, 'team_task_update', { task_id: 'task-1', revision: 1, action: 'reassign', owner: 'alpha' })) as { ownerName: string; status: string }
  assert.equal(reassigned.ownerName, 'alpha')
  assert.equal(reassigned.status, 'in_progress')
  assert.equal((await call(h, 'team_task_update', { task_id: 'task-1', revision: 2, action: 'reassign', owner: 'nobody' })).error?.code, 'TEAM_MEMBER_INVALID')
  assert.equal(memberId.length > 0, true)
})

test('a non-team failure becomes TEAM_FAILED rather than escaping as an exception', async () => {
  const h = harness()
  ;(h.service as unknown as { list: () => never }).list = () => {
    throw new Error('boom')
  }
  const result = await call(h, 'list_agents')
  assert.equal(result.error?.code, 'TEAM_FAILED')
  assert.match(result.error?.message ?? '', /boom/)
})
