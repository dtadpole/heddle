import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../agent/loop.ts'
import type { TurnRegistry } from '../agent/turns.ts'
import type { ContentPart } from '../llm/types.ts'
import { claimNextTurn, pendingInbox, queuedByRequest, queueTurn, removeQueued, replaceQueued, type InboxMessage } from '../session/inbox.ts'
import type { SessionHandle } from '../session/store.ts'

/**
 * The session's queue of prompts waiting for the running turn: the durable `next-turn` inbox, kept by the host (#162).
 *
 * DSH queues a message sent while a turn runs on the host, in the session's inbox (`agent/inbox/spliced` on `next-turn`),
 * and draws its queue dock from that projection (`session.projections.faceOf("inbox")["next-turn"]`,
 * dsh-client-ui-conversation), so a reload, another tab and another device see the same queue, and the host runs the
 * first queued message as the next turn once the running one ends. heddle's page kept its queue in a page-local map: a
 * reload dropped every queued message without a word, and a queued message sent at the turn's end lost the race to the
 * goal driver's next round (#177).
 *
 * Routes:
 * - `POST /api/turn {queue: true, requestId}` on a busy session appends one row and answers `202 {queued, id, requestId}`
 *   (see `queueRequest`); a retry with the same `requestId` answers the same row.
 * - `GET /api/sessions/<id>/queue` — `{items: [{id, requestId?, text, content}]}`.
 * - `POST /api/sessions/<id>/queue/remove {id}` — `{outcome: 'removed'}`, or `409 {outcome: 'claimed'}` when its turn
 *   already took it.
 * - `POST /api/sessions/<id>/queue/edit {id, text}` — text-only rows, as DSH's queue dock edits only rows whose every part
 *   is text; `400` for a row with an attachment, `409` once claimed.
 *
 * The drain: when the session has nothing in flight (the live-turn registry is idle, which a `/compact` hold also
 * settles), the first row is claimed — a splice with no `outcome` — and run as the session's next turn.
 */

/** One row of the queue as a page draws it. */
export interface QueueItem {
  readonly id: string
  readonly requestId?: string
  /** The row's text parts, joined: what the dock shows and what an edit rewrites. */
  readonly text: string
  /** Whether every part is text, so the row can be edited (DSH's `textOf` is `null` for any other part). */
  readonly editable: boolean
  readonly content: readonly ContentPart[]
}

const textOf = (content: readonly ContentPart[]): string =>
  content
    .filter((part): part is ContentPart & { type: 'text'; text: string } => part.type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('')

function itemOf(message: InboxMessage): QueueItem {
  return {
    id: message.id,
    ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
    text: textOf(message.content),
    editable: message.content.every((part) => part.type === 'text'),
    content: message.content,
  }
}

/** The session's queued prompts, oldest first. */
export function queuedItems(ctx: Context, handle: SessionHandle): readonly QueueItem[] {
  return pendingInbox(ctx.session.store, handle)['next-turn'].map(itemOf)
}

/**
 * Queue a prompt sent to a session that is busy, or that already has prompts waiting (so the order is kept), and answer
 * the row; `undefined` when the session is free and the prompt should run at once. A retry of the same request answers
 * the row it queued the first time (`duplicate: true`).
 */
export function queueRequest(
  ctx: Context,
  handle: SessionHandle,
  content: readonly ContentPart[],
  requestId: string | undefined,
): { readonly item: QueueItem; readonly duplicate: boolean } | undefined {
  const store = ctx.session.store
  if (requestId !== undefined) {
    const already = queuedByRequest(store, handle, requestId)
    if (already !== undefined) return { item: itemOf(already), duplicate: true }
  }
  const turns = ctx.get('turns') as TurnRegistry | undefined
  const busy = turns?.isRunning(handle.id) === true
  if (!busy && pendingInbox(store, handle)['next-turn'].length === 0) return undefined
  const message = queueTurn(store, handle, content, undefined, requestId !== undefined ? { requestId } : {})
  // A new send is the person acting again: a queue held by their Stop may drain once the session is free.
  held.get(ctx)?.delete(handle.id)
  kick(ctx, handle.id)
  return { item: itemOf(message), duplicate: false }
}

/** Read a JSON body; answers `undefined` (and the 400) when it is not an object. */
async function readBody(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > 10 * 1024 * 1024) {
      answer(response, 413, { error: 'the body is larger than 10 MiB' })
      return undefined
    }
    chunks.push(chunk as Buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // answered below
  }
  answer(response, 400, { error: 'the body is not a JSON object' })
  return undefined
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(`${JSON.stringify(body)}\n`)
}

const QUEUE_PATH = /^\/api\/sessions\/(session-[0-9a-f-]{36})\/queue(\/remove|\/edit)?$/i

