import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { decodeTranscript } from '../../src/session/transcript.ts'

/**
 * Helpers shared by the verifiers in `_verifiers_/`.
 *
 * Three rules are carried by this file, and all three come from `ULTIMATE_GOAL.md`:
 *
 * - **Nothing here spends anything.** Every check runs against this checkout,
 *   with a substituted provider where a model would otherwise be called, and
 *   never against a paid endpoint unless a check says so in its own name.
 * - **A check that cannot judge says so.** `skipUnless` turns "the mechanism this
 *   part is about does not exist yet" into a labelled skip, which the runner
 *   counts as unjudged (exit `3`) rather than as a pass.
 * - **Fixtures go under `.heddle-tmp/` inside the checkout.** Measured: the loader
 *   imports a plugin by absolute path, so a fixture in `/tmp` cannot resolve
 *   `@deepseek-ai/cordis` and fails to load; and Node strips TypeScript types by
 *   extension, so a generated plugin fixture is `.ts` and never `.mjs`. A check
 *   file itself is plain JavaScript, because Node strips no types from `.mjs`.
 */

/** Repository root, derived from this file so a check can be run from anywhere. */
export const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** Where generated fixtures live. Git-ignored, and skipped by every walk. */
export const scratchRoot = join(repoRoot, '.heddle-tmp')

const scratchCounter = { value: 0 }

/**
 * This run's own token, so two runs of the same check cannot share a fixture.
 *
 * Measured on 2026-10-17: a second verifier run in the same checkout (another session was running the same part)
 * produced `ENOTEMPTY` on `.heddle-tmp/session-work-…`, `spawn … ENOENT` as one run's cleanup removed the other's
 * binary path, and a session id with a `-2` suffix because two runs created one in the same second. The scratch root
 * is a shared directory by design; the **names inside it** are what must be per-process.
 */
const runToken = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`

/** A fresh fixture directory under the scratch root, named for this process. */
export function fixtureDir(label) {
  scratchCounter.value += 1
  const dir = join(scratchRoot, `${label}-${runToken}-${scratchCounter.value}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Allocate a unique runtime evidence path without rewriting historical, committed artifacts.
 *
 * Browser verifiers used to overwrite `_context_` screenshots on every run. That changed the deployment
 * checkout while judging it, and made the clean-main check fail even after all functional assertions
 * passed. Evidence belongs to this run, stays under the checkout's ignored runtime directory, and is
 * never shared with another process or reused by a second allocation.
 */
export function evidencePath(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error('an evidence name must be a filename without directory components')
  }
  scratchCounter.value += 1
  const dir = join(scratchRoot, 'verifier-evidence', runToken, String(scratchCounter.value))
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

/** An isolated home for one check, so its sessions and config are its own. */
export function isolatedHome(label) {
  return fixtureDir(`home-${label}`)
}

/** Write a JSON file and return its path. */
export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

/** Remove a fixture directory, ignoring the case where it never appeared. */
export function removeDir(path) {
  rmSync(path, { recursive: true, force: true })
}

/** Every file under `dir`, relative to it and sorted, or `[]` when it is absent. */
export function listFiles(dir) {
  if (!existsSync(dir)) return []
  const found = []
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(current, entry.name), next)
      else found.push(next)
    }
  }
  walk(dir, '')
  return found.sort()
}

/** How many files a directory holds, and the newest modification time. */
export function fingerprint(dir) {
  let newestMtime = 0
  const files = listFiles(dir)
  for (const name of files) {
    try {
      const stats = statSync(join(dir, name))
      if (stats.mtimeMs > newestMtime) newestMtime = stats.mtimeMs
    } catch {
      continue
    }
  }
  return { files: files.length, newestMtime }
}

/**
 * Run one command and capture it whole.
 *
 * A timeout is a judgement, not an error: a run that hangs cannot satisfy any
 * part, so it is reported as a failure of that check with the partial output
 * attached.
 */
