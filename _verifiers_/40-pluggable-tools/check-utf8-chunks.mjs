// Characters whose UTF-8 bytes reach the harness in separate chunks are decoded whole (live-testing issue #96): the
// TypeScript build decoded each chunk on its own, so a command printing Chinese and an emoji a byte at a time came back
// as replacement characters, while the Rust build was right. DSH concatenates the bytes before decoding.
// A scripted endpoint asks for one bash call. Runs against whichever harness HEDDLE_BIN names, or the TS build.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

/** A command that prints `text` one byte at a time, pausing between bytes so they reach the reader apart. */
function bytewise(text) {
  return [...Buffer.from(text, 'utf8')].map((byte) => `printf '\\${byte.toString(8).padStart(3, '0')}'; sleep 0.03`).join('; ')
}

function profile(home) {
  const dir = join(home, 'utf8-chunks-profile')
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
  const home = isolatedHome('utf8-chunks')
  try {
    const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: 'bash', arguments: { command } } }, { text: 'done' }] })
    const run = await runCli(['--profile', profile(home), '--sandbox-root', home, '--turn', 'print it'], {
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

test('Chinese and an emoji printed one byte at a time reach the model whole', async () => {
  assert.deepEqual(await toolResults(bytewise('你好🙂')), ['你好🙂'])
})
