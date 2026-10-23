import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { test } from 'node:test'

// The script under test, and the worktree it must not depend on.
const RUN = join(import.meta.dirname, '..', '..', 'run')
const CWD = join(import.meta.dirname, '..', '..', '..', '..')

// Every test gets its own slot root and its own fake cargo, so no test can see or
// disturb a real build slot on this Mac.
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'local-build-test-'))
  const log = join(root, 'cargo.log')
  const cargo = join(root, 'fake-cargo')
  writeFileSync(
    cargo,
    `#!/bin/sh
for a in "$@"; do printf 'arg:%s\\n' "$a" >> "$FAKE_LOG"; done
printf 'env:%s|%s|%s\\n' "$CARGO_PROFILE_DEV_DEBUG" "$CARGO_PROFILE_RELEASE_DEBUG" "$CARGO_INCREMENTAL" >> "$FAKE_LOG"
printf '+%s\\n' "$$" >> "$FAKE_LOG"
if [ -n "\${FAKE_HIJACK:-}" ]; then
  printf '1 %s hijacked\\n' "$(date +%s)" > "$FAKE_HIJACK"
fi
sleep "\${FAKE_SLEEP:-0}"
printf -- '-%s\\n' "$$" >> "$FAKE_LOG"
exit "\${FAKE_RC:-0}"
`,
    { mode: 0o755 },
  )
  chmodSync(cargo, 0o755)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root: join(root, 'slots'), log, cargo, dir: root }
}

function env(sb, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LOCAL_BUILD_SLOT_ROOT: sb.root,
    CARGO: sb.cargo,
    FAKE_LOG: sb.log,
    ...extra,
  }
}

function run(sb, args, extra = {}) {
  return spawnSync('/bin/sh', [RUN, ...args], { cwd: CWD, env: env(sb, extra), encoding: 'utf8' })
}

function start(sb, args, extra = {}) {
  const child = spawn('/bin/sh', [RUN, ...args], {
    cwd: CWD,
    env: env(sb, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const chunks = { stdout: '', stderr: '' }
  child.stdout.on('data', (d) => (chunks.stdout += d))
  child.stderr.on('data', (d) => (chunks.stderr += d))
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, ...chunks })))
  return { child, done }
}

function slotDirs(sb) {
  return existsSync(sb.root) ? readdirSync(sb.root).filter((n) => n.startsWith('slot-')) : []
}

function logLines(sb) {
  return existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim().split('\n').filter(Boolean) : []
}

function args(sb) {
  return logLines(sb).filter((l) => l.startsWith('arg:')).map((l) => l.slice(4))
}

// Poll `status` until it prints the wanted substring, or the deadline passes.
async function waitForStatus(sb, wanted, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = run(sb, ['status']).stdout
    if (last.includes(wanted)) return last
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.fail(`status never printed ${JSON.stringify(wanted)}; last was:\n${last}`)
}

