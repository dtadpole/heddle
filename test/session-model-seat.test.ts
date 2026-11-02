import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Issue #175: a subagent's session, a teammate's included, offers no model choice. DSH's `model` command is
 * `available: (session) => sessions.subagentAddress(session.sessionId) === void 0` (dsh-client-ui-model-selection), and
 * `subagentAddress` answers for any `origin: 'subagent'` session with a parent. The page's seat asks
 * `SessionRules.modelSelectable`, and `gateModelSeat` disables the trigger when it says no.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* session-rules:begin */')
const end = page.indexOf('/* session-rules:end */')
const rules = new Function(`${page.slice(begin, end)}\nreturn SessionRules`)() as { modelSelectable: (meta: unknown) => boolean }

test('a plain session offers a model choice; a teammate’s and a one-shot child’s do not', () => {
  assert.equal(typeof rules.modelSelectable, 'function')
  assert.equal(rules.modelSelectable({ id: 's', origin: 'web' }), true)
  assert.equal(rules.modelSelectable({ id: 's' }), true)
  assert.equal(rules.modelSelectable(undefined), true, 'a session the list does not know yet is not gated')
  assert.equal(rules.modelSelectable({ id: 'm', origin: 'subagent', parentSession: 'l', teamId: 'l' }), false, 'a teammate')
  assert.equal(rules.modelSelectable({ id: 'c', origin: 'subagent', parentSession: 'p' }), false, 'a one-shot child')
})

test('the page disables the seat for a gated session and gives it back for the next', () => {
  const gate = page.slice(page.indexOf('function gateModelSeat() {'), page.indexOf('\n}\n', page.indexOf('function gateModelSeat() {')) + 2)
  assert.match(gate, /SessionRules\.modelSelectable\(listedMetas\.get\(current\)\)/)
  assert.match(gate, /modelTrigger\.disabled = true/)
  assert.match(gate, /renderModelSeat\(\)/, 'leaving a gated session repaints the seat')
  const seat = page.slice(page.indexOf('function renderModelSeat() {'), page.indexOf('\n}\n', page.indexOf('function renderModelSeat() {')))
  assert.match(seat, /modelTrigger\.disabled = modelTrigger\.dataset\.subagent === 'true'/, 'a repaint keeps the gate')
  assert.ok(!/modelTrigger\.title = (?!seatTitle\(|'no model')/.test(seat), 'and every title it writes goes through seatTitle, which keeps the gate’s reason')
  const access = page.slice(page.indexOf('function paintComposerAccess() {'), page.indexOf('\n}\n', page.indexOf('function paintComposerAccess() {')))
  assert.match(access, /gateModelSeat\(\)/, 'every access paint applies it')
})
