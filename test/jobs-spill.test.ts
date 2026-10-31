import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { bashBackground } from '../src/jobs/bash.ts'
import { JobRegistry, type JobEvent } from '../src/jobs/registry.ts'
import { DEFAULT_MAX_SPILL_BYTES, DEFAULT_STREAM_TAIL_BYTES, privateSpillDir, StreamSpill } from '../src/jobs/spill.ts'
import { jobTools } from '../src/jobs/tools.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { attachBashBackground, builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A background job's streams spill to private files once they outgrow the in-memory tail, so the model's
 * dropped-output notice can name where the whole stream is (DSH's `OutputCollector` spill,
 * `dsh-subprocess-local/lib/output.js`, and `renderModelDelta`'s notice in `dsh-tool-jobs`).
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-jobs-spill-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0
const dirFor = (): string => {
  const dir = join(scratch, `spill-${(counter += 1)}`)
  mkdirSync(dir)
  return dir
}
const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')

test('the defaults are DSH bash provider\'s: a 64 000-byte tail and a 64 MiB spill cap', () => {
  assert.equal(DEFAULT_STREAM_TAIL_BYTES, 64_000)
  assert.equal(DEFAULT_MAX_SPILL_BYTES, 64 * 1024 * 1024)
})

test('a stream within its tail never spills', () => {
  const dir = dirFor()
  const spill = new StreamSpill('stdout', { dir, tailBytes: 10 })
  spill.push(bytes('12345'))
  spill.push(bytes('67890'))
  spill.seal()
  assert.equal(spill.path, undefined)
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(spill.total, 10)
})

test('the first overflow opens the file with the held chunks first, and every later chunk is appended', () => {
  const dir = dirFor()
  const spill = new StreamSpill('stderr', { dir, tailBytes: 8 })
  spill.push(bytes('abcd'))
  spill.push(bytes('efgh'))
  assert.equal(spill.path, undefined, 'exactly at the cap is not an overflow')
  spill.push(bytes('ijkl'))
  /** Read past the narrowing of the `undefined` assertion above: the getter's value changed. */
  const path = (spill as StreamSpill).path
  assert.ok(path !== undefined && path.startsWith(dir), `a file in the spill directory, saw ${path}`)
  assert.match(path, new RegExp(`heddle-jobs-${process.pid}-\\d+-[0-9a-f]{12}-stderr\\.log$`))
  spill.push(bytes('mnop'))
  spill.seal()
  assert.equal(readFileSync(path, 'utf8'), 'abcdefghijklmnop', 'the file holds the stream from byte 0')
  assert.equal(statSync(path).mode & 0o777, 0o600, 'private to the user')
  assert.equal(spill.path, path, 'a sealed file is still advertised')
})

test('past the spill cap the file is removed and spilling stops for good', () => {
  const dir = dirFor()
  const spill = new StreamSpill('stdout', { dir, tailBytes: 4, maxBytes: 12 })
  spill.push(bytes('aaaa'))
  spill.push(bytes('bbbb'))
  const path = spill.path
  assert.ok(path !== undefined)
  spill.push(bytes('cccc'))
  assert.equal(spill.path, path, 'exactly at the cap still holds the complete stream')
  spill.push(bytes('d'))
  assert.equal(spill.path, undefined, 'one byte past the cap: the file could no longer be complete')
  assert.equal(existsSync(path), false, 'and it is removed')
  spill.push(bytes('eeee'))
  assert.equal(spill.path, undefined, 'it never reopens')
  assert.deepEqual(readdirSync(dir), [])
})

test('a spill that cannot open is reported once and collection goes on', () => {
  const failures: string[] = []
  const spill = new StreamSpill('stdout', { dir: join(scratch, 'no-such-dir'), tailBytes: 2, onFailure: (_error, label) => failures.push(label) })
  spill.push(bytes('aa'))
  assert.doesNotThrow(() => spill.push(bytes('bb')))
  assert.doesNotThrow(() => spill.push(bytes('cc')))
  assert.deepEqual(failures, ['stdout'])
  assert.equal(spill.path, undefined)
  assert.equal(spill.total, 6)
})

test('the default directory is private (0700) under the OS tmpdir, and one per process', () => {
  const dir = privateSpillDir()
  assert.ok(dir.startsWith(tmpdir()) || dir.startsWith('/private' + tmpdir()), dir)
  assert.match(dir, /heddle-jobs-[^/]+$/)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(privateSpillDir(), dir)
})

/** The real tool registry, background bash and the job tools, with a small ring and a small tail. */
function harness() {
  const root = join(scratch, `h-${(counter += 1)}`)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const spillDir = join(root, 'spill')
  mkdirSync(spillDir)
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(root, 'sessions') })
  const tools = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) tools.register(tool)
  const jobs = new JobRegistry({ sessionExists: (id) => sessions.store.open(id) !== null, retainBytes: 4_096, settledRetainBytes: 1_024 })
  jobs.attachController('test')
  for (const tool of jobTools(jobs)) tools.register(tool)
  attachBashBackground(sandbox, bashBackground(jobs, sandbox, { readLog: (handle) => sessions.store.read(handle), spill: { dir: spillDir, tailBytes: 2_048 } }))
  const events: JobEvent[] = []
  jobs.subscribe((event) => events.push(event))
  const session = sessions.start({ cwd: workspace })
  const call = (name: string, args: Record<string, unknown>) => tools.call(name, args, { cwd: workspace, session, log: () => undefined })
  return { call, events, jobs, spillDir, session }
}

async function settledEvent(events: JobEvent[], id: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === 'settled' && event.job.id === id)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`job ${id} never settled`)
}

test('a background job whose output outgrew the ring names its spill file in the dropped-output notice, and the file holds every byte', async () => {
  const { call, events, jobs, spillDir, session } = harness()
  /** 40 000 lines of `line NNNNN\n` (11 bytes each): 440 000 bytes, far past the 4 KiB ring and the 2 KiB tail. */
  const started = await call('bash', { command: "awk 'BEGIN { for (i = 0; i < 40000; i++) printf \"line %05d\\n\", i }'", run_in_background: true })
  const id = /started background job (bash-[0-9a-f]{16})/.exec(started.output)?.[1]
  assert.ok(id, started.output)
  await settledEvent(events, id)
  const view = jobs.list(session.id).find((job) => job.id === id)
  const paths = view?.output.spillPaths ?? []
  assert.equal(paths.length, 1, `stdout spilled, stderr did not: ${JSON.stringify(paths)}`)
  const [path] = paths as [string]
  assert.ok(path.startsWith(spillDir) && path.endsWith('-stdout.log'), path)

  const read = await call('job_output', { job_id: id })
  assert.match(read.output, new RegExp(`\\[some output was dropped from memory; full output: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`), read.output.slice(0, 400))
  const full = readFileSync(path, 'utf8')
  assert.equal(full.length, 440_000, 'the file holds the complete stream')
  assert.ok(full.startsWith('line 00000\nline 00001\n') && full.endsWith('line 39999\n'))
})

test('a foreground call that answered in time leaves no spill file behind', async () => {
  const { call, spillDir } = harness()
  const answered = await call('bash', { command: "awk 'BEGIN { for (i = 0; i < 2000; i++) printf \"line %05d\\n\", i }'" })
  assert.equal(answered.error, undefined, JSON.stringify(answered.error))
  assert.deepEqual(readdirSync(spillDir), [], 'nobody will ever name it, so it is removed')
})
