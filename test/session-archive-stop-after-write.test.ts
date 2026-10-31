import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Stop-and-archive stops the session's work only **after** the archive is written (developer-ten's F1 on stack-2).
 *
 * DSH's `archiveSession` with `stopActivity` writes the archive set first and asks the `workspace/session-stop`
 * listeners only once that write has resolved (`dsh-workspace/lib/index.js:527-541`): a write that throws stops
 * nothing. The flags route aborted the turn and its subagents before `flags()`, so a refused write (`409`), an unknown
 * session (`404`) or a failed write killed the work and archived nothing.
 *
 * The refused write is made the way the store refuses one: `{ archived: true, pinned: true }` on a session whose record
 * already says archived (`SessionFlagError('archived')`, an archived session cannot be pinned). The record is marked on
 * disk while the turn sits in a long bash step, as another writer could have left it; the turn writes no record during
 * that step, so the mark stays.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-archive-stop-order-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const script = join(scratch, 'script.json')
const config = join(scratch, 'heddle.json')
writeFileSync(config, JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: script, model: 'scripted' }] }))
writeFileSync(script, JSON.stringify({ steps: [{ toolCall: { name: 'bash', arguments: { command: 'sleep 40', timeoutMs: 60000 } } }, { text: 'slept' }] }))
const sessionRoot = join(scratch, 'sessions')
const work = join(scratch, 'work')
mkdirSync(work, { recursive: true })
const env = { ...process.env, HOME: scratch, HEDDLE_HOME: scratch, HEDDLE_CONFIG: config, NO_COLOR: '1' }

/** `src/cli.ts web` on a free port, resolved once it prints its URL. */
function startServer(): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [join(repoRoot, 'src', 'cli.ts'), 'web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', sessionRoot],
      { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the server printed no URL within 30s\n${output}`))
    }, 30_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolvePromise({ url: match[1], child })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
    })
  })
}

/** The session's record file under the store: `<root>/<folder>/<id>.json`, or `<root>/<id>/meta.json` in the old shape. */
function metaFile(id: string): string {
  for (const name of readdirSync(sessionRoot)) {
    if (name === id) return join(sessionRoot, name, 'meta.json')
    const file = join(sessionRoot, name, `${id}.json`)
    if (existsSync(file)) return file
  }
  throw new Error(`no record for ${id} under ${sessionRoot}`)
}

/** Probe until it answers something truthy or `ms` pass; `undefined` when it never does. */
async function until<T>(probe: () => Promise<T | undefined | false>, ms: number): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const value = await probe()
    if (value) return value
    await new Promise((done) => setTimeout(done, 100))
  }
  return undefined
}

test('a stop-and-archive whose write is refused stops nothing: the turn and its job keep running', async () => {
  const { url, child } = await startServer()
  const pending: Promise<unknown>[] = []
  try {
    const handshake = await fetch(url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]!
    const post = (path: string, body: object) =>
      fetch(new URL(path, url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const get = async (path: string) => (await fetch(new URL(path, url), { headers: { cookie } })).json() as Promise<any>
    const meta = async (id: string) => ((await get('/api/sessions')) as { id: string; running?: boolean; archived?: boolean }[]).find((one) => one.id === id)
    const runningJobs = async (id: string) => (((await get(`/api/jobs?session=${encodeURIComponent(id)}`)).jobs ?? []) as { status: string }[]).filter((job) => job.status === 'running').length

    pending.push(post('/api/turn', { prompt: 'wait a while', folder: work }).then((response) => response.text()))
    const running = await until(async () => ((await get('/api/sessions')) as { id: string; running?: boolean }[]).find((one) => one.running === true), 15_000)
    assert.ok(running, 'the turn is running')
    const id = running.id
    assert.ok(await until(async () => (await runningJobs(id)) === 1, 15_000), 'and is inside its bash step, a running job')

    const file = metaFile(id)
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), archived: true }, null, 2)}\n`)

    const refused = await post(`/api/sessions/${id}/flags`, { archived: true, pinned: true, stop: true })
    const body = (await refused.json()) as { code?: string }
    assert.equal(refused.status, 409, `an archived session cannot be pinned, so the write is refused\n${JSON.stringify(body)}`)
    assert.equal(body.code, 'archived', 'with the store\'s refusal')

    const stopped = await until(async () => (await meta(id))?.running !== true || (await runningJobs(id)) === 0, 2_000)
    assert.equal(stopped, undefined, `a refused write stops nothing\nsaw: ${JSON.stringify({ meta: await meta(id), jobs: await runningJobs(id) })}`)
    assert.equal((await meta(id))?.running, true, 'the turn is still running')
    assert.equal(await runningJobs(id), 1, 'and its job too')

    /** Put the record back and stop the turn, so nothing outlives the test. */
    const { archived: _archived, ...rest } = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, `${JSON.stringify(rest, null, 2)}\n`)
    await post(`/api/sessions/${id}/stop`, {})
    await Promise.race([Promise.allSettled(pending), new Promise((done) => setTimeout(done, 10_000))])
  } finally {
    child.kill('SIGKILL')
  }
})