export async function run(command, args, options = {}) {
  const child = spawn(command, [...args], {
    cwd: options.cwd ?? repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const timeoutMs = options.timeoutMs ?? 30_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)

  const code = await new Promise((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('close', resolvePromise)
  })
  clearTimeout(timer)

  return { code, stdout, stderr, timedOut, failed: timedOut || code !== 0 }
}

/**
 * The command that runs the harness under test, as `[file, argv]`.
 *
 * By default it is the TypeScript build, `node dist/cli.js`. `HEDDLE_BIN` names any other build of the same
 * contract — the Rust port's binary — and the checks then judge **that** binary unchanged: the verifiers
 * are the contract, and a port is finished when they pass against it (rust/ULTIMATE_GOAL.md). An empty
 * value is the default, so an unset and a blank variable mean the same thing.
 */
export function heddleCommand(args, env = process.env) {
  const bin = namedBinary(env)
  if (bin !== null) return [bin, [...args]]
  return [process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args]]
}

/** The binary `HEDDLE_BIN` names, or `null` when the TypeScript build is the one under test. */
function namedBinary(env) {
  const bin = env.HEDDLE_BIN
  return typeof bin === 'string' && bin.length > 0 ? bin : null
}

/**
 * The file that **is** the harness under test: `dist/cli.js` by default, the `HEDDLE_BIN` binary otherwise.
 *
 * For a check that first asks whether there is a build to judge at all. Naming `dist/cli.js` there asks the
 * TypeScript build that question even when the binary is the one under test.
 */
export function harnessEntry(env = process.env) {
  return namedBinary(env) ?? join(repoRoot, 'dist', 'cli.js')
}

/**
 * Skip a check that judges the TypeScript build **in process** when `HEDDLE_BIN` names the harness under test.
 *
 * Such a check imports modules from `dist/` and calls them, so under `HEDDLE_BIN` it would pass without the
 * binary ever running — a pass reported for a build it never looked at. There it is unjudged, and says why,
 * until its claim has a route through the command line; on the TypeScript build it judges what it always did.
 */
export function inProcessOnly(context, claim, env = process.env) {
  return skipUnless(context, namedBinary(env) === null, `judged in process against dist/, not through HEDDLE_BIN: ${claim}`)
}

/**
 * Run the built CLI.
 *
 * The built output is judged rather than `src/`, so the check measures what a
 * user installs. The build is the caller's job — a check that built the project
 * itself would hide a broken build behind a passing test.
 */
export function runCli(args, options = {}) {
  const [file, argv] = heddleCommand(args)
  return run(file, argv, options)
}

/** Run the CLI from source, for a check that needs the sources rather than the build. */
export function runCliSource(args, options = {}) {
  return run(process.execPath, [join(repoRoot, 'src', 'cli.ts'), ...args], options)
}

/**
 * Skip a check when the mechanism it judges is not built yet.
 *
 * `context.skip(reason)` marks it unjudged, which is the honest verdict for a
 * part whose subject does not exist: it is not a pass, and it is not a failure of
 * the part either.
 */
export function skipUnless(context, condition, reason) {
  if (!condition) context.skip(reason)
  return Boolean(condition)
}

/** Does this checkout declare a dependency, in either dependencies section? */
export function hasDependency(name) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name])
}

/** The plugin labels a run reported, read from the CLI's own output. */
export function loadedPlugins(stdout) {
  return stdout
    .split('\n')
    .filter((line) => /^\s{2}\S/.test(line))
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name.length > 0 && name !== 'fiber(s)')
}

/** The plugin count a run reported, or `null` when it said nothing usable. */
export function loadedCount(stdout) {
  const match = /heddle: (\d+) plugin\(s\) loaded/.exec(stdout)
  return match ? Number(match[1]) : null
}

/**
 * A local configuration whose default endpoint is a **script**.
 *
 * This is the offline backend every turn-driven check uses: a JSON file of steps
 * read by the `scripted` adapter, calling nothing. A check that drives a turn is
 * therefore reproducible and free, and the one check that spends real quota says
 * so in its own name.
 */
export function scriptedConfig(options) {
  const name = options.name ?? 'scripted'
  const script = join(options.home, 'script.json')
  writeJson(script, { steps: options.steps })
  const config = writeJson(join(options.home, 'heddle.json'), {
    default: name,
    endpoints: [{ name, kind: 'scripted', baseUrl: script, model: 'scripted' }, ...(options.extraEndpoints ?? [])],
  })
  return { config, script }
}

