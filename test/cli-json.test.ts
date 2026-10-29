import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { boot, settle } from '../src/boot.ts'

/**
 * `--json` stdout is the document alone (R-developer-nine-1, measured on 2026-10-29).
 *
 * `heddle goal <session> --json` printed the plugins' boot lines — `model: 1 endpoint(s) — …`, `tools: 4 registered,
 * …`, `team: durable team service ready` — to stdout ahead of the JSON, so stdout did not parse. The mechanism is
 * `boot`'s `logLevel`, judged in process. The wiring — a one-shot `--json` run asks for it, a run without `--json`
 * does not — is the command line's own, so it is judged by running `src/cli.ts` on the shipped profile.
 *
 * Every store is a scratch directory: `HOME` and `HEDDLE_HOME` point into it before anything reads them.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-cli-json-'))
process.env.HOME = scratch
process.env.HEDDLE_HOME = scratch
process.env.HEDDLE_CONFIG = join(scratch, 'heddle.json')
writeFileSync(join(scratch, 'script.json'), JSON.stringify({ steps: [{ text: 'ready' }] }))
writeFileSync(
  process.env.HEDDLE_CONFIG,
  JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(scratch, 'script.json'), model: 'scripted' }] }),
)

after(() => rmSync(scratch, { recursive: true, force: true }))

/** The records every fixture exporter saw, shared through a global because the loader imports the plugins itself. */
const captured: { type: string; args: unknown[] }[] = []
;(globalThis as { __heddleCaptured?: typeof captured }).__heddleCaptured = captured

/** A profile of two fixture rows: one exporter that captures, one plugin that logs an info and an error line. */
function loggingProfile(): string {
  const dir = join(scratch, 'logging-profile')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'capture.ts'),
    `export const name = 'capture'
export function apply(ctx: any) {
  ctx.logger.exporter({ export(message: any) { (globalThis as any).__heddleCaptured.push({ type: message.type, args: message.args }) } })
}
`,
  )
  // On \`heddle/ready\`, which fires once every row has loaded, so the capture row is registered whatever the order.
  writeFileSync(
    join(dir, 'noisy.ts'),
    `export const name = 'noisy'
export function apply(ctx: any) {
  ctx.on('heddle/ready', () => {
    ctx.logger.info('noisy: an announcement')
    ctx.logger.error('noisy: a failure')
  })
}
`,
  )
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
    - id: capture
      name: ./capture.ts
    - id: noisy
      name: ./noisy.ts
`,
  )
  return join(dir, 'cordis.yml')
}

test('a boot asked for errors only keeps info records off every exporter, and errors still arrive', async () => {
  const base = loggingProfile()
  const kinds = async (options: { logLevel?: number }): Promise<string[]> => {
    captured.length = 0
    const app = await boot({ base, includeProjectPatch: true, ...options })
    try {
      await settle(app.ctx)
      // The caller logs through the context it was handed, as a turn's tool log does (`turn: wrote …`).
      app.ctx.logger.info('noisy: the caller')
      return captured.filter((record) => String(record.args[0]).startsWith('noisy:')).map((record) => `${record.type} ${String(record.args[0])}`)
    } finally {
      await app.dispose()
    }
  }
  assert.deepEqual(
    await kinds({}),
    ['info noisy: an announcement', 'error noisy: a failure', 'info noisy: the caller'],
    "without the option every info line reaches the exporter, as before",
  )
  assert.deepEqual(
    await kinds({ logLevel: 0 }),
    ['error noisy: a failure'],
    "with level 0 the rows' and the caller's info lines are dropped, and the error still arrives",
  )
})

/** Run `src/cli.ts` from the repository root — the shipped profile — with every store in the scratch directory. */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'src', 'cli.ts'), '--session-root', join(scratch, 'sessions'), '--sandbox-root', scratch, ...args],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 60_000 },
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('goal and tools with --json print the document alone on stdout; without --json the boot lines stay', () => {
  const tools = cli('tools', '--json')
  assert.equal(tools.status, 0, tools.stderr)
  const listed = JSON.parse(tools.stdout) as { name: string }[]
  assert.ok(Array.isArray(listed) && listed.length > 0, `the document is the tool list\n${tools.stdout}`)

  const goal = cli('goal', '--json')
  assert.equal(goal.status, 0, goal.stderr)
  const report = JSON.parse(goal.stdout) as { session: string; goal: unknown }
  assert.match(report.session, /^session-/, 'the document names the folder’s session')
  assert.equal(report.goal, null, 'and no goal is set in it')

  const human = cli('tools')
  assert.equal(human.status, 0, human.stderr)
  assert.match(human.stdout, /^model: \d+ endpoint\(s\)/m, 'a run without --json still prints the boot lines where it did')
  assert.match(human.stdout, /^heddle: \d+ tool\(s\)$/m, 'followed by its listing')
})

test('a --turn with --json prints the document alone, even when a tool logs; without --json the tool line stays', () => {
  writeFileSync(
    join(scratch, 'script.json'),
    JSON.stringify({ steps: [{ toolCall: { name: 'write_file', arguments: { path: 'note.txt', content: 'hi' } } }, { text: 'wrote it' }] }),
  )
  const turn = cli('--new', '--turn', 'write a note', '--json')
  assert.equal(turn.status, 0, turn.stderr)
  const report = JSON.parse(turn.stdout) as { text: string; toolCalls: { name: string; ok: boolean }[] }
  assert.deepEqual(report.toolCalls, [{ name: 'write_file', ok: true }], 'the tool ran, and its `turn: wrote …` line stayed off stdout')
  assert.equal(report.text, 'wrote it')

  const human = cli('--new', '--turn', 'write a note')
  assert.equal(human.status, 0, human.stderr)
  assert.match(human.stdout, /^turn: wrote .*note\.txt/m, 'a run without --json still prints the tool line where it did')
})
