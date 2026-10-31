import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { classify, collectNames, descendantsOf, lastLines, tapCounts } from '../../run.mjs'

/**
 * The runner's own **component tests**.
 *
 * Every verdict in this repository passes through `classify`, and the runner's header already said the
 * mapping "is worth a test of its own" — this is it. The rules under test are the ones a wrong
 * implementation would hide behind a green run: a skipped check is never a pass, a failure outranks an
 * unjudged check, and nothing collected is unjudged rather than passed.
 *
 *     node --test _tools_/verify-runner/_tests_/<suite>/unit.test.mjs
 */

/** One TAP tail, as node v24 writes it: no colon after the key. */
function tap({ tests, pass, fail = 0, skipped = 0, cancelled = 0, todo = 0 }) {
  return [
    `# tests ${tests}`,
    `# pass ${pass}`,
    `# fail ${fail}`,
    `# cancelled ${cancelled}`,
    `# skipped ${skipped}`,
    `# todo ${todo}`,
    '',
  ].join('\n')
}

test('a tap counter is read without a colon, and a missing one is zero', () => {
  const text = tap({ tests: 4, pass: 3, skipped: 1 })
  assert.equal(tapCounts(text, 'tests'), 4)
  assert.equal(tapCounts(text, 'pass'), 3)
  assert.equal(tapCounts(text, 'skipped'), 1)
  assert.equal(tapCounts(text, 'fail'), 0, 'an absent counter is zero rather than an error')
  assert.equal(tapCounts('', 'tests'), 0)
})

test('a run where every check passed is the only zero', () => {
  const result = classify(tap({ tests: 3, pass: 3 }), '', 0)
  assert.equal(result.verdict, 0)
  assert.equal(result.reason, 'all 3 check(s) passed')
})

test('a skipped check is unjudged, even beside passes', () => {
  const result = classify(tap({ tests: 3, pass: 2, skipped: 1 }), '', 0)
  assert.equal(result.verdict, 3, 'a skip is never a pass')
  assert.equal(result.reason, '1 of 3 check(s) could not be judged')
})

test('a suite where every check skipped is unjudged', () => {
  const result = classify(tap({ tests: 2, pass: 0, skipped: 2 }), '', 0)
  assert.equal(result.verdict, 3)
})

test('nothing collected is unjudged, not passed', () => {
  const result = classify(tap({ tests: 0, pass: 0 }), '', 0)
  assert.equal(result.verdict, 3)
  assert.equal(result.reason, 'no checks were collected')
})

test('a failure outranks a skip, and a cancellation counts as one', () => {
  const withSkip = classify(tap({ tests: 4, pass: 2, fail: 1, skipped: 1 }), '', 1)
  assert.equal(withSkip.verdict, 1, 'a broken capability matters more than a missing one')
  assert.equal(withSkip.reason, '1 check(s) failed')
  const cancelled = classify(tap({ tests: 4, pass: 2, cancelled: 1 }), '', 1)
  assert.equal(cancelled.verdict, 1)
})

test('a todo is unjudged, because it was not judged', () => {
  const result = classify(tap({ tests: 2, pass: 1, todo: 1 }), '', 0)
  assert.equal(result.verdict, 3)
})

test('a run with no passes, failures or skips produced no verdict', () => {
  const result = classify(tap({ tests: 1, pass: 0 }), '', 0)
  assert.equal(result.verdict, 3)
  assert.equal(result.reason, 'no verdict was produced')
})

/** The `--list` reading: which checks ran, how they finished, and why a skip was unjudged. */
test('a skip line names the check and carries its reason, indented or not', () => {
  const stdout = [
    'ok 1 - the first claim',
    'ok 2 - a skipped claim # SKIP the fixture was absent',
    '    ok 3 - a nested skip # SKIP',
    'not ok 4 - the fourth claim',
    '',
  ].join('\n')
  assert.deepEqual(collectNames(stdout), [
    { name: 'the first claim', status: 'pass' },
    { name: 'a skipped claim', status: 'skip', reason: 'the fixture was absent' },
    { name: 'a nested skip', status: 'skip', reason: '' },
    { name: 'the fourth claim', status: 'fail' },
  ])
})

