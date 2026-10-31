import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../src/agent/loop.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { ContextService } from '../src/context/service.ts'
import { ModelService } from '../src/llm/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import type { SessionHandle } from '../src/session/store.ts'
import { builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A session whose workspace folder was deleted or moved outside heddle (issue #56).
 *
 * Measured on both builds before this change: a fork of such a session answered 200 and recreated the folder with a
 * `_sessions_` drawer in it, and a turn ran on as if nothing had happened — its `write_file` with a relative path put the
 * folder back on disk. DSH does neither: a turn's prompt assembly validates the session's working directory and, when the
 * session's own original directory is gone too, fails with `working-directory: directory does not exist` (dsh-working-
 * directory lib/index.js:87-102 and :123-131); a fork creates no directory and its workspace attach refuses a cwd that
 * does not resolve (dsh-api-session-controller lib/index.js:873-909, dsh-workspace lib/index.js:111-122). A heddle
 * session's recorded folder *is* its original directory, so both refuse here, naming the folder, and write nothing into it.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-missing-folder-'))
const previousHome = process.env.HEDDLE_HOME
process.env.HEDDLE_HOME = join(scratch, 'home')
after(() => {
  if (previousHome === undefined) delete process.env.HEDDLE_HOME
  else process.env.HEDDLE_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
})

/** A workspace folder that exists now, under its canonical spelling, so the reason can be compared exactly. */
function folder(name: string): string {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return realpathSync(path)
}

/** The sentence names the folder by its name, never by its absolute path, as #106's unwritable refusal does. */
const reason = (path: string): string => `This workspace's folder no longer exists: "${basename(path)}"`

/** One completed turn, as the loop records it, so the session has something to fork from. */
function answeredTurn(service: SessionService, handle: SessionHandle, prompt: string): void {
  service.user(handle, prompt)
  service.store.assistantChunk(handle, { type: 'text-delta', text: `answer to ${prompt}` })
  service.store.assistantChunk(handle, { type: 'done', finishReason: 'stop' })
  service.store.append(handle, { type: 'assistant/completed', text: `answer to ${prompt}`, finishReason: 'stop', rounds: 1 })
  service.store.append(handle, { type: 'turn/completed' })
}

/** One composition with the built-in tools and a scripted model, as a server or a CLI boots it. */
function compose(label: string, steps: readonly unknown[]) {
  const ctx = new Context()
  const sessions = new SessionService(ctx, { root: join(scratch, `sessions-${label}`) })
  const sandbox = new SandboxService(ctx, { mode: 'danger-full-access', backend: 'none' })
  const tools = new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) tools.register(tool)
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const script = join(scratch, `script-${label}.json`)
  writeFileSync(script, JSON.stringify({ steps }))
  new ModelService(ctx, [{ name: 'scripted', kind: 'scripted', baseUrl: script }])
  return { ctx, sessions }
}

test('a fork of a session whose folder is gone is refused with the reason, and nothing comes back on disk', () => {
  const w = folder('fork-w')
  const service = new SessionService(new Context(), { root: join(scratch, 'sessions-fork') })
  const source = service.start({ cwd: w, title: 'Source' })
  answeredTurn(service, source, 'a conversation worth continuing')
  const before = service.list().length
  rmSync(w, { recursive: true, force: true })

  assert.throws(
    () => service.fork(source.id),
    (error: Error & { code?: string }) => error.message === reason(w) && error.code === 'session/folder-missing',
    'the fork is refused, naming the folder, with its code',
  )
  assert.throws(() => service.fork(source.id, { atSeq: 0 }), (error: Error) => error.message === reason(w), 'and so is a fork at an explicit event')
  assert.equal(existsSync(w), false, 'the deleted folder is not recreated')
  assert.equal(service.list().length, before, 'and no child session is left in the store')
})

test('a fork of a session whose folder is now a file is refused the same way', () => {
  const w = folder('fork-file')
  const service = new SessionService(new Context(), { root: join(scratch, 'sessions-fork-file') })
  const source = service.start({ cwd: w, title: 'Source' })
  answeredTurn(service, source, 'a conversation worth continuing')
  rmSync(w, { recursive: true, force: true })
  writeFileSync(w, 'not a folder any more\n')

  assert.throws(() => service.fork(source.id), (error: Error) => error.message === reason(w))
  assert.equal(existsSync(join(w, '_sessions_')), false)
})

test('a turn in a session whose folder is gone fails with the reason before any tool runs, and the folder stays gone', async () => {
  const w = folder('turn-w')
  const { ctx, sessions } = compose('turn', [
    { toolCall: { name: 'write_file', arguments: { path: 'notes.md', content: 'x\n' } } },
    { text: 'wrote it' },
  ])
  const session = sessions.start({ cwd: w })
  rmSync(w, { recursive: true, force: true })

  await assert.rejects(
    runTurn(ctx, { session, endpoint: 'scripted', prompt: 'write a note', maxRounds: 3 }),
    (error: Error) => error.message === reason(w),
    'the turn fails, naming the folder',
  )
  assert.equal(existsSync(w), false, 'the relative write did not put the folder back')
  const events = sessions.events(session)
  const types = events.map((event) => event.type)
  const toolResults = events.filter((event) => event.type === 'message' && (event as { message?: { role?: string } }).message?.role === 'tool')
  assert.ok(!types.includes('model/request') && toolResults.length === 0, `no model call or tool ran\n${JSON.stringify(types)}`)
})

test('a turn in a session whose folder still exists runs as before', async () => {
  const w = folder('turn-present')
  const { ctx, sessions } = compose('present', [{ text: 'here' }])
  const session = sessions.start({ cwd: w })
  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'are you there', maxRounds: 2 })
  assert.equal(result.text, 'here')
})

/**
 * New session at a folder that is gone: refused here **on purpose**, where DSH's session create makes the directory
 * (`mkdir(cwd, { recursive: true })`, dsh-api-session-controller lib/index.js:511-516). heddle writes the session's
 * committed definition into the folder, so a recreated folder is a decoy at the old path of a folder a person moved, and
 * Add workspace already refuses a folder that does not exist.
 */
test('a new session at a folder that is gone is refused with the reason, and nothing is written there or in the store', () => {
  const w = folder('create-w')
  const service = new SessionService(new Context(), { root: join(scratch, 'sessions-create') })
  service.createAt(w)
  const before = service.list().length
  rmSync(w, { recursive: true, force: true })

  assert.throws(() => service.createAt(w), (error: Error) => error.message === reason(w), 'the new session is refused, naming the folder')
  assert.equal(existsSync(w), false, 'the deleted folder is not recreated')
  assert.equal(service.list().length, before, 'and no session is left in the store')

  writeFileSync(w, 'not a folder any more\n')
  assert.throws(() => service.createAt(w), (error: Error) => error.message === reason(w), 'a file where the folder was is refused the same way')
})
