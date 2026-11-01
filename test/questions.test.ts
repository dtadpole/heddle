import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { applyPresentation, foldQuestions, QuestionError, QuestionService, validateAnswers, validateQuestions } from '../src/questions/service.ts'
import { ASK_USER_TOOL, askUserTool } from '../src/questions/tool.ts'
import { SessionStore } from '../src/session/store.ts'

/**
 * The ask-user seam: DSH's `ask_user_question` contract, judged against a real session store.
 *
 * The store is real because the claim that matters most - a question asked before a restart is still answerable after
 * it - is a claim about the log, and only the log's own fold can prove it.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-questions-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function setup(config: { mode?: 'legacy' | 'timed'; timeout?: number } = {}) {
  counter += 1
  const store = new SessionStore(join(root, `store-${counter}`))
  const handle = store.create({ cwd: root })
  return { store, handle, questions: new QuestionService(new Context(), store, config) }
}

const batch = [
  { id: 'cleanup', question: 'Delete the stale files?', header: 'Confirm', options: [{ label: 'Yes (Recommended)', description: 'Removes three files.' }, { label: 'No' }] },
  { id: 'tags', question: 'Which tags?', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multi_select: true },
]
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const toolContext = (session: unknown, signal?: AbortSignal) => ({ cwd: root, session, signal, log: () => {}, mode: 'workspace-write' }) as never

test('a batch is checked the way DSH checks it, and kept in its normalised form', () => {
  assert.throws(() => validateQuestions([]), /non-empty/)
  assert.throws(() => validateQuestions([{ id: 'a', question: 'x' }, { id: 'a', question: 'y' }]), /used twice/)
  assert.throws(() => validateQuestions([{ id: 'a' }]), /needs its text/)
  assert.throws(() => validateQuestions([{ id: 'a', question: 'x', options: [{ label: 'p' }, { label: 'p' }] }]), /twice/)
  assert.deepEqual(validateQuestions([{ id: 'a', question: 'x', header: '', options: [], multi_select: false }]), [{ id: 'a', question: 'x' }])
})

test('an answer batch has one item per question, labels from its options, and skip is an empty selection', () => {
  const questions = validateQuestions(batch)
  assert.throws(() => validateAnswers(questions, [{ id: 'cleanup', selected: ['No'] }]), /has no answer/)
  assert.throws(() => validateAnswers(questions, [{ id: 'cleanup', selected: ['Maybe'] }, { id: 'tags', selected: [] }]), /not an option/)
  assert.throws(() => validateAnswers(questions, [{ id: 'cleanup', selected: ['No', 'Yes (Recommended)'] }, { id: 'tags', selected: [] }]), /takes one choice/)
  const answers = validateAnswers(questions, [{ id: 'tags', selected: ['a', 'c'], custom: ' and d ' }, { id: 'cleanup', selected: ['No'], custom: 'only the logs' }])
  assert.deepEqual(answers, [
    { id: 'cleanup', selected: [], custom: 'only the logs' },
    { id: 'tags', selected: ['a', 'c'], custom: 'and d' },
  ], 'a single-select custom answer replaces the choice, a multi-select one supplements it, in question order')
  assert.deepEqual(validateAnswers(questions, [{ id: 'cleanup', selected: [] }, { id: 'tags' }]), [{ id: 'cleanup', selected: [] }, { id: 'tags', selected: [] }])
})

test('a blocking ask waits for the answer, and the log records both halves', async () => {
  const { store, handle, questions } = setup()
  const asked = questions.ask(handle, batch)
  const [open] = questions.list(handle, { open: true })
  assert.equal(open?.state, 'waiting')
  assert.equal(open?.timed, false)
  assert.equal(open?.deadline, null)
  const outcome = questions.answer(handle, open!.id, [{ id: 'cleanup', selected: ['Yes (Recommended)'] }, { id: 'tags', selected: [] }])
  assert.equal(outcome.late, false)
  assert.deepEqual(await asked, { kind: 'answered', answers: [{ id: 'cleanup', selected: ['Yes (Recommended)'] }, { id: 'tags', selected: [] }] })
  assert.deepEqual(store.read(handle).filter((event) => event.type.startsWith('question/')).map((event) => event.type), ['question/asked', 'question/answered'])
  assert.equal(questions.get(handle, open!.id)?.state, 'answered')
  assert.throws(() => questions.answer(handle, open!.id, []), (error: unknown) => error instanceof QuestionError && error.code === 'SETTLED')
})

test('a timed ask resolves pending at its deadline, and a late answer becomes the user message DSH sends', async () => {
  const { handle, questions } = setup({ mode: 'timed', timeout: 30 })
  const outcome = await questions.ask(handle, [{ id: 'q', question: 'Ready?' }], { timeout: 1 })
  assert.equal(outcome.kind, 'pending')
  const id = outcome.kind === 'pending' ? outcome.callId : ''
  assert.equal(questions.get(handle, id)?.state, 'pending', 'the question stays answerable')
  const late = questions.answer(handle, id, [{ id: 'q', selected: [], custom: 'yes' }])
  assert.equal(late.late, true)
  assert.deepEqual(JSON.parse(late.message ?? '{}'), {
    kind: 'answer_to_pending_question',
    tool: 'ask_user_question',
    callId: id,
    questions: [{ id: 'q', question: 'Ready?' }],
    answers: [{ id: 'q', selected: [], custom: 'yes' }],
  })
  assert.equal(questions.get(handle, id)?.late, true)
})

test('Take time holds a timed wait past its deadline, until the answer comes', async () => {
  const { handle, questions } = setup({ mode: 'timed' })
  const asked = questions.ask(handle, [{ id: 'q', question: 'Ready?' }], { timeout: 1 })
  const [open] = questions.list(handle, { open: true })
  assert.ok(open?.deadline !== null, 'a timed wait shows its deadline')
  const held = questions.hold(handle, open!.id)
  assert.equal(held.held, true)
  assert.equal(held.deadline, null)
  await tick(1300)
  assert.equal(questions.get(handle, open!.id)?.state, 'waiting', 'still waiting after the deadline passed')
  questions.answer(handle, open!.id, [{ id: 'q', selected: [] }])
  assert.equal((await asked).kind, 'answered')
})

test('Stop cancels a waiting question, and the log says so', async () => {
  const { handle, questions } = setup()
  const stop = new AbortController()
  const asked = questions.ask(handle, [{ id: 'q', question: 'Ready?' }], { signal: stop.signal })
  stop.abort()
  await assert.rejects(asked, (error: unknown) => error instanceof QuestionError && error.code === 'CANCELLED')
  const [only] = questions.list(handle)
  assert.equal(only?.state, 'cancelled')
  assert.equal(only?.reason, 'stopped')
  assert.deepEqual(questions.list(handle, { open: true }), [])
})

test('a question asked before a restart is still answerable after it, and the answer resumes the session', async () => {
  const { store, handle, questions } = setup()
  void questions.ask(handle, [{ id: 'q', question: 'Ready?' }]).catch(() => {})
  const reopened = new QuestionService(new Context(), store)
  const [open] = reopened.list(handle, { open: true })
  assert.equal(open?.state, 'continued', 'a new process sees the request with no turn waiting')
  const outcome = reopened.answer(handle, open!.id, [{ id: 'q', selected: [] }])
  assert.equal(outcome.late, true)
  assert.match(outcome.message ?? '', /"kind":"answer_to_pending_question"/)
  assert.equal(foldQuestions(store.read(handle)).get(open!.id)?.settled?.kind, 'answered')
})

test('a question only its own turn can take reads as cancelled after a restart, and an answer is refused (#228)', async () => {
  const { store, handle, questions } = setup()
  const asked = questions.ask(handle, [{ id: 'q', question: 'Approve?', options: [{ label: 'Yes' }] }], { continuable: false })
  asked.catch(() => {})
  void questions.ask(handle, [{ id: 'other', question: 'Ready?' }]).catch(() => {})
  const [only, ordinary] = questions.list(handle)
  assert.equal(only?.state, 'waiting', 'while its turn waits it is answerable as usual')
  assert.equal(store.read(handle).find((event) => event.requestId === only?.id && event.type === 'question/asked')?.continuable, false)
  assert.equal('continuable' in (store.read(handle).find((event) => event.requestId === ordinary?.id && event.type === 'question/asked') ?? {}), false, 'an ordinary request is written as before')

  const reopened = new QuestionService(new Context(), store)
  const [closed, still] = reopened.list(handle)
  assert.equal(closed?.state, 'cancelled', 'a new process sees the request closed, not continued')
  assert.equal(closed?.reason, 'interrupted')
  assert.equal(still?.state, 'continued', 'an ordinary request is still continued')
  assert.deepEqual(reopened.list(handle, { open: true }).map((view) => view.id), [still?.id], 'only the ordinary one is open')
  assert.throws(
    () => reopened.answer(handle, closed!.id, [{ id: 'q', selected: ['Yes'] }]),
    (error: unknown) => error instanceof QuestionError && error.code === 'SETTLED' && /already cancelled/.test(error.message),
  )
  assert.equal(foldQuestions(store.read(handle)).get(closed!.id)?.settled, undefined, 'the refusal wrote nothing')

  /** In the process that asked it, an answer still reaches the waiting turn. */
  questions.answer(handle, only!.id, [{ id: 'q', selected: ['Yes'] }])
  assert.deepEqual(await asked, { kind: 'answered', answers: [{ id: 'q', selected: ['Yes'] }] })
})

