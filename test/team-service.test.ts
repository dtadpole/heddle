import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { SessionStore, type SessionHandle } from '../src/session/store.ts'
import { TeamService, type TeamDeps } from '../src/team/service.ts'
import { TeamError, TEAM_EVENT_VERSION, type TeamMemberSnapshot } from '../src/team/state.ts'

/**
 * The team service over fakes: a session store, a recorder standing in for `runTurn`, and a set standing in for
 * the live-turn registry. No model and no clock, so the claims are about the service's own rules — who may
 * spawn, what a delivery must prove, where a queue waits, and how a teammate's turn is interrupted.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-team-service-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0

interface Harness {
  readonly store: SessionStore
  readonly lead: SessionHandle
  readonly service: TeamService
  readonly running: Set<string>
  readonly aborted: string[]
  readonly warnings: string[]
  readonly runCalls: { readonly session: string; readonly prompt: string; readonly source: unknown }[]
}

function harness(limits: TeamDeps['limits'] = {}): Harness {
  counter += 1
  const store = new SessionStore(join(root, `store-${counter}`))
  const lead = store.create({ cwd: root, endpoint: 'scripted', model: 'm' })
  const running = new Set<string>()
  const aborted: string[] = []
  const warnings: string[] = []
  const runCalls: { session: string; prompt: string; source: unknown }[] = []
  const deps: TeamDeps = {
    store,
    limits: limits ?? {},
    warn: (message) => warnings.push(message),
    turns: {
      isRunning: (id) => running.has(id),
      abort: (id) => {
        aborted.push(id)
        return running.delete(id)
      },
    },
    run: async (child, prompt, source) => {
      runCalls.push({ session: child.id, prompt, source })
      store.message(child, { role: 'user', content: [{ type: 'text', text: prompt }], ...(source !== undefined ? { source } : {}) })
      store.append(child, { type: 'assistant/chunk', chunk: { type: 'text-delta', text: `answer:${prompt}` } })
    },
  }
  return { store, lead, running, aborted, warnings, runCalls, service: new TeamService(deps) }
}

const memberMeta = (store: SessionStore, id: string) => store.list().find((meta) => meta.id === id)

function addProvisioning(store: SessionStore, lead: SessionHandle, name: string): SessionHandle {
  const child = store.create({ id: `session-${name}-${counter}`, parentSession: lead.id, origin: 'subagent', delegationDepth: 1, teamId: lead.id, cwd: root })
  const member: TeamMemberSnapshot = { id: child.id, name, description: 'x', context: 'fresh', phase: 'provisioning' }
  store.append(lead, { type: 'team/member', version: TEAM_EVENT_VERSION, teamId: lead.id, member })
  return child
}

test('spawn creates an attributed teammate session and journals it provisioning then active', () => {
  const h = harness()
  const view = h.service.spawn(h.lead, { name: 'alpha', description: 'the first teammate', prompt: 'start working' })

  assert.equal(view.name, 'alpha')
  assert.equal(view.role, 'teammate')
  assert.equal(view.status, 'inactive', 'the fake turn finished, so nothing is running')
  const meta = memberMeta(h.store, view.id)
  assert.equal(meta?.teamId, h.lead.id, 'the child names its team')
  assert.equal(meta?.parentSession, h.lead.id, 'and its parent session')
  assert.equal(meta?.origin, 'subagent')
  assert.equal(meta?.delegationDepth, 1)
  const child = h.store.open(view.id)
  assert.ok(child !== null)
  assert.ok(
    h.store.read(child).some((event) => (event.message as { role?: string } | undefined)?.role === 'user'),
    'the initial prompt is durable in the child log',
  )
  const state = h.service.state(h.lead)
  assert.deepEqual(state.members.map((member) => member.phase), ['active'])
  assert.equal(h.runCalls.length, 1)
})

test('only the Lead may spawn, and a teammate cannot spawn a peer', () => {
  const h = harness()
  const teammate = h.service.spawn(h.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  const child = h.store.open(teammate.id)
  assert.ok(child !== null)
  assert.throws(
    () => h.service.spawn(child, { name: 'beta', description: 'x', prompt: 'go' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_LEAD_REQUIRED',
  )
})

test('spawn honours maxMembers, and a failed spawn settles the member as failed', () => {
  const limited = harness({ maxMembers: 1 })
  limited.service.spawn(limited.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  assert.throws(
    () => limited.service.spawn(limited.lead, { name: 'beta', description: 'x', prompt: 'go' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_LIMIT',
  )

  const h = harness()
  const original = h.store.create.bind(h.store)
  ;(h.store as unknown as { create: typeof h.store.create }).create = (options) => {
    if (options?.teamId !== undefined) throw new Error('disk is full')
    return original(options)
  }
  assert.throws(() => h.service.spawn(h.lead, { name: 'alpha', description: 'x', prompt: 'go' }), /disk is full/)
  const state = h.service.state(h.lead)
  assert.equal(state.members[0]?.phase, 'failed')
  assert.match(String(state.members[0]?.error), /disk is full/)
})

test('a fork teammate starts from the Lead’s history, a fresh one starts empty', () => {
  const h = harness()
  h.store.message(h.lead, { role: 'user', content: [{ type: 'text', text: 'earlier work' }] })
  const fresh = h.service.spawn(h.lead, { name: 'alpha', description: 'x', prompt: 'go', context: 'fresh' })
  const forked = h.service.spawn(h.lead, { name: 'beta', description: 'x', prompt: 'go', context: 'fork' })
  const freshLog = h.store.read(h.store.open(fresh.id) as SessionHandle)
  const forkedLog = h.store.read(h.store.open(forked.id) as SessionHandle)
  assert.ok(!freshLog.some((event) => JSON.stringify(event).includes('earlier work')), 'a fresh teammate does not inherit')
  assert.ok(forkedLog.some((event) => JSON.stringify(event).includes('earlier work')), 'a forked teammate inherits the Lead history')
})

test('sending to an idle teammate starts a turn, and delivery is proven by the target log', async () => {
  const h = harness()
  const alpha = h.service.spawn(h.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  h.runCalls.length = 0

  const sent = await h.service.send(h.lead, { target: 'alpha', content: [{ type: 'text', text: 'do the next thing' }] })
  assert.equal(sent.status, 'accepted')
  assert.equal(h.runCalls.length, 1, 'the idle teammate was given a turn')
  const child = h.store.open(alpha.id) as SessionHandle
  const delivered = h.store.read(child).filter((event) => (event.message as { source?: { kind?: string } } | undefined)?.source?.kind === 'team-message')
  assert.equal(delivered.length, 1)
  const state = h.service.state(h.lead)
  assert.deepEqual(state.delivered, [sent.messageId], 'the delivery was journaled only after the target log showed it')
  assert.equal(state.messages.length, 1)
})

test('mail to a provisioning member is queued, then delivered when recover settles it', async () => {
  const h = harness()
  const child = addProvisioning(h.store, h.lead, 'beta')
  h.store.message(child, { role: 'user', content: [{ type: 'text', text: 'warm-up' }] })

  const sent = await h.service.send(h.lead, { target: 'beta', content: [{ type: 'text', text: 'later' }] })
  assert.equal(sent.status, 'queued', 'a provisioning member has no turn to deliver into')
  assert.equal(h.service.state(h.lead).delivered.length, 0)

  const recovered = await h.service.recover(h.lead)
  assert.equal(recovered.settled, 1)
  assert.equal(recovered.delivered, 1)
  assert.equal(h.service.state(h.lead).members[0]?.phase, 'active')
  assert.deepEqual(h.service.state(h.lead).delivered, [sent.messageId])
})

test('recover fails a provisioning member whose child session never accepted a prompt', async () => {
  const h = harness()
  addProvisioning(h.store, h.lead, 'ghost')
  const recovered = await h.service.recover(h.lead)
  assert.equal(recovered.settled, 1)
  const state = h.service.state(h.lead)
  assert.equal(state.members[0]?.phase, 'failed')
  assert.match(String(state.members[0]?.error), /resumable child session/)
})

test('self messages, unknown targets and the mailbox caps are refusals', async () => {
  const h = harness()
  h.service.spawn(h.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  await assert.rejects(
    () => h.service.send(h.lead, { target: 'lead', content: [{ type: 'text', text: 'me' }] }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_SELF_MESSAGE',
  )
  await assert.rejects(
    () => h.service.send(h.lead, { target: 'nobody', content: [{ type: 'text', text: 'x' }] }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_MEMBER_INVALID',
  )
  const tiny = harness({ maxMessageBytes: 4 })
  tiny.service.spawn(tiny.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  await assert.rejects(
    () => tiny.service.send(tiny.lead, { target: 'alpha', content: [{ type: 'text', text: 'more than four bytes' }] }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_MESSAGE_TOO_LARGE',
  )
  const full = harness({ maxPendingMessagesPerMember: 0 })
  full.service.spawn(full.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  await assert.rejects(
    () => full.service.send(full.lead, { target: 'alpha', content: [{ type: 'text', text: 'x' }] }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_MAILBOX_FULL',
  )
})

test('the task board goes through the service with journaling and revision checks', () => {
  const h = harness()
  h.service.spawn(h.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  const created = h.service.createTask(h.lead, { subject: 'write the thing' })
  assert.equal(created.id, 'task-1')
  assert.equal(created.status, 'pending')
  const claimed = h.service.updateTask(h.lead, { taskId: created.id, revision: 1, action: 'claim' })
  assert.equal(claimed.status, 'in_progress')
  assert.equal(claimed.ownerName, 'lead')
  assert.throws(
    () => h.service.updateTask(h.lead, { taskId: created.id, revision: 1, action: 'complete' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_TASK_STALE',
  )
  const completed = h.service.updateTask(h.lead, { taskId: created.id, revision: 2, action: 'complete' })
  assert.equal(completed.status, 'completed')
})

test('status comes from the durable phase and the live-turn registry', () => {
  const h = harness()
  const alpha = h.service.spawn(h.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  h.running.add(alpha.id)
  assert.equal(h.service.list(h.lead).find((member) => member.name === 'alpha')?.status, 'running')
  h.running.delete(alpha.id)
  assert.equal(h.service.list(h.lead).find((member) => member.name === 'alpha')?.status, 'inactive')
  h.running.add(h.lead.id)
  assert.equal(h.service.list(h.lead).find((member) => member.role === 'lead')?.status, 'running')
})

test('wait is level-triggered: noProgress when nobody can act, changed on a journal write, timeout otherwise', async () => {
  const idle = harness()
  idle.service.spawn(idle.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  assert.deepEqual(await idle.service.waitForChange(idle.lead, 10), { noProgress: true })

  const h = harness()
  addProvisioning(h.store, h.lead, 'beta')
  const changed = h.service.waitForChange(h.lead, 500)
  setTimeout(() => h.service.createTask(h.lead, { subject: 'wake up' }), 10)
  assert.deepEqual(await changed, { changed: true })

  const timed = h.service.waitForChange(h.lead, 20)
  assert.deepEqual(await timed, { timedOut: true })
})

test('interrupt is Lead-only and stops the target’s turn without touching its mail', async () => {
  const h = harness()
  const alpha = h.service.spawn(h.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  h.running.add(alpha.id)
  const sent = await h.service.send(h.lead, { target: 'alpha', content: [{ type: 'text', text: 'one' }] })
  assert.equal(sent.status, 'accepted', 'mid-turn delivery is a steer, so it counts as accepted')

  const child = h.store.open(alpha.id)
  assert.ok(child !== null)
  assert.throws(
    () => h.service.interrupt(child, 'alpha'),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_LEAD_REQUIRED',
  )
  const result = h.service.interrupt(h.lead, 'alpha')
  assert.deepEqual(result, { previousStatus: 'running' })
  assert.deepEqual(h.aborted, [alpha.id])
  assert.equal(h.service.state(h.lead).messages.length, 1, 'the inbox is untouched by an interrupt')
  assert.throws(
    () => h.service.interrupt(h.lead, 'nobody'),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_MEMBER_INVALID',
  )
})

test('a teammate can message its Lead through the same mailbox', async () => {
  const h = harness()
  const alpha = h.service.spawn(h.lead, { name: 'alpha', description: 'x', prompt: 'go' })
  const child = h.store.open(alpha.id) as SessionHandle
  const sent = await h.service.send(child, { target: 'lead', content: [{ type: 'text', text: 'reporting in' }] })
  assert.equal(sent.status, 'accepted')
  const leadLog = h.store.read(h.lead)
  assert.ok(leadLog.some((event) => JSON.stringify(event).includes('reporting in')), 'the Lead’s own log accepted the message')
  assert.equal(h.service.leadOf(child).id, h.lead.id, 'a teammate resolves its team’s Lead')
})

test('a corrupt team is reported by recoverAll and does not stop the healthy ones', async () => {
  const h = harness()
  // A team whose log the fold refuses: a member that is active without ever being provisioning.
  const broken = h.store.create({ cwd: root, endpoint: 'scripted' })
  const ghost = h.store.create({ id: `session-broken-${counter}`, cwd: root, parentSession: broken.id, origin: 'subagent', delegationDepth: 1, teamId: broken.id })
  h.store.append(broken, {
    type: 'team/member',
    version: TEAM_EVENT_VERSION,
    teamId: broken.id,
    member: { id: ghost.id, name: 'broken', description: 'x', context: 'fresh', phase: 'active' },
  })
  h.service.spawn(h.lead, { name: 'alpha', description: 'x', prompt: 'go' })

  const recovered = await h.service.recoverAll([broken, h.lead])
  assert.equal(recovered.failed, 1, 'the corrupt team is counted as failed')
  assert.equal(recovered.recovered, 1, 'the healthy team was still recovered')
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0] ?? '', /must start provisioning/)

  assert.deepEqual(await h.service.recoverAll([]), { recovered: 0, settled: 0, delivered: 0, failed: 0 })
})
