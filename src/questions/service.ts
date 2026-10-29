import { randomUUID } from 'node:crypto'

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import type { SessionEvent, SessionHandle, SessionStore } from '../session/store.ts'

/**
 * Questions the model asks a person, and the person's answers: DSH's `userQuestions` seam, kept in the session log.
 *
 * A request is three kinds of event in the session's own log: `question/asked` (the batch, whether it is timed, and its
 * deadline), then at most one of `question/answered` or `question/cancelled`, with `question/pending` in between when a
 * timed wait ran out first. The state of every request is the fold of those events, so a question asked before a
 * restart or a reload is still there afterwards. What only the process knows - which requests have a turn waiting on
 * them, and which a person is holding open with Take time - is kept beside the log, never in it.
 */

/** Name this plugin is registered and logged under. */
export const name = 'questions'

/** The version written on every question event, so a later shape can be told apart. */
export const QUESTION_EVENT_VERSION = 1

/** DSH's default foreground wait for a timed call, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 120

/** The longest wait a call may name, in seconds: DSH's schema bound. */
export const MAX_TIMEOUT_SECONDS = 2_147_483

/** One choice the person may pick. */
export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

/** One question in a batch. */
export interface Question {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options?: readonly QuestionOption[]
  readonly multi_select?: boolean
}

/** One answer: chosen labels, and free text that supplements a multi-select or replaces a single choice. */
export interface Answer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/**
 * Where a request stands.
 *
 * `waiting` - a turn in this process is waiting for it. `pending` - a timed wait ran out; it is still answerable and a
 * late answer reaches the model as a user message. `continued` - asked by a turn that no longer runs (the process ended
 * or the turn was replaced); still answerable the same way. `answered` and `cancelled` are final.
 */
export type QuestionState = 'waiting' | 'pending' | 'continued' | 'answered' | 'cancelled'

/** A request as a reader sees it. */
export interface QuestionRequestView {
  readonly id: string
  readonly session: string
  readonly questions: readonly Question[]
  readonly timed: boolean
  readonly askedAt: string
  /** When a timed wait ends, as an ISO time; `null` for an untimed or held wait. */
  readonly deadline: string | null
  /** A person chose Take time (or is editing), so the foreground wait does not run out. */
  readonly held: boolean
  readonly state: QuestionState
  readonly answers?: readonly Answer[]
  readonly answeredAt?: string
  /** The answer came after the turn stopped waiting, so it reached the model as a user message. */
  readonly late?: boolean
  readonly reason?: string
}

/** What `ask` resolves to. */
export type AskOutcome =
  | { readonly kind: 'answered'; readonly answers: readonly Answer[] }
  | { readonly kind: 'pending'; readonly callId: string }

/** What `answer` reports. */
export interface AnswerOutcome {
  readonly view: QuestionRequestView
  /** True when no turn was waiting: the caller must deliver `message` to the session as a user message. */
  readonly late: boolean
  /** The user-message text for a late answer, DSH's `answer_to_pending_question` shape. */
  readonly message?: string
}

/** A refusal with a stable code: `INVALID_QUESTIONS`, `INVALID_ANSWERS`, `NOT_FOUND`, `SETTLED`, `CANCELLED`. */
export class QuestionError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'QuestionError'
    this.code = code
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim().length > 0 ? value : undefined)

/** Check a batch the way DSH's schema does: at least one question, unique non-empty ids, a question each. */
export function validateQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new QuestionError('questions must be a non-empty list', 'INVALID_QUESTIONS')
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    if (!isRecord(entry)) throw new QuestionError(`question ${index + 1} is not an object`, 'INVALID_QUESTIONS')
    const id = text(entry.id)
    const question = text(entry.question)
    if (id === undefined) throw new QuestionError(`question ${index + 1} needs an id`, 'INVALID_QUESTIONS')
    if (seen.has(id)) throw new QuestionError(`question id '${id}' is used twice`, 'INVALID_QUESTIONS')
    seen.add(id)
    if (question === undefined) throw new QuestionError(`question '${id}' needs its text`, 'INVALID_QUESTIONS')
    let options: QuestionOption[] | undefined
    if (entry.options !== undefined) {
      if (!Array.isArray(entry.options)) throw new QuestionError(`question '${id}' options must be a list`, 'INVALID_QUESTIONS')
      const labels = new Set<string>()
      options = entry.options.map((option, at) => {
        const label = isRecord(option) ? text(option.label) : undefined
        if (label === undefined) throw new QuestionError(`question '${id}' option ${at + 1} needs a label`, 'INVALID_QUESTIONS')
        if (labels.has(label)) throw new QuestionError(`question '${id}' has the option '${label}' twice`, 'INVALID_QUESTIONS')
        labels.add(label)
        const description = isRecord(option) ? text(option.description) : undefined
        return description === undefined ? { label } : { label, description }
      })
    }
    const header = text(entry.header)
    return {
      id,
      question,
      ...(header !== undefined ? { header } : {}),
      ...(options !== undefined && options.length > 0 ? { options } : {}),
      ...(entry.multi_select === true ? { multi_select: true } : {}),
    }
  })
}

