import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Copy Session ID, judged out of the page that runs it (R-developer-eight-23, row C20).
 *
 * DSH's session-row menu ends with `Copy Session ID` (dsh-client-ui-workspace `lib/client.js:4730-4740`, order 450 after
 * Archive at `:5283`). It writes the complete id with its `writeClipboard` (the Clipboard API, else a hidden textarea and
 * `execCommand('copy')`) and shows `Session ID copied`, or `Copy failed. Try again.` as a warning (`:4590-4605`,
 * `:4929-4931`). Phase A found heddle's menu had only Pin, Rename, Fork and Archive.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* session-id-copy:begin */')
const end = page.indexOf('/* session-id-copy:end */')

interface Notice {
  kind: string
  text: string
  tone: string
}

interface Copier {
  TEXT: { menu: string; copied: string; failed: string }
  HOLD_MS: number
  FADE_MS: number
  copy: (sessionId: string, env: unknown) => Promise<Notice>
}

const copier = (): Copier => new Function(`${page.slice(begin, end)}\nreturn SessionIdCopy`)() as Copier

const ID = 'session-a-full-id-that-must-not-be-shortened'

test('the block is in the page, between its markers', () => {
  assert.ok(begin > 0 && end > begin, 'both markers are present, in order')
})

test('the words are DSH en dictionary, verbatim, and the Toast holds three seconds then fades for one', () => {
  const { TEXT, HOLD_MS, FADE_MS } = copier()
  assert.deepEqual(TEXT, { menu: 'Copy Session ID', copied: 'Session ID copied', failed: 'Copy failed. Try again.' })
  assert.equal(HOLD_MS, 3000)
  assert.equal(FADE_MS, 1000)
})

test('a copy writes the complete id through the Clipboard API and reports success', async () => {
  const written: string[] = []
  const notice = await copier().copy(ID, { navigator: { clipboard: { writeText: async (text: string) => void written.push(text) } } })
  assert.deepEqual(written, [ID], 'the whole id, not a shortened one')
  assert.deepEqual(notice, { kind: 'sessionIdCopied', text: 'Session ID copied', tone: 'success' })
})

test('a refused clipboard reports the warning instead of claiming a copy', async () => {
  const notice = await copier().copy(ID, {
    navigator: {
      clipboard: {
        writeText: async () => {
          throw new Error('NotAllowedError')
        },
      },
    },
  })
  assert.deepEqual(notice, { kind: 'sessionIdCopyFailed', text: 'Copy failed. Try again.', tone: 'warning' })
})

test('without the Clipboard API the id goes through a hidden textarea and execCommand copy, which is then removed', async () => {
  const events: string[] = []
  let value = ''
  const area = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: (name: string) => events.push(`attr:${name}`),
    select: () => {
      value = area.value
      events.push('select')
    },
    remove: () => events.push('remove'),
  }
  const document = {
    createElement: (tag: string) => {
      events.push(`create:${tag}`)
      return area
    },
    body: { appendChild: () => events.push('append') },
    execCommand: (command: string) => {
      events.push(`exec:${command}`)
      return true
    },
  }
  const notice = await copier().copy(ID, { navigator: {}, document })
  assert.equal(value, ID, 'the textarea held the complete id when it was selected')
  assert.deepEqual(events, ['create:textarea', 'attr:readonly', 'append', 'select', 'exec:copy', 'remove'])
  assert.equal(notice.kind, 'sessionIdCopied')
  const refused = await copier().copy(ID, { navigator: {}, document: { ...document, execCommand: () => false } })
  assert.equal(refused.kind, 'sessionIdCopyFailed', 'a copy command that reports false is a failed copy')
  assert.equal((await copier().copy(ID, {})).kind, 'sessionIdCopyFailed', 'and a page with neither way to copy says so')
})

test('the session row menu ends with Copy Session ID, after Archive, on archived rows too', () => {
  const archive = page.indexOf("items.push({ label: node.archived ? 'Unarchive session' : 'Archive session'")
  const copy = page.indexOf("items.push({ label: SessionIdCopy.TEXT.menu, glyph: 'copy', run: () => copySessionId(node) })")
  assert.ok(archive > 0 && copy > archive, 'the item is pushed after the archive item')
  const between = page.slice(archive, copy)
  assert.equal((between.match(/items\.push\(/g) ?? []).length, 1, 'with nothing pushed between them')
  const after = page.slice(copy, page.indexOf('\n  }', copy))
  assert.equal((after.match(/items\.push\(/g) ?? []).length, 1, 'and nothing after it in the session block')
  assert.ok(!/if \(!node\.archived\)\s*items\.push\(\{ label: SessionIdCopy/.test(page), 'and it is not withheld from an archived row')
})