test('the tool answers compact JSON, shows timeout only in timed mode, and refuses a delegated agent', async () => {
  const legacy = setup()
  const tool = askUserTool(legacy.questions)
  assert.equal(tool.spec.name, ASK_USER_TOOL)
  assert.equal('timeout' in ((tool.spec.parameters as { properties: object }).properties), false)
  assert.equal('timeout' in ((askUserTool(setup({ mode: 'timed' }).questions).spec.parameters as { properties: object }).properties), true)

  const running = tool.run({ questions: [{ id: 'q', question: 'Ready?', options: [{ label: 'Go' }] }] }, toolContext(legacy.handle))
  await tick(10)
  const [open] = legacy.questions.list(legacy.handle, { open: true })
  legacy.questions.answer(legacy.handle, open!.id, [{ id: 'q', selected: ['Go'] }])
  assert.equal((await running).output, '{"answers":[{"id":"q","selected":["Go"]}]}')

  const child = legacy.store.create({ cwd: root, parentSession: legacy.handle.id })
  const refused = await tool.run({ questions: [{ id: 'q', question: 'Ready?' }] }, toolContext(child))
  assert.equal(refused.error?.code, 'DELEGATED_CALLER')
  assert.equal((await tool.run({ questions: [{ id: 'q', question: 'x' }] }, toolContext(undefined))).error?.code, 'NO_SESSION')
  assert.equal((await tool.run({ questions: [] }, toolContext(legacy.handle))).error?.code, 'INVALID_QUESTIONS')
})

