import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as web from '../src/server/web.ts'

/**
 * A turn into a one-shot subagent's session is refused, in DSH's words.
 *
 * DSH's generic session route answers a prompt into a subagent's child with `session/agent-busy`, `session "<id>" is
 * owned by subagent routing`, reason `use subagent delivery for this child session` (dsh-api-session-controller
 * `lib/index.js:128-142`). Phase A measured `POST /api/turn` into a one-shot child answering `200` in both builds and
 * growing the child's log (R-developer-eight-26). `subagentTurnRefusal` is the decision `handleTurn` asks before it opens
 * the session.
 */

type Refusal = (meta: { id: string; origin?: 'subagent'; teamId?: string } | undefined) => {
  status: number
  body: { error: string; code: string; reason: string }
} | null

/** Read through the module namespace, so the unfixed module fails these tests by name instead of failing to load. */
const refusal = (web as unknown as { subagentTurnRefusal?: Refusal }).subagentTurnRefusal

test('a one-shot child refuses the turn with 409 session/agent-busy and DSH\'s sentence and reason', () => {
  assert.equal(typeof refusal, 'function', 'web.ts exports the decision')
  assert.deepEqual(refusal!({ id: 'session-child', origin: 'subagent' }), {
    status: 409,
    body: {
      error: 'session "session-child" is owned by subagent routing',
      code: 'session/agent-busy',
      reason: 'use subagent delivery for this child session',
    },
  })
})

test('an ordinary session, an unknown one and a continuable teammate take the turn', () => {
  assert.equal(typeof refusal, 'function', 'web.ts exports the decision')
  assert.equal(refusal!({ id: 'session-plain' }), null, 'a session that is no subagent\'s')
  assert.equal(refusal!(undefined), null, 'a session the store does not list is left to the resume path to answer')
  assert.equal(refusal!({ id: 'session-mate', origin: 'subagent', teamId: 'session-lead' }), null, 'a teammate is continuable')
})
