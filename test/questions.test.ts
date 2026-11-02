import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { foldQuestions, QuestionError, QuestionService, validateAnswers, validateQuestions } from '../src/questions/service.ts'
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

test('a fork cut inside a waiting question answers only itself: the source keeps its waiter and its log (#245)', async () => {
  const { store, handle, questions } = setup()
  const asked = questions.ask(handle, [{ id: 'q', question: 'Ready?', options: [{ label: 'Go' }] }])
  const [waiting] = questions.list(handle)
  assert.equal(waiting?.state, 'waiting')
  const fork = store.fork(handle.id, { atSeq: Math.max(...store.read(handle).map((event) => event.seq)) })
  assert.ok(fork !== null)
  const [copy] = questions.list(fork, { open: true })
  assert.equal(copy?.id, waiting!.id, 'the fork copies the request with its id')
  assert.equal(copy?.state, 'continued', 'but no turn of the fork waits on it')

  const outcome = questions.answer(fork, copy!.id, [{ id: 'q', selected: ['Go'] }])
  assert.equal(outcome.late, true, "so the fork's answer is late, a message for the fork's next turn")
  assert.match(outcome.message ?? '', /"kind":"answer_to_pending_question"/)
  assert.equal(questions.get(handle, waiting!.id)?.state, 'waiting', "the source's turn still waits")
  assert.equal(foldQuestions(store.read(handle)).get(waiting!.id)?.settled, undefined, "and the source's log records no answer")
  assert.equal(await Promise.race([asked.then(() => 'answered'), tick(20).then(() => 'waiting')]), 'waiting', "the fork's answer never reached the source's turn")

  questions.answer(handle, waiting!.id, [{ id: 'q', selected: ['Go'] }])
  assert.deepEqual(await asked, { kind: 'answered', answers: [{ id: 'q', selected: ['Go'] }] }, 'an answer in the source still does')
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
