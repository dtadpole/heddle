import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { repoRoot } from '../_tools_/verify-runner/lib.mjs'

/**
 * A refused send is a Toast, as DSH's composer shows it (`dsh-client-ui-conversation`): DSH's sentence for a session
 * another process writes (`session/writer-held`), `<sentence> (<code>)` for a refusal with a code, the server's sentence
 * otherwise; announced (`role=alert`) and gone after a few seconds. The page wrote a permanent `denied` line into the
 * conversation, outside any live region (DSH parity R-developer-seven-1, row S27). The wording is run from the page here;
 * the browser behaviour is judged by `_verifiers_/80-web-ui/check-send-toast.mjs`.
 */

const page = readFileSync(join(repoRoot, 'src', 'server', 'page.html'), 'utf8')

function words(error: unknown): string {
  const source = /function sendRefusalText\([^)]*\) \{[\s\S]*?\n\}/.exec(page)
  assert.ok(source, 'the page has a sendRefusalText function')
  return runInNewContext(`${source[0]}\nsendRefusalText(error)`, { error }) as string
}

test('a session another process writes gets DSH\'s sentence', () => {
  const error = Object.assign(new Error('{"error":"held"}'), { reason: 'held', code: 'session/writer-held' })
  assert.match(words(error), /^This session is already in use, possibly by another running heddle .* Quit the other one and try again\.$/)
})

test('a refusal with a code reads sentence (code); without one, the server\'s sentence', () => {
  assert.equal(words(Object.assign(new Error('raw'), { reason: 'no session x', code: 'session/not-found' })), 'no session x (session/not-found)')
  assert.equal(words(Object.assign(new Error('raw'), { reason: 'that path is not a file' })), 'that path is not a file')
  assert.equal(words(new Error("no endpoint named 'x'; configured: scripted")), "no endpoint named 'x'; configured: scripted")
})

test('the Toast is announced, goes away by itself, and replaces the old denied line at both send sites', () => {
  assert.match(page, /<div id="composer-toast" role="alert" hidden>/, 'an alert above the composer')
  assert.match(page, /const TOAST_MS = 6000/, 'gone after six seconds')
  assert.equal((page.match(/showToast\(sendRefusalText\(error\)\)/g) ?? []).length, 2, 'the direct send and the queue both use it')
  assert.ok(!page.includes('the message could not be sent'), 'no permanent denied line is written for a refused send')
  assert.match(page, /refusal\.reason = parsed\.error/, 'a JSON refusal keeps its sentence apart from its code')
})