/**
 * Check an answer batch against its questions: one item per question, labels from that question's options, at most
 * one label for a single-select question, and free text only as a string. A skipped question is `selected: []` with
 * no `custom`, which is allowed; a missing item is not, because DSH answers one item per question.
 */
export function validateAnswers(questions: readonly Question[], raw: unknown): Answer[] {
  if (!Array.isArray(raw)) throw new QuestionError('answers must be a list', 'INVALID_ANSWERS')
  const byId = new Map(questions.map((question) => [question.id, question]))
  const given = new Map<string, Answer>()
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== 'string') throw new QuestionError('every answer needs the id of its question', 'INVALID_ANSWERS')
    const question = byId.get(entry.id)
    if (question === undefined) throw new QuestionError(`no question has the id '${entry.id}'`, 'INVALID_ANSWERS')
    if (given.has(entry.id)) throw new QuestionError(`question '${entry.id}' is answered twice`, 'INVALID_ANSWERS')
    const selected = entry.selected ?? []
    if (!Array.isArray(selected) || selected.some((label) => typeof label !== 'string')) {
      throw new QuestionError(`answer '${entry.id}' must select labels`, 'INVALID_ANSWERS')
    }
    const labels = new Set((question.options ?? []).map((option) => option.label))
    for (const label of selected as string[]) {
      if (!labels.has(label)) throw new QuestionError(`'${label}' is not an option of question '${entry.id}'`, 'INVALID_ANSWERS')
    }
    if (new Set(selected).size !== selected.length) throw new QuestionError(`answer '${entry.id}' selects a label twice`, 'INVALID_ANSWERS')
    if (question.multi_select !== true && selected.length > 1) {
      throw new QuestionError(`question '${entry.id}' takes one choice`, 'INVALID_ANSWERS')
    }
    if (entry.custom !== undefined && typeof entry.custom !== 'string') throw new QuestionError(`answer '${entry.id}' custom must be text`, 'INVALID_ANSWERS')
    const custom = typeof entry.custom === 'string' && entry.custom.trim().length > 0 ? entry.custom.trim() : undefined
    /** A single-select custom answer replaces the choice, as DSH's card makes it exclusive. */
    const kept = question.multi_select !== true && custom !== undefined ? [] : [...(selected as string[])]
    given.set(entry.id, { id: entry.id, selected: kept, ...(custom !== undefined ? { custom } : {}) })
  }
  for (const question of questions) {
    if (!given.has(question.id)) throw new QuestionError(`question '${question.id}' has no answer (send selected: [] to skip it)`, 'INVALID_ANSWERS')
  }
  return questions.map((question) => given.get(question.id) as Answer)
}

/** A request as the log describes it. */
export interface FoldedRequest {
  readonly id: string
  readonly questions: readonly Question[]
  readonly timed: boolean
  readonly askedAt: string
  readonly deadline: string | null
  readonly expired: boolean
  readonly settled?: { readonly kind: 'answered'; readonly answers: readonly Answer[]; readonly at: string; readonly late: boolean } | { readonly kind: 'cancelled'; readonly reason: string; readonly at: string }
}

