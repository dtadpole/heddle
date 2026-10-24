// Re-records this folder's fixtures with the TypeScript build: each Trajectory verifier's own scenario, run through
// src/cli.ts from source, decoded to one JSON event per line.
//
//   node record.mjs --checkout <dir> --out <dir>
//
// <checkout> is a checkout of the TypeScript sources with its node_modules (Node 24 runs it from source). Each
// scenario gets a fresh home under <out> holding a work folder with a.txt and b.txt, and the CLI starts in that work
// folder as the verifiers start theirs; <out>/<fixture>.jsonl is written. The endpoints are the shapes the
// verifiers configure: lib.mjs's scriptedConfig, and for check-composer's dock its chatDouble with that check's
// startServer('stats', …) options. The double answers from this process, so the CLI is spawned asynchronously.
// Needs `zstd` on PATH to decode the logs.
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'

const { values } = parseArgs({ options: { checkout: { type: 'string' }, out: { type: 'string' } } })
if (values.checkout === undefined || values.out === undefined) {
  console.error('usage: node record.mjs --checkout <dir> --out <dir>')
  process.exit(2)
}
const checkout = resolve(values.checkout)
const out = resolve(values.out)
const { chatDouble, scriptedConfig } = await import(new URL('../../../../../_tools_/verify-runner/lib.mjs', import.meta.url).href)
const run = promisify(execFile)

const scenarios = [
  {
    fixture: '85-run-pwd-and-answer',
    steps: [{ toolCall: { name: 'bash', arguments: { command: 'pwd' } } }, { text: 'the answer' }],
    prompts: ['run pwd and answer'],
  },
  {
    fixture: '80-list-dir-two-turns',
    steps: (work) => [{ toolCall: { name: 'list_dir', arguments: { path: work } } }, { text: 'the folder holds two files' }, { text: 'second answer' }],
    prompts: ['what is in here', 'and again'],
  },
  {
    fixture: '80-composer-stats-two-turns',
    double: { content: 'the answer', reasoning: 'thinking', holdOpenMs: 50, usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } },
    prompts: ['first', 'second'],
  },
]

mkdirSync(out, { recursive: true })
for (const scenario of scenarios) {
  const home = join(out, `heddle-recorded-${scenario.fixture}`)
  rmSync(home, { recursive: true, force: true })
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'a.txt'), 'one\n')
  writeFileSync(join(work, 'b.txt'), 'two\n')
  let double
  let config
  let endpoint
  if (scenario.double !== undefined) {
    double = await chatDouble(scenario.double)
    endpoint = 'held'
    config = join(home, 'heddle.json')
    writeFileSync(config, JSON.stringify({ default: endpoint, endpoints: [{ name: endpoint, kind: 'openai-chat', baseUrl: double.baseUrl, model: 'held-model', stream: true, contextWindow: 2000 }] }))
  } else {
    endpoint = 'scripted'
    const steps = typeof scenario.steps === 'function' ? scenario.steps(work) : scenario.steps
    config = scriptedConfig({ home, steps }).config
  }
  try {
    let session
    for (const prompt of scenario.prompts) {
      const resume = session === undefined ? [] : ['--resume', session]
      const { stdout, stderr } = await run(process.execPath, [
        join(checkout, 'src/cli.ts'), '--config', join(checkout, 'cordis.yml'),
        '--session-root', join(home, 'sessions'), '--sandbox-root', work, '--endpoint', endpoint, ...resume, '--turn', prompt,
      ], { cwd: work, env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config, NO_COLOR: '1' }, timeout: 60_000 })
      session ??= /session (session-[0-9a-f-]{36})/.exec(stdout + stderr)?.[1]
      if (session === undefined) throw new Error(`${scenario.fixture}: no session id in the CLI's output`)
    }
    const folder = join(home, 'sessions', readdirSync(join(home, 'sessions'))[0])
    const log = readdirSync(folder).find((name) => name.endsWith('.v2.jsonl.zstd'))
    // A log is one zstd frame per event; `zstd -dc` decodes them all (node:zlib stops after the first).
    const { stdout: decoded } = await run('zstd', ['-dc', join(folder, log)], { encoding: 'buffer', maxBuffer: 64 << 20 })
    writeFileSync(join(out, `${scenario.fixture}.jsonl`), decoded)
    console.log(`recorded ${scenario.fixture}.jsonl (${scenario.prompts.length} turn(s))`)
  } finally {
    await double?.close()
  }
}
