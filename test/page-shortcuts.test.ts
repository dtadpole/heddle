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
    ['KeyO', 'ø', 'add-workspace'],
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
  assert.match(page, /shortcutFor\(event, \{ afterDeadKey: shortcutAfterDeadKey, table: activeShortcuts \}\)/, 'the listener passes the dead-key state and the active bindings')
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
  assert.match(page, /if \(action === 'add-workspace'\) \{\n\s+if \(!workspacePicker\.open\) void openWorkspacePicker\(\)/, 'the chord opens the picker')
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
  /** DSH's sequence breakers (`dsh-client-ui-conversation`): each resets the sequence. */
  assert.match(page, /if \(event\.key !== 'Escape' \|\| event\.repeat \|\| event\.isComposing\) \{\n\s+stopSequence = null/, 'a repeat or composition breaks it')
  assert.match(page, /event\.shiftKey \|\| uiTakesEscape\(\)\) \{\n\s+stopSequence = null/, 'a modifier or a control that takes Escape breaks it')
  assert.match(page, /if \(document\.querySelector\('dialog\[open\]'\) !== null\) return true/, 'a dialog takes Escape')
  assert.match(page, /\[\.\.\.document\.querySelectorAll\('\[role="menu"\]'\)\]\.some\(\(menu\) => !menu\.hidden\)/, 'so does any open menu')
  assert.match(page, /const card = document\.getElementById\('approval-card'\)\n\s+return card !== null && !card\.hidden/, 'and the approval card')
  assert.match(page, /previous\.region === press\.region &&\n\s+previous\.session === press\.session &&\n\s+previous\.turn === press\.turn &&/, 'a change of region, session or turn breaks it')
  assert.match(page, /\n\s+\},\n\s+true,\n\)\n/, 'read in the capture phase, before menus close themselves')
  /** "preserve queued messages": the sequence is the Stop button's own cancellation, which holds the queue (Refs #75). */
  assert.match(page, /anyRunning\(\)\n\s+\) \{\n\s+stopSequence = null\n\s+void stopTurn\(\)/, 'the second press stops through stopTurn')
  assert.match(page, /async function stopTurn\(\) \{\n\s+stoppedQueues\.add\(queueOf\(\)\)/, 'which holds the queue')
  assert.match(page, /title="Stop generating \(Esc Esc\)"/, 'and the Stop button names the sequence, as DSH\'s tooltip does')
})

test('Mod+/ opens DSH\'s keyboard reference: every command in product order, then the fixed input actions', () => {
  /** `dsh-client-ui-shortcuts`: one dialog, ordered commands with their chords, read-only input actions (S40). */
  assert.equal(shortcutFor(keydown({ code: 'Slash', key: '/', metaKey: true }), mac), 'shortcuts-reference')
  const pieces = ['SESSION_SHORTCUTS', 'SHORTCUT_LABELS', 'FIXED_INPUT_ACTIONS', 'function keyForCode', 'function chordText', 'function subsequenceMatch', 'function shortcutReferenceRows']
  const take = (start: string) => {
    const at = page.indexOf(start === 'SESSION_SHORTCUTS' ? 'const SESSION_SHORTCUTS' : start.startsWith('function') ? start : `const ${start}`)
    assert.ok(at !== -1, `${start} is in the page`)
    const end = start.startsWith('function') ? page.indexOf('\n}\n', at) + 2 : page.indexOf('\n]\n', at) !== -1 && page.indexOf('\n]\n', at) < page.indexOf('\n}\n', at) ? page.indexOf('\n]\n', at) + 2 : page.indexOf('\n}\n', at) + 2
    return page.slice(at, end)
  }
  const source = pieces.map(take).join('\n')
  const rows = runInNewContext(`const SHORTCUTS_ON_MAC = true\n${source}\n({ all: shortcutReferenceRows('', true), byKey: shortcutReferenceRows('⌥⌘g', true), byAlias: shortcutReferenceRows('prefs', true), other: shortcutReferenceRows('', false) })`) as Record<'all' | 'byKey' | 'byAlias' | 'other', Array<{ label: string; keys: string; fixed: boolean; group: string }>>
  const plain = JSON.parse(JSON.stringify(rows)) as typeof rows
  /** DSH's `coreActionOrder` (`dsh-client-ui-shortcuts`), not the order the chords were added in. */
  assert.deepEqual(plain.all.filter((row) => !row.fixed).map((row) => row.label), ['Keyboard shortcuts', 'New session', 'Toggle sidebar', 'Search sessions', 'Add workspace', 'Rename session', 'Fork session', 'Archive session', 'Open settings', 'Toggle right sidebar', 'Browser'])
  assert.equal(plain.all.find((row) => row.label === 'New session')?.keys, '⌥⌘N')
  assert.equal(plain.all.find((row) => row.label === 'Fork session')?.keys, '⇧⌘F')
  assert.equal(plain.other.find((row) => row.label === 'Rename session')?.keys, 'Ctrl+Alt+G')
  assert.deepEqual(plain.all.filter((row) => row.fixed).map((row) => row.label), ['Send message', 'Insert a new line', 'Stop the current response'])
  assert.deepEqual(plain.byKey.map((row) => row.label), ['Rename session'], 'a key combination finds its command')
  assert.deepEqual(plain.byAlias.map((row) => row.label), ['Open settings'], 'an English alias finds it by subsequence')
  assert.match(page, /if \(front !== null && front\.id !== 'settings-dialog'\) return/, 'it opens over Settings or nothing else')
  assert.match(page, /if \(shortcutReference\.open\) return\n\s+void showSettings\(\)/, 'and Settings stays put while it is in front')
})

