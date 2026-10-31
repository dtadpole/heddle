import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * What the page says when a session's Pin, Unpin, Archive, Unarchive or Rename did not happen (GitHub issue #149).
 *
 * With the session store read-only, a row's Pin said nothing (its failure went to the tree's note, which the next redraw
 * writes over), and the Rename dialog showed the Rust server's "no session session-<full id>". DSH says a pin that failed
 * for any reason in a toast, "Pin failed. Try again later." (`toast.pinFailed`, `toast.unpinFailed`,
 * dsh-client-ui-workspace lib/client.js:4955-4956, from its pin's catch, :5085-5094). DSH says nothing for a failed archive
 * (it logs it, :5104-5108) and puts the host's message in the rename dialog (:4452-4455), which carries the raw id; the
 * page says those in the pin's words. A refusal the server explains (a `4xx` with its sentence) is still its sentence.
 *
 * The page's own functions are cut out of `page.html` and run against stand-ins for `fetch` and the document.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

/** A marked block of the page, or `''` when the page has none. */
function block(name: string): string {
  const begin = page.indexOf(`/* ${name}:begin */`)
  const end = page.indexOf(`/* ${name}:end */`)
  return begin > 0 && end > begin ? page.slice(begin, end) : ''
}

/** A top-level function of the page: from its `function` line to the first line that is a lone `}`. */
function source(name: string): string {
  const start = page.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start + 1)
  return page.slice(start + 1, end + 2)
}

interface Notice {
  kind: string
  text: string
  tone: string
}

interface Failure {
  TEXT: Record<string, string>
  flagAction: (patch: Record<string, unknown>) => string
  failed: (status: number) => boolean
  notice: (action: string) => Notice
}

const failureBlock = block('session-action-failure')
const SessionActionFailure = (failureBlock === '' ? undefined : new Function(`${failureBlock}\nreturn SessionActionFailure`)()) as Failure | undefined

test("the words are DSH's pin and unpin toasts, and archive, unarchive and rename said the same way", () => {
  assert.ok(SessionActionFailure !== undefined, 'page.html carries the session-action-failure block')
  assert.deepEqual(SessionActionFailure.TEXT, {
    pin: 'Pin failed. Try again later.',
    unpin: 'Unpin failed. Try again later.',
    archive: 'Archive failed. Try again later.',
    unarchive: 'Unarchive failed. Try again later.',
    rename: 'Rename failed. Try again later.',
  })
  assert.equal(SessionActionFailure.flagAction({ pinned: true }), 'pin')
  assert.equal(SessionActionFailure.flagAction({ pinned: false }), 'unpin')
  assert.equal(SessionActionFailure.flagAction({ archived: true }), 'archive')
  assert.equal(SessionActionFailure.flagAction({ archived: false }), 'unarchive')
  assert.equal(SessionActionFailure.flagAction({ archived: true, pinned: true }), 'archive', "the server's flagVerb")
  assert.equal(SessionActionFailure.failed(0), true, 'no answer')
  assert.equal(SessionActionFailure.failed(500), true, 'a write the server could not save')
  assert.equal(SessionActionFailure.failed(503), true)
  assert.equal(SessionActionFailure.failed(409), false, 'a refusal the server explains')
  assert.equal(SessionActionFailure.failed(404), false)
  assert.deepEqual(SessionActionFailure.notice('pin'), { kind: 'pinFailed', text: 'Pin failed. Try again later.', tone: 'warning' }, "DSH's pinFailed, a warning")
  assert.deepEqual(SessionActionFailure.notice('unarchive'), { kind: 'unarchiveFailed', text: 'Unarchive failed. Try again later.', tone: 'warning' })
})

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> }
const answer = (body: unknown, status: number): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const offline = async (): Promise<Reply> => {
  throw new TypeError('Failed to fetch')
}

interface Flags {
  (node: unknown, patch: Record<string, unknown>, extra?: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ ok: boolean; status: number }>
}

/** `setSessionFlags` against `fetchImpl`, recording the notes, toasts and redraws it makes. */
function flagsPage(fetchImpl: () => Promise<Reply>) {
  const seen = { notes: [] as string[], toasts: [] as Notice[], redraws: 0 }
  const flags = new Function(
    'fetch',
    'setNote',
    'showSessionToast',
    'SessionActionFailure',
    'definitionFolder',
    'captureRowBoxes',
    'renderTree',
    'refreshSessions',
    'glideRows',
    'window',
    `${source('setSessionFlags')}\nreturn setSessionFlags`,
  )(
    fetchImpl,
    (text: string) => seen.notes.push(text),
    (notice: Notice) => seen.toasts.push(notice),
    SessionActionFailure,
    () => undefined,
    () => null,
    async () => {
      seen.redraws += 1
    },
    async () => undefined,
    () => undefined,
    { confirm: () => false },
  ) as Flags
  return { flags, seen }
}

const node = { kind: 'session', session: { id: 'session-00000000-0000-0000-0000-000000000001' }, pinned: false, archived: false }
const writeFailed = (verb: string) => ({ error: `failed to ${verb} session "${node.session.id}": permission denied`, code: 'gateway/internal' })