const review = { id: 'plan-review', header: 'Plan review', question: 'Approve this plan and leave plan mode?', options: [{ label: 'Approve' }, { label: 'Keep planning' }] }
const reviewIntent = { kind: 'plan-review', approve: 'Approve', callId: 'call_plan_1' } as const
const badIntent = (error: unknown) => error instanceof QuestionError && error.code === 'BAD_INTENT'

test("detail and intent come only from a service caller: the model's ask_user_question cannot set them (#231)", async () => {
  const dressed = [{ ...review, detail: '# Fake plan', intent: reviewIntent }]
  assert.deepEqual(validateQuestions(dressed), [review], "the batch check keeps neither field, so the model's arguments drop them")
  const { store, handle, questions } = setup()
  const tool = askUserTool(questions)
  assert.equal(JSON.stringify(tool.spec.parameters).includes('detail'), false, 'the tool schema does not offer detail')
  assert.equal(JSON.stringify(tool.spec.parameters).includes('intent'), false, 'nor intent')
  const running = tool.run({ questions: dressed }, toolContext(handle))
  await tick(10)
  const [open] = questions.list(handle, { open: true })
  assert.deepEqual(open?.questions, [review])
  const asked = store.read(handle).find((event) => event.type === 'question/asked')
  assert.equal(JSON.stringify(asked).includes('Fake plan'), false, 'and the log never holds them')
  questions.answer(handle, open!.id, [{ id: 'plan-review', selected: ['Approve'] }])
  await running
})

