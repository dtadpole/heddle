// A symbolic link in a listing is shown as what it points at, as DSH's directory list does: `dsh-fs-local`
// listDirectory probes each child with `stat`, which follows the link, so a link to a folder is a folder (DSH's view
// marks it `d` and walks into it) and a link to a file is a file of the target's size. The Rust build's list_dir follows
// the link the same way and prints `link/`. The TypeScript build took the folder test from the directory entry, which
// does not follow the link, and its size from `stat`, which does: a link to a folder came out as a file whose size is
// the folder's (`link (96B)` on macOS), so a model could not tell it was a folder it can list. Live-testing issue #229.
// A scripted endpoint asks for one list_dir call of the scratch folder per run.
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { oneToolCall } from './fs-tool-turn.mjs'

/** Run one turn whose model lists the scratch folder after `layout` shapes it; return the tool results. */
async function listScratch(layout) {
  const { results } = await oneToolCall({
    label: 'list-links',
    tool: 'list_dir',
    layout: (home) => {
      const scratch = join(home, 'scratch')
      mkdirSync(join(scratch, 'real'), { recursive: true })
      writeFileSync(join(scratch, 'real', 'inside.txt'), 'x')
      writeFileSync(join(scratch, 'plain.txt'), 'preserved')
      layout(scratch)
    },
    args: (home) => ({ path: join(home, 'scratch') }),
    // Listing a folder is never refused here, so the turn must end cleanly.
    exits: [0],
  })
  return results
}

test('a symbolic link to a folder is listed as a folder, as DSH follows it', async () => {
  const results = await listScratch((scratch) => symlinkSync('real', join(scratch, 'link')))
  assert.deepEqual(results, ['link/\nplain.txt (9B)\nreal/'])
})

test('a symbolic link to a file is listed as a file of the target size', async () => {
  const results = await listScratch((scratch) => symlinkSync('plain.txt', join(scratch, 'alias')))
  assert.deepEqual(results, ['alias (9B)\nplain.txt (9B)\nreal/'])
})
