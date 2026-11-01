// What write_file tells the model it wrote (live-testing issue #3): the UTF-8 bytes it wrote, and its file named
// relative to the workspace inside it, absolutely elsewhere, never as a climb of ../. DSH's fs write tool reports the
// bytes on disk. Runs against whichever harness HEDDLE_BIN names, or the TypeScript build.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

function profile(home) {
  const dir = join(home, 'write-report-profile')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
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
        allow: [write_file]
`,
  )
  return dir
}

test('a write reports UTF-8 bytes and names its file inside the workspace relatively and elsewhere absolutely', async () => {
  const home = isolatedHome('write-report')
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-write-report-elsewhere-')))
  try {
    const { config } = scriptedConfig({
      home,
      steps: [
        { toolCall: { name: 'write_file', arguments: { path: 'zh.txt', content: '你好，世界' } } },
        { toolCall: { name: 'write_file', arguments: { path: join(elsewhere, 'x.txt'), content: 'x' } } },
        { text: 'done' },
      ],
    })
    const run = await runCli(['--profile', profile(home), '--sandbox-root', home, '--turn', 'write two files'], {
      env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    })
    assert.match(run.stdout, /done/, `the turn ran to its answer\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(home, 'sessions'))[0]
    const results = readTranscript(join(home, 'sessions', session))
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.equal(results.length, 2, results.join('\n'))
    assert.equal(results[0], 'wrote 15 bytes to zh.txt', 'five characters are fifteen bytes of UTF-8, named inside the workspace')
    assert.equal(results[1], `wrote 1 bytes to ${join(elsewhere, 'x.txt')}`, 'a file outside the workspace is named absolutely')
  } finally {
    removeDir(home)
    removeDir(elsewhere)
  }
})
