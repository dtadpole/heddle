import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { SESSIONS_FOLDER } from '../src/session/definition.ts'
import { blankReuse, SessionReuseRefused, SessionService } from '../src/session/service.ts'
import { lockPath, type SessionMeta } from '../src/session/store.ts'

/**
 * New session reuses the blank session it names — DSH's `session.create` rule (dsh-api-session-controller
 * `lib/index.js:416-465`, the placement rule at `:755-770`). Phase A measured each New session click leaving another blank
 * session in the store and another definition folder in the workspace (R-developer-eight-9, row C2).
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-blank-reuse-')))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
/** A fresh store and a fresh workspace folder for one test. */
function setup(): { readonly service: SessionService; readonly branch: string; readonly other: string } {
  counter += 1
  const branch = join(scratch, `work-${counter}`, 'ws')
  const other = join(scratch, `work-${counter}`, 'other')
  mkdirSync(branch, { recursive: true })
  mkdirSync(other, { recursive: true })
  return { service: new SessionService(new Context(), { root: join(scratch, `root-${counter}`) }), branch, other }
}

function definitions(branch: string): string[] {
  try {
    return readdirSync(join(branch, SESSIONS_FOLDER), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

const meta = (fields: Partial<SessionMeta> & { readonly cwd: string }): SessionMeta => ({ id: 'session-x', created: '2026-10-29T00:00:00.000Z', turns: 0, ...fields })

test('the rule: refusals first, in DSH order, then started or archived make a new session, and a blank one is reused', () => {
  const folder = scratch
  assert.deepEqual(blankReuse(undefined, folder), { kind: 'create', reason: 'unknown' })
  assert.deepEqual(blankReuse(meta({ cwd: join(folder, 'elsewhere'), origin: 'subagent' }), folder), {
    kind: 'refuse',
    code: 'session/agent-busy',
    message: 'session "session-x" is owned by subagent routing',
  })
  assert.deepEqual(blankReuse(meta({ cwd: '/somewhere/else' }), folder), {
    kind: 'refuse',
    code: 'session/conflict',
    message: `session "session-x" belongs to "/somewhere/else", not "${folder}"`,
  })
  assert.deepEqual(blankReuse(meta({ cwd: folder, archived: true }), folder), { kind: 'create', reason: 'archived' })
  assert.deepEqual(blankReuse(meta({ cwd: folder, turns: 1 }), folder), { kind: 'create', reason: 'started' })
  assert.deepEqual(blankReuse(meta({ cwd: folder }), folder, { running: true }), { kind: 'create', reason: 'started' })
  assert.deepEqual(blankReuse(meta({ cwd: folder }), folder), { kind: 'reuse' })
})

test('New session twice without a prompt leaves one session and one definition, the second answer naming the first', () => {
  const { service, branch } = setup()
  const first = service.createOrReuseAt(branch)
  assert.equal(first.reused, false)
  const second = service.createOrReuseAt(branch, { reuse: first.handle.id })
  assert.equal(second.reused, true, 'the named blank session is reused')
  assert.equal(second.handle.id, first.handle.id)
  assert.equal(second.definition.file, first.definition.file, 'with the definition it already had')
  assert.equal(second.definition.log, first.handle.transcript)
  assert.equal(service.list().length, 1, 'the store holds one session')
  assert.deepEqual(definitions(branch), [first.definition.name], 'and the workspace one definition folder')
  /** Without a name nothing is reused: asking for a new session without naming one is asking for a new one. */
  const third = service.createOrReuseAt(branch)
  assert.equal(third.reused, false)
  assert.notEqual(third.handle.id, first.handle.id)
})

test('a session that has started a turn, or is archived, or is running, stays as it is and a new one is made', () => {
  const { service, branch } = setup()
  const talked = service.createOrReuseAt(branch).handle
  service.user(talked, 'hello')
  const afterTurn = service.createOrReuseAt(branch, { reuse: talked.id })
  assert.equal(afterTurn.reused, false)
  assert.notEqual(afterTurn.handle.id, talked.id)

  service.flags(afterTurn.handle.id, { archived: true })
  const afterArchive = service.createOrReuseAt(branch, { reuse: afterTurn.handle.id })
  assert.equal(afterArchive.reused, false)
  assert.notEqual(afterArchive.handle.id, afterTurn.handle.id)

  const running = service.createOrReuseAt(branch, { reuse: afterArchive.handle.id, running: (id) => id === afterArchive.handle.id })
  assert.equal(running.reused, false)
  assert.notEqual(running.handle.id, afterArchive.handle.id)

  const unknown = service.createOrReuseAt(branch, { reuse: 'session-never-created' })
  assert.equal(unknown.reused, false)
})

test('a session of another folder, or a subagent child, is refused with DSH code and sentence', () => {
  const { service, branch, other } = setup()
  const elsewhere = service.createOrReuseAt(other).handle
  assert.throws(
    () => service.createOrReuseAt(branch, { reuse: elsewhere.id }),
    (error: unknown) =>
      error instanceof SessionReuseRefused &&
      error.code === 'session/conflict' &&
      error.message === `session "${elsewhere.id}" belongs to "${other}", not "${branch}"`,
  )
  const child = service.store.create({ cwd: branch, origin: 'subagent', parentSession: elsewhere.id })
  assert.throws(
    () => service.createOrReuseAt(branch, { reuse: child.id }),
    (error: unknown) => error instanceof SessionReuseRefused && error.code === 'session/agent-busy',
  )
  assert.equal(service.list().length, 2, 'and nothing was created by either refusal')
})

test('a blank session another process is writing is not reused', () => {
  const { service, branch } = setup()
  const blank = service.createOrReuseAt(branch).handle
  service.store.release(blank)
  /** The parent of this test process is alive and is not this process: the lock names a live other writer. */
  writeFileSync(lockPath(blank), `${process.ppid}\n`)
  const next = service.createOrReuseAt(branch, { reuse: blank.id })
  assert.equal(next.reused, false)
  assert.notEqual(next.handle.id, blank.id)
  rmSync(lockPath(blank), { force: true })
})

test('a reused blank with no definition yet is given one, and a requested title names both records', () => {
  const { service, branch } = setup()
  const bare = service.openAt(branch, { fresh: true })
  assert.deepEqual(definitions(branch), [])
  const reused = service.createOrReuseAt(branch, { reuse: bare.id, title: 'Planning' })
  assert.equal(reused.reused, true)
  assert.equal(reused.handle.id, bare.id)
  assert.deepEqual(definitions(branch), [reused.definition.name])
  assert.equal(service.list().find((entry) => entry.id === bare.id)?.title, 'Planning')
})
