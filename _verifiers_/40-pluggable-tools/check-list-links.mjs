// A symbolic link in a listing is shown as what it points at, as DSH's directory list does: `dsh-fs-local`
// listDirectory probes each child with `stat`, which follows the link, so a link to a folder is a folder (DSH's view
// marks it `d` and walks into it) and a link to a file is a file of the target's size. The Rust build's list_dir follows
// the link the same way and prints `link/`. The TypeScript build took the folder test from the directory entry, which
// does not follow the link, and its size from `stat`, which does: a link to a folder came out as a file whose size is
// the folder's (`link (96B)` on macOS), so a model could not tell it was a folder it can list. Live-testing issue #230.
// A scripted endpoint asks for one list_dir call of the scratch folder per run.
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

function profile(home) {
  const dir = join(home, 'list-links-profile')
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

/** Run one turn whose model lists the scratch folder after `layout` shapes it; return the tool results. */
async function listScratch(layout) {
  const home = isolatedHome('list-links')
  try {
    const scratch = join(home, 'scratch')
    mkdirSync(join(scratch, 'real'), { recursive: true })
    writeFileSync(join(scratch, 'real', 'inside.txt'), 'x')
    writeFileSync(join(scratch, 'plain.txt'), 'preserved')
    layout(scratch)
    const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: 'list_dir', arguments: { path: scratch } } }, { text: 'done' }] })
    const run = await runCli(['--profile', profile(home), '--sandbox-root', home, '--turn', 'list it'], {
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

test('a symbolic link to a folder is listed as a folder, as DSH follows it', async () => {
  const results = await listScratch((scratch) => symlinkSync('real', join(scratch, 'link')))
  assert.deepEqual(results, ['link/\nplain.txt (9B)\nreal/'])
})

test('a symbolic link to a file is listed as a file of the target size', async () => {
  const results = await listScratch((scratch) => symlinkSync('plain.txt', join(scratch, 'alias')))
  assert.deepEqual(results, ['alias (9B)\nplain.txt (9B)\nreal/'])
})
