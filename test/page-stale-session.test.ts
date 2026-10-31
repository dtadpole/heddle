import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { repoRoot } from '../_tools_/verify-runner/lib.mjs'

/**
 * #56: a session that cannot be loaded opens to DSH's error state, not to a blank start page with a live composer.
 *
 * Ported from developer-six's 4cd4cafb (R-developer-six-4, DSH parity S84) onto the page with the workspace tree, the
 * first-visit start and the saved-selection restore. Measured before the fix, on both builds (they serve this one page):
 * a session row whose session could no longer be read opened to "No session" and an empty conversation, the composer
 * stayed enabled with its normal placeholder, and a message sent from there was answered 500. DSH's Chat shows "Failed
 * to load history: {message} ({code})" (`dsh-client-ui-chat` `lib/client.js:2893-2898`, `:5991`) and its composer is
 * disabled and reads "Session unavailable" (`dsh-client-ui-conversation` `lib/client.js:18819-18824`, `:18972`,
 * `:16406`). The browser check in `_verifiers_/80-web-ui/check-workspace-tree.mjs` judges it in a real page; this file
 * runs the pieces lifted out of the page and keeps the failure branch wired.
 */

const page = readFileSync(join(repoRoot, 'src', 'server', 'page.html'), 'utf8')

function lift(name: string): string {
  const source = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(page)?.[0]
  assert.ok(source, `the page defines ${name}`)
  return source
}

/** Run one lifted function with the page globals it reads given as `scope`. */
function run<T>(name: string, scope: Record<string, unknown>): T {
  const keys = Object.keys(scope)
  return new Function(...keys, `${lift(name)}\nreturn ${name}`)(...keys.map((key) => scope[key])) as T
}

test("the failure line is DSH's, with the server's reason and the status code", () => {
  const historyFailureText = run<(status: number, statusText: string, failure: unknown) => string>('historyFailureText', {})
  assert.equal(
    historyFailureText(404, 'Not Found', { error: 'no session session-66666666-6666-4666-8666-666666666666' }),
    'Failed to load history: no session session-66666666-6666-4666-8666-666666666666 (404)',
  )
  assert.equal(historyFailureText(500, 'Internal Server Error', {}), 'Failed to load history: Internal Server Error (500)')
  assert.equal(historyFailureText(502, '', null), 'Failed to load history: no reason given (502)')
})

