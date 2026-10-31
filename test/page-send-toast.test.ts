import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { repoRoot } from '../_tools_/verify-runner/lib.mjs'

/**
 * A refused send is DSH's composer Toast (`dsh-client-ui-conversation`, its `promptError` effect): DSH's sentence for a
 * session another process writes (`session/writer-held`), `<message> (<code>)` for a refusal with a code, the reason as
 * it came otherwise; shown by the page's Toast seat anchored above the composer card, announced and gone by itself. The
 * page wrote a permanent `denied` line into the conversation, outside any live region, and a JSON refusal read as raw
 * JSON (DSH parity R-developer-seven-1, row S27). The wording is run from the page here; the browser behaviour is judged
 * by `_verifiers_/80-web-ui/check-send-toast.mjs`.
 */

const page = readFileSync(join(repoRoot, 'src', 'server', 'page.html'), 'utf8')

function cut(pattern: RegExp, name: string): string {
  const found = pattern.exec(page)
  assert.ok(found, `the page has ${name}`)
  return found[0]
}

const source = [
  cut(/function turnRefusal\([^)]*\) \{[\s\S]*?\n\}/, 'a turnRefusal function'),
  cut(/const SESSION_IN_USE_TEXT =\n[^\n]*\n/, 'a SESSION_IN_USE_TEXT sentence'),
  cut(/function sendRefusalText\([^)]*\) \{[\s\S]*?\n\}/, 'a sendRefusalText function'),
].join('\n')

const api = runInNewContext(`${source}\n({ turnRefusal, sendRefusalText })`) as {
  turnRefusal: (detail: string, status: number) => Error & { code?: string }
  sendRefusalText: (error: unknown) => string
}

test('a JSON refusal keeps its sentence and its code apart', () => {
  const refusal = api.turnRefusal('{"error":"no session session-x","code":"session/not-found"}\n', 404)
  assert.equal(refusal.message, 'no session session-x')
  assert.equal(refusal.code, 'session/not-found')
  const plain = api.turnRefusal("no endpoint named 'x'; configured: scripted", 400)
  assert.equal(plain.message, "no endpoint named 'x'; configured: scripted", 'a body that is not JSON is the server\'s own words')
  assert.equal(plain.code, undefined)
  assert.equal(api.turnRefusal('', 502).message, 'the server refused it (502)', 'an empty body still names the status')
  assert.equal(api.turnRefusal('{"code":"x"}', 400).message, '{"code":"x"}', 'JSON without a sentence is kept as it came')
})

test('a session another process writes gets DSH\'s sentence; a coded refusal reads message (code)', () => {
  assert.match(
    api.sendRefusalText(api.turnRefusal('{"error":"session is held by pid 4242","code":"session/writer-held"}', 409)),
    /^This session is already in use, possibly by another running heddle .* Quit the other one and try again\.$/,
  )
  assert.equal(api.sendRefusalText(api.turnRefusal('{"error":"no session session-x","code":"session/not-found"}', 404)), 'no session session-x (session/not-found)')
  assert.equal(api.sendRefusalText(new Error('Choose a workspace first.')), 'Choose a workspace first.', 'an uncoded refusal is its reason')
  assert.equal(api.sendRefusalText(new TypeError('Failed to fetch')), 'Failed to fetch')
})

test('both send paths show it through the Toast seat, anchored to the composer card, and write no denied line', () => {
  assert.equal((page.match(/\n\s+showSendRefusal\(error\)\n/g) ?? []).length, 2, 'the direct send and the queue both use it')
  assert.ok(!page.includes("add('denied', `the message could not be sent"), 'no permanent denied line is written for a refused send')
  assert.match(page, /showSessionToast\(\{ kind: 'sendRefused', tone: 'warning', text: sendRefusalText\(error\) \}, document\.getElementById\('composer-card'\)\)/)
  assert.match(page, /function showSessionToast\(notice, anchor = null\) \{/, 'the seat takes DSH\'s anchor')
  assert.match(page, /#session-toast\[data-anchored\] \{ transform: translate\(-50%, -100%\); \}/, 'and sits above it')
})
