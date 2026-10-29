import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { repoRoot } from '../_tools_/verify-runner/lib.mjs'

/**
 * The page's session shortcuts, **run**: the chord table and `shortcutFor` are read out of `page.html` and evaluated
 * here with the key events a browser delivers, so the matching rule is judged as behaviour, not as text.
 *
 * The events are the ones Chrome sends on a Mac. Chromium's `DomKeyFromNSEvent`
 * (`ui/events/keycodes/keyboard_code_conversion_mac.mm`) keeps Option as a glyph modifier and drops Command, so
 * ⌥⌘A arrives with `key` `å`, ⌥⌘K with `˚`, ⌥⌘G with `©`, ⌥⌘B with `∫`, ⌥⌘, with `≤`, and ⌥⌘N as a dead key, while
 * `code` stays the physical key. DSH matches `code` (`dsh-client-shortcuts`: "the service accepts physical `code`
 * values"); a page that matched `key` answered none of its Option chords on a Mac (DSH parity R-developer-seven-7).
 */

const page = readFileSync(join(repoRoot, 'src', 'server', 'page.html'), 'utf8')

type Shortcut = (event: Record<string, unknown>, options?: { mac?: boolean; afterDeadKey?: boolean }) => string | null

/** The table and the matcher, cut from the page and evaluated alone; `SHORTCUTS_ON_MAC` is supplied, not read. */
function loadShortcutFor(): Shortcut {
  const table = /const SESSION_SHORTCUTS = \[[\s\S]*?\n\]/.exec(page)
  const matcher = /function shortcutFor\([^)]*\) \{[\s\S]*?\n\}/.exec(page)
  assert.ok(table, 'the page has a SESSION_SHORTCUTS table')
  assert.ok(matcher, 'the page has a shortcutFor function')
  return runInNewContext(`const SHORTCUTS_ON_MAC = true\n${table[0]}\n${matcher[0]}\nshortcutFor`) as Shortcut
}

const shortcutFor = loadShortcutFor()

/** One keydown as Chrome builds it: nothing held unless named, nothing composing. */
function keydown(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    getModifierState: () => false,
    ...fields,
  }
}

const mac = { mac: true }
const elsewhere = { mac: false }

test('every Option chord fires with the key values Chrome delivers on a Mac', () => {
  const chords: Array<[string, string, string]> = [
    ['KeyA', 'å', 'archive'],
    ['KeyG', '©', 'rename'],
    ['KeyK', '˚', 'search'],
    ['KeyB', '∫', 'sidebar'],
    ['KeyN', 'Dead', 'new-session'],
    ['Comma', '≤', 'settings'],
  ]
  for (const [code, key, action] of chords) {
    assert.equal(shortcutFor(keydown({ code, key, metaKey: true, altKey: true }), mac), action, `⌥⌘ ${code} (key ${key})`)
  }
  assert.equal(shortcutFor(keydown({ code: 'KeyF', key: 'F', metaKey: true, shiftKey: true }), mac), 'fork', '⇧⌘F')
})

test('the same chords fire with the plain letters, which a keyboard without Option glyphs delivers', () => {
  assert.equal(shortcutFor(keydown({ code: 'KeyA', key: 'a', metaKey: true, altKey: true }), mac), 'archive')
  assert.equal(shortcutFor(keydown({ code: 'KeyA', key: 'a', ctrlKey: true, altKey: true }), elsewhere), 'archive')
  assert.equal(shortcutFor(keydown({ code: 'Comma', key: ',', ctrlKey: true, altKey: true }), elsewhere), 'settings')
})

test('Mod is Command on a Mac and Control elsewhere, and the other one is not part of any chord', () => {
  assert.equal(shortcutFor(keydown({ code: 'KeyA', key: 'å', ctrlKey: true, altKey: true }), mac), null, 'Control+Option on a Mac')
  assert.equal(shortcutFor(keydown({ code: 'KeyA', key: 'å', metaKey: true, ctrlKey: true, altKey: true }), mac), null, 'Control held too')
  assert.equal(shortcutFor(keydown({ code: 'KeyA', key: 'a', metaKey: true, altKey: true }), elsewhere), null, 'Meta elsewhere')
})

test('the modifier set must match exactly', () => {
  assert.equal(shortcutFor(keydown({ code: 'KeyA', key: 'Å', metaKey: true, altKey: true, shiftKey: true }), mac), null, 'Shift added to archive')
  assert.equal(shortcutFor(keydown({ code: 'KeyA', key: 'a', metaKey: true }), mac), null, 'Option missing')
  assert.equal(shortcutFor(keydown({ code: 'KeyF', key: 'ƒ', metaKey: true, altKey: true }), mac), null, 'fork without Shift')
})

