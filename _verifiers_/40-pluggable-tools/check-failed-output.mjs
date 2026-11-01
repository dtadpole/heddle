// A failed bash call keeps what it printed (live-testing issue #82). The tool result of a command that exited 7 reached
// the model as the bare `error (EXIT): the command exited 7`, its stdout and stderr dropped on both builds, so the model
// ran a second command to see them. DSH's bash renderResult keeps the body and adds an exit marker. Here the error line
// stays first (the page reads it as the failure and the closed row's summary) and the output follows it.
// A scripted endpoint asks for the issue's exact command. Runs against whichever harness HEDDLE_BIN names, or the TS build.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

function profile(home) {
  const dir = join(home, 'failed-output-profile')
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
`,
  )
  return dir
}


async function toolResults(command) {
  const home = isolatedHome('failed-output')
  try {
    const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: 'bash', arguments: { command } } }, { text: 'done' }] })
    const run = await runCli(['--profile', profile(home), '--sandbox-root', home, '--turn', 'run it'], {
      env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    })
    // A failed call is a denial, which a `--turn` run reports with exit 1; the transcript is the verdict.
    assert.ok(run.code === 0 || run.code === 1, `the turn ran (exit ${run.code})\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(home, 'sessions'))[0]
    return readTranscript(join(home, 'sessions', session))
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
  } finally {
    removeDir(home)
  }
}

test('a command that fails keeps its stdout and stderr below the error line', async () => {
  const results = await toolResults('printf "stdout-marker\\n"; printf "stderr-marker\\n" >&2; exit 7')
  assert.equal(results.length, 1, JSON.stringify(results))
  const [first, ...rest] = results[0].split('\n')
  assert.equal(first, 'error (EXIT): the command exited 7', 'the error line is first')
  assert.match(rest.join('\n'), /stdout-marker/, 'stdout is kept')
  assert.match(rest.join('\n'), /stderr-marker/, 'stderr is kept')
})

test('a command that fails silently is the error line alone, as before', async () => {
  assert.deepEqual(await toolResults('exit 3'), ['error (EXIT): the command exited 3'])
})
