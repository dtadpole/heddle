import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { repoRoot } from '../_tools_/verify-runner/lib.mjs'

/**
 * R-developer-six-4: a session that cannot be loaded opens to an error state, not to a blank start page.
 *
 * Measured before the fix, on both builds (they serve this one page): a session removed after the tree was drawn, then
 * clicked in that stale tree, gave the title "No session" and the "Start a conversation" page, with the row still
 * selected and the server's 404 shown nowhere. DSH's Chat shows "Failed to load history: {message} ({code})" and its
 * composer reads "Session unavailable". The browser check `_verifiers_/80-web-ui/check-stale-session.mjs` judges the
 * behaviour where it runs; this file runs the failure line lifted out of the page and keeps the state wired.
 */

const page = readFileSync(join(repoRoot, 'src', 'server', 'page.html'), 'utf8')

function lift(name: string): string {
  const source = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(page)?.[0]
  assert.ok(source, `the page defines ${name}`)
  return source
}

test('the failure line is DSH\'s, with the server\'s reason and the status code', () => {
  const historyFailureText = new Function(`${lift('historyFailureText')}\nreturn historyFailureText`)() as (
    status: number,
    statusText: string,
    failure: unknown,
  ) => string
  assert.equal(
    historyFailureText(404, 'Not Found', { error: 'no session session-66666666-6666-4666-8666-666666666666' }),
    'Failed to load history: no session session-66666666-6666-4666-8666-666666666666 (404)',
  )
  assert.equal(historyFailureText(500, 'Internal Server Error', {}), 'Failed to load history: Internal Server Error (500)')
  assert.equal(historyFailureText(502, '', null), 'Failed to load history: no reason given (502)')
})

test('a session that cannot be loaded says so, lets its stale row go, and makes the composer unavailable', () => {
  const show = lift('showSession')
  const refused = /if \(!response\.ok\) \{[\s\S]*?\n {4}\}/.exec(show)?.[0] ?? ''
  assert.match(refused, /unavailableSession = id/, 'the session is marked unavailable')
  assert.match(refused, /historyFailureText\(response\.status/, 'the failure line is written')
  assert.match(refused, /log\.append\(note\)/, 'where the conversation would be, which also puts the start page away')
  assert.match(refused, /selectedPath = null[\s\S]*await renderTree\(\)[\s\S]*markSelection\(\)/, 'the tree is read again and the selection dropped')
  assert.doesNotMatch(refused, /textContent = 'No session'/, 'the header no longer says there is nothing open')
  assert.match(show, /if \(unavailableSession !== null\) \{\n\s+unavailableSession = null/, 'opening any session clears the state')

  assert.match(lift('renderComposerState'), /unavailableSession !== null\s*\? 'Session unavailable'/, 'the composer reads "Session unavailable"')
  assert.match(lift('updateSendDisabled'), /unavailableSession !== null \|\|/, 'Send is disabled')
  assert.match(lift('submitDraft'), /if \(unavailableSession !== null\) return/, 'and Enter does not send either')
})