/** A local configuration whose default endpoint points at a local double. */
export function httpConfig(options) {
  const name = options.name ?? 'double'
  return writeJson(join(options.home, 'heddle.json'), {
    default: name,
    endpoints: [
      {
        name,
        kind: options.kind ?? 'openai-chat',
        baseUrl: options.baseUrl,
        model: options.model ?? 'double',
        // Streaming by default, because that is what most checks want to exercise; a check
        // about the body-only path turns it off explicitly.
        stream: options.stream ?? true,
      },
    ],
  })
}

/** A minimal OpenAI-compatible chat double, streamed in the provider's shape. */
export async function chatDouble(options = {}) {
  const { createServer } = await import('node:http')
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      /**
       * The model list is discovered on page load, so it is not one of the "endpoint was asked" requests the
       * turn checks count; it is answered (or refused) here, before the completion path below.
       */
      const pathname = new URL(request.url ?? '/', 'http://x').pathname
      const isModelList = pathname.endsWith('/models')
      if (!isModelList) requests.push({ url: request.url ?? '', body, headers: request.headers })
      const message = options.toolCall
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: options.toolCall.name, arguments: JSON.stringify(options.toolCall.arguments ?? {}) },
              },
            ],
          }
        : { role: 'assistant', content: options.content ?? 'double answer' }
      // A body-only answer, for the check that a non-streaming transport still reaches
      // the same delta vocabulary rather than being a second code path.
      if (options.json) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: options.content ?? 'double answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        )
        return
      }

      if (isModelList) {
        if (options.modelList !== undefined) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ object: 'list', data: options.modelList }))
        } else {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'no model list' }))
        }
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const finish = () => {
        /**
         * Usage rides the frame that carries `finish_reason`, which is where the adapters read it — a
         * separate frame after the terminator never reaches the turn. The shape is the provider's own
         * (`prompt_tokens`/`completion_tokens`), so a check can prove the status line's rate and context
         * share from real reported numbers rather than from a unit test of the arithmetic alone.
         */
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: message, finish_reason: options.toolCall ? 'tool_calls' : 'stop' }],
            ...(options.usage !== undefined ? { usage: options.usage } : {}),
          })}\n\n`,
        )
        response.write('data: [DONE]\n\n')
        response.end()
      }
      if (options.reasoning) {
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: options.reasoning }, finish_reason: null }] })}\n\n`,
        )
        // A gap before the terminator, so a run that buffered the answer and printed it
        // at the end is distinguishable from one that streamed.
        if (options.holdOpenMs) setTimeout(finish, options.holdOpenMs)
        else finish()
        return
      }
      finish()
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/ds`,
    requests,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  }
}

/**
 * A Codex-shaped Responses double.
 *
 * Streamed and terminated by `response.completed` rather than `[DONE]`, because
 * that is the contract the real route enforces — measured against the live
 * gateway, and the reason the two adapters are not one.
 */
export async function responsesDouble(options = {}) {
  const { createServer } = await import('node:http')
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push({ url: request.url ?? '', body, headers: request.headers })
      const content = options.content ?? 'double answer'
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: content })}\n\n`)
      response.write(
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`,
      )
      response.end()
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/cx`,
    requests,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  }
}

/**
 * Parse the JSON value a run printed.
 *
 * The CLI prints its JSON last and pretty-printed, so this takes the **last** line that starts
 * a value and parses from there to the end. Measured the hard way: taking the first `{` in the
 * output looks right until a log line contains a brace, and taking the last *line* looks right
 * until the value spans lines, which the pretty-printed objects do.
 */
export function parseJson(stdout) {
  const lines = stdout.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trimStart()
    if (!line.startsWith('{') && !line.startsWith('[')) continue
    const candidate = lines.slice(index).join('\n')
    try {
      return JSON.parse(candidate)
    } catch {
      // A log line can begin with a brace; keep looking upward.
      continue
    }
  }
  return null
}

