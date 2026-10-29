/**
 * The pass rules, judged without a browser.
 *
 * Each test is a judgment a pass makes from numbers it read: a marker that matches or does not, an
 * answer that arrived as two chunks or as one, a bare URL refused with the token form or served as an
 * app. The reading itself (a real page, a real deployment) is the integration step; these are the
 * rules that decide what a reading means.
 *
 *   node --test _tools_/live-health/_tests_/pass-rules/unit.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  acrossMove,
  classifyOutage,
  consoleVerdict,
  deploymentMove,
  deploymentDown,
  doorVerdict,
  expectedPage,
  gateVerdict,
  launchUrlFromLog,
  looksLikeProxyError,
  FIXTURE_PREFIX,
  fixtureOnly,
  expectedSeatLabel,
  lowestEffort,
  modelLabel,
  REAL_MODEL,
  realModelChoice,
  markerVerdict,
  outageHop,
  previewTurnVerdict,
  previewVerdict,
  sharedSessions,
  turnLanding,
  conversationVerdict,
  deploymentTurnWithConversation,
  sameHealthSession,
  parseArguments,
  passVerdict,
  processVerdict,
  redactRecord,
  shellVerdict,
  summaryRow,
  tildePath,
  tildeText,
  turnVerdict,
} from '../../rules.mjs'

test('arguments are --name=value or a bare --flag', () => {
  assert.deepEqual(parseArguments(['--json', '--pin', '--url=http://x/', '--no-turn', 'ignored']), {
    json: true,
    pin: true,
    url: 'http://x/',
    'no-turn': true,
  })
})

test('the launch token is the last one the server printed, because each start mints its own', () => {
  const log = [
    'model: 1 endpoint(s) — scripted(scripted)',
    'heddle web: http://127.0.0.1:3082/?token=first-token',
    'heddle web: serving on 127.0.0.1:3082; pass --port to change it',
    'heddle web: http://127.0.0.1:3082/?token=second-token',
  ].join('\n')
  assert.equal(launchUrlFromLog(log), 'http://127.0.0.1:3082/?token=second-token')
  assert.equal(launchUrlFromLog('no server has started here'), null)
})

test('a pinned path is stated under the home directory, never as the absolute home', () => {
  assert.equal(tildePath('/Users/someone/heddle-live/dist', '/Users/someone'), '~/heddle-live/dist')
  assert.equal(tildePath('/Users/someone', '/Users/someone'), '~')
  assert.equal(tildePath('/tmp/elsewhere', '/Users/someone'), '/tmp/elsewhere')
})

test('the door passes only with the 401 wall AND the 303 cookie', () => {
  const goodCookie = { httpOnly: true, sameSite: true }
  assert.equal(
    doorVerdict({ reachable: true, bareStatus: 401, form: true, app: false, exchangeStatus: 303, cookie: goodCookie }).verdict,
    'pass',
  )
  // A wall with no way in, or a way in with no wall, is a failure; there is no 'partial' pass.
  assert.equal(doorVerdict({ reachable: true, bareStatus: 401, form: true, app: false, exchangeStatus: 401, cookie: null }).verdict, 'fail')
  assert.equal(doorVerdict({ reachable: true, bareStatus: 200, form: false, app: true, exchangeStatus: 303, cookie: goodCookie }).verdict, 'fail')
  assert.equal(doorVerdict({ reachable: true, bareStatus: 401, form: true, app: false, exchangeStatus: 303, cookie: { httpOnly: false, sameSite: true } }).verdict, 'fail')
  assert.equal(doorVerdict({ reachable: false }).verdict, 'unjudged')
})

test('the proxy error is the gate\'s own 5xx sentence, not a word in a healthy page', () => {
  assert.equal(looksLikeProxyError(502, 'heddle-proxy: the upstream did not answer (ECONNREFUSED 127.0.0.1:3082)\n'), true)
  assert.equal(looksLikeProxyError(200, '<!doctype html>\n<!-- the heddle-proxy gate -->'), false)
  assert.equal(looksLikeProxyError(500, 'heddle-proxy: something else'), false)
})

test('the gate passes only when it served the app, and keeps its own sentence when it did not', () => {
  assert.equal(gateVerdict({ status: 200, app: true }).verdict, 'pass')
  const upstream = gateVerdict({ status: 502, app: false, proxyError: true, firstLine: 'heddle-proxy: the upstream did not answer' })
  assert.equal(upstream.verdict, 'fail')
  assert.match(upstream.detail, /upstream did not answer/)
  assert.equal(gateVerdict({ status: 500, app: false, proxyError: false }).verdict, 'fail')
})

test('the shell passes after a 303 exchange or when the gate served it, with the log, the composer and Send', () => {
  assert.equal(shellVerdict({ exchangeStatus: 303, loaded: true, log: true, composer: true, send: true }).verdict, 'pass')
  assert.equal(shellVerdict({ exchangeStatus: null, loaded: true, log: true, composer: true, send: true }).verdict, 'pass')
  assert.equal(shellVerdict({ exchangeStatus: 401, loaded: true, log: false, composer: false, send: false, tokenForm: true }).verdict, 'fail')
  assert.equal(shellVerdict({ exchangeStatus: 303, loaded: true, log: true, composer: false, send: true }).verdict, 'fail')
  assert.equal(shellVerdict({ exchangeStatus: 303, loaded: true, log: true, composer: true, send: false }).verdict, 'fail')
  assert.equal(shellVerdict({ exchangeStatus: 303, loaded: true, log: false, composer: false, send: false }).verdict, 'fail')
})

test('the expected page is the built page with its marker substituted', () => {
  const built = '<head>\n<meta name="heddle-page" content="unbuilt" />\n</head>'
  const expected = expectedPage(built, 'abcdef123456')
  assert.match(expected, /<meta name="heddle-page" content="abcdef123456">/)
  assert.doesNotMatch(expected, /unbuilt/)
})

test('the marker passes on a match, fails on a mismatch, and is unjudged when no page loaded', () => {
  assert.equal(markerVerdict({ served: 'abc123', expected: 'abc123', loaded: true }).verdict, 'pass')
  assert.equal(markerVerdict({ served: 'abc123', expected: 'def456', loaded: true }).verdict, 'fail')
  assert.equal(markerVerdict({ served: null, expected: 'abc123', loaded: true }).verdict, 'fail')
  assert.equal(markerVerdict({ served: null, expected: null, loaded: true }).verdict, 'unjudged')
  assert.equal(markerVerdict({ served: 'abc123', expected: 'abc123', loaded: false }).verdict, 'unjudged')
})

test('a console error fails the pass; warnings do not', () => {
  assert.equal(consoleVerdict([]).verdict, 'pass')
  assert.equal(consoleVerdict([{ type: 'warning', text: 'a warning' }]).verdict, 'pass')
  const failed = consoleVerdict([{ type: 'error', text: 'TypeError: x' }])
  assert.equal(failed.verdict, 'fail')
  assert.equal(failed.errors, 1)
})

test('a turn that arrived as one whole answer did not stream', () => {
  const whole = turnVerdict({ userAppeared: true, assistantAppeared: true, chunks: 1, samples: 1, settledMs: 900, notices: [] })
  assert.equal(whole.streamed, false)
  assert.equal(whole.verdict, 'fail')
})

test('a turn passes on two recorded chunks even when the page was sampled only once', () => {
  const fast = turnVerdict({ userAppeared: true, assistantAppeared: true, chunks: 2, samples: 1, settledMs: 3, notices: [] })
  assert.equal(fast.streamed, true)
  assert.equal(fast.verdict, 'pass')
})

test('a turn passes on two lengths growing in the page when no chunk record is readable', () => {
  const seen = turnVerdict({ userAppeared: true, assistantAppeared: true, chunks: null, samples: [8, 40], settledMs: 400, notices: [] })
  assert.equal(seen.streamed, true)
  assert.equal(seen.verdict, 'pass')
})

test('a turn fails when the answer never came, the turn never settled, or it was refused', () => {
  const silent = turnVerdict({ userAppeared: true, assistantAppeared: false, chunks: 0, samples: [], settledMs: null, notices: [] })
  assert.equal(silent.verdict, 'fail')
  assert.match(silent.detail, /never appeared/)
  const refused = turnVerdict({ userAppeared: true, assistantAppeared: true, chunks: 2, samples: 2, settledMs: 10, notices: ['the model refused it'] })
  assert.equal(refused.verdict, 'fail')
  assert.match(refused.detail, /refused/)
  const running = turnVerdict({ userAppeared: true, assistantAppeared: true, chunks: 2, samples: 2, settledMs: null, notices: [] })
  assert.equal(running.verdict, 'fail')
  const notSubmitted = turnVerdict({ userAppeared: false, assistantAppeared: false, chunks: 0, samples: [], settledMs: null, notices: [] })
  assert.equal(notSubmitted.verdict, 'fail')
})

test('a command line states every home path as ~, not only a leading one', () => {
  assert.equal(tildeText('node /Users/someone/heddle-live/dist/cli.js web', '/Users/someone'), 'node ~/heddle-live/dist/cli.js web')
})

test('the serving process must run the deployment checkout, and another checkout is a failure', () => {
  const home = '/Users/someone'
  const deploy = `${home}/heddle-live`
  const pass = processVerdict({ command: `node ${deploy}/dist/cli.js web --host 127.0.0.1 --port 3082`, deployRoot: deploy, home })
  assert.equal(pass.verdict, 'pass')
  const other = processVerdict({ command: `node ${home}/heddle--other/dist/cli.js web --port 3082`, deployRoot: deploy, home })
  assert.equal(other.verdict, 'fail')
  assert.match(other.detail, /another checkout/)
  assert.doesNotMatch(other.detail, /Users\/someone/)
  assert.equal(processVerdict({ command: null, deployRoot: deploy, home }).verdict, 'unjudged')
  const rust = processVerdict({ command: '/opt/tools/heddle web --port 3082', deployRoot: deploy, home })
  assert.equal(rust.verdict, 'unjudged')
})

test('only a gate with no upstream or a silent port counts as down enough to kickstart', () => {
  assert.equal(deploymentDown({ gate: { verdict: 'fail', proxyError: true }, door: { verdict: 'unjudged' } }), true)
  assert.equal(deploymentDown({ gate: { verdict: 'fail', status: null }, door: { verdict: 'fail', detail: 'x' } }), true)
  assert.equal(deploymentDown({ gate: { verdict: 'pass' }, door: { verdict: 'fail', detail: 'the deployed server on http://127.0.0.1:3082 does not answer: fetch failed' } }), true)
  // A gate that answers a wrong status, or a server that answers and refuses, is not down.
  assert.equal(deploymentDown({ gate: { verdict: 'fail', status: 500, proxyError: false }, door: { verdict: 'pass' } }), false)
  assert.equal(deploymentDown({ gate: { verdict: 'pass' }, door: { verdict: 'fail', detail: 'the deployed server answered 200 without a credential' } }), false)
  assert.equal(deploymentDown({ gate: { verdict: 'pass' }, door: { verdict: 'pass' } }), false)
})

test('a refused gate with a healthy server is the gate, not the server', () => {
  // live-deploy's rehearsal: a killed gate stays down while 3082 answers; launchd does not restart it.
  assert.equal(outageHop({ gateStatus: null, serverAnswers: true }), 'gate')
  assert.equal(outageHop({ gateStatus: 502, serverAnswers: false }), 'server')
  assert.equal(outageHop({ gateStatus: null, serverAnswers: false }), 'both')
  assert.equal(outageHop({ gateStatus: 200, serverAnswers: true }), 'none')
})

test('a down reading that answers again within the window is a restart, not an outage', () => {
  assert.equal(classifyOutage({ down: false, recoveredAfterMs: null, windowMs: 20_000 }), 'healthy')
  // The supervisor's one-second restart, or the lane gate's 95 kill test.
  assert.equal(classifyOutage({ down: true, recoveredAfterMs: 1_200, windowMs: 20_000 }), 'restart')
  assert.equal(classifyOutage({ down: true, recoveredAfterMs: null, windowMs: 20_000 }), 'outage')
  assert.equal(classifyOutage({ down: true, recoveredAfterMs: 25_000, windowMs: 20_000 }), 'outage')
})

test('a pinned pass renders as a table row that keeps failures, restarts and staleness visible', () => {
  const row = summaryRow({
    at: '2026-10-23T04:04:57.979Z',
    deployment: { headShort: '480d9b83dc9a', behind: 3 },
    checks: { gate: { verdict: 'pass' }, door: { verdict: 'fail' }, turn: { verdict: 'unjudged' } },
    outage: { kind: 'restart', recoveredAfterMs: 1200 },
    verdict: 'fail',
  })
  // An entry pinned before the preview was a target shows '-' in the Preview column.
  assert.deepEqual(row, ['2026-10-23 04:04:57Z', '480d9b8 (behind 3)', 'pass', '-', 'FAIL', '-', '-', '----', '-', 'restart 1200ms', 'FAIL', '-'])
  const withPreview = summaryRow({ at: '2026-10-23T06:20:00Z', deployment: {}, checks: {}, verdict: 'pass', preview: { verdict: 'fail' } })
  assert.equal(withPreview.at(-1), 'FAIL', "a failing preview stays visible beside a passing deployment")
})

test('the pass fails on any failure or unknown verdict, is unjudged on any unjudged check, and passes only when all pass', () => {
  assert.equal(passVerdict({ a: { verdict: 'pass' }, b: { verdict: 'pass' } }), 'pass')
  assert.equal(passVerdict({ a: { verdict: 'pass' }, b: { verdict: 'fail' } }), 'fail')
  assert.equal(passVerdict({ a: { verdict: 'pass' }, b: { verdict: 'unjudged' } }), 'unjudged')
  assert.equal(passVerdict({ a: { verdict: 'fail' }, b: { verdict: 'unjudged' } }), 'fail')
  // An unknown verdict is never a pass: this is the hole a 'partial' door used to fall through.
  assert.equal(passVerdict({ a: { verdict: 'pass' }, b: { verdict: 'partial' } }), 'fail')
})

test('the pinned record redacts home paths and launch tokens at the boundary', () => {
  const record = { at: 'x', detail: 'read /Users/someone/.heddle/web.log', url: 'http://127.0.0.1:3082/?token=abcdef123', nested: [{ note: 'session at /Users/someone/x' }] }
  const out = redactRecord(record, '/Users/someone')
  assert.equal(out.detail, 'read ~/.heddle/web.log')
  assert.equal(out.url, 'http://127.0.0.1:3082/?token=<redacted>')
  assert.equal(out.nested[0].note, 'session at ~/x')
})

test('a turn is spent on the preview only when every endpoint is the fixture', () => {
  assert.equal(fixtureOnly([{ name: 'scripted', kind: 'scripted' }]), true)
  assert.equal(fixtureOnly([{ name: 'scripted', kind: 'scripted' }, { name: 'deepseek', kind: 'openai' }]), false)
  assert.equal(fixtureOnly([]), false, 'no endpoints is not "all fixture"')
  assert.equal(fixtureOnly(null), false)
})

test('a preview turn passes only when it completed with the fixture answer', () => {
  const done = { userAppeared: true, assistantAppeared: true, settled: true, answerHead: `${FIXTURE_PREFIX}, not a model` }
  assert.equal(previewTurnVerdict(done).verdict, 'pass')
  assert.equal(previewTurnVerdict({ ...done, assistantAppeared: false }).verdict, 'fail')
  assert.equal(previewTurnVerdict({ ...done, settled: false }).verdict, 'fail')
  assert.match(previewTurnVerdict({ ...done, answerHead: 'Hello! How can I help?' }).detail, /not the fixture/)
})

test('a real-model turn (D-052) is judged on completion, never on its wording', () => {
  const selection = { ok: true, endpoint: 'deepseek-official', model: 'deepseek-flash', effort: 'low' }
  const done = { mode: 'real', selection, userAppeared: true, assistantAppeared: true, settled: true, settledMs: 900, answerHead: 'OK' }
  assert.equal(previewTurnVerdict(done).verdict, 'pass')
  assert.match(previewTurnVerdict(done).detail, /a real turn completed \(deepseek-official\/deepseek-flash, effort low, settled at 900ms\)/)
  assert.equal(previewTurnVerdict({ ...done, answerHead: 'Hello! How can I help?' }).verdict, 'pass', 'any wording passes')
  assert.equal(previewTurnVerdict({ ...done, settled: false }).verdict, 'fail')
  assert.equal(previewTurnVerdict({ ...done, assistantAppeared: false }).verdict, 'fail')
  const missing = previewTurnVerdict({ ...done, selection: { ok: false, reason: 'deepseek-official/deepseek-flash is not configured' } })
  assert.equal(missing.verdict, 'fail', 'a model that cannot be selected fails; no other model is tried')
  assert.match(missing.detail, /not configured/)
})

test('the lowest effort is the least common level declared, else the first, else none', () => {
  assert.equal(lowestEffort([{ id: 'high' }, { id: 'low' }, { id: 'medium' }]), 'low')
  assert.equal(lowestEffort([{ id: 'medium' }, { id: 'minimal' }]), 'minimal')
  assert.equal(lowestEffort([{ id: 'fast' }, { id: 'deep' }]), 'fast', 'unknown names keep the catalogue order')
  assert.equal(lowestEffort([]), null)
  assert.equal(lowestEffort(undefined), null)
})

test('the real model is chosen from the catalogue at its lowest effort, or the reason it cannot be', () => {
  const catalogue = {
    endpoints: [
      { name: 'scripted', kind: 'scripted' },
      { name: 'deepseek-official', kind: 'openai-chat', models: [{ id: 'deepseek-pro' }, { id: 'deepseek-flash', reasoning: { levels: [{ id: 'high' }, { id: 'low' }] } }] },
    ],
  }
  assert.deepEqual(realModelChoice(catalogue), { ok: true, endpoint: 'deepseek-official', model: 'deepseek-flash', effort: 'low', modelTitle: 'deepseek-flash', effortName: 'low' })
  const named = { endpoints: [{ name: 'deepseek-official', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: { levels: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }] }] }
  const choice = realModelChoice(named)
  assert.equal(choice.modelTitle, 'DeepSeek Flash')
  assert.equal(choice.effortName, 'Low')
  assert.equal(expectedSeatLabel(choice), 'Select model, current DeepSeek Flash, reasoning effort Low')
  assert.equal(expectedSeatLabel({ ...choice, effortName: null }), 'Select model, current DeepSeek Flash')
  assert.deepEqual(REAL_MODEL, { endpoint: 'deepseek-official', model: 'deepseek-flash' })
  const endpointWide = { endpoints: [{ name: 'deepseek-official', kind: 'openai-chat', model: 'deepseek-flash', reasoning: { levels: [{ id: 'medium' }] } }] }
  assert.equal(realModelChoice(endpointWide).effort, 'medium', "the endpoint's levels apply when the model declares none")
  assert.equal(realModelChoice({ endpoints: [{ name: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }] }).effort, null)
  assert.match(realModelChoice({ endpoints: [{ name: 'other', kind: 'openai-chat' }] }).reason, /deepseek-official is not configured/)
  assert.match(realModelChoice({ endpoints: [{ name: 'deepseek-official', models: [{ id: 'deepseek-pro' }] }] }).reason, /deepseek-official\/deepseek-flash is not configured/)
  assert.equal(realModelChoice(null).ok, false)
  assert.equal(modelLabel({ endpoint: 'e', model: 'm', effort: null }), 'e/m')
})

test('a redeploy inside a pass leaves its failures unjudged, with the move named (2026-10-29 11:08Z)', () => {
  const start = { head: 'aefbd9c9d7f7d6b9', marker: '68527116cd03' }
  assert.equal(deploymentMove(start, { ...start }), null, 'nothing moved')
  assert.equal(deploymentMove(start, { head: null, marker: null }), null, 'a missing end reading is not a move')
  const move = deploymentMove(start, { head: '551c0a44b65915b8', marker: 'e7c848afdc92' })
  assert.deepEqual(move, { fromHead: 'aefbd9c9d7f7', toHead: '551c0a44b659', fromMarker: '68527116cd03', toMarker: 'e7c848afdc92' })
  assert.notEqual(deploymentMove(start, { head: start.head, marker: 'e7c848afdc92' }), null, 'a rebuilt page alone is a move')
  const marker = { verdict: 'fail', detail: 'the served page is not this build' }
  const judged = acrossMove(marker, move)
  assert.equal(judged.verdict, 'unjudged')
  assert.match(judged.detail, /moved during the pass \(aefbd9c9d7f7 -> 551c0a44b659\).*not this build/)
  assert.deepEqual(acrossMove({ verdict: 'pass', detail: 'ok' }, move), { verdict: 'pass', detail: 'ok' }, 'a pass stays a pass')
  assert.equal(acrossMove(marker, null), marker, 'without a move a failure stays a failure')
  assert.equal(passVerdict({ gate: { verdict: 'pass' }, marker: judged }), 'unjudged')
})

test("one real turn per pass: a conversation that is not sent is recorded, never judged", () => {
  const ok = { tokenStatus: 303, endpointsStatus: 200, treeStatus: 200, turn: { verdict: 'pass', mode: 'real' }, shared: 0 }
  const judged = previewVerdict({ ...ok, conversation: { verdict: 'not-sent', detail: 'one real turn per pass' } })
  assert.equal(judged.verdict, 'pass')
  assert.equal(judged.checks.conversation, undefined)
  assert.match(judged.detail, /a real turn completed/)
})

test("the preview's verdict needs 303, 200, 200 and a completed turn; an unspent turn leaves it unjudged", () => {
  const ok = { tokenStatus: 303, endpointsStatus: 200, treeStatus: 200, turn: { verdict: 'pass' }, shared: 0 }
  assert.equal(previewVerdict(ok).verdict, 'pass')
  assert.equal(previewVerdict({ ...ok, tokenStatus: 401 }).verdict, 'fail')
  assert.match(previewVerdict({ ...ok, treeStatus: 500 }).detail, /failing: tree/)
  assert.equal(previewVerdict({ ...ok, turn: { verdict: 'unjudged' } }).verdict, 'unjudged')
  assert.equal(previewVerdict({ ...ok, tokenStatus: null }).verdict, 'fail', 'a preview that does not answer fails')
})

test("the preview fails when it shares the deployment's session store, and is unjudged when that cannot be read", () => {
  const deployment = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.equal(sharedSessions(deployment, [{ id: 'x' }, { id: 'y' }]), 0)
  assert.equal(sharedSessions(deployment, [{ id: 'a' }, { id: 'c' }, { id: 'z' }]), 2)
  assert.equal(sharedSessions(null, deployment), null)
  const ok = { tokenStatus: 303, endpointsStatus: 200, treeStatus: 200, turn: { verdict: 'pass' } }
  assert.equal(previewVerdict({ ...ok, shared: 0 }).verdict, 'pass')
  assert.match(previewVerdict({ ...ok, shared: 18 }).detail, /failing: store/)
  assert.equal(previewVerdict({ ...ok, shared: null }).verdict, 'unjudged')
})

test("a turn counts as the monitor's only when its own session changed; landing elsewhere is named", () => {
  const before = [{ id: 'health', updated: 't1' }, { id: 'theirs', updated: 't1' }]
  assert.deepEqual(turnLanding({ target: 'health', before, after: [{ id: 'health', updated: 't2' }, { id: 'theirs', updated: 't1' }] }), { landed: 'own', othersChanged: 0 })
  // The 2026-10-23 mistake: the target untouched, someone else's session written.
  assert.equal(turnLanding({ target: 'health', before, after: [{ id: 'health', updated: 't1' }, { id: 'theirs', updated: 't2' }] }).landed, 'other')
  // A person working beside the monitor is counted, not blamed.
  assert.deepEqual(turnLanding({ target: 'health', before, after: [{ id: 'health', updated: 't2' }, { id: 'theirs', updated: 't2' }] }), { landed: 'own', othersChanged: 1 })
  assert.equal(turnLanding({ target: 'health', before, after: before }).landed, 'unknown')
  assert.equal(turnLanding({ target: null, before, after: before }).landed, 'unknown', 'no target, no claim')
})

test('a preview conversation is pending until the fix is served, then needs both messages in one session', () => {
  const pass = { verdict: 'pass', detail: 'a fixture turn completed' }
  assert.equal(conversationVerdict({ gate: { open: false, reason: 'built from 33407a4, before 4da44cf' }, first: pass, second: pass, sameSession: true }).verdict, 'pending')
  const open = { open: true }
  assert.equal(conversationVerdict({ gate: open, first: pass, second: pass, sameSession: true }).verdict, 'pass')
  assert.match(conversationVerdict({ gate: open, first: pass, second: { verdict: 'fail', detail: 'no answer appeared' }, sameSession: true }).detail, /follow-up/)
  assert.equal(conversationVerdict({ gate: open, first: pass, second: pass, sameSession: false }).verdict, 'fail')
  // Pending is recorded, not judged: the preview's verdict is untouched by it.
  const base = { tokenStatus: 303, endpointsStatus: 200, treeStatus: 200, turn: pass, shared: 0 }
  assert.equal(previewVerdict({ ...base, conversation: { verdict: 'pending' } }).verdict, 'pass')
  assert.equal(previewVerdict({ ...base, conversation: { verdict: 'fail' } }).verdict, 'fail')
})

test('a deployment follow-up must land in the same health session the first turn used', () => {
  const first = { session: { reused: true, via: 'tree', title: 'live health check 1' } }
  assert.equal(sameHealthSession(first, { landing: { landed: 'own' }, session: { reused: true, title: 'live health check 1' } }), true)
  assert.equal(sameHealthSession(first, { landing: { landed: 'own' }, session: { reused: true, title: 'live health check 2' } }), false, 'another health session')
  assert.equal(sameHealthSession(first, { landing: { landed: 'other' }, session: { reused: true, title: 'live health check 1' } }), false, 'landed elsewhere')
  // A first turn that started the session has no title yet: the follow-up must continue an existing one.
  const started = { session: { reused: false, via: 'started', title: null } }
  assert.equal(sameHealthSession(started, { landing: { landed: 'own' }, session: { reused: true, title: 'live health check 3' } }), true)
  assert.equal(sameHealthSession(started, { landing: { landed: 'own' }, session: { reused: false, title: null } }), false, 'started yet another')
})

test('with the deployment conversation on, the turn check claims both messages', () => {
  const first = { verdict: 'pass', detail: 'answer streamed' }
  const passed = deploymentTurnWithConversation(first, { verdict: 'pass', detail: 'a two-message conversation completed in one session' })
  assert.equal(passed.verdict, 'pass')
  assert.equal(passed.detail, 'answer streamed', 'a passing conversation adds no noise to the turn detail')
  assert.equal(passed.conversation.verdict, 'pass')
  const failed = deploymentTurnWithConversation(first, { verdict: 'fail', detail: 'the follow-up message: no answer appeared' })
  assert.equal(failed.verdict, 'fail')
  assert.match(failed.detail, /follow-up/)
  assert.equal(deploymentTurnWithConversation(first, { verdict: 'unjudged', detail: 'x' }).verdict, 'unjudged')
  // A first message that failed keeps its own story; the conversation is still recorded beside it.
  const broken = deploymentTurnWithConversation({ verdict: 'fail', detail: 'no answer' }, { verdict: 'unjudged', detail: 'no follow-up was sent' })
  assert.equal(broken.detail, 'no answer')
  assert.equal(broken.conversation.verdict, 'unjudged')
  // Without the flag nothing changes.
  assert.equal(deploymentTurnWithConversation(first, undefined), first)
})
