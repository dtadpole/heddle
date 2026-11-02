import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { SessionService } from '../src/session/service.ts'

const scratch = mkdtempSync(join(tmpdir(), 'heddle-model-selection-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * A change of a session's model selection is a `model/selection` event in its log (#46, DSH's durable selection
 * event), which every page following the session reads to move its model seat. A repeat of the current selection
 * writes nothing.
 */
test('a change of model selection is one model/selection event, and a repeat writes none', () => {
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const session = sessions.start({ cwd: scratch })
  const selections = () => sessions.store.read(session).filter((event) => event.type === 'model/selection')
  assert.notEqual(sessions.setModel(session.id, { endpoint: 'second', model: 'pro', reasoningEffort: 'high' }), null)
  assert.equal(selections().length, 1, 'one event for the change')
  assert.equal(selections()[0]?.endpoint, 'second')
  assert.equal(selections()[0]?.model, 'pro')
  assert.equal(selections()[0]?.reasoningEffort, 'high')
  sessions.setModel(session.id, { endpoint: 'second', model: 'pro', reasoningEffort: 'high' })
  assert.equal(selections().length, 1, 'choosing what is already chosen writes nothing')
  sessions.setModel(session.id, { endpoint: 'second', model: 'lite', reasoningEffort: 'high' })
  assert.equal(selections().length, 2, 'a new choice is a new event')
  assert.equal(sessions.setModel('session-missing', { endpoint: 'second' }), null, 'no session, no record and no event')
})
