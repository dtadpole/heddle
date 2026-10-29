import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { MENU_PATH, menuSource } from '../src/commands/http.ts'
// @ts-expect-error -- a browser module without declarations; its pure functions are judged here, its DOM in 80-web-ui.
import { candidates, claims, detectTrigger } from '../src/commands/menu.js'

/**
 * The slash menu's decisions, judged without a browser: when `/` opens it, which rows it offers, and which submitted
 * lines belong to the command layer rather than the model (DSH's dsh-client-ui-input-trigger and
 * dsh-client-ui-commands, re-read on 2026-10-29).
 */

interface Entry {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly section: 'add' | 'commands'
  readonly input?: { readonly hint: string }
  readonly client?: boolean
}

const catalog: readonly Entry[] = [
  { name: 'compact', label: 'Compact', description: 'Compact older conversation history', section: 'commands' },
  { name: 'export', label: 'Export', description: 'Download this session log', section: 'commands' },
  { name: 'feedback', label: 'Feedback', description: 'Record feedback', section: 'add', input: { hint: '<text>' } },
  { name: 'goal', label: 'Goal', description: 'Set or view the goal', section: 'add', input: { hint: '[<objective>|clear]' } },
  { name: 'permission', label: 'Permission', description: 'Switch the preset', section: 'commands', input: { hint: '<preset>' } },
  { name: 'file', label: 'File', description: 'Attach a file', section: 'add', client: true },
  { name: 'model', label: 'Model', description: 'Select the model', section: 'commands', client: true },
]

test('/ opens at the start, after whitespace or punctuation, and never inside a word, a path or a URL', () => {
  assert.deepEqual(detectTrigger('/', 1), { start: 0, end: 1, query: '', position: 'leading' })
  assert.deepEqual(detectTrigger('/go', 3), { start: 0, end: 3, query: 'go', position: 'leading' })
  assert.deepEqual(detectTrigger('  /co', 5), { start: 2, end: 5, query: 'co', position: 'leading' })
  assert.deepEqual(detectTrigger('fix this /co', 12), { start: 9, end: 12, query: 'co', position: 'inline' })
  assert.equal(detectTrigger('a/b', 3), null, 'after a word character')
  assert.equal(detectTrigger('http://x', 8), null, 'inside a URL')
  assert.equal(detectTrigger('/usr/bin', 8), null, 'a path holds a second slash')
  assert.equal(detectTrigger('/goal ', 6), null, 'the caret has left the token')
  assert.equal(detectTrigger('/go.al', 6), null, 'only name characters follow the slash')
  assert.deepEqual(detectTrigger('/goal ship', 3), { start: 0, end: 3, query: 'go', position: 'leading' }, 'the caret decides')
})

test('an empty query groups the rows as DSH does: Add then Commands, in its order', () => {
  const rows = candidates(catalog, { start: 0, end: 1, query: '', position: 'leading' }) as (Entry & { group: string })[]
  assert.deepEqual(
    rows.map((row) => `${row.group}:${row.name}`),
    ['Add:file', 'Add:goal', 'Add:feedback', 'Commands:compact', 'Commands:permission', 'Commands:model', 'Commands:export'],
  )
})

test('an inline token hides every command that takes input', () => {
  const rows = candidates(catalog, { start: 4, end: 5, query: '', position: 'inline' }) as Entry[]
  assert.deepEqual(rows.map((row) => row.name).sort(), ['compact', 'export', 'file', 'model'])
})

test('a typed query ranks prefixes of the name or label first, then any ordered subsequence', () => {
  const rank = (query: string) => (candidates(catalog, { start: 0, end: query.length + 1, query, position: 'leading' }) as Entry[]).map((row) => row.name)
  assert.deepEqual(rank('co'), ['compact'])
  assert.deepEqual(rank('e'), ['export', 'feedback', 'permission', 'file', 'model'])
  assert.deepEqual(rank('GO'), ['goal'], 'case-insensitive')
  assert.deepEqual(rank('cpt'), ['compact'], 'an ordered subsequence')
  assert.deepEqual(rank('pmt'), [], 'the order matters')
  assert.deepEqual(rank('zz'), [])
})

test('a registered command always belongs to the host; a page entry only bare; anything else goes to the model', () => {
  assert.equal(claims(catalog, '/goal ship it'), true)
  assert.equal(claims(catalog, '/compact'), true)
  assert.equal(claims(catalog, '/compact now'), true, 'the host answers its own usage sentence')
  assert.equal(claims(catalog, '/export /tmp/x.zip'), true)
  assert.equal(claims(catalog, '/model'), true)
  assert.equal(claims(catalog, '/model gpt'), false, 'a page entry with words after it is a prompt, as in DSH')
  assert.equal(claims(catalog, '/skillname do the thing'), false, 'unknown: the model gets it')
  assert.equal(claims(catalog, 'see /compact'), false)
  assert.equal(claims(catalog, '/Goal x'), false)
  assert.equal(claims([], '/goal x'), false, 'before the list has loaded, nothing is claimed')
})

test('the route serves the menu module the page imports, from the checkout', () => {
  assert.equal(MENU_PATH, '/commands/menu.js')
  assert.equal(menuSource(), readFileSync(new URL('../src/commands/menu.js', import.meta.url), 'utf8'))
  assert.match(menuSource(), /export function install\(api\)/)
})
