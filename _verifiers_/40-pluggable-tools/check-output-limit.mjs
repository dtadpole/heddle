// The bash output cap is a setting, as DSH's shell output cap is: a tools row with `bashOutputLimit: 50` shows the
// model 50 characters of a command's combined output and marks the cut, where the cap used to be a fixed 20,000.
// A scripted endpoint asks for one bash call. Runs against whichever harness HEDDLE_BIN names, or the TypeScript build.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
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

async function bashOutput(limit) {
  const home = isolatedHome('output-limit')
  try {
    const { config } = scriptedConfig({
      home,
      steps: [{ toolCall: { name: 'bash', arguments: { command: "printf 'a%.0s' $(seq 1 500)" } } }, { text: 'done' }],
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

test('a tools row with bashOutputLimit shows the model that many characters and marks the cut', async () => {
  const results = await bashOutput(50)
  assert.deepEqual(results, [`${'a'.repeat(50)}\n… truncated`])
})

test('without the setting the old cap stands, so 500 characters arrive whole', async () => {
  const results = await bashOutput(undefined)
  assert.deepEqual(results, ['a'.repeat(500)])
})
