// A bash command that reads stdin gets end-of-file at once (live-testing issue #97). The tool has no input to give, and
// DSH's shell leaves stdin closed when none is supplied. The TypeScript build left an open pipe that nothing ended, so
// `read` waited for the wall time. The Rust build passed its own stdin on to the command, so the result depended on how
// the harness was started: EOF under a daemon's /dev/null, a wait under an open pipe.
// A scripted endpoint asks for one bash call. Runs against whichever harness HEDDLE_BIN names, or the TS build.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

const READ = 'if read -r line; then printf input; else printf eof; fi'

function profile(home) {
  const dir = join(home, 'stdin-eof-profile')
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

/**
 * Run one turn whose only tool call is `command`, with the harness's own stdin either ignored or an open pipe that is
 * never written, as a supervisor that pipes into the server would leave it. Answers the tool results.
 */
async function toolResults(command, stdin) {
  const home = isolatedHome('stdin-eof')
  try {
    const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: 'bash', arguments: { command, timeoutMs: 3000 } } }, { text: 'done' }] })
    const [file, argv] = heddleCommand(['--profile', profile(home), '--sandbox-root', home, '--turn', 'read it'])
    const child = spawn(file, argv, {
      cwd: repoRoot,
      stdio: [stdin, 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
      child.on('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
    })
    child.stdin?.destroy()
    assert.equal(code, 0, `the turn ran\n${output}`)
    const session = sessionsUnder(join(home, 'sessions'))[0]
    return readTranscript(join(home, 'sessions', session))
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
  } finally {
    removeDir(home)
  }
}

test('a shell read gets end-of-file at once, not the wall time', async () => {
  assert.deepEqual(await toolResults(READ, 'ignore'), ['eof'])
})

test('the command does not inherit the harness’s stdin: an open pipe on the harness still gives the command end-of-file', async () => {
  assert.deepEqual(await toolResults(READ, 'pipe'), ['eof'])
})