/** The temp directory a check may use for artifacts it is judging. */
export function tempDir(prefix = 'heddle-check-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Every session directory under a store root. */
export function sessionsUnder(root) {
  /**
   * Every session id the store holds, in **either** layout.
   *
   * Two layouts exist because the store changed where it files a log: a session's own directory (the old
   * shape) and a folder per workspace with one file per session (the current one, the owner's ruling of
   * 2026-10-11). A check asks the root for sessions and gets ids, rather than getting whatever the current
   * layout happens to name its directories.
   */
  const ids = new Set()
  let names
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  for (const name of names) {
    if (name.startsWith('session-')) {
      ids.add(name)
      continue
    }
    let entries
    try {
      entries = readdirSync(join(root, name))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('session-') && entry.endsWith('.json')) ids.add(entry.slice(0, -'.json'.length))
    }
  }
  return [...ids]
}

/**
 * The transcript a session directory holds.
 *
 * Two names exist because the storage format changed: `session.v2.jsonl.zstd` holds one zstd frame
 * per event and `session.jsonl` is the plain JSONL written before that, still read and still
 * appended to. A check asks the directory and gets whichever the session actually has, rather than
 * naming a format it does not own.
 */
export function transcriptFile(dir) {
  /**
   * The log a session actually has, asked for as `<root>/<id>` whatever layout the store used.
   *
   * The old layout keeps `session.v2.jsonl.zstd` or `session.jsonl` **inside** the session's directory; the
   * current one keeps `<id>.v2.jsonl.zstd` or `<id>.jsonl` in the session's **workspace folder**. A check
   * that names a session by root and id therefore does not have to know which of the two it is looking at —
   * which is the point, because the layout is the store's business and not the check's.
   */
  for (const name of ['session.v2.jsonl.zstd', 'session.jsonl']) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  const id = basename(dir)
  if (id.startsWith('session-')) {
    const root = dirname(dir)
    for (const folder of [root, ...readdirSync(root).map((name) => join(root, name))]) {
      for (const name of [`${id}.v2.jsonl.zstd`, `${id}.jsonl`]) {
        const candidate = join(folder, name)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return join(dir, 'session.v2.jsonl.zstd')
}

/**
 * Read a transcript into parsed events, whichever format it is in.
 *
 * A session directory is accepted as readily as a file path, because that is what a check has: it
 * knows which session it is judging, not how that session's events happen to be stored today.
 *
 * The decoder is the harness's own module, imported from `src/` rather than `dist/` for one reason:
 * it must be **sync** (twenty call sites read a transcript in the middle of an assertion) and it
 * must work when a check is judged without a build. The format itself is judged against the built
 * CLI elsewhere — `heddle transcript` prints these same events — so no claim rests on this import.
 */
export function readTranscript(target) {
  const path = target.endsWith('.jsonl') || target.endsWith('.zstd') ? target : transcriptFile(target)
  return decodeTranscript(readFileSync(path)).lines.map((line) => JSON.parse(line))
}

/**
 * Run the CLI and collect both streams **with the time each line arrived**.
 *
 * The timing is the point: a check that a delta was printed before the turn finished
 * cannot be made from a buffer, because a buffer is only read at the end — which is
 * exactly the difference between streaming and printing a finished answer.
 */
export function runCliTimed(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const [file, argv] = heddleCommand(args)
    const child = spawn(file, argv, {
      cwd: options.cwd ?? repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
    })
    const started = Date.now()
    const lines = []
    const record = (stream) => (chunk) => {
      for (const piece of chunk.toString().split('\n')) {
        if (piece.length > 0) lines.push({ at: Date.now() - started, stream, text: piece })
      }
    }
    child.stdout.on('data', record('stdout'))
    child.stderr.on('data', record('stderr'))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`timed out after ${options.timeoutMs ?? 30000}ms`))
    }, options.timeoutMs ?? 30_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      // `resolvePromise`, not `resolve` from `node:path`, which this module also imports.
      // Measured: the first version passed the path function to the executor's resolution
      // slot, so every streaming check failed with a TypeError instead of a verdict.
      resolvePromise({ code, lines, elapsed: Date.now() - started })
    })
  })
}
