import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ContextService } from '../src/context/service.ts'
import { SessionService } from '../src/session/service.ts'
import type { SessionStore } from '../src/session/store.ts'
import { runTurn } from '../src/agent/loop.ts'
import { ModelService } from '../src/llm/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A session's folder is its identity, and the instruction baseline is read **in** it.
 *
 * The defect these pin was measured rather than imagined: a session bound to one folder, resumed by a
 * server or a CLI launched in another, read the *launching* directory's `AGENTS.md`. The baseline
 * followed whichever directory the process started in, so a conversation could be given a different
 * project's house rules — and the run, the `context` command and the context panel could each name a
 * different file. The two facts are separate and both are pinned here: which folder a session belongs
 * to (`folder`), and that the baseline is read from that folder rather than from the sandbox root.
 */

/**
 * The files are read from a scratch home, so a machine whose `~/.heddle/AGENTS.md` exists does not
 * change what this test sees. Set before any service is built, because `heddleHome()` reads the
 * environment at call time and the user-global baseline is the first file in the chain.
 */
const scratch = mkdtempSync(join(tmpdir(), 'heddle-session-folder-'))
const previousHome = process.env.HEDDLE_HOME
process.env.HEDDLE_HOME = join(scratch, 'home')
after(() => {
  if (previousHome === undefined) delete process.env.HEDDLE_HOME
  else process.env.HEDDLE_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
})

/** A folder with one `AGENTS.md`, which is the only thing these tests need a folder for. */
function folderWith(name: string, safeWord: string): string {
  const folder = join(scratch, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'AGENTS.md'), `# house rules\n\nThe safe word is ${safeWord}.\n`)
  return folder
}

/** Everything the model would read, joined — the surface, not the raw log. */
function surfaceText(store: SessionStore, session: Parameters<SessionStore['deriveMessages']>[0]): string {
  return store
    .deriveMessages(session)
    .map((message) => message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''))
    .join('\n')
}

test('a session answers with the folder it was opened in, and not the newest one it shares a store with', () => {
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions-folder') })
  const first = folderWith('alpha-session', 'ALPHA')
  const second = folderWith('beta-session', 'BETA')

  const inFirst = sessions.start({ cwd: first })
  const inSecond = sessions.start({ cwd: second })

  assert.equal(sessions.folder(inFirst), first, 'the folder is the one this session was opened in')
  assert.equal(sessions.folder(inSecond), second, 'and the second session has its own, not the store’s newest')
})

test('the baseline is read from the session’s folder, not from the sandbox root', () => {
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions-baseline') })
  const sessionFolder = folderWith('session-folder', 'ALPHA')
  const sandboxRoot = folderWith('sandbox-root', 'BETA')
  const session = sessions.start({ cwd: sessionFolder })

  const context = new ContextService(new Context(), sessions.store, { instructionsMaxBytes: 100_000 })
  /**
   * Spelled exactly as `runTurn` spells it, which is the point: the folder first, the sandbox root only
   * for a session that recorded none. A test that passed either directory directly would judge this
   * file's own arithmetic instead of the rule the run applies.
   */
  const cwd = sessions.folder(session) ?? sandboxRoot
  context.ensureContext(session, { cwd })

  const text = surfaceText(sessions.store, session)
  assert.ok(text.includes('ALPHA'), 'the model reads the house rules of the conversation’s own folder')
  assert.ok(!text.includes('BETA'), 'and not the ones of the directory the process happened to start in')
  /**
   * The two folders really do say different things, so the assertion above is not vacuous: the sandbox
   * root holds a file the baseline would have carried under the old rule.
   */
  assert.match(readFileSync(join(sandboxRoot, 'AGENTS.md'), 'utf8'), /BETA/)
})

test('a legacy record with no directory leaves the explicit fallback available', () => {
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions-legacy-folder') })
  const session = sessions.start({ cwd: folderWith('legacy-record', 'LEGACY') })
  const meta = JSON.parse(readFileSync(session.meta, 'utf8'))
  delete meta.cwd
  writeFileSync(session.meta, JSON.stringify(meta))
  assert.equal(sessions.folder(session), undefined)
  writeFileSync(session.meta, '{broken')
  assert.equal(sessions.folder(session), undefined, 'unreadable metadata also leaves the fallback available')
})

test('a real resumed turn reads session instructions without moving the tool sandbox', async () => {
  const ctx = new Context()
  const sessionFolder = folderWith('turn-session', 'TURN_ALPHA')
  const sandboxRoot = folderWith('turn-sandbox', 'TURN_BETA')
  const sessions = new SessionService(ctx, { root: join(scratch, 'sessions-real-turn') })
  const original = sessions.start({ cwd: sessionFolder })
  const session = sessions.start({ resume: original.id })
  const sandbox = new SandboxService(ctx, { workspaceRoot: sandboxRoot, backend: 'none' })
  const approvals = new ApprovalService(ctx, { mode: 'allow' })
  const tools = new ToolRegistry(ctx, approvals, sandbox, sessions)
  let toolCwd: string | undefined
  tools.register({
    spec: { name: 'probe_directory', description: 'Report the tool directory', parameters: { type: 'object', properties: {} } },
    run: async (_args, runtime) => {
      toolCwd = runtime.cwd
      return { output: runtime.cwd }
    },
  })
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const script = join(scratch, 'session-folder-turn.json')
  writeFileSync(script, JSON.stringify({ steps: [
    { toolCall: { name: 'probe_directory', arguments: {} } },
    { text: 'done' },
  ] }))
  new ModelService(ctx, [{ name: 'scripted', kind: 'scripted', baseUrl: script }])
  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'Probe the directory', maxRounds: 3 })
  assert.equal(result.text, 'done')
  assert.ok(surfaceText(sessions.store, session).includes('TURN_ALPHA'), 'runTurn reads the resumed session baseline')
  assert.ok(!surfaceText(sessions.store, session).includes('The safe word is TURN_BETA'), 'launch-directory instructions are not substituted')
  assert.equal(toolCwd, sandbox.workspaceRoot, 'tool calls stay under the configured sandbox directory')
})
