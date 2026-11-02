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

import { oneToolCall } from './fs-tool-turn.mjs'

/**
 * Run one turn whose model writes `content` to `relative` under the scratch folder, given as an absolute path; return
 * the tool results and what `inspect` saw on disk afterwards.
 */
async function writeResult(relative, content, inspect) {
  const { results, scripted, disk } = await oneToolCall({
    label: 'write-errors',
    tool: 'write_file',
    layout: (home) => {
      mkdirSync(join(home, 'scratch', 'folder'), { recursive: true })
      writeFileSync(join(home, 'scratch', 'folder', 'plain.txt'), 'preserved')
    },
    args: (home) => ({ path: join(home, 'scratch', relative), content }),
    inspect: (home) => inspect(join(home, 'scratch')),
  })
  return { results, path: scripted.path, disk }
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
