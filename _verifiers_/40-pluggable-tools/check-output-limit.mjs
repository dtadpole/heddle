// The bash output cap is a setting, as DSH's shell output cap is: a tools row with `bashOutputLimit: 50` shows the
// model 50 characters of a command's combined output and marks the cut, where the cap used to be a fixed 20,000.
// A cut keeps the END of the output and names a file holding all of it, `[output truncated; full output: <path>]`, as
// DSH's bash does (live-testing issue #83: the head was kept, so a long command's closing summary was lost).
// A scripted endpoint asks for one bash call. Runs against whichever harness HEDDLE_BIN names, or the TypeScript build.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

function profile(home, limit) {
  const dir = join(home, 'output-limit-profile')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
    - id: console
      name: ${repoRoot}/src/plugins/console-exporter.ts
    - id: session
      name: ${repoRoot}/src/plugins/session.ts
      config:
        root: ${join(home, 'sessions')}
    - id: model
      name: ${repoRoot}/src/plugins/model.ts
    - id: context
      name: ${repoRoot}/src/context/service.ts
      inject: [model, session]
      config:
        contextWindow: 200000
    - id: sandbox
      name: ${repoRoot}/src/sandbox/service.ts
      config:
        mode: danger-full-access
        workspaceRoot: ${home}
    - id: approvals
      name: ${repoRoot}/src/approvals/service.ts
      config:
        mode: allow
    - id: tools
      name: ${repoRoot}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [bash]
${limit === undefined ? '' : `        bashOutputLimit: ${limit}\n`}`,
  )
  return dir
}

async function bashOutput(limit, command = "printf 'a%.0s' $(seq 1 500)") {
  const home = isolatedHome('output-limit')
  try {
    const { config } = scriptedConfig({
      home,
      steps: [{ toolCall: { name: 'bash', arguments: { command } } }, { text: 'done' }],
    })
    const run = await runCli(['--profile', profile(home, limit), '--sandbox-root', home, '--turn', 'print five hundred'], {
      env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(home, 'sessions'))[0]
    return readTranscript(join(home, 'sessions', session))
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
  } finally {
    removeDir(home)
  }
}

/** The kept tail and the full-output path of a cut result; the file is read, then removed. */
function cut(result) {
  const match = /^([\s\S]*)\n\[output truncated; full output: (.+)\]$/.exec(result)
  assert.ok(match, `the cut is marked with the full-output path: ${String(result).slice(-160)}`)
  const full = readFileSync(match[2], 'utf8')
  rmSync(match[2], { force: true })
  return { kept: match[1], full }
}

test('a tools row with bashOutputLimit shows the model that many characters and marks the cut', async () => {
  const results = await bashOutput(50)
  assert.equal(results.length, 1)
  const { kept, full } = cut(results[0])
  assert.equal(kept, 'a'.repeat(50))
  assert.equal(full, 'a'.repeat(500), 'the named file holds the whole output')
})

test('a long output keeps its end and names a file with all of it, as DSH does (#83)', async () => {
  // The issue's probe: a head marker, 21,000 ordinary characters, a tail marker, at the default limit of 20,000.
  const results = await bashOutput(undefined, "printf 'HEAD-PROBE'; printf 'x%.0s' $(seq 1 21000); printf 'TAIL-PROBE'")
  assert.equal(results.length, 1)
  const { kept, full } = cut(results[0])
  assert.equal(kept.length, 20_000)
  assert.ok(kept.endsWith('TAIL-PROBE'), 'the end of the output is kept')
  assert.ok(!kept.includes('HEAD-PROBE'), 'the start is what is cut')
  assert.equal(full, `HEAD-PROBE${'x'.repeat(21_000)}TAIL-PROBE`, 'the named file holds the whole output')
})

test('without the setting the old cap stands, so 500 characters arrive whole', async () => {
  const results = await bashOutput(undefined)
  assert.deepEqual(results, ['a'.repeat(500)])
})
