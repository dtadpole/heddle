// A failed read is classified and names the file, as DSH's read tool does (`dsh-tool-fs` resolveRegularReadTarget):
// a missing file is `FS_NOT_FOUND`, `cannot read "<path>": not found`, and a directory `FS_NOT_REGULAR_FILE`,
// `cannot read "<path>": not a regular file`, with DSH's absolute display spelling of the path (`dsh-fs-local`
// localDisplayPath). Live-testing issue #4: the TypeScript build returned Node's raw ENOENT text and the Rust build the
// raw OS error with no path at all, both as TOOL_FAILED, so a model reading several files could not tell which failed.
// A scripted endpoint asks for one read_file call per run, with an absolute path so both builds spell it alike.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

function profile(home) {
  const dir = join(home, 'read-errors-profile')
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
        allow: [read_file]
`,
  )
  return dir
}

/** Run one turn whose model reads `relative` under the home, given as an absolute path; return the tool results. */
async function readResult(relative, layout = () => {}) {
  const home = isolatedHome('read-errors')
  try {
    layout(home)
    const path = join(home, relative)
    const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: 'read_file', arguments: { path } } }, { text: 'done' }] })
    const run = await runCli(['--profile', profile(home), '--sandbox-root', home, '--turn', 'read it'], {
      env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    })
    // A refused call is a denial, which a `--turn` run reports with exit 1; the transcript is the verdict.
    assert.ok(run.code === 0 || run.code === 1, `the turn ran (exit ${run.code})\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(home, 'sessions'))[0]
    const results = readTranscript(join(home, 'sessions', session))
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    return { results, path }
  } finally {
    removeDir(home)
  }
}

test('a missing file is FS_NOT_FOUND and names the file, as DSH says it', async () => {
  const { results, path } = await readResult('notes/missing.txt')
  assert.deepEqual(results, [`error (FS_NOT_FOUND): cannot read "${path}": not found`])
})

test('a directory is FS_NOT_REGULAR_FILE and names it', async () => {
  const { results, path } = await readResult('notes', (home) => mkdirSync(join(home, 'notes'), { recursive: true }))
  assert.deepEqual(results, [`error (FS_NOT_REGULAR_FILE): cannot read "${path}": not a regular file`])
})

test('a readable file still reads as before', async () => {
  const { results } = await readResult('notes/here.txt', (home) => {
    mkdirSync(join(home, 'notes'), { recursive: true })
    writeFileSync(join(home, 'notes', 'here.txt'), 'hello')
  })
  assert.deepEqual(results, ['hello'])
})