test('bindings a person records are kept as overrides, DSH\'s way (S41)', () => {
  /**
   * `dsh-client-shortcuts`: only overrides are stored, per device (Web: this origin's localStorage); a missing command
   * inherits its default, `null` clears it, restoring removes the override; explicit overrides displace a colliding
   * default and colliding explicit overrides are all off; an unreadable document disables editing.
   */
  const take = (name: string) => {
    const at = page.indexOf(name.startsWith('function') ? name : `const ${name}`)
    assert.ok(at !== -1, `${name} is in the page`)
    const close = name.startsWith('function') ? '\n}\n' : name === 'SESSION_SHORTCUTS' ? '\n]\n' : '\n'
    return page.slice(at, page.indexOf(close, at) + close.length)
  }
  const source = ['SESSION_SHORTCUTS', 'RECORDABLE_CODE', 'function keyForCode', 'function parseKeybindings', 'function sameChord', 'function effectiveShortcuts', 'function recordedChord', 'function bindingConflict']
    .map(take)
    .join('\n')
  const api = runInNewContext(`${source}\n({ parseKeybindings, effectiveShortcuts, recordedChord, bindingConflict, SESSION_SHORTCUTS })`) as {
    parseKeybindings: (raw: string | null) => { readable: boolean; overrides: Record<string, unknown> }
    effectiveShortcuts: (defaults: unknown[], overrides: Record<string, unknown>) => Array<{ code: string; alt?: boolean; shift?: boolean; action: string }>
    recordedChord: (event: Record<string, unknown>, mac: boolean) => Record<string, unknown>
    bindingConflict: (chord: unknown, action: string, table: unknown[]) => string | null
    SESSION_SHORTCUTS: unknown[]
  }
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

  assert.deepEqual(plain(api.parseKeybindings(null)), { readable: true, overrides: {} }, 'nothing stored: defaults')
  assert.deepEqual(plain(api.parseKeybindings('{"version":1,"overrides":{"rename":{"code":"KeyE","alt":true},"fork":null,"bad":{"code":"F5"}}}')), {
    readable: true,
    overrides: { rename: { code: 'KeyE', alt: true, shift: false }, fork: null },
  }, 'a chord, a removal, and an entry that is not a recordable key dropped')
  assert.equal(api.parseKeybindings('{"version":2,"overrides":{}}').readable, false, 'a newer document is not read')
  assert.equal(api.parseKeybindings('not json').readable, false, 'a damaged document is not read')

  const table = (overrides: Record<string, unknown>) => plain(api.effectiveShortcuts(api.SESSION_SHORTCUTS, overrides))
  const actionFor = (rows: Array<{ code: string; alt?: boolean; action: string }>, code: string, alt: boolean) =>
    rows.find((row) => row.code === code && Boolean(row.alt) === alt)?.action ?? null
  assert.equal(actionFor(table({ rename: { code: 'KeyE', alt: true } }), 'KeyE', true), 'rename', 'an override takes effect')
  assert.equal(actionFor(table({ rename: { code: 'KeyE', alt: true } }), 'KeyG', true), null, 'and the default chord is free')
  assert.ok(!table({ fork: null }).some((row) => row.action === 'fork'), 'null clears the binding')
  const displaced = table({ rename: { code: 'KeyA', alt: true } })
  assert.equal(actionFor(displaced, 'KeyA', true), 'rename', 'an explicit override displaces the default it collides with')
  assert.ok(!displaced.some((row) => row.action === 'archive'), 'so archive loses Mod+Alt+A')
  const clash = table({ rename: { code: 'KeyE', alt: true }, fork: { code: 'KeyE', alt: true } })
  assert.ok(!clash.some((row) => row.action === 'rename' || row.action === 'fork'), 'colliding explicit overrides are both off')

  assert.deepEqual(plain(api.recordedChord({ key: 'Meta', metaKey: true }, true)), { pending: true }, 'a modifier alone waits')
  assert.match(String(api.recordedChord({ key: 'e', code: 'KeyE' }, true).error), /⌘/, 'a chord starts with Mod')
  assert.deepEqual(plain(api.recordedChord({ key: 'Dead', code: 'KeyN', metaKey: true, altKey: true }, true)), { chord: { code: 'KeyN', alt: true, shift: false } }, 'Option+Command+N reported as a dead key records')
  assert.ok(api.recordedChord({ key: 'F5', code: 'F5', ctrlKey: true }, false).error, 'a key outside letters, digits and punctuation is refused')
  assert.match(String(api.recordedChord({ key: 'Dead', code: 'KeyE', metaKey: true, altKey: true }, true).error), /accent/, 'a dead key other than ⌥⌘N is refused, since it would never fire')
  assert.equal(api.bindingConflict({ code: 'KeyK', alt: true }, 'rename', api.SESSION_SHORTCUTS), 'search', 'a taken chord names its command')
  assert.equal(api.bindingConflict({ code: 'KeyG', alt: true }, 'rename', api.SESSION_SHORTCUTS), null, 'a command does not collide with itself')

  assert.match(page, /const KEYBINDINGS_KEY = 'heddle\.keybindings\.v1'/, 'stored per origin, as DSH\'s dsh.keybindings.v1')
  assert.match(page, /window\.addEventListener\('storage', \(event\) => \{\n\s+if \(event\.key !== KEYBINDINGS_KEY\) return/, 'another tab\'s change applies here')
  assert.match(page, /if \(!keybindings\.readable\) \{\n\s+shortcutStatus\(unreadableNotice\(\)\)\n\s+return false/, 'an unreadable store is never overwritten')
})

test('Mod+Shift+B toggles the right sidebar and Mod+Alt+T opens a Browser tab, while the Browser is on (S38, S42)', () => {
  /**
   * DSH's Web defaults: `sidebar.right.toggle` is primary+shift+B (`dsh-client-ui-sidebar-right`) and `browser.new`
   * primary+alt+T (`dsh-client-ui-sidebar-browser`). On a Mac Chrome delivers ⇧⌘B as `B` and ⌥⌘T as `†`.
   */
  assert.equal(shortcutFor(keydown({ code: 'KeyB', key: 'B', metaKey: true, shiftKey: true }), mac), 'right-sidebar', '⇧⌘B')
  assert.equal(shortcutFor(keydown({ code: 'KeyB', key: '∫', metaKey: true, altKey: true }), mac), 'sidebar', '⌥⌘B is still the left sidebar')
  assert.equal(shortcutFor(keydown({ code: 'KeyT', key: '†', metaKey: true, altKey: true }), mac), 'browser-new', '⌥⌘T')
  assert.equal(shortcutFor(keydown({ code: 'KeyB', key: 'B', ctrlKey: true, shiftKey: true }), elsewhere), 'right-sidebar', 'Ctrl+Shift+B')
  assert.equal(shortcutFor(keydown({ code: 'KeyT', key: 't', ctrlKey: true, altKey: true }), elsewhere), 'browser-new', 'Ctrl+Alt+T')
  assert.equal(shortcutFor(keydown({ code: 'KeyT', key: 't', metaKey: true }), mac), null, '⌘T is left to the browser')

  /** The right sidebar exists only with the Browser, so its commands are unbound and unlisted until the server says so. */
  const cut = (pattern: RegExp) => {
    const match = pattern.exec(page)
    assert.ok(match, `${pattern} is in the page`)
    return match[0]
  }
  const source = [
    /const SESSION_SHORTCUTS = \[[\s\S]*?\n\]/,
    /const SHORTCUT_LABELS = \{[\s\S]*?\n\}/,
    /const PANEL_SHORTCUTS = [^\n]+/,
    /const FIXED_INPUT_ACTIONS = \[[\s\S]*?\n\]/,
    /function keyForCode\([^)]*\) \{[\s\S]*?\n\}/,
    /function chordText\([^)]*\) \{[\s\S]*?\n\}/,
    /function subsequenceMatch\([^)]*\) \{[\s\S]*?\n\}/,
    /function shortcutReferenceRows\([^)]*\) \{[\s\S]*?\n\}/,
    /function availableShortcuts\(\) \{[\s\S]*?\n\}/,
  ]
    .map(cut)
    .join('\n')
  const seen = JSON.parse(
    runInNewContext(`const SHORTCUTS_ON_MAC = true
let browserEnabled = false
${source}
const commands = (hidden) => shortcutReferenceRows('', true, availableShortcuts(), {}, hidden).filter((row) => !row.fixed).map((row) => [row.label, row.keys])
const off = { table: availableShortcuts().map((entry) => entry.action), rows: commands(PANEL_SHORTCUTS) }
browserEnabled = true
JSON.stringify({ off, on: { table: availableShortcuts().map((entry) => entry.action), rows: commands([]) } })`) as string,
  ) as Record<'off' | 'on', { table: string[]; rows: Array<[string, string]> }>
  assert.ok(!seen.off.table.includes('right-sidebar') && !seen.off.table.includes('browser-new'), `Browser off: neither is bound (${seen.off.table.join(', ')})`)
  assert.ok(seen.off.table.includes('sidebar'), 'and the left sidebar keeps its chord')
  assert.deepEqual(seen.off.rows.map(([label]) => label).slice(-2), ['Archive session', 'Open settings'], 'nor listed')
  assert.ok(seen.on.table.includes('right-sidebar') && seen.on.table.includes('browser-new'), 'Browser on: both are bound')
  assert.deepEqual(seen.on.rows.slice(-2), [['Toggle right sidebar', '⇧⌘B'], ['Browser', '⌥⌘T']], 'and listed last, in DSH\'s order with its labels')

  /** The wiring: the server's answer binds them, the chord is the globe's own action, and a dialog in front stops both. */
  assert.match(page, /function applyBrowserFeature\(enabled\) \{\n\s+browserEnabled = enabled\n\s+browserOpen\.hidden = !enabled\n\s+refreshShortcuts\(\)/, 'the server\'s answer binds them')
  assert.match(page, /browserOpen\.addEventListener\('click', \(\) => toggleRightSidebar\(\)\)/, 'the globe and the chord are one action')
  assert.match(page, /if \(action === 'right-sidebar' \|\| action === 'browser-new'\) \{\n\s+if \(document\.querySelector\('dialog\[open\]'\) !== null\) return\n\s+if \(action === 'right-sidebar'\) toggleRightSidebar\(\)\n\s+else openBrowserTab\(\)/, 'nothing happens behind a dialog')
  assert.match(page, /keybindings\.overrides, browserEnabled \? \[\] : PANEL_SHORTCUTS\)/, 'the reference leaves them out while the Browser is off')
})
