import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { SessionService } from '../src/session/service.ts'

/**
 * The rule a fork is cut by: **a completed turn**, not a recorded question.
 *
 * Measured on 2026-10-17, from part 7's provenance check: the fork route answered `200` where the reference answers
 * `409`. The guard read `meta.turns`, and the store bumps that counter when a **user** message is written — so a session
 * whose question was recorded and whose answer never arrived passed the guard and forked a half-finished turn. The
 * claim that matters is the one that can fail: a question alone is not forkable, and the answer's completion is what
 * makes it so.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-fork-guard-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

test('a question with no answer is not forkable, and a completed answer makes it so', () => {
  const service = new SessionService(new Context(), { root: join(scratch, 'root-1') })
  const handle = service.start({ cwd: scratch, title: 'a conversation' })

  service.user(handle, 'a question worth asking')
  /** `turns` says one; the session has no answer, which is the difference this test exists for. */
  const recorded = service.list().find((meta) => meta.id === handle.id)
  assert.equal(recorded?.turns, 1, 'the question is counted as a turn')
  assert.deepEqual(service.fork(handle.id), { error: 'unavailable' }, 'and the session is still not forkable')

  service.store.append(handle, { type: 'assistant/completed', text: 'an answer', finishReason: 'stop', rounds: 1 })
  const forked = service.fork(handle.id)
  assert.ok(forked !== null, 'the completed answer makes it forkable')
  assert.ok('handle' in forked, 'and the fork is a session rather than a refusal')
})