test("Pin, Unpin, Archive and Unarchive that the store could not save say DSH's words in its toast, never the server's (#149)", async () => {
  for (const [patch, verb, kind, text] of [
    [{ pinned: true }, 'pin', 'pinFailed', 'Pin failed. Try again later.'],
    [{ pinned: false }, 'unpin', 'unpinFailed', 'Unpin failed. Try again later.'],
    [{ archived: true }, 'archive', 'archiveFailed', 'Archive failed. Try again later.'],
    [{ archived: false }, 'unarchive', 'unarchiveFailed', 'Unarchive failed. Try again later.'],
  ] as const) {
    const { flags, seen } = flagsPage(async () => answer(writeFailed(verb), 500))
    const result = await flags(node, patch)
    assert.deepEqual({ ok: result.ok, status: result.status }, { ok: false, status: 500 }, verb)
    assert.deepEqual(seen.toasts, [{ kind, text, tone: 'warning' }], `${verb}: the toast says it failed, in DSH's words`)
    assert.deepEqual(seen.notes, [], `${verb}: not the tree's note, which the next redraw writes over, nor the server's sentence with the raw id`)
    assert.equal(seen.redraws, 0, `${verb}: the row stays as it was`)
  }
  /** Rust's old answer for the same failure, a 409 coded `archived` with the store's path, was a refusal by its status. */
})

test('a press whose request gets no answer says the same words (#137, #149)', async () => {
  for (const [patch, text] of [
    [{ pinned: true }, 'Pin failed. Try again later.'],
    [{ archived: true }, 'Archive failed. Try again later.'],
  ] as const) {
    const { flags, seen } = flagsPage(offline)
    const result = await flags(node, patch)
    assert.deepEqual({ ok: result.ok, status: result.status }, { ok: false, status: 0 })
    assert.deepEqual(seen.toasts.map((notice) => notice.text), [text])
    assert.deepEqual(seen.notes, [])
  }
})

test("a refusal the server explains is still its sentence in the note, and a caller that says it itself hears nothing", async () => {
  const refused = flagsPage(async () => answer({ error: 'cannot pin an archived session', code: 'archived' }, 409))
  await refused.flags(node, { pinned: true })
  assert.deepEqual(refused.seen.notes, ['cannot pin an archived session'])
  assert.deepEqual(refused.seen.toasts, [])

  const quiet = flagsPage(async () => answer(writeFailed('archive'), 500))
  await quiet.flags(node, { archived: true }, { stop: true }, { quiet: () => true })
  assert.deepEqual({ notes: quiet.seen.notes, toasts: quiet.seen.toasts }, { notes: [], toasts: [] }, 'the stop-and-archive dialog says it in its own line')
})

/** `confirmSessionRename` with its dialog stood in for: the dialog's error line is what it says. */
function renamePage(fetchImpl: () => Promise<Reply>) {
  const elements = new Map<string, { value: string; disabled: boolean; focus: () => void }>()
  for (const id of ['session-rename-input', 'session-rename-confirm']) elements.set(id, { value: '', disabled: false, focus: () => undefined })
  elements.get('session-rename-input')!.value = 'A new name'
  const seen = { errors: [] as string[], closed: 0, redraws: 0 }
  const dialog = {
    open: true,
    close: () => {
      seen.closed += 1
    },
  }
  const target = { node: { session: { id: node.session.id } }, busy: false }
  const confirm = new Function(
    'fetch',
    'document',
    'sessionRenameDialog',
    'sessionRenameTarget',
    'refreshSessionRename',
    'definitionFolder',
    'setSessionRenameBusy',
    'dialogError',
    'setNote',
    'renderTree',
    'refreshSessions',
    'SessionActionFailure',
    `${source('confirmSessionRename')}\nreturn confirmSessionRename`,
  )(
    fetchImpl,
    { getElementById: (id: string) => elements.get(id) ?? null },
    dialog,
    target,
    () => undefined,
    () => undefined,
    () => undefined,
    (id: string, text: string) => {
      if (id === 'session-rename-error') seen.errors.push(text)
    },
    () => undefined,
    async () => {
      seen.redraws += 1
    },
    async () => undefined,
    SessionActionFailure,
  ) as () => Promise<void>
  return { confirm, seen }
}

test('Rename that the store could not save, or that got no answer, says so in its dialog without the raw id, and the dialog stays open (#149)', async () => {
  for (const [label, reply] of [
    ['a write failure', async () => answer(writeFailed('rename'), 500)],
    ["a plain-text 500, the TypeScript build's old answer", async (): Promise<Reply> => ({ ok: false, status: 500, json: async () => Promise.reject(new SyntaxError('not JSON')) })],
    ['no answer', offline],
  ] as const) {
    const { confirm, seen } = renamePage(reply)
    await confirm()
    assert.deepEqual(seen.errors, ['Rename failed. Try again later.'], `${label}: the dialog's line`)
    assert.equal(seen.closed, 0, `${label}: the dialog stays open, to try again or cancel`)
    assert.equal(seen.redraws, 0, `${label}: nothing is redrawn`)
  }
})

test("a rename the server refuses keeps the server's sentence, and one it takes closes the dialog", async () => {
  const refused = renamePage(async () => answer({ error: 'A session title must contain visible text.', code: 'session/title-invalid' }, 400))
  await refused.confirm()
  assert.deepEqual(refused.seen.errors, ['A session title must contain visible text.'])

  const taken = renamePage(async () => answer({ id: node.session.id, title: 'A new name' }, 200))
  await taken.confirm()
  assert.deepEqual(taken.seen.errors, [], 'no error line')
  assert.equal(taken.seen.closed, 1, 'the dialog closes')
  assert.equal(taken.seen.redraws, 1, 'and the tree is redrawn')
})