/** Fold a session's question events, in log order. Events of other kinds are ignored; an unknown request is skipped. */
export function foldQuestions(events: readonly SessionEvent[]): Map<string, FoldedRequest> {
  const requests = new Map<string, FoldedRequest>()
  for (const event of events) {
    if (typeof event.type !== 'string' || !event.type.startsWith('question/')) continue
    const id = typeof event.requestId === 'string' ? event.requestId : undefined
    if (id === undefined) continue
    if (event.type === 'question/asked') {
      if (requests.has(id) || !Array.isArray(event.questions)) continue
      requests.set(id, {
        id,
        questions: event.questions as Question[],
        timed: event.timed === true,
        askedAt: typeof event.askedAt === 'string' ? event.askedAt : event.at,
        deadline: typeof event.deadline === 'string' ? event.deadline : null,
        expired: false,
      })
      continue
    }
    const current = requests.get(id)
    if (current === undefined || current.settled !== undefined) continue
    if (event.type === 'question/pending') requests.set(id, { ...current, expired: true })
    else if (event.type === 'question/answered' && Array.isArray(event.answers)) {
      requests.set(id, { ...current, settled: { kind: 'answered', answers: event.answers as Answer[], at: event.at, late: event.late === true } })
    } else if (event.type === 'question/cancelled') {
      requests.set(id, { ...current, settled: { kind: 'cancelled', reason: typeof event.reason === 'string' ? event.reason : 'cancelled', at: event.at } })
    }
  }
  return requests
}

/** The user-message text a late answer becomes: DSH's `answer_to_pending_question` record, as compact JSON. */
export function lateAnswerMessage(request: FoldedRequest, answers: readonly Answer[]): string {
  return JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: request.id, questions: request.questions, answers })
}

export const Config = Schema.object({
  mode: Schema.union(['legacy', 'timed']).default('legacy').description('legacy waits for an answer; timed may release the model at a deadline'),
  timeout: Schema.number().default(DEFAULT_TIMEOUT_SECONDS).description('default foreground wait of a timed call, in seconds; -1 waits indefinitely'),
})

export interface Config {
  readonly mode?: 'legacy' | 'timed'
  readonly timeout?: number
}

interface Waiter {
  readonly session: string
  readonly resolve: (outcome: AskOutcome) => void
  readonly reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  held: boolean
  deadline: string | null
}

/** The question service: requests in the log, waiting turns and holds in the process. */
export class QuestionService extends Service {
  static readonly provide = 'questions'

  private readonly store: SessionStore
  readonly mode: 'legacy' | 'timed'
  readonly defaultTimeout: number
  private readonly waiters = new Map<string, Waiter>()

  constructor(ctx: Context, store: SessionStore, config: Config = {}) {
    super(ctx, 'questions')
    this.store = store
    this.mode = config.mode === 'timed' ? 'timed' : 'legacy'
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_SECONDS
    this.defaultTimeout = timeout === -1 || (Number.isInteger(timeout) && timeout > 0) ? timeout : DEFAULT_TIMEOUT_SECONDS
  }

  /**
   * Ask a batch and wait. A legacy call, or a timed call with `-1`, waits until an answer or a cancellation; a timed
   * call with a positive wait resolves `pending` at its deadline, unless a person is holding it open. An aborted
   * signal (Stop) records the cancellation and rejects with `CANCELLED`.
   */
  ask(handle: SessionHandle, rawQuestions: unknown, options: { readonly timeout?: unknown; readonly signal?: AbortSignal } = {}): Promise<AskOutcome> {
    const questions = validateQuestions(rawQuestions)
    const seconds = this.waitSeconds(options.timeout)
    const timed = seconds !== null
    const id = `question-${randomUUID()}`
    const askedAt = new Date().toISOString()
    const deadline = seconds !== null ? new Date(Date.now() + seconds * 1000).toISOString() : null
    if (options.signal?.aborted === true) throw new QuestionError('the turn was stopped before the question was asked', 'CANCELLED')
    this.store.append(handle, { type: 'question/asked', version: QUESTION_EVENT_VERSION, requestId: id, questions, timed, askedAt, deadline })
    return new Promise<AskOutcome>((resolve, reject) => {
      const waiter: Waiter = { session: handle.id, resolve, reject, held: false, deadline }
      this.waiters.set(id, waiter)
      if (seconds !== null) {
        waiter.timer = setTimeout(() => {
          if (!this.waiters.has(id) || waiter.held) return
          this.waiters.delete(id)
          this.store.append(handle, { type: 'question/pending', version: QUESTION_EVENT_VERSION, requestId: id })
          resolve({ kind: 'pending', callId: id })
        }, seconds * 1000)
        waiter.timer.unref?.()
      }
      options.signal?.addEventListener(
        'abort',
        () => {
          if (!this.waiters.has(id)) return
          this.release(id)
          this.store.append(handle, { type: 'question/cancelled', version: QUESTION_EVENT_VERSION, requestId: id, reason: 'stopped' })
          reject(new QuestionError('the turn was stopped while the question waited', 'CANCELLED'))
        },
        { once: true },
      )
    })
  }

