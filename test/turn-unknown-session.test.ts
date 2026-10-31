import assert from 'node:assert/strict'
import { test } from 'node:test'

import { unknownTurnSession } from '../src/server/web.ts'

/**
 * A turn for a session the server does not hold is a client error with DSH's `session/not-found`
 * (`dsh-api-session-controller`), in the shape of the other session routes: `404 {"error": "no session <id>"}`.
 * The route used to reach the resume, which threw and came back as `500 internal error: no session '<id>' under
 * <session root>` on this build and `400` on the Rust one (DSH parity R-developer-seven-2). The route itself is
 * judged on both builds by `_verifiers_/80-web-ui/check-turn-unknown-session.mjs`.
 */

const KNOWN = 'session-11111111-1111-1111-1111-111111111111'
const UNKNOWN = 'session-22222222-2222-2222-2222-222222222222'

function store(...held: string[]): { open: (id: string) => unknown; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    open: (id: string) => {
      asked.push(id)
      return held.includes(id) ? { id } : null
    },
  }
}

test('an unknown session is DSH\'s session/not-found, naming the id', () => {
  const { open } = store(KNOWN)
  assert.deepEqual(unknownTurnSession(UNKNOWN, open), { error: `no session ${UNKNOWN}`, code: 'session/not-found' })
})

test('a held session, or a turn that names none, is not refused', () => {
  const { open, asked } = store(KNOWN)
  assert.equal(unknownTurnSession(KNOWN, open), null, 'a held session continues')
  assert.equal(unknownTurnSession(undefined, open), null, 'no session: the turn starts one')
  assert.equal(unknownTurnSession('', open), null, 'an empty id is no id')
  assert.deepEqual(asked, [KNOWN], 'only the named id was looked up')
})

test('a string that is not a session id is refused the same way, without being echoed or looked up', () => {
  const { open, asked } = store(KNOWN)
  for (const raw of ['session-does-not-exist', '../../etc/passwd', `SESSION-${KNOWN.slice(8)}`, `${KNOWN}x`]) {
    assert.deepEqual(unknownTurnSession(raw, open), { error: 'no session with that id', code: 'session/not-found' }, raw)
  }
  assert.deepEqual(asked, [], 'no malformed id reached the store')
})

test('the message never carries a path', () => {
  const refusal = unknownTurnSession(UNKNOWN, store().open)
  assert.ok(refusal !== null && !refusal.error.includes('/'), refusal?.error)
})
