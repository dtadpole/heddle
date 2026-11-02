// A failed listing is classified and names the directory, as DSH's directory list does (`dsh-fs-local` listDirectory):
// a missing directory is `FS_NOT_FOUND`, `cannot list "<path>": not found`, and a file `FS_NOT_DIRECTORY`,
// `cannot list "<path>": not a directory`, with DSH's absolute display spelling of the path (`dsh-fs-local`
// localDisplayPath), as read_file's refusals spell it. Live-testing issue #223: the TypeScript build returned Node's raw
// `ENOENT: … scandir` / `ENOTDIR` text and the Rust build the raw OS error (os error 2 / 20) with no path at all, both
// as TOOL_FAILED, so a model listing several folders could not tell which failed. The TypeScript build also failed a
// whole listing on one dangling symbolic link (`ENOENT: … stat`), where the Rust build lists the link by name.
// A scripted endpoint asks for one list_dir call per run, with an absolute path so both builds spell it alike.
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

function profile(home) {
  const dir = join(home, 'list-errors-profile')
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
        allow: [list_dir]
`,
  )
  return dir
}

/** Run one turn whose model lists `relative` under the scratch folder, given as an absolute path; return the tool results. */
async function listResult(relative, layout = () => {}) {
  const home = isolatedHome('list-errors')
  try {
    const scratch = join(home, 'scratch')
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, 'plain.txt'), 'preserved')
    layout(scratch)
    const path = join(scratch, relative)
    const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: 'list_dir', arguments: { path } } }, { text: 'done' }] })
    const run = await runCli(['--profile', profile(home), '--sandbox-root', home, '--turn', 'list it'], {
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

test('a missing directory is FS_NOT_FOUND and names it, as DSH says it', async () => {
  const { results, path } = await listResult('missing')
  assert.deepEqual(results, [`error (FS_NOT_FOUND): cannot list "${path}": not found`])
})

test('a file is FS_NOT_DIRECTORY and names it', async () => {
  const { results, path } = await listResult('plain.txt')
  assert.deepEqual(results, [`error (FS_NOT_DIRECTORY): cannot list "${path}": not a directory`])
})

test('a dangling symbolic link is listed by name and does not fail the listing', async () => {
  const { results } = await listResult('.', (scratch) => symlinkSync('nowhere', join(scratch, 'dangling')))
  assert.deepEqual(results, ['dangling\nplain.txt (9B)'])
})

test('a listable folder still lists as before', async () => {
  const { results } = await listResult('.', (scratch) => mkdirSync(join(scratch, 'sub')))
  assert.deepEqual(results, ['plain.txt (9B)\nsub/'])
})
