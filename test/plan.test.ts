import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { CommandRegistry, type CommandLog } from '../src/commands/registry.ts'
import type { GenerateRequest } from '../src/llm/types.ts'
import { handlePlanRequest } from '../src/plan/http.ts'
import { PLAN_EVENT, PLAN_OFF_NOTICE, PLAN_ON_NOTICE, planActive, setPlanMode, type PlanLog } from '../src/plan/mode.ts'
import { PLAN_POLICY_SECTION, withPlanPolicy } from '../src/plan/policy.ts'
import { applyPlanPolicy, planCommand, questionsReviewChannel, type QuestionAsker } from '../src/plan/service.ts'
import { EXIT_DESCRIPTION, EXIT_PLAN_MODE, PLAN_REVIEW, exitPlanModeTool, planTitle, type PlanReviewAnswer, type PlanReviewChannel } from '../src/plan/tool.ts'
import { foldSurface, SessionStore } from '../src/session/store.ts'

/**
 * Plan mode (C88, C89; DSH's dsh-plan-mode, re-read 2026-10-29): the mode as a log fold, the notice the model reads
 * when the mode changes under it, the policy section every request carries while it is on, `/plan`, and the exit
 * tool's refusals and review outcomes.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-plan-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function session() {
  counter += 1
  const store = new SessionStore(join(root, `store-${counter}`))
  const handle = store.create({ cwd: root })
  const log: PlanLog & CommandLog = {
    read: (target) => store.read(target),
    append: (target, event, options?: Parameters<PlanLog['append']>[2]) => store.append(target, event, options ?? {}),
  }
  return { store, handle, log }
}

function request(messages: GenerateRequest['messages'], sessionId?: string): GenerateRequest {
  return { endpoint: 'scripted', messages, ...(sessionId !== undefined ? { sessionId } : {}) }
}

test('the mode is the last plan/mode event, off when there is none, and a change to the current mode writes nothing', () => {
  const { store, handle, log } = session()
  assert.equal(planActive(store.read(handle)), false)
  assert.equal(setPlanMode(log, handle, false), 'noop')
  assert.equal(setPlanMode(log, handle, true), 'committed')
  assert.equal(planActive(store.read(handle)), true)
  const before = store.read(handle).length
  assert.equal(setPlanMode(log, handle, true), 'noop')
  assert.equal(store.read(handle).length, before)
  assert.equal(setPlanMode(log, handle, false), 'committed')
  assert.equal(planActive(store.read(handle)), false)
  assert.deepEqual(
    store.read(handle).filter((event) => event.type === PLAN_EVENT).map((event) => event.active),
    [true, false],
  )
})

test('the mode event is log-only, and a notice is added only once the model has answered in the session', () => {
  const { store, handle, log } = session()
  const surface = () => foldSurface(store.read(handle)).nodes.length
  const start = surface()
  setPlanMode(log, handle, true)
  assert.equal(surface(), start, 'a fresh session gets no notice: the policy section alone tells the model')
  assert.equal(store.read(handle).some((event) => event.type === 'context/note'), false)

  store.append(handle, { type: 'model/request', messages: 1 })
  setPlanMode(log, handle, false)
  const notes = store.read(handle).filter((event) => event.type === 'context/note')
  assert.equal(notes.length, 1)
  assert.deepEqual(notes[0]?.message, { role: 'user', content: [{ type: 'text', text: PLAN_OFF_NOTICE }] })
  assert.equal(notes[0]?.origin, 'plan-mode')
  assert.equal(surface(), start + 1, 'the notice is part of the conversation the model reads')
  setPlanMode(log, handle, true)
  assert.equal(
    store.read(handle).filter((event) => event.type === 'context/note').at(-1)?.message !== undefined &&
      JSON.stringify(store.read(handle).filter((event) => event.type === 'context/note').at(-1)?.message).includes(PLAN_ON_NOTICE),
    true,
  )
})

test("the policy section is DSH's, and it goes in after the system messages a request opens with", () => {
  assert.match(PLAN_POLICY_SECTION, /^You are in plan mode\. Stay in plan mode until the user approves your plan through exit_plan_mode/)
  assert.match(PLAN_POLICY_SECTION, /Do not edit or write files, change configuration/)
  assert.match(PLAN_POLICY_SECTION, /those tools remain listed only to keep the request shape stable/)
  assert.match(PLAN_POLICY_SECTION, /call exit_plan_mode with the complete plan markdown, starting with a # title\./)
  const system = { role: 'system' as const, content: [{ type: 'text' as const, text: 'be careful' }] }
  const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'plan the change' }] }
  const planned = withPlanPolicy(request([system, user]))
  assert.equal(planned.messages.length, 3)
  assert.deepEqual(planned.messages[0], system)
  assert.deepEqual(planned.messages[1], { role: 'system', content: [{ type: 'text', text: PLAN_POLICY_SECTION }] })
  assert.deepEqual(planned.messages[2], user)
  assert.deepEqual(withPlanPolicy(request([user])).messages[0]?.role, 'system', 'with no system prompt it opens the request')
})

test('a request carries the section only while its session is in plan mode', () => {
  const { store, handle, log } = session()
  const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }
  const plain = request([user], handle.id)
  assert.equal(applyPlanPolicy(store, plain), plain, 'default mode: the request is untouched')
  setPlanMode(log, handle, true)
  const planned = applyPlanPolicy(store, plain)
  assert.equal(planned.messages.length, 2)
  assert.equal(planned.messages[0]?.role, 'system')
  assert.equal(applyPlanPolicy(store, request([user])).messages.length, 1, 'a request naming no session is untouched')
  assert.equal(applyPlanPolicy(store, request([user], 'session-00000000-0000-4000-8000-000000000000')).messages.length, 1, 'an unknown session too')
})

test('/plan enters, /plan off leaves, and words after /plan go to the model as a message', async () => {
  const { store, handle, log } = session()
  const registry = new CommandRegistry()
  registry.register(planCommand(log))
  const run = async (line: string) => (await registry.execute(log, handle, line))?.result
  assert.deepEqual(registry.list(), [
    { name: 'plan', label: 'Plan', description: 'Enter or leave plan mode', section: 'add', input: { hint: '[off|message]', attachments: true } },
  ])
  assert.deepEqual(await run('/plan off'), { kind: 'success', text: 'Plan mode is already inactive.' })
  assert.deepEqual(await run('/plan'), { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' })
  assert.equal(planActive(store.read(handle)), true)
  assert.deepEqual(await run('/plan off'), { kind: 'success', text: 'Plan mode off.' })
  assert.equal(planActive(store.read(handle)), false)
  assert.deepEqual(await run('/plan design the slash menu'), {
    kind: 'success',
    text: 'Plan mode on. Use /plan off to leave.',
    action: { kind: 'prompt', text: 'design the slash menu' },
  })
  assert.equal(planActive(store.read(handle)), true)
})

/** A channel that answers what it is told and records what it was shown. */
function channel(answer: PlanReviewAnswer) {
  const shown: { title: string; markdown: string }[] = []
  const reviewer: PlanReviewChannel = {
    review: async (_session, plan) => {
      shown.push(plan)
      return answer
    },
  }
  return { reviewer, shown }
}