test('a session that cannot be loaded shows the failure line, is not kept, and lets its stale row go', () => {
  const show = lift('showSession')
  const refused = /if \(!response\.ok\) \{[\s\S]*?\n {4}\}/.exec(show)?.[0] ?? ''
  assert.ok(refused.length > 0, 'showSession has a branch for a refused read')
  assert.match(refused, /if \(current !== id\) return false/, 'a later open that replaced this one is not overwritten')
  assert.match(refused, /unavailableSession = id/, 'the session is marked unavailable')
  assert.match(refused, /current = null/, 'and it is not the open session (the stack-1 404 branch)')
  assert.match(refused, /historyFailureText\(response\.status/, 'the failure line is written')
  assert.match(refused, /log\.append\(note\)[\s\S]*paintEmptyState\(\)/, 'into the conversation before the empty state is judged, so the line wins over it')
  assert.match(refused, /rememberCurrent\(\)/, 'the saved selection is emptied, so a reload starts a fresh session (restoreSelection)')
  assert.match(refused, /selectedPath = null[\s\S]*await renderTree\(\)[\s\S]*markSelection\(\)/, 'the tree is read again and the selection dropped')
  assert.match(refused, /return false/, 'and the caller is told the session did not open')
  assert.match(show, /if \(unavailableSession !== null\) \{\n\s+unavailableSession = null/, 'opening any session clears the state')
  assert.match(show, /\n {2}return true\n}\n$/, 'a session whose history was read resolves true')
})

test('the header names a session that could not be loaded, not "No session"', () => {
  const cell = { hidden: true, textContent: '' }
  const doc = { title: '', getElementById: () => cell }
  const tree = { documentTitle: () => 'Heddle' }
  const paint = (unavailable: string | null) =>
    run<() => void>('paintSessionHeading', { current: null, unavailableSession: unavailable, sessionMetas: new Map(), document: doc, WorkspaceTree: tree })()
  paint('session-66666666-6666-4666-8666-666666666666')
  assert.equal(cell.textContent, 'Session unavailable')
  assert.equal(cell.hidden, false)
  paint(null)
  assert.equal(cell.textContent, 'No session', 'with nothing opened it still says there is nothing open')
})

test('the composer is disabled and reads "Session unavailable", and neither Send nor Enter sends', () => {
  const composer = { hidden: false }
  const field = { disabled: false, readOnly: false, value: '', placeholder: '' }
  const readonlyCard = { hidden: true }
  const body = { dataset: {} as Record<string, string> }
  const access = (unavailable: string | null) =>
    run<() => void>('paintComposerAccess', {
      current: null,
      unavailableSession: unavailable,
      SessionRules: { composerReadOnly: () => false },
      listedMetas: new Map(),
      composer,
      field,
      document: { getElementById: () => readonlyCard, body },
    })()
  access('session-66666666-6666-4666-8666-666666666666')
  assert.deepEqual([field.disabled, field.readOnly, composer.hidden, body.dataset.composer], [true, true, false, 'unavailable'], 'the editor is disabled, on screen')
  access(null)
  assert.deepEqual([field.disabled, field.readOnly, body.dataset.composer], [false, false, 'writable'], 'and writable again once a session opens')

  const sendButton = { disabled: false, hidden: false, title: '', setAttribute: () => {} }
  const state = (unavailable: string | null, draft: string) => {
    field.value = draft
    run<() => void>('renderComposerState', {
      unavailableSession: unavailable,
      anyRunning: () => false,
      resolveSubmitMode: () => 'queue',
      BUSY_ENTER: 'queue',
      sendButton,
      stopButton: { hidden: true },
      field,
      queueOf: () => [],
      updateSendDisabled: run<() => void>('updateSendDisabled', { unavailableSession: unavailable, sendButton, anyRunning: () => false, field }),
      refreshRunningStatus: () => {},
      updateStatusBar: () => {},
    })()
  }
  state('session-66666666-6666-4666-8666-666666666666', 'hello')
  assert.equal(field.placeholder, 'Session unavailable', "DSH's placeholder.unavailable")
  assert.equal(sendButton.disabled, true, 'Send is disabled even with a draft')
  state(null, 'hello')
  assert.equal(field.placeholder, 'Message or run a task, / commands, @ files or sessions')
  assert.equal(sendButton.disabled, false)

  const sent: string[] = []
  const submit = (unavailable: string | null) =>
    run<(gesture: string) => void>('submitDraft', {
      unavailableSession: unavailable,
      document: { body: { dataset: { composer: 'writable' } } },
      field,
      steerQueue: () => {},
      growComposer: () => {},
      updateSendDisabled: () => {},
      takeAttachments: () => [],
      // main's Stop pause (3db975b7): a new submission clears the open queue's stopped mark.
      stoppedQueues: new WeakSet(),
      queueOf: () => [],
      resolveSubmitMode: () => 'queue',
      BUSY_ENTER: 'queue',
      anyRunning: () => false,
      deliverSteered: () => {},
      sendNow: (text: string) => sent.push(text),
      enqueue: () => {},
    })('enter')
  field.value = 'into a session that is gone'
  submit('session-66666666-6666-4666-8666-666666666666')
  assert.deepEqual(sent, [], 'Enter sends nothing from that state')
  assert.equal(field.value, 'into a session that is gone', 'and the draft is left where it was')
  submit(null)
  assert.deepEqual(sent, ['into a session that is gone'], 'while an open session still sends')
})
