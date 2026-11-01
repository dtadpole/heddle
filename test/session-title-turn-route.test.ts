import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { titleFrom } from '../src/session/service.ts'
import { SESSION_TITLE_PURPOSE } from '../src/session/title.ts'

/**
 * A conversation started through the **turn route** is titled the way a blank-first one is (#68).
 *
 * DSH writes no title when a session is created: `dsh-session-title` writes the deterministic fallback from the first
 * eligible human message once it is logged (`onUserMessage` defers `ensureFallback`, lib/index.js:396-403 and 620-648), and
 * the first-prompt provider is scheduled only for a session that has no title yet (`get(session) === undefined`, :387);
 * its answer replaces the fallback unless a person renamed the session first (`rename()` appends a `user`-sourced title,
 * :295-311, and a user title schedules nothing, :383). Heddle's session layer does the same for a session opened blank
 * (`./session-title.test.ts`). Measured before on both builds: `POST /api/turn {prompt, folder, new: true}`, a turn with
 * no session and no folder, and the CLI's `--new --turn` opened the session **already titled** with the prompt cut to
 * 60 characters, so the coordinator saw a named session, asked nothing, and the cut prompt stayed the title for good.
 *
 * The scripted endpoint answers the title call with its `session-title` step and the turn with the untagged one; the
 * script is re-read on every call, so a step that fails the title call shows the fallback that stays.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-turn-route-title-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const script = join(scratch, 'script.json')
const config = join(scratch, 'heddle.json')
writeFileSync(config, JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: script, model: 'scripted' }] }))
const sessionRoot = join(scratch, 'sessions')
const work = join(scratch, 'work')
mkdirSync(work, { recursive: true })
const env = { ...process.env, HOME: scratch, HEDDLE_HOME: scratch, HEDDLE_CONFIG: config, NO_COLOR: '1' }
const common = ['--config', join(repoRoot, 'cordis.yml'), '--session-root', sessionRoot, '--sandbox-root', scratch]

const PROMPT = 'Please summarise the quarterly revenue figures for the northern region and compare them with last year, thanks.'
const GENERATED = 'Northern revenue year on year'
/** The step a title call takes when it answers, and the one that makes it fail. */
const titleStep = { purpose: SESSION_TITLE_PURPOSE, text: `**${GENERATED}**\nA title for your request.` }
const failingTitleStep = { purpose: SESSION_TITLE_PURPOSE, error: { message: 'the title model is down' } }
const useScript = (title: object) => writeFileSync(script, JSON.stringify({ steps: [title, { text: 'a scripted answer' }] }))

/** Every session's meta record under the scratch store, read from disk. */
function metas(): { id: string; title?: string; cwd?: string }[] {
  const found: { id: string; title?: string; cwd?: string }[] = []
  let folders: string[] = []
  try {
    folders = readdirSync(sessionRoot)
  } catch {
    return found
  }
  for (const folder of folders) {
    let entries: string[] = []
    try {
      entries = readdirSync(join(sessionRoot, folder))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('session-') && entry.endsWith('.json')) found.push(JSON.parse(readFileSync(join(sessionRoot, folder, entry), 'utf8')))
    }
  }
  return found
}

const titleOf = (id: string) => metas().find((meta) => meta.id === id)?.title

/** Read a title until it is `wanted` or two seconds pass: a generated title lands without delaying the turn. */
async function titleSettles(id: string, wanted: string): Promise<string | undefined> {
  let title = titleOf(id)
  for (let attempt = 0; attempt < 40 && title !== wanted; attempt += 1) {
    await new Promise((done) => setTimeout(done, 50))
    title = titleOf(id)
  }
  return title
}

/** `src/cli.ts web` on a free port, resolved once it prints its URL. */
function startServer(): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'cli.ts'), 'web', '--host', '127.0.0.1', '--port', '0', ...common], {
      cwd: work,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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

test('a session the turn route opens is titled by its own model, then keeps the fallback at a word when the call fails', async () => {
  const { url, child } = await startServer()
  try {
    const handshake = await fetch(url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]!
    const turn = async (body: object): Promise<string> => {
      const before = new Set(metas().map((meta) => meta.id))
      const response = await fetch(new URL('/api/turn', url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const stream = await response.text()
      assert.equal(response.status, 200, stream)
      assert.match(stream, /a scripted answer/, 'the turn took the turn step, not the title step')
      const made = metas().filter((meta) => !before.has(meta.id))
      assert.equal(made.length, 1, 'the turn opened one new session')
      return made[0]!.id
    }

    useScript(titleStep)
    const folder = join(work, 'ws-new')
    mkdirSync(folder, { recursive: true })
    const fresh = await turn({ prompt: PROMPT, folder, new: true })
    assert.equal(await titleSettles(fresh, GENERATED), GENERATED, '`new: true` in a folder: the generated title replaces the fallback')

    const loose = await turn({ prompt: PROMPT })
    assert.equal(await titleSettles(loose, GENERATED), GENERATED, 'no session and no folder: the same')

    useScript(failingTitleStep)
    const failed = await turn({ prompt: PROMPT, folder, new: true })
    assert.equal(titleOf(failed), titleFrom(PROMPT), "a failed call leaves the fallback the first message wrote: the prompt's words, cut at a word")
    assert.notEqual(titleOf(failed), PROMPT.slice(0, 60), 'not the prompt cut mid-word at 60 characters')
  } finally {
    child.kill('SIGKILL')
  }
})

test("the CLI's --new --turn session follows the same rule", () => {
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(repoRoot, 'src', 'cli.ts'), ...common, ...args], { cwd: work, env, encoding: 'utf8', timeout: 60_000 })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    return JSON.parse(result.stdout) as { session: string; text: string }
  }
  useScript(titleStep)
  const titled = cli('--new', '--turn', PROMPT, '--json')
  assert.equal(titled.text, 'a scripted answer')
  assert.equal(titleOf(titled.session), GENERATED, 'the generated title replaced the fallback before the one-shot process ended')

  useScript(failingTitleStep)
  const failed = cli('--new', '--turn', PROMPT, '--json')
  assert.equal(titleOf(failed.session), titleFrom(PROMPT), 'a failed call leaves the fallback at a word')
  assert.notEqual(titleOf(failed.session), PROMPT.slice(0, 60))
})
