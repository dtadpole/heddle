import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../src/agent/loop.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { ContextService } from '../src/context/service.ts'
import { ModelService } from '../src/llm/service.ts'
import { SandboxService, type SandboxMode } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A turn's tools run in the session's own folder, not in the directory the process was launched in.
 *
 * Measured on both builds (R-developer-eight-10): a server launched in one directory ran a turn for a session of
 * workspace B, and the turn's `bash pwd` printed the launch directory. DSH roots a session's tools at the session's
 * recorded folder — the shell's directory, the base of a relative path and the `workspace-write` boundary
 * (`dsh-working-directory`, `dsh-sandbox-policy`) — so these turns are run by a process launched elsewhere, with no
 * root named by the operator, and judge where each tool acted.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-tool-cwd-'))
const previousHome = process.env.HEDDLE_HOME
const previousCwd = process.cwd()
process.env.HEDDLE_HOME = join(scratch, 'home')
/** The launch directory: what an unnamed sandbox root falls back to, and where no tool may act. */
const launch = join(scratch, 'launch')
mkdirSync(launch, { recursive: true })
process.chdir(launch)
after(() => {
  process.chdir(previousCwd)
  if (previousHome === undefined) delete process.env.HEDDLE_HOME
  else process.env.HEDDLE_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
})

/** A workspace folder of its own, outside the launch directory. */
function workspace(name: string): string {
  const folder = join(scratch, name)
  mkdirSync(folder, { recursive: true })
  return folder
}

/** One composition, as a server or a CLI boots it, with the built-in tools and a scripted model. */
function compose(label: string, mode: SandboxMode, steps: readonly unknown[]) {
  const ctx = new Context()
  const sessions = new SessionService(ctx, { root: join(scratch, `sessions-${label}`) })
  const sandbox = new SandboxService(ctx, { mode, backend: 'none' })
  const tools = new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) tools.register(tool)
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 100_000 })
  const script = join(scratch, `script-${label}.json`)
  writeFileSync(script, JSON.stringify({ steps }))
  new ModelService(ctx, [{ name: 'scripted', kind: 'scripted', baseUrl: script }])
  return { ctx, sessions, sandbox }
}

test('a turn in a session of workspace B runs bash in B, not in the launch directory', async () => {
  const b = workspace('ws-b-shell')
  const { ctx, sessions, sandbox } = compose('shell', 'danger-full-access', [
    { toolCall: { name: 'bash', arguments: { command: 'pwd' } } },
    { text: 'done' },
  ])
  assert.equal(sandbox.workspaceRoot, realpathSync(launch), 'the fixture really is launched elsewhere')
  const session = sessions.start({ cwd: b })

  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'where am I', maxRounds: 3 })
  assert.equal(result.text, 'done')
  const shell = result.toolCalls.find((call) => call.name === 'bash')
  assert.equal(shell?.result.error, undefined, `the shell ran\n${JSON.stringify(shell?.result)}`)
  assert.equal(shell?.result.output, `${realpathSync(b)}\n`, 'pwd printed the session’s folder')
})

test('a resumed session’s file tools resolve against its folder, and the workspace-write boundary is that folder', async () => {
  const b = workspace('ws-b-files')
  writeFileSync(join(b, 'already-here.txt'), 'from B')
  const { ctx, sessions } = compose('files', 'workspace-write', [
    { toolCall: { name: 'write_file', arguments: { path: 'note.txt', content: 'written in B' } } },
    { toolCall: { name: 'read_file', arguments: { path: 'already-here.txt' } } },
    { toolCall: { name: 'list_dir', arguments: {} } },
    { text: 'done' },
  ])
  const original = sessions.start({ cwd: b })
  const session = sessions.start({ resume: original.id })

  const result = await runTurn(ctx, { session, endpoint: 'scripted', prompt: 'work in my folder', maxRounds: 5 })
  const [write, read, list] = result.toolCalls
  assert.equal(write?.result.error, undefined, `a relative write inside the session’s folder is admitted\n${JSON.stringify(write?.result)}`)
  assert.ok(existsSync(join(b, 'note.txt')), 'the relative path landed in the session’s folder')
  assert.ok(!existsSync(join(launch, 'note.txt')), 'and not in the launch directory')
  assert.equal(read?.result.output, 'from B', 'a relative read is the session folder’s file')
  assert.match(list?.result.output ?? '', /already-here\.txt/, 'list_dir with no path lists the session’s folder')

  const policy = ctx.session
    .events(session)
    .filter((event) => event.type === 'context/note')
    .map((event) => JSON.stringify(event))
    .join('\n')
  assert.ok(policy.includes(realpathSync(b)), `the model is told the session’s folder is its workspace\n${policy}`)
})

test('the root a call runs at: the session’s folder, unless the operator named one', () => {
  const b = workspace('ws-b-rule')
  const named = workspace('named-root')
  const unnamed = new SandboxService(new Context(), { mode: 'workspace-write', backend: 'none' })
  assert.equal(unnamed.rootFor(b), realpathSync(b), 'a session’s folder is its root')
  assert.equal(unnamed.rootFor(undefined), realpathSync(launch), 'a call without a folder falls back to the launch directory')
  const pinned = new SandboxService(new Context(), { mode: 'workspace-write', backend: 'none', workspaceRoot: named })
  assert.equal(pinned.rootFor(b), realpathSync(named), '--sandbox-root still confines every session to the named root')
  const root = unnamed.rootFor(b)
  assert.equal(unnamed.assertWritable('x.txt', 'workspace-write', root), join(realpathSync(b), 'x.txt'), 'a relative path joins the folder')
  assert.equal(unnamed.policy('workspace-write', root).workspaceRoot, realpathSync(b), 'the workspace-write boundary is the folder')
  /** Outside the folder and the host temp areas (where every scratch directory here lives), a write is refused, naming the folder. */
  assert.throws(() => unnamed.assertWritable('/etc/heddle-tool-cwd.txt', 'workspace-write', root), (error: Error) => error.message.includes(`outside the sandbox root ${realpathSync(b)}`))
})