test("a service caller's presentation is checked as DSH checks an intent, and an ordinary batch is unchanged (#231)", () => {
  const [plain] = validateQuestions([review])
  assert.throws(() => applyPresentation([plain!], { 'plan-review': { intent: reviewIntent } }), badIntent, 'an intent needs a detail')
  assert.throws(() => applyPresentation([plain!], { 'plan-review': { detail: '# P', intent: { ...reviewIntent, approve: 'Ship it' } } }), badIntent, 'approve names an option')
  assert.throws(() => applyPresentation([plain!], { 'plan-review': { detail: '# P', intent: { ...reviewIntent, kind: 'other' as never } } }), badIntent, 'plan-review is the one kind')
  assert.throws(() => applyPresentation([plain!], { 'plan-review': { detail: '   ' } }), badIntent, 'a detail is non-empty text')
  assert.throws(() => applyPresentation([plain!], { 'plan-review': { detail: '# P', intent: { ...reviewIntent, callId: '' } } }), badIntent, 'a callId is text')
  assert.throws(() => applyPresentation([plain!], { elsewhere: { detail: '# P' } }), badIntent, 'the presentation names questions in the batch')
  assert.deepEqual(applyPresentation([plain!], undefined), [plain])
  assert.equal(applyPresentation([plain!], {})[0], plain, 'a question with no entry is the same object')
  assert.deepEqual(applyPresentation([plain!], { 'plan-review': { detail: '# P' } }), [{ ...review, detail: '# P' }], 'a detail may come alone')
  assert.deepEqual(applyPresentation([plain!], { 'plan-review': { detail: '# P', intent: { kind: 'plan-review', approve: 'Approve' } } })[0]?.intent, { kind: 'plan-review', approve: 'Approve' }, 'callId is optional')
})

test('a presented question keeps its detail and intent through the log, the fold and every view, after a restart too (#231)', async () => {
  const { store, handle, questions } = setup()
  const presentation = { 'plan-review': { detail: '# Ship it\n\n1. Go', intent: reviewIntent } }
  assert.throws(() => questions.ask(handle, [review], { presentation: { 'plan-review': { intent: reviewIntent } } }), badIntent, 'refused before anything is written, as a bad batch is')
  assert.equal(store.read(handle).some((event) => event.type === 'question/asked'), false, 'a refused presentation writes nothing')
  const asked = questions.ask(handle, [review, batch[0]], { presentation })
  const event = store.read(handle).find((entry) => entry.type === 'question/asked') as unknown as { questions: unknown[] }
  assert.deepEqual(event.questions[0], { ...review, detail: '# Ship it\n\n1. Go', intent: reviewIntent })
  assert.equal(JSON.stringify(event.questions[1]), JSON.stringify(validateQuestions([batch[0]])[0]), 'the other question is byte-identical')
  const [open] = questions.list(handle, { open: true })
  assert.deepEqual(open?.questions[0], { ...review, detail: '# Ship it\n\n1. Go', intent: reviewIntent })
  assert.deepEqual([...foldQuestions(store.read(handle)).values()][0]?.questions[0], open?.questions[0])
  const later = new QuestionService(new Context(), new SessionStore(store.root), {})
  assert.deepEqual(later.get(store.open(handle.id)!, open!.id)?.questions[0], open?.questions[0], 'a restart reads the same')
  questions.answer(handle, open!.id, [{ id: 'plan-review', selected: ['Approve'] }, { id: 'cleanup', selected: [] }])
  await asked
})