test('status on an empty root lists three free slots and exits 0', (t) => {
  const sb = sandbox(t)
  const r = run(sb, ['status'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^root: /m)
  for (const i of [0, 1, 2]) assert.match(r.stdout, new RegExp(`slot ${i}: free`))
  assert.match(r.stdout, /summary: busy=0 stale=0 free=3/)
})

test('a finished command releases its slot, and the exit code is cargo\'s', (t) => {
  const sb = sandbox(t)
  const ok = run(sb, ['build'], { FAKE_SLEEP: '0' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(slotDirs(sb), [], 'no slot directory survives a normal exit')
  assert.equal(run(sb, ['status']).status, 0)

  const failed = run(sb, ['test'], { FAKE_RC: '7' })
  assert.equal(failed.status, 7, 'a failing cargo fails the runner with the same status')
  assert.deepEqual(slotDirs(sb), [], 'a failed command releases its slot too')
})

test('the slot cap defaults to three jobs and the small-target environment', (t) => {
  const sb = sandbox(t)
  assert.equal(run(sb, ['check', '-p', 'heddle-config'], { FAKE_SLEEP: '0' }).status, 0)
  assert.deepEqual(args(sb), ['check', '-j', '3', '-p', 'heddle-config'])
  assert.ok(logLines(sb).includes('env:0|0|0'), 'debug symbols off and no incremental')
})

test('a caller\'s own -j is kept, in every spelling, and no -j is added to fmt', (t) => {
  const sb = sandbox(t)
  assert.equal(run(sb, ['test', '-j', '2'], { FAKE_SLEEP: '0' }).status, 0)
  assert.deepEqual(args(sb), ['test', '-j', '2'])
  writeFileSync(sb.log, '')

  assert.equal(run(sb, ['build', '--jobs=4'], { FAKE_SLEEP: '0' }).status, 0)
  assert.deepEqual(args(sb), ['build', '--jobs=4'])
  writeFileSync(sb.log, '')

  assert.equal(run(sb, ['fmt', '--check'], { FAKE_SLEEP: '0' }).status, 0)
  assert.deepEqual(args(sb), ['fmt', '--check'])
  writeFileSync(sb.log, '')

  assert.equal(run(sb, ['check', '-j2'], { FAKE_SLEEP: '0' }).status, 0)
  assert.deepEqual(args(sb), ['check', '-j2'])
})

test('six at once never exceed the three slots, and all of them finish', async (t) => {
  const sb = sandbox(t)
  const runs = Array.from({ length: 6 }, () => start(sb, ['check'], { FAKE_SLEEP: '0.5' }))
  const results = await Promise.all(runs.map((r) => r.done))
  for (const r of results) assert.equal(r.code, 0, r.stderr)

  const events = logLines(sb).filter((l) => l.startsWith('+') || l.startsWith('-'))
  let current = 0
  let peak = 0
  for (const e of events) {
    current += e.startsWith('+') ? 1 : -1
    peak = Math.max(peak, current)
  }
  assert.equal(peak, 3, 'three slots, so three commands at most')
  assert.equal(results.length, 6)
  assert.deepEqual(slotDirs(sb), [])
})

test('a slot whose owner was killed is reclaimed instead of blocking the queue', async (t) => {
  const sb = sandbox(t)
  const runs = Array.from({ length: 3 }, () => start(sb, ['check'], { FAKE_SLEEP: '30' }))
  await waitForStatus(sb, 'summary: busy=3 stale=0 free=0')
  for (const r of runs) {
    try {
      process.kill(-r.child.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  await Promise.all(runs.map((r) => r.done))
  const stale = run(sb, ['status'])
  assert.equal(stale.status, 1, 'a stale slot is not a healthy status')
  assert.match(stale.stdout, /summary: busy=0 stale=3 free=0/)

  const recovered = run(sb, ['check'], { FAKE_SLEEP: '0', LOCAL_BUILD_WAIT_SECONDS: '10' })
  assert.equal(recovered.status, 0, `reclaim failed: exit ${recovered.status}\n${recovered.stderr}`)
  // The run swept every dead slot before taking one, so the root is healthy again.
  const after = run(sb, ['status'])
  assert.equal(after.status, 0, after.stdout)
  assert.match(after.stdout, /summary: busy=0 stale=0 free=3/)
})

test('an hour-old stamp is reclaimed even while its pid lives', (t) => {
  const sb = sandbox(t)
  mkdirSync(sb.root, { recursive: true })
  mkdirSync(join(sb.root, 'slot-0'))
  writeFileSync(join(sb.root, 'slot-0', 'owner'), `${process.pid} ${Math.floor(Date.now() / 1000) - 7200} /tmp/elsewhere\n`)
  // One slot only, so the run can only succeed by reclaiming the old one.
  const r = run(sb, ['check'], {
    FAKE_SLEEP: '0',
    LOCAL_BUILD_SLOTS: '1',
    LOCAL_BUILD_WAIT_SECONDS: '10',
  })
  assert.equal(r.status, 0, r.stderr)
})

test('a live slot with a fresh owner is left alone: the runner waits and gives up', (t) => {
  const sb = sandbox(t)
  mkdirSync(sb.root, { recursive: true })
  mkdirSync(join(sb.root, 'slot-0'))
  writeFileSync(join(sb.root, 'slot-0', 'owner'), `${process.pid} ${Math.floor(Date.now() / 1000)} /tmp/busy\n`)
  const r = run(sb, ['check'], {
    FAKE_SLEEP: '0',
    LOCAL_BUILD_SLOTS: '1',
    LOCAL_BUILD_WAIT_SECONDS: '2',
  })
  assert.equal(r.status, 75, 'a busy slot ends in the documented timeout, not a second command')
  assert.deepEqual(args(sb), [], 'cargo never ran')
  assert.ok(existsSync(join(sb.root, 'slot-0', 'owner')), 'the live slot is untouched')
})

test('an ownerless slot directory is reclaimed after a grace, not taken from a starting command', (t) => {
  const sb = sandbox(t)
  mkdirSync(join(sb.root, 'slot-0'), { recursive: true })
  const r = run(sb, ['check'], {
    FAKE_SLEEP: '0',
    LOCAL_BUILD_SLOTS: '1',
    LOCAL_BUILD_WAIT_SECONDS: '10',
  })
  assert.equal(r.status, 0, r.stderr)
})

test('cleanup never deletes a slot that another command now owns', (t) => {
  const sb = sandbox(t)
  mkdirSync(sb.root, { recursive: true })
  const r = run(sb, ['check'], {
    FAKE_SLEEP: '0.2',
    LOCAL_BUILD_SLOTS: '1',
    FAKE_HIJACK: join(sb.root, 'slot-0', 'owner'),
  })
  assert.equal(r.status, 0, r.stderr)
  const owner = readFileSync(join(sb.root, 'slot-0', 'owner'), 'utf8')
  assert.match(owner, /^1 /, 'the hijacker still owns the slot')
})

test('status names a dead owner stale and a live one busy', (t) => {
  const sb = sandbox(t)
  mkdirSync(join(sb.root, 'slot-0'), { recursive: true })
  writeFileSync(join(sb.root, 'slot-0', 'owner'), `999999 ${Math.floor(Date.now() / 1000)} /tmp/gone\n`)
  const r = run(sb, ['status'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /slot 0: stale pid=999999/)
  assert.match(r.stdout, /summary: busy=0 stale=1 free=2/)
})

test('an owner file from the earlier three-field runner is read as pid, stamp and directory', (t) => {
  const sb = sandbox(t)
  mkdirSync(join(sb.root, 'slot-0'), { recursive: true })
  writeFileSync(join(sb.root, 'slot-0', 'owner'), `999999 ${Math.floor(Date.now() / 1000)} /tmp/old-format\n`)
  const r = run(sb, ['status'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /slot 0: stale pid=999999 cargo=0 age=\d+s cwd=\/tmp\/old-format/)
  // and it can still be reclaimed by a command that needs the slot
  const check = run(sb, ['check'], { FAKE_SLEEP: '0', LOCAL_BUILD_SLOTS: '1', LOCAL_BUILD_WAIT_SECONDS: '10' })
  assert.equal(check.status, 0, check.stderr)
})

test('the coordinator caps the machine with one file, and status says which cap is in force', async (t) => {
  const sb = sandbox(t)
  mkdirSync(sb.root, { recursive: true })
  writeFileSync(join(sb.root, 'cap'), '2\n')

  const status = run(sb, ['status'])
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /cap: 2 of 3 slots \(set by .*cap\)/)

  const runs = Array.from({ length: 4 }, () => start(sb, ['check'], { FAKE_SLEEP: '0.4' }))
  const results = await Promise.all(runs.map((r) => r.done))
  for (const r of results) assert.equal(r.code, 0, r.stderr)
  const events = logLines(sb).filter((l) => l.startsWith('+') || l.startsWith('-'))
  let current = 0
  let peak = 0
  for (const e of events) {
    current += e.startsWith('+') ? 1 : -1
    peak = Math.max(peak, current)
  }
  assert.equal(peak, 2, 'a cap of two means two commands at most')
})

test('a cap of one leaves the other slots alone, and a cap file it cannot read is ignored', async (t) => {
  const sb = sandbox(t)
  mkdirSync(sb.root, { recursive: true })
  writeFileSync(join(sb.root, 'cap'), '1\n')
  const a = start(sb, ['check'], { FAKE_SLEEP: '0.5' })
  const b = start(sb, ['check'], { FAKE_SLEEP: '0.5' })
  await waitForStatus(sb, 'slot 0: busy')
  const during = run(sb, ['status'])
  assert.match(during.stdout, /slot 1: free/)
  assert.match(during.stdout, /slot 2: free/)
  const results = await Promise.all([a.done, b.done])
  for (const r of results) assert.equal(r.code, 0, r.stderr)

  writeFileSync(join(sb.root, 'cap'), '99\n')
  const ignored = run(sb, ['status'])
  assert.equal(ignored.status, 0)
  assert.match(ignored.stderr, /ignoring .*cap/)
  assert.match(ignored.stdout, /cap: 3 of 3 slots \(cap file ignored/)
})

test('usage is a distinct failure, and a missing cargo takes no slot', (t) => {
  const sb = sandbox(t)
  assert.equal(run(sb, []).status, 64)
  assert.equal(run(sb, ['status', 'extra']).status, 64)
  const missing = run(sb, ['check'], { CARGO: join(sb.dir, 'no-such-cargo') })
  assert.equal(missing.status, 127)
  assert.match(missing.stderr, /cargo not found/)
  assert.deepEqual(slotDirs(sb), [])
})