test('nothing fires while composing, under AltGraph, after a dead key, or on a dead key other than ⌥⌘N', () => {
  const archive = { code: 'KeyA', key: 'å', metaKey: true, altKey: true }
  assert.equal(shortcutFor(keydown({ ...archive, isComposing: true }), mac), null, 'input method composing')
  assert.equal(shortcutFor(keydown({ ...archive, keyCode: 229 }), mac), null, 'keyCode 229')
  assert.equal(shortcutFor(keydown({ ...archive, getModifierState: (name: string) => name === 'AltGraph' }), mac), null, 'AltGraph')
  assert.equal(shortcutFor(keydown(archive), { mac: true, afterDeadKey: true }), null, 'the key after a dead key')
  assert.equal(shortcutFor(keydown({ code: 'KeyN', key: 'Dead', metaKey: true, altKey: true, shiftKey: true }), mac), null, 'a dead key with Shift')
  assert.equal(shortcutFor(keydown({ code: 'KeyN', key: 'Dead', ctrlKey: true, altKey: true }), elsewhere), null, 'a dead key off a Mac')
  assert.equal(shortcutFor(keydown({ ...archive, defaultPrevented: true }), mac), null, 'an event already taken')
})

test('an event with no physical code falls back to the character, and a code always wins over it', () => {
  assert.equal(shortcutFor(keydown({ code: '', key: 'a', metaKey: true, altKey: true }), mac), 'archive', 'no code: the letter decides')
  assert.equal(shortcutFor(keydown({ code: 'KeyQ', key: 'a', metaKey: true, altKey: true }), mac), null, 'a code that is not in the table')
})

test('the listener tracks dead keys and leaves held repeats unrun', () => {
  /** Removal detectors for the two pieces of state the pure matcher cannot hold. */
  assert.match(page, /shortcutFor\(event, \{ afterDeadKey: shortcutAfterDeadKey \}\)/, 'the listener passes the dead-key state')
  assert.match(page, /shortcutAfterDeadKey = event\.key === 'Dead' && action === null/, 'and keeps it')
  assert.match(page, /if \(event\.repeat\) return/, 'a repeat is taken and not run')
})

test('the page reads a Mac the way DSH does, from navigator.platform and without minding case', () => {
  /**
   * `navigator.userAgentData.platform` is `macOS` on a Mac; a case-sensitive `/Mac/` over it read a Mac as not one,
   * which made Mod Control there and turned every Cmd chord off. DSH reads `navigator.platform` with
   * `/darwin|mac|iphone|ipad/iu` (`dsh-client-shortcuts` `detectEnvironment`).
   */
  const line = /const SHORTCUTS_ON_MAC = [^\n]+/.exec(page)
  assert.ok(line, 'the page decides the platform in one line')
  const onMac = (navigator: Record<string, unknown>) =>
    runInNewContext(`${line[0]}\nSHORTCUTS_ON_MAC`, { navigator }) as boolean
  assert.equal(onMac({ platform: 'MacIntel', userAgentData: { platform: 'macOS' } }), true, 'Chrome on a Mac')
  assert.equal(onMac({ platform: 'iPhone' }), true, 'an iPhone')
  assert.equal(onMac({ platform: 'Win32', userAgentData: { platform: 'Windows' } }), false, 'Windows')
  assert.equal(onMac({ platform: 'Linux x86_64' }), false, 'Linux')
  assert.equal(onMac({ platform: '' }), false, 'unknown')
})

