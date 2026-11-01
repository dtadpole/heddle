// A write aimed at something that is not a regular file is refused and names it, as DSH's text write does
// (`dsh-fs-local` writeText probes the target first): an existing folder is `FS_NOT_REGULAR_FILE`,
// `cannot write "<path>": not a regular file`, and the folder and what it holds are left as they were. Live-testing
// issue #237: the TypeScript build returned Node's raw `EISDIR: … open` text and the Rust build the raw
// `Is a directory (os error 21)` with no path, both as TOOL_FAILED.
// A scripted endpoint asks for one write_file call per run, with an absolute path so both builds spell it alike.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

function profile(home) {
  const dir = join(home, 'write-errors-profile')
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
        allow: [write_file]
`,
  )
  return dir
}

/**
 * Run one turn whose model writes `content` to `relative` under the scratch folder, given as an absolute path; return
 * the tool results and what `inspect` saw on disk afterwards.
 */
async function writeResult(relative, content, inspect) {
  const home = isolatedHome('write-errors')
  try {
    const scratch = join(home, 'scratch')
    mkdirSync(join(scratch, 'folder'), { recursive: true })
    writeFileSync(join(scratch, 'folder', 'plain.txt'), 'preserved')
    const path = join(scratch, relative)
    const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: 'write_file', arguments: { path, content } } }, { text: 'done' }] })
    const run = await runCli(['--profile', profile(home), '--sandbox-root', home, '--turn', 'write it'], {
      env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    })
    // A refused call is a denial, which a `--turn` run reports with exit 1; the transcript is the verdict.
    assert.ok(run.code === 0 || run.code === 1, `the turn ran (exit ${run.code})\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(home, 'sessions'))[0]
    const results = readTranscript(join(home, 'sessions', session))
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    return { results, path, disk: inspect(scratch) }
  } finally {
    removeDir(home)
  }
}

test('a write aimed at a folder is FS_NOT_REGULAR_FILE, names it, and leaves the folder as it was', async () => {
  const { results, path, disk } = await writeResult('folder', 'ordinary text', (scratch) => ({
    folder: statSync(join(scratch, 'folder')).isDirectory(),
    child: readFileSync(join(scratch, 'folder', 'plain.txt'), 'utf8'),
  }))
  assert.deepEqual(results, [`error (FS_NOT_REGULAR_FILE): cannot write "${path}": not a regular file`])
  assert.deepEqual(disk, { folder: true, child: 'preserved' })
})

test('a write to a new file still writes as before', async () => {
  const { results, disk } = await writeResult('folder/new.txt', 'recovered', (scratch) => readFileSync(join(scratch, 'folder', 'new.txt'), 'utf8'))
  assert.equal(results.length, 1)
  assert.match(results[0], /^wrote 9 bytes to \S*folder\/new\.txt$/)
  assert.equal(disk, 'recovered')
})
