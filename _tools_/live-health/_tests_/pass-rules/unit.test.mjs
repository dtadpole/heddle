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
  consoleVerdict,
  deploymentDown,
  processVerdict,
  doorVerdict,
  gateVerdict,
  launchUrlFromLog,
  markerVerdict,
  parseArguments,
  passVerdict,
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

test('the bare URL passes only as 401 with the token form and no app shell', () => {
  assert.equal(doorVerdict({ reachable: true, status: 401, form: true, app: false }).verdict, 'pass')
  assert.equal(doorVerdict({ reachable: true, status: 401, form: false, app: false }).verdict, 'partial')
  assert.equal(doorVerdict({ reachable: true, status: 200, form: false, app: true }).verdict, 'fail')
  assert.equal(doorVerdict({ reachable: false }).verdict, 'unjudged')
})

test('the gate passes only when it served the app, and keeps its own sentence when it did not', () => {
  assert.equal(gateVerdict({ status: 200, app: true }).verdict, 'pass')
  const upstream = gateVerdict({ status: 502, app: false, proxyError: true, firstLine: 'heddle-proxy: the upstream did not answer' })
  assert.equal(upstream.verdict, 'fail')
  assert.match(upstream.detail, /upstream did not answer/)
  assert.equal(gateVerdict({ status: 500, app: false, proxyError: false }).verdict, 'fail')
})

test('the shell passes after a 303 exchange or when the gate served it, with the log and the composer', () => {
  assert.equal(shellVerdict({ exchangeStatus: 303, loaded: true, log: true, composer: true }).verdict, 'pass')
  assert.equal(shellVerdict({ exchangeStatus: null, loaded: true, log: true, composer: true }).verdict, 'pass')
  assert.equal(shellVerdict({ exchangeStatus: 401, loaded: true, log: false, composer: false, tokenForm: true }).verdict, 'fail')
  assert.equal(shellVerdict({ exchangeStatus: 303, loaded: true, log: true, composer: false }).verdict, 'fail')
  assert.equal(shellVerdict({ exchangeStatus: 303, loaded: true, log: false, composer: false }).verdict, 'fail')
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
  const rust = processVerdict({ command: `${home}/heddle--developer-ten/rust/target/release/heddle web --port 3082`, deployRoot: deploy, home })
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

test('the pass fails on any failure, is unjudged on any unjudged check, and passes only when all pass', () => {
  assert.equal(passVerdict({ a: { verdict: 'pass' }, b: { verdict: 'pass' } }), 'pass')
  assert.equal(passVerdict({ a: { verdict: 'pass' }, b: { verdict: 'fail' } }), 'fail')
  assert.equal(passVerdict({ a: { verdict: 'pass' }, b: { verdict: 'unjudged' } }), 'unjudged')
  assert.equal(passVerdict({ a: { verdict: 'fail' }, b: { verdict: 'unjudged' } }), 'fail')
})
