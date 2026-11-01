// A bash call's own timeoutMs follows DSH's rule (`dsh-tool-bash` validateBashArgs, `dsh-timeout` clampTimeout): a value
// that is not a finite positive number is refused and the command does not run, a larger one is cut to the tools row's
// `bashMaxTimeoutMs` (DSH's maxTimeoutMs, ten minutes by default). Live-testing issue #13: the TypeScript build killed the
// command at once for 0, -5 and 3000000000 and said it had timed out, and neither build had a cap.
// A scripted endpoint asks for one bash call per run. Runs against whichever harness HEDDLE_BIN names, or the TS build.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

function profile(home, maxTimeoutMs) {
  const dir = join(home, 'bash-timeout-profile')
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
${maxTimeoutMs === undefined ? '' : `        bashMaxTimeoutMs: ${maxTimeoutMs}\n`}`,
  )
  return dir
}

/** Run one turn whose model asks for `bash` with `args`; return the tool results and whether the marker was written. */
async function bashCall(args, options = {}) {
  const home = isolatedHome('bash-timeout')
  const marker = join(home, 'ran.marker')
  try {
    const command = (args.command ?? 'touch {marker}; echo ok').replace('{marker}', JSON.stringify(marker))
    const { config } = scriptedConfig({
      home,
      steps: [{ toolCall: { name: 'bash', arguments: { ...args, command } } }, { text: 'done' }],
    })
    const run = await runCli(['--profile', profile(home, options.maxTimeoutMs), '--sandbox-root', home, '--turn', 'run it'], {
      env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    })
    // A refused or timed-out call is a denial, which a `--turn` run reports with exit 1; the transcript is the verdict.
    assert.ok(run.code === 0 || run.code === 1, `the turn ran (exit ${run.code})\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(home, 'sessions'))[0]
    const results = readTranscript(join(home, 'sessions', session))
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    return { results, ran: existsSync(marker) }
  } finally {
    removeDir(home)
  }
}

test('timeoutMs 0 is refused and the command does not run, as DSH refuses a non-positive timeout', async () => {
  const { results, ran } = await bashCall({ timeoutMs: 0 })
  assert.deepEqual(results, ['error (BAD_ARGS): invalid timeoutMs: expected a positive number, got 0'])
  assert.equal(ran, false, 'the command did not run')
})

test('a negative timeoutMs is refused the same way', async () => {
  const { results, ran } = await bashCall({ timeoutMs: -5 })
  assert.deepEqual(results, ['error (BAD_ARGS): invalid timeoutMs: expected a positive number, got -5'])
  assert.equal(ran, false, 'the command did not run')
})

test('an over-large timeoutMs is cut to the cap, so the command runs instead of being killed at once', async () => {
  const { results, ran } = await bashCall({ timeoutMs: 3_000_000_000, command: 'sleep 0.3; touch {marker}; echo ok' })
  assert.deepEqual(results, ['ok\n'])
  assert.equal(ran, true, 'the command ran to its end')
})

test("the tools row's bashMaxTimeoutMs caps what a call may ask for", async () => {
  const { results, ran } = await bashCall({ timeoutMs: 5_000, command: 'sleep 3; touch {marker}; echo late' }, { maxTimeoutMs: 400 })
  assert.equal(results.length, 1, JSON.stringify(results))
  assert.match(results[0], /^error \(TIMEOUT\): the command exceeded 400ms and was killed/)
  assert.equal(ran, false, 'the command was stopped at the cap, before it finished')
})
