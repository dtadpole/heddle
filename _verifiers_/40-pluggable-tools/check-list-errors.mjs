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

import { oneToolCall } from './fs-tool-turn.mjs'

/** Run one turn whose model lists `relative` under the scratch folder, given as an absolute path; return the tool results. */
async function listResult(relative, layout = () => {}) {
  const { results, args } = await oneToolCall({
    label: 'list-errors',
    tool: 'list_dir',
    layout: (home) => {
      const scratch = join(home, 'scratch')
      mkdirSync(scratch, { recursive: true })
      writeFileSync(join(scratch, 'plain.txt'), 'preserved')
      layout(scratch)
    },
    args: (home) => ({ path: join(home, 'scratch', relative) }),
  })
  return { results, path: args.path }
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