/** The queue routes; answers whether the request was one of them. */
export async function handleQueueRoute(ctx: Context, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const match = QUEUE_PATH.exec(url.pathname)
  if (match === null) return false
  const id = match[1]!
  const action = match[2]
  const handle = ctx.session.store.open(id)
  if (handle === null) {
    answer(response, 404, { error: `no session ${id}` })
    return true
  }
  if (action === undefined) {
    if (request.method !== 'GET') return false
    // A queue a page asks about is also a queue the drain looks at, so rows left by a restart run once the session is free.
    kick(ctx, id)
    answer(response, 200, { items: queuedItems(ctx, handle) })
    return true
  }
  if (request.method !== 'POST') return false
  const body = await readBody(request, response)
  if (body === undefined) return true
  const row = typeof body.id === 'string' ? body.id : ''
  if (row.length === 0) {
    answer(response, 400, { error: 'an id is required' })
    return true
  }
  if (action === '/remove') {
    if (removeQueued(ctx.session.store, handle, row)) answer(response, 200, { outcome: 'removed', id: row })
    else answer(response, 409, { outcome: 'claimed', id: row, error: `queued message ${row} is no longer waiting` })
    return true
  }
  const text = typeof body.text === 'string' ? body.text : undefined
  if (text === undefined || text.trim().length === 0) {
    answer(response, 400, { error: 'a non-empty text is required' })
    return true
  }
  const current = pendingInbox(ctx.session.store, handle)['next-turn'].find((message) => message.id === row)
  if (current === undefined) {
    answer(response, 409, { outcome: 'claimed', id: row, error: `queued message ${row} is no longer waiting` })
    return true
  }
  if (!current.content.every((part) => part.type === 'text')) {
    answer(response, 400, { error: 'a queued message with an attachment cannot be edited; remove it and send it again' })
    return true
  }
  replaceQueued(ctx.session.store, handle, row, [{ type: 'text', text }])
  answer(response, 200, { outcome: 'edited', id: row })
  return true
}

/** Sessions whose drain is waiting for the session to go idle, so each has one waiter at most. */
const waiting = new WeakMap<Context, Set<string>>()
/**
 * Sessions a person stopped: their queue is kept and not drained on its own (DSH's `agent.cancel({ kind: 'user' },
 * { keepInbox: true })`; #75), until the person sends again, or steers or edits a row.
 */
const held = new WeakMap<Context, Set<string>>()

/** A person's Stop: keep the session's queue, and run none of it until they act again (#75). */
export function holdQueue(ctx: Context, session: string): void {
  held.get(ctx)?.add(session)
}

/** The person acted again in the session: its queue may drain once the session is free. */
export function releaseQueue(ctx: Context, session: string): void {
  if (held.get(ctx)?.delete(session) === true) kick(ctx, session)
}
/** The server's round budget for a drained turn, as the turn route gives its own. */
const budgets = new WeakMap<Context, number | undefined>()

/** Install the drain for this server: how many rounds a drained turn gets. */
export function installQueue(ctx: Context, options: { readonly maxRounds?: number } = {}): void {
  budgets.set(ctx, options.maxRounds)
  waiting.set(ctx, new Set())
  held.set(ctx, new Set())
}

/**
 * Run the session's first queued prompt once it has nothing in flight; a no-op when nothing waits. A busy session gets
 * one idle waiter, and the drain looks again when it fires, so every row runs in order, one turn each.
 */
export function kick(ctx: Context, session: string): void {
  const pending = waiting.get(ctx)
  if (pending === undefined || pending.has(session) || held.get(ctx)?.has(session) === true) return
  const turns = ctx.get('turns') as TurnRegistry | undefined
  const handle = ctx.session.store.open(session)
  if (handle === null || pendingInbox(ctx.session.store, handle)['next-turn'].length === 0) return
  pending.add(session)
  const idle = turns === undefined ? Promise.resolve() : turns.whenIdle(session)
  void idle.then(() => {
    // Past the turn that just settled, so its own listeners (the goal driver's among them) have run.
    setImmediate(() => {
      pending.delete(session)
      if (held.get(ctx)?.has(session) === true) return
      if (turns?.isRunning(session) === true) {
        kick(ctx, session)
        return
      }
      drain(ctx, session)
    })
  })
}

function drain(ctx: Context, session: string): void {
  const store = ctx.session.store
  const handle = store.open(session)
  if (handle === null) return
  const claimed = claimNextTurn(store, handle)
  if (claimed === undefined) return
  const meta = ctx.session.list().find((one) => one.id === session)
  const endpoint = meta?.endpoint ?? ctx.model.defaultEndpoint()
  if (endpoint === undefined) {
    ctx.logger.warn('queue: no endpoint is configured for the queued turn in session %s', session)
    return
  }
  const text = textOf(claimed.content)
  const attachments = claimed.content.filter((part) => part.type !== 'text')
  const maxRounds = budgets.get(ctx)
  const turn = runTurn(ctx, {
    session: handle,
    endpoint,
    prompt: text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(meta?.model !== undefined ? { model: meta.model } : {}),
    ...(meta?.reasoningEffort !== undefined ? { reasoningEffort: meta.reasoningEffort } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
  })
  void turn
    .catch((error: unknown) => {
      ctx.logger.warn('queue: the queued turn in session %s failed — %s', session, error instanceof Error ? error.message : String(error))
    })
    .finally(() => kick(ctx, session))
}