  /** Every request in a session, oldest first; `open` keeps only those still answerable. */
  list(handle: SessionHandle, filter: { readonly open?: boolean } = {}): QuestionRequestView[] {
    const views = [...foldQuestions(this.store.read(handle)).values()].map((request) => this.view(handle, request))
    return filter.open === true ? views.filter((view) => view.state === 'waiting' || view.state === 'pending' || view.state === 'continued') : views
  }

  /** One request, or `undefined`. */
  get(handle: SessionHandle, id: string): QuestionRequestView | undefined {
    const request = foldQuestions(this.store.read(handle)).get(id)
    return request === undefined ? undefined : this.view(handle, request)
  }

  /**
   * Answer a request. A waiting turn receives the answers as its tool result; with no turn waiting the answer is
   * recorded as late and `message` is the user message the caller must deliver, which is how DSH resumes a session.
   */
  answer(handle: SessionHandle, id: string, rawAnswers: unknown): AnswerOutcome {
    const request = foldQuestions(this.store.read(handle)).get(id)
    if (request === undefined) throw new QuestionError(`no question request '${id}' in this session`, 'NOT_FOUND')
    if (request.settled !== undefined) throw new QuestionError(`question request '${id}' is already ${request.settled.kind}`, 'SETTLED')
    const answers = validateAnswers(request.questions, rawAnswers)
    const waiter = this.waiters.get(id)
    const late = waiter === undefined
    this.store.append(handle, { type: 'question/answered', version: QUESTION_EVENT_VERSION, requestId: id, answers, late })
    if (waiter !== undefined) {
      this.release(id)
      waiter.resolve({ kind: 'answered', answers })
    }
    const view = this.get(handle, id) as QuestionRequestView
    return late ? { view, late, message: lateAnswerMessage(request, answers) } : { view, late }
  }

  /**
   * Take time: keep a timed wait from running out while a person works on the answer. Only a request a turn is
   * waiting on can be held; for any other the call changes nothing and returns the current view.
   */
  hold(handle: SessionHandle, id: string): QuestionRequestView {
    const request = foldQuestions(this.store.read(handle)).get(id)
    if (request === undefined) throw new QuestionError(`no question request '${id}' in this session`, 'NOT_FOUND')
    const waiter = this.waiters.get(id)
    if (waiter !== undefined && waiter.session === handle.id) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.timer = undefined
      waiter.held = true
      waiter.deadline = null
    }
    return this.view(handle, request)
  }

  /** Whether a turn in this process is waiting on a request: the one fact the log cannot carry. */
  isWaiting(id: string): boolean {
    return this.waiters.has(id)
  }

  /** The wait in seconds, or `null` for an untimed call. */
  private waitSeconds(raw: unknown): number | null {
    if (this.mode !== 'timed') return null
    const asked = typeof raw === 'number' && Number.isInteger(raw) && (raw === -1 || (raw > 0 && raw <= MAX_TIMEOUT_SECONDS)) ? raw : undefined
    const seconds = asked ?? this.defaultTimeout
    return seconds === -1 ? null : seconds
  }

  private release(id: string): void {
    const waiter = this.waiters.get(id)
    if (waiter?.timer !== undefined) clearTimeout(waiter.timer)
    this.waiters.delete(id)
  }

  private view(handle: SessionHandle, request: FoldedRequest): QuestionRequestView {
    const waiter = this.waiters.get(request.id)
    const base = {
      id: request.id,
      session: handle.id,
      questions: request.questions,
      timed: request.timed,
      askedAt: request.askedAt,
      deadline: waiter?.deadline ?? null,
      held: waiter?.held === true,
    }
    if (request.settled?.kind === 'answered') {
      return { ...base, deadline: null, state: 'answered', answers: request.settled.answers, answeredAt: request.settled.at, late: request.settled.late }
    }
    if (request.settled?.kind === 'cancelled') return { ...base, deadline: null, state: 'cancelled', reason: request.settled.reason }
    if (waiter !== undefined) return { ...base, state: 'waiting' }
    return { ...base, deadline: null, state: request.expired ? 'pending' : 'continued' }
  }
}

/** The question plugin: the service wired to the session store, loaded by the profile. */
export default class QuestionPlugin extends QuestionService {
  static readonly Config = Config

  static readonly inject = ['session']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, ctx.session.store, config)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['questions']`. */
    questions: QuestionService
  }
}