function tool(log: PlanLog, reviewer?: PlanReviewChannel) {
  return exitPlanModeTool({
    active: (handle) => planActive(log.read(handle)),
    leave: (handle) => {
      setPlanMode(log, handle, false)
    },
    channel: () => reviewer,
  })
}

const PLAN = '# Ship the slash menu\n\n1. Registry\n2. Menu'

test("exit_plan_mode carries DSH's name, description and parameter", () => {
  const { log } = session()
  const { spec } = tool(log)
  assert.equal(spec.name, EXIT_PLAN_MODE)
  assert.equal(spec.description, EXIT_DESCRIPTION)
  assert.deepEqual(spec.parameters, {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The complete plan, as markdown, starting with a # heading that names it.' } },
    required: ['plan'],
    additionalProperties: false,
  })
  assert.equal(PLAN_REVIEW.question, 'Approve this plan and leave plan mode?')
  assert.deepEqual([PLAN_REVIEW.approve.label, PLAN_REVIEW.keepPlanning.label], ['Approve', 'Keep planning'])
})

test('exit_plan_mode refuses without a session, outside plan mode, without a heading, and without a review channel', async () => {
  const { handle, log } = session()
  const context = { cwd: root, mode: 'workspace-write' as const, log: () => undefined }
  const refuse = async (definition: ReturnType<typeof tool>, args: Record<string, unknown>, withSession = true) =>
    (await definition.run(args, withSession ? { ...context, session: handle } : context)).error
  assert.equal((await refuse(tool(log), { plan: PLAN }, false))?.message, 'exit_plan_mode requires a calling agent (no session to switch)')
  assert.equal((await refuse(tool(log), { plan: PLAN }))?.message, 'exit_plan_mode is only available in plan mode')
  setPlanMode(log, handle, true)
  assert.equal((await refuse(tool(log), { plan: 'no heading here' }))?.message, 'exit_plan_mode requires a non-empty markdown plan starting with a # heading')
  assert.equal((await refuse(tool(log), { plan: '#' }))?.message, 'exit_plan_mode requires a non-empty markdown plan starting with a # heading')
  assert.equal(
    (await refuse(tool(log), { plan: PLAN }))?.message,
    'no user-questions channel is available to review the plan; ask the user to switch the session mode instead',
  )
  assert.equal(planActive(log.read(handle)), true, 'every refusal leaves plan mode on')
})