test('Mod+Alt+O adds a workspace, with the key value a Mac delivers', () => {
  /** DSH's Web default for `workspace.add` (`dsh-client-ui-workspace`); the page had no chord for it (S35). */
  assert.equal(shortcutFor(keydown({ code: 'KeyO', key: 'ø', metaKey: true, altKey: true }), mac), 'add-workspace')
  assert.equal(shortcutFor(keydown({ code: 'KeyO', key: 'o', ctrlKey: true, altKey: true }), elsewhere), 'add-workspace')
  assert.match(page, /if \(action === 'add-workspace'\) \{\n\s+void openWorkspacePicker\(\)/, 'the chord opens the picker')
})

test('two Escape presses within 500 ms stop the running turn, as DSH does', () => {
  /** DSH's fixed action: two independent Escape presses in the chat or composer, `stopSequenceMs` 500 by default (S43). */
  const source = /function isStopSequence\([^)]*\) \{[\s\S]*?\n\}/.exec(page)
  assert.ok(source, 'the page has an isStopSequence function')
  const isStopSequence = runInNewContext(`const STOP_SEQUENCE_MS = 500\n${source[0]}\nisStopSequence`) as (previous: number | null, now: number) => boolean
  assert.equal(isStopSequence(null, 1000), false, 'a first press only arms it')
  assert.equal(isStopSequence(1000, 1200), true, 'a second press 200 ms later stops')
  assert.equal(isStopSequence(1000, 1500), true, 'at the interval it still stops')
  assert.equal(isStopSequence(1000, 1501), false, 'past the interval it re-arms instead')
  assert.equal(isStopSequence(1000, 900), false, 'a clock that went back is not a sequence')
  assert.match(page, /const STOP_SEQUENCE_MS = 500/)
  assert.match(page, /if \(event\.repeat \|\| event\.isComposing \|\| event\.defaultPrevented\) return/, 'repeats, composition and taken presses do not count')
  assert.match(page, /if \(document\.querySelector\('dialog\[open\]'\) !== null\) return/, 'nor presses while a dialog is open')
  assert.match(page, /if \(target === null \|\| target\.closest\('main'\) === null\) return/, 'only presses in the conversation column count')
  assert.match(page, /if \(isStopSequence\(stopEscapeAt, now\) && anyRunning\(\)\) \{\n\s+stopEscapeAt = null\n\s+void stopTurn\(\)/, 'and the sequence stops the turn')
})

test('Mod+/ opens DSH\'s keyboard reference: every command in product order, then the fixed input actions', () => {
  /** `dsh-client-ui-shortcuts`: one dialog, ordered commands with their chords, read-only input actions (S40). */
  assert.equal(shortcutFor(keydown({ code: 'Slash', key: '/', metaKey: true }), mac), 'shortcuts-reference')
  const pieces = ['SESSION_SHORTCUTS', 'SHORTCUT_LABELS', 'FIXED_INPUT_ACTIONS', 'function chordText', 'function subsequenceMatch', 'function shortcutReferenceRows']
  const take = (start: string) => {
    const at = page.indexOf(start === 'SESSION_SHORTCUTS' ? 'const SESSION_SHORTCUTS' : start.startsWith('function') ? start : `const ${start}`)
    assert.ok(at !== -1, `${start} is in the page`)
    const end = start.startsWith('function') ? page.indexOf('\n}\n', at) + 2 : page.indexOf('\n]\n', at) !== -1 && page.indexOf('\n]\n', at) < page.indexOf('\n}\n', at) ? page.indexOf('\n]\n', at) + 2 : page.indexOf('\n}\n', at) + 2
    return page.slice(at, end)
  }
  const source = pieces.map(take).join('\n')
  const rows = runInNewContext(`const SHORTCUTS_ON_MAC = true\n${source}\n({ all: shortcutReferenceRows('', true), byKey: shortcutReferenceRows('⌥⌘g', true), byAlias: shortcutReferenceRows('prefs', true), other: shortcutReferenceRows('', false) })`) as Record<string, Array<{ label: string; keys: string; fixed: boolean; group: string }>>
  const plain = JSON.parse(JSON.stringify(rows)) as typeof rows
  assert.deepEqual(plain.all.filter((row) => !row.fixed).map((row) => row.label), ['New session', 'Search sessions', 'Add workspace', 'Rename session', 'Fork session', 'Archive session', 'Toggle sidebar', 'Open settings', 'Keyboard shortcuts'])
  assert.equal(plain.all.find((row) => row.label === 'New session')?.keys, '⌥⌘N')
  assert.equal(plain.all.find((row) => row.label === 'Fork session')?.keys, '⇧⌘F')
  assert.equal(plain.other.find((row) => row.label === 'Rename session')?.keys, 'Ctrl+Alt+G')
  assert.deepEqual(plain.all.filter((row) => row.fixed).map((row) => row.label), ['Send message', 'Insert a new line', 'Stop the current response'])
  assert.deepEqual(plain.byKey.map((row) => row.label), ['Rename session'], 'a key combination finds its command')
  assert.deepEqual(plain.byAlias.map((row) => row.label), ['Open settings'], 'an English alias finds it by subsequence')
  assert.match(page, /if \(front !== null && front\.id !== 'settings-dialog'\) return/, 'it opens over Settings or nothing else')
  assert.match(page, /if \(shortcutReference\.open\) return\n\s+void showSettings\(\)/, 'and Settings stays put while it is in front')
})