test('a deliberate skip is a pass only when the target asks for it, never by default', () => {
  /** The default contract: a skipped check is unjudged, and an unjudged run is exit 3. */
  const skipped = classify(tap({ tests: 5, pass: 3, skipped: 2 }), '', 0)
  assert.equal(skipped.verdict, 3, 'a skip without permission stays unjudged')
  assert.match(skipped.reason, /2 of 5 check\(s\) could not be judged/)

  /**
   * The **standard target** excludes the browser checks on purpose, so those skips are a stated part of that run. The flag is
   * explicit — the same input still fails without it.
   */
  const allowed = classify(tap({ tests: 5, pass: 3, skipped: 2 }), '', 0, { allowSkip: true })
  assert.equal(allowed.verdict, 0, 'with --allow-skip the judged checks decide the verdict')
  assert.match(allowed.reason, /all 3 judged check\(s\) passed; 2 skipped by this target/)

  /** A failure still outranks a permitted skip: a red check is never hidden by the flag. */
  const failed = classify(tap({ tests: 5, pass: 2, fail: 1, skipped: 2 }), '', 1, { allowSkip: true })
  assert.equal(failed.verdict, 1, 'a failure is still a failure')
})

test('the descendants of a process are found by parent, across levels, and nothing else is', () => {
  const rows = [
    { pid: 10, ppid: 1 }, // the runner
    { pid: 11, ppid: 10 }, // node --test
    { pid: 12, ppid: 11 }, // the harness
    { pid: 13, ppid: 11 }, // a browser in its own process group, still a child by parent
    { pid: 14, ppid: 13 }, // the browser's helper
    { pid: 20, ppid: 1 }, // an unrelated process
    { pid: 21, ppid: 20 },
  ]
  assert.deepEqual(descendantsOf(10, rows), [11, 12, 13, 14])
  assert.deepEqual(descendantsOf(20, rows), [21])
  assert.deepEqual(descendantsOf(14, rows), [], 'a leaf has no descendants')
})

/** Whether a pid still names a live process. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a runner told to stop ends every process its check started, a detached one included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-runner-orphans-'))
  const pidsFile = join(dir, 'pids.json')
  const check = join(dir, 'hang.check.mjs')
  writeFileSync(
    check,
    [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "import { test } from 'node:test'",
      "test('hangs with two children', async () => {",
      "  const attached = spawn('sleep', ['120'], { stdio: 'ignore' })",
      "  const detached = spawn('sleep', ['120'], { stdio: 'ignore', detached: true })",
      `  writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([attached.pid, detached.pid]))`,
      '  await new Promise(() => setInterval(() => {}, 1000))',
      '})',
      '',
    ].join('\n'),
  )
  const runner = fileURLToPath(new URL('../../run.mjs', import.meta.url))
  /** Outside this test runner's own context: a nested `node --test` that inherits it reports to this run instead. */
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, [runner, check, '--list'], { stdio: ['ignore', 'ignore', 'pipe'], env })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  let pids = []
  try {
    const started = Date.now()
    while (!existsSync(pidsFile) && Date.now() - started < 15_000) await new Promise((resolve) => setTimeout(resolve, 50))
    pids = JSON.parse(readFileSync(pidsFile, 'utf8'))
    assert.ok(pids.every(alive), 'both children run before the runner is stopped')
    child.kill('SIGTERM')
    const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timed out'), 10_000))])
    assert.deepEqual(result, { code: 143, signal: null }, 'the runner exits at once, with the SIGTERM status')
    assert.match(stderr, /run\.mjs: stopped by SIGTERM; the last TAP lines:/, 'and says where its check stood')
    const settled = Date.now()
    while (pids.some(alive) && Date.now() - settled < 3000) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(pids.filter(alive), [], 'no child of the check outlives the runner')
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stopped runner reports the last non-empty TAP lines it saw', () => {
  const text = ['TAP version 13', '# Subtest: one', 'ok 1 - one', '', '# Subtest: two', '  ', ''].join('\n')
  assert.deepEqual(lastLines(text, 2), ['ok 1 - one', '# Subtest: two'])
  assert.deepEqual(lastLines('', 8), [])
})