test('an approved plan leaves plan mode; keeping on planning and dismissing do not', async () => {
  const context = { cwd: root, mode: 'workspace-write' as const, log: () => undefined }

  const approved = session()
  setPlanMode(approved.log, approved.handle, true)
  const yes = channel({ kind: 'approve' })
  const result = await tool(approved.log, yes.reviewer).run({ plan: `\n${PLAN}\n` }, { ...context, session: approved.handle })
  assert.deepEqual(result, { output: 'Plan approved — plan mode exited; carry out the plan starting with your next step.', data: { approved: true } })
  assert.deepEqual(yes.shown, [{ title: 'Ship the slash menu', markdown: PLAN }])
  assert.equal(planActive(approved.log.read(approved.handle)), false)

  const kept = session()
  setPlanMode(kept.log, kept.handle, true)
  const again = await tool(kept.log, channel({ kind: 'keep-planning', feedback: '  split the menu out  ' }).reviewer).run({ plan: PLAN }, { ...context, session: kept.handle })
  assert.equal(again.error?.message, 'The user chose to keep planning; their feedback: split the menu out')
  const silent = await tool(kept.log, channel({ kind: 'keep-planning', feedback: '' }).reviewer).run({ plan: PLAN }, { ...context, session: kept.handle })
  assert.equal(silent.error?.message, 'The user chose to keep planning; revise the plan and present it again.')
  assert.equal(planActive(kept.log.read(kept.handle)), true)

  const dismissed = await tool(kept.log, channel({ kind: 'dismissed' }).reviewer).run({ plan: PLAN }, { ...context, session: kept.handle })
  assert.deepEqual(dismissed, { output: 'The user dismissed the plan review to reply in their own words; plan mode remains active.', data: { approved: false } })
  assert.equal(planActive(kept.log.read(kept.handle)), true)
})

test("a plan's title is its first heading at any level", () => {
  assert.equal(planTitle('intro\n## Phase one  \n# Later'), 'Phase one')
  assert.equal(planTitle('no heading'), undefined)
})

test('GET /api/sessions/{id}/plan answers whether the session is in plan mode', async () => {
  const { store, handle, log } = session()
  const host = { open: (id: string) => store.open(id), active: (target: typeof handle) => planActive(store.read(target)) }
  const server = createServer((incoming, response) => {
    void handlePlanRequest(host, incoming, response, new URL(incoming.url ?? '/', 'http://localhost')).then((handled) => {
      if (!handled) {
        response.writeHead(418)
        response.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    assert.deepEqual(await (await fetch(`${base}/api/sessions/${handle.id}/plan`)).json(), { session: handle.id, active: false })
    setPlanMode(log, handle, true)
    assert.deepEqual(await (await fetch(`${base}/api/sessions/${handle.id}/plan`)).json(), { session: handle.id, active: true })
    assert.equal((await fetch(`${base}/api/sessions/nope/plan`)).status, 400)
    assert.equal((await fetch(`${base}/api/sessions/session-00000000-0000-4000-8000-000000000000/plan`)).status, 404)
    assert.equal((await fetch(`${base}/api/sessions/${handle.id}/plan`, { method: 'POST' })).status, 418, 'only GET is the route')
  } finally {
    server.close()
  }
})

test("the review over the question service asks DSH's plan-review question and reads each answer as DSH does", async () => {
  const { handle } = session()
  const asked: unknown[] = []
  const asker = (answer: Awaited<ReturnType<QuestionAsker['ask']>>): QuestionAsker => ({
    ask: async (_session, questions, options) => {
      asked.push({ questions, timeout: options.timeout })
      return answer
    },
  })
  const review = (answer: Awaited<ReturnType<QuestionAsker['ask']>>) => questionsReviewChannel(asker(answer)).review(handle, { title: 'Ship it', markdown: '# Ship it\n\n1. Go' })

  assert.deepEqual(await review({ kind: 'answered', answers: [{ id: 'plan-review', selected: ['Approve'] }] }), { kind: 'approve' })
  assert.deepEqual(asked[0], {
    questions: [
      {
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?\n\n# Ship it\n\n1. Go',
        options: [
          { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
          { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
        ],
      },
    ],
    timeout: -1,
  })
  assert.deepEqual(await review({ kind: 'answered', answers: [{ id: 'plan-review', selected: ['Keep planning'] }] }), { kind: 'keep-planning', feedback: '' })
  assert.deepEqual(await review({ kind: 'answered', answers: [{ id: 'plan-review', selected: [], custom: ' split it ' }] }), { kind: 'keep-planning', feedback: 'split it' })
  assert.deepEqual(await review({ kind: 'answered', answers: [{ id: 'plan-review', selected: ['Approve'], custom: 'but rename it' }] }), { kind: 'keep-planning', feedback: 'but rename it' }, 'typed words are feedback, never approval')
  assert.deepEqual(await review({ kind: 'answered', answers: [{ id: 'plan-review', selected: [] }] }), { kind: 'dismissed' }, 'a skip dismisses')
  assert.deepEqual(await review({ kind: 'pending', callId: 'call-1' }), { kind: 'dismissed' }, 'pending cannot happen with no time limit, and reads as the safe outcome')
})

test('a stop during the review reaches the turn as the stop it is', async () => {
  const { handle } = session()
  const stopped = Object.assign(new Error('the question was cancelled'), { code: 'CANCELLED' })
  const channel = questionsReviewChannel({ ask: async () => Promise.reject(stopped) })
  await assert.rejects(channel.review(handle, { title: 'x', markdown: '# x' }), (error: unknown) => error === stopped)
})
