// A listing comes back in DSH's order (`dsh-fs-local` listDirectory sorts the children with `name.localeCompare`),
// which the TypeScript build shares: ICU collation, so case and accents sort with their letters, and punctuation and
// digits sort before letters in ICU's own order. Names that collate equal keep byte order, because Node's readdir
// hands them over sorted by bytes before its stable sort. Live-testing issue #247: the Rust build sorted by bytes, so
// `B.txt` came before `a.txt` and `é.txt` after `plain.txt`.
// The expected orders are what Node gives under an English locale (en-US: sensitivity "variant", punctuation not
// ignored, numeric off, case-first off); the Rust build uses root collation, which agrees with English. Under another
// locale the TypeScript build follows LANG, so the check reports itself unjudged rather than guess.
// A scripted endpoint asks for one list_dir call of the scratch folder per run.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { skipUnless } from '../../_tools_/verify-runner/lib.mjs'
import { oneToolCall } from './fs-tool-turn.mjs'

const collation = new Intl.Collator().resolvedOptions()
const ENGLISH =
  /^en(-|$)/.test(collation.locale) &&
  collation.sensitivity === 'variant' &&
  !collation.ignorePunctuation &&
  !collation.numeric &&
  collation.caseFirst === 'false'
const UNJUDGED = `the expected orders are English collation; this lane's Node resolves ${JSON.stringify(collation)}`

/** Run one turn whose model lists a scratch folder holding `files` (one byte each) and `folders`; return its lines. */
async function listing(files, folders = []) {
  const { results } = await oneToolCall({
    label: 'list-order',
    tool: 'list_dir',
    layout: (home) => {
      const scratch = join(home, 'scratch')
      mkdirSync(scratch, { recursive: true })
      for (const name of files) writeFileSync(join(scratch, name), 'x')
      for (const name of folders) mkdirSync(join(scratch, name))
    },
    args: (home) => ({ path: join(home, 'scratch') }),
    exits: [0],
  })
  assert.equal(results.length, 1, JSON.stringify(results))
  return results[0].split('\n')
}

test('mixed case and an accent sort with their letters, as localeCompare orders them', async (context) => {
  if (!skipUnless(context, ENGLISH, UNJUDGED)) return
  const lines = await listing(['plain.txt', '\u00e9.txt', 'e.txt', 'c.txt', 'B.txt', 'a.txt'])
  assert.deepEqual(lines, ['a.txt (1B)', 'B.txt (1B)', 'c.txt (1B)', 'e.txt (1B)', '\u00e9.txt (1B)', 'plain.txt (1B)'])
})

test('punctuation and digits sort before letters in ICU order, and a folder sorts by its name among files', async (context) => {
  if (!skipUnless(context, ENGLISH, UNJUDGED)) return
  const lines = await listing(['zed', 'alpha', '9nine', '10ten', '-dash', '_under', '.hidden', 'a b', 'a~b', 'a#b'], ['Docs'])
  assert.deepEqual(lines, [
    '_under (1B)',
    '-dash (1B)',
    '.hidden (1B)',
    '10ten (1B)',
    '9nine (1B)',
    'a b (1B)',
    'a#b (1B)',
    'a~b (1B)',
    'alpha (1B)',
    'Docs/',
    'zed (1B)',
  ])
})

test('names that collate equal keep byte order', async (context) => {
  if (!skipUnless(context, ENGLISH, UNJUDGED)) return
  // A zero-width joiner is ignorable to collation, so `ab` and `a<ZWJ>b` compare equal; both can exist on any file
  // system, and Node lists them in readdir's byte order.
  const lines = await listing(['a\u200db', 'ab'])
  assert.deepEqual(lines, ['ab (1B)', 'a\u200db (1B)'])
})
