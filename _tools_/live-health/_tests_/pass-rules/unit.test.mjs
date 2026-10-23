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
  classifyOutage,
  consoleVerdict,
  deploymentDown,
  doorVerdict,
  expectedPage,
  gateVerdict,
  launchUrlFromLog,
  looksLikeProxyError,
  markerVerdict,
  parseArguments,
  passVerdict,
  processVerdict,
  redactRecord,
  restoreDecision,
  shellVerdict,
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

test('a down reading that answers again within the window is a restart, not an outage', () => {
  assert.equal(classifyOutage({ down: false, recoveredAfterMs: null, windowMs: 20_000 }), 'healthy')
  // The supervisor's one-second restart, or the lane gate's 95 kill test.
  assert.equal(classifyOutage({ down: true, recoveredAfterMs: 1_200, windowMs: 20_000 }), 'restart')
  assert.equal(classifyOutage({ down: true, recoveredAfterMs: null, windowMs: 20_000 }), 'outage')
  assert.equal(classifyOutage({ down: true, recoveredAfterMs: 25_000, windowMs: 20_000 }), 'outage')
})

test('a kickstart never runs on a deployment that is up', () => {
  assert.equal(restoreDecision({ down: false, secondsSinceDeployChange: 9999, stillDownAfterGrace: true }).allowed, false)
})

test('a kickstart never runs inside an install window, even when the port is silent', () => {
  // The 03:54 case: the page was rebuilt six seconds before the pass read the port.
  const install = restoreDecision({ down: true, secondsSinceDeployChange: 6, stillDownAfterGrace: true })
  assert.equal(install.allowed, false)
  assert.match(install.reason, /redeploy is in progress/)
})

test('a kickstart never runs when the port came back during the grace period', () => {
  const back = restoreDecision({ down: true, secondsSinceDeployChange: 9999, stillDownAfterGrace: false })
  assert.equal(back.allowed, false)
  assert.match(back.reason, /answered again/)
})

test('a kickstart never runs while launchd reports the agent running, even after the grace', () => {
  // The 03:58 case: the agent had just started and its server took ~15 s to listen.
  const booting = restoreDecision({ down: true, agentRunning: true, secondsSinceDeployChange: 9999, stillDownAfterGrace: true })
  assert.equal(booting.allowed, false)
  assert.match(booting.reason, /supervisor owns restarts/)
})

test('a kickstart runs only when down, outside an install window, and still silent after the grace', () => {
  assert.equal(restoreDecision({ down: true, secondsSinceDeployChange: 9999, stillDownAfterGrace: true }).allowed, true)
  // An unreadable change time does not block the restore on its own: the grace still has to hold.
  assert.equal(restoreDecision({ down: true, secondsSinceDeployChange: null, stillDownAfterGrace: true }).allowed, true)
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
